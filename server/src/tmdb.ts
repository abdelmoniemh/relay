// TMDB metadata: genres, plots, cast, trailers, popularity; trending/popular lists; recommendations.
// Works with a v3 API key or a v4 read-access token. Everything degrades gracefully without one.
import type { DatabaseSync } from 'node:sqlite';

const API = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/';

type TKind = 'movie' | 'tv';
const tk = (kind: string): TKind => (kind === 'series' ? 'tv' : 'movie');

export class Tmdb {
  private db: DatabaseSync;
  private getKey: () => string | null;
  private bucket = 0;
  private bucketAt = 0;
  private running = false;
  private log: (m: string) => void;
  lastError: string | null = null;
  enriched = 0;

  constructor(db: DatabaseSync, getKey: () => string | null, log: (m: string) => void = () => {}) {
    this.db = db; this.getKey = getKey; this.log = log;
  }

  get enabled() { return !!this.getKey(); }

  /** ~30 requests/second, well under TMDB's limits. */
  private async throttle() {
    for (;;) {
      const now = Date.now();
      if (now - this.bucketAt >= 1000) { this.bucketAt = now; this.bucket = 0; }
      if (this.bucket < 30) { this.bucket++; return; }
      await new Promise((r) => setTimeout(r, 1000 - (now - this.bucketAt) + 5));
    }
  }

  async get<T = any>(path: string, params: Record<string, string> = {}): Promise<T> {
    const key = this.getKey();
    if (!key) throw new Error('TMDB key not set');
    await this.throttle();
    const isToken = key.length > 60; // v4 read-access tokens are long JWTs; v3 keys are 32 hex chars
    const q = new URLSearchParams({ language: 'en-US', ...params, ...(isToken ? {} : { api_key: key }) });
    const res = await fetch(`${API}${path}?${q}`, {
      headers: isToken ? { authorization: `Bearer ${key}`, accept: 'application/json' } : { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 429) { await new Promise((r) => setTimeout(r, 2000)); return this.get(path, params); }
    if (!res.ok) throw new Error(`TMDB ${res.status}`);
    return res.json() as Promise<T>;
  }

  async verify(key: string): Promise<boolean> {
    const isToken = key.length > 60;
    const res = await fetch(`${API}/configuration${isToken ? '' : `?api_key=${encodeURIComponent(key)}`}`, {
      headers: isToken ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    return !!res?.ok;
  }

  /** Cached JSON (lists, recommendations, collections). */
  async cached<T>(k: string, maxAgeS: number, fetcher: () => Promise<T>): Promise<T> {
    const row = this.db.prepare('SELECT json, at FROM tmdb_cache WHERE k = ?').get(k) as { json: string; at: number } | undefined;
    if (row && Date.now() / 1000 - row.at < maxAgeS) return JSON.parse(row.json);
    try {
      const v = await fetcher();
      this.db.prepare('INSERT OR REPLACE INTO tmdb_cache (k, json, at) VALUES (?, ?, ?)').run(k, JSON.stringify(v), Math.floor(Date.now() / 1000));
      return v;
    } catch (e) {
      if (row) return JSON.parse(row.json); // stale beats nothing
      throw e;
    }
  }

  /** TMDB ids of a list (trending / popular / top rated / now playing), first `pages` pages. */
  list(kind: string, which: 'trending' | 'popular' | 'top_rated' | 'now_playing' | 'on_the_air', pages = 3): Promise<number[]> {
    const t = tk(kind);
    return this.cached(`list:${which}:${t}`, 6 * 3600, async () => {
      const ids: number[] = [];
      for (let p = 1; p <= pages; p++) {
        const path = which === 'trending' ? `/trending/${t}/week` : `/${t}/${which}`;
        const r = await this.get<{ results: { id: number }[] }>(path, { page: String(p) });
        ids.push(...r.results.map((x) => x.id));
      }
      return ids;
    });
  }

  recommendations(kind: string, id: number): Promise<number[]> {
    const t = tk(kind);
    return this.cached(`rec:${t}:${id}`, 7 * 86400, async () => {
      const [a, b] = await Promise.all([
        this.get<{ results: { id: number }[] }>(`/${t}/${id}/recommendations`),
        this.get<{ results: { id: number }[] }>(`/${t}/${id}/similar`),
      ]);
      return [...new Set([...a.results, ...b.results].map((x) => x.id))];
    });
  }

  collection(id: number): Promise<number[]> {
    return this.cached(`col:${id}`, 30 * 86400, async () => {
      const r = await this.get<{ parts: { id: number; release_date?: string }[] }>(`/collection/${id}`);
      return r.parts.sort((a, b) => (a.release_date ?? '').localeCompare(b.release_date ?? '')).map((x) => x.id);
    });
  }

  /** Fetch details for one title and store them on the titles row. */
  async enrich(tid: number, kind: string, id: number) {
    const t = tk(kind);
    const d = await this.get<any>(`/${t}/${id}`, { append_to_response: 'credits,videos' });
    const trailer = (d.videos?.results ?? []).find((v: any) => v.site === 'YouTube' && v.type === 'Trailer' && v.official) ??
      (d.videos?.results ?? []).find((v: any) => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser'));
    const director = t === 'movie'
      ? (d.credits?.crew ?? []).filter((c: any) => c.job === 'Director').map((c: any) => c.name).slice(0, 2).join(', ')
      : (d.created_by ?? []).map((c: any) => c.name).slice(0, 2).join(', ');
    const cast = (d.credits?.cast ?? []).slice(0, 10).map((c: any) => c.name).join(', ');
    // "Action & Adventure" (TV) -> Action, Adventure; "Sci-Fi & Fantasy" -> Science Fiction, Fantasy (matches movie genre names)
    const gnames = [...new Set((d.genres ?? []).flatMap((g: any) => String(g.name).split(/\s*&\s*/)).map((g: string) => (g === 'Sci-Fi' ? 'Science Fiction' : g)))];
    const genres = gnames.length ? ',' + gnames.join(',') + ',' : null;
    const runtime = t === 'movie' ? d.runtime : d.episode_run_time?.[0] ?? null;
    const year = Number((d.release_date ?? d.first_air_date ?? '').slice(0, 4)) || null;
    this.db.prepare(`UPDATE titles SET genres = COALESCE(?, genres), plot = COALESCE(NULLIF(?, ''), plot), "cast" = COALESCE(NULLIF(?, ''), "cast"),
      director = COALESCE(NULLIF(?, ''), director), trailer = COALESCE(?, trailer), runtime = COALESCE(?, runtime),
      popularity = ?, votes = ?, rating = CASE WHEN ? > 20 THEN ? ELSE rating END, orig_lang = ?, collection = ?,
      poster = COALESCE(?, poster), backdrop = COALESCE(?, backdrop), year = COALESCE(year, ?), meta_at = ? WHERE tid = ?`)
      .run(genres, d.overview ?? '', cast, director, trailer?.key ?? null, runtime || null,
        d.popularity ?? null, d.vote_count ?? null, d.vote_count ?? 0, d.vote_average ? Math.round(d.vote_average * 10) / 20 : null,
        d.original_language ?? null, d.belongs_to_collection?.id ?? null,
        d.poster_path ? `${IMG}w342${d.poster_path}` : null, d.backdrop_path ? `${IMG}w1280${d.backdrop_path}` : null,
        year, Math.floor(Date.now() / 1000), tid);
  }

  /**
   * Background backfill: titles in the visible languages first (newest first), 8 at a time.
   * `langMask()` returns the language bitmask currently shown, so hidden languages are done last (or never).
   */
  start(langMask: () => number, onBatch: () => void) {
    const tick = async () => {
      if (this.running || !this.enabled) return;
      this.running = true;
      try {
        for (;;) {
          const rows = this.db.prepare(`SELECT tid, kind, tmdb FROM titles WHERE tmdb IS NOT NULL AND (meta_at IS NULL OR meta_at < ?)
            AND (lmask & ?) != 0 ORDER BY added DESC LIMIT 40`).all(Math.floor(Date.now() / 1000) - 30 * 86400, langMask()) as { tid: number; kind: string; tmdb: number }[];
          if (!rows.length) break;
          let fails = 0;
          for (let i = 0; i < rows.length; i += 8) {
            await Promise.all(rows.slice(i, i + 8).map(async (r) => {
              try { await this.enrich(r.tid, r.kind, r.tmdb); this.enriched++; }
              catch (e) {
                fails++;
                this.lastError = (e as Error).message;
                // Unknown id: mark as fetched so we don't retry forever
                if (/TMDB 404/.test(this.lastError)) this.db.prepare('UPDATE titles SET meta_at = ? WHERE tid = ?').run(Math.floor(Date.now() / 1000), r.tid);
              }
            }));
          }
          onBatch();
          if (fails === rows.length) { this.log(`tmdb: batch failed (${this.lastError}); pausing`); break; }
          if (!this.enabled) break;
        }
      } finally { this.running = false; }
    };
    tick();
    setInterval(tick, 10 * 60_000).unref();
    return tick;
  }
}

export const tmdbImg = (path: string | null, size = 'w342') => (path ? `${IMG}${size}${path}` : null);
