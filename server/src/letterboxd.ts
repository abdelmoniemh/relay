// Letterboxd (read-only; the official API is invite-only):
//  - watchlist: the member's public watchlist pages (28 films/page), each film's TMDB id looked up once and cached
//  - watched + ratings: the member's public diary RSS (includes TMDB ids)
// Requests are slow and sparse (≈1 every 1.5s, hourly), and only happen when a username is set.
import type { DatabaseSync } from 'node:sqlite';
import { kvGet, kvSet } from './db.ts';

const BASE = 'https://letterboxd.com';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0 Safari/537.36';
const GAP_MS = 1500;
const MAX_PAGES = 80;          // 2,240 films
const MAX_LOOKUPS_PER_RUN = 300;

const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Films on one watchlist page (slug + "Name (Year)"). */
export function parseWatchlistPage(html: string): { slug: string; name: string; year: number | null }[] {
  return [...html.matchAll(/data-item-slug="([^"]+)"[^>]*?data-item-full-display-name="([^"]*)"/g)].map((m) => {
    const full = decode(m[2]);
    const y = /\((\d{4})\)\s*$/.exec(full);
    return { slug: m[1], name: y ? full.slice(0, y.index).trim() : full, year: y ? Number(y[1]) : null };
  });
}

/** Diary RSS entries with a TMDB id. */
export function parseDiary(xml: string): { tmdb: number; rating: number | null; date: string | null; name: string }[] {
  const out: { tmdb: number; rating: number | null; date: string | null; name: string }[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const body = m[1];
    const tmdb = Number(/<tmdb:movieId>(\d+)<\/tmdb:movieId>/.exec(body)?.[1]);
    if (!tmdb) continue;
    out.push({
      tmdb,
      rating: Number(/<letterboxd:memberRating>([\d.]+)<\/letterboxd:memberRating>/.exec(body)?.[1]) || null,
      date: /<letterboxd:watchedDate>([^<]+)<\/letterboxd:watchedDate>/.exec(body)?.[1] ?? null,
      name: decode(/<letterboxd:filmTitle>([^<]*)<\/letterboxd:filmTitle>/.exec(body)?.[1] ?? ''),
    });
  }
  return out;
}

export interface LbStatus { user: string | null; fromConfig: boolean; watchlist: number; resolved: number; watched: number; syncedAt: number | null; error: string | null; syncing: boolean }

export class Letterboxd {
  private db: DatabaseSync;
  private onChange: () => void;
  private running = false;
  error: string | null = null;

  constructor(db: DatabaseSync, onChange: () => void) {
    this.db = db; this.onChange = onChange;
    db.exec(`
      CREATE TABLE IF NOT EXISTS lb_films (slug TEXT PRIMARY KEY, tmdb INTEGER, kind TEXT, fetched INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS lb_watchlist (slug TEXT PRIMARY KEY, pos INTEGER NOT NULL, name TEXT NOT NULL, year INTEGER, synced INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS lb_watched (tmdb INTEGER PRIMARY KEY, rating REAL, date TEXT, name TEXT);
    `);
  }

  /** Username from config (LETTERBOXD_USER in server/.env) wins; otherwise the one set in the app's Settings. */
  get user() { return Letterboxd.clean(process.env.LETTERBOXD_USER ?? '') || kvGet(this.db, 'lb_user') || ''; }
  get fromConfig() { return !!Letterboxd.clean(process.env.LETTERBOXD_USER ?? ''); }
  static clean(u: string) { return u.trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?letterboxd\.com\//, '').replace(/\/.*$/, '').toLowerCase(); }
  setUser(u: string | null) {
    if (this.fromConfig) return this.user; // configured in server/.env: change it there
    const clean = u ? Letterboxd.clean(u) : '';
    kvSet(this.db, 'lb_user', clean);
    if (!clean) { this.db.exec('DELETE FROM lb_watchlist; DELETE FROM lb_watched;'); this.onChange(); }
    return clean;
  }

  status(): LbStatus {
    const n = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      user: this.user || null, fromConfig: this.fromConfig,
      watchlist: n('SELECT count(*) AS n FROM lb_watchlist'),
      resolved: n('SELECT count(*) AS n FROM lb_watchlist w JOIN lb_films f ON f.slug = w.slug WHERE f.tmdb IS NOT NULL'),
      watched: n('SELECT count(*) AS n FROM lb_watched'),
      syncedAt: Number(kvGet(this.db, 'lb_synced') ?? 0) || null,
      error: this.error, syncing: this.running,
    };
  }

  private async get(path: string): Promise<{ status: number; text: string }> {
    const res = await fetch(BASE + path, { headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/rss+xml' }, signal: AbortSignal.timeout(20_000) });
    return { status: res.status, text: await res.text() };
  }

  /** Watchlist in Letterboxd order (most recently added first), with TMDB ids where known. */
  watchlist(): { slug: string; pos: number; name: string; year: number | null; tmdb: number | null }[] {
    return this.db.prepare(`SELECT w.slug, w.pos, w.name, w.year, f.tmdb FROM lb_watchlist w LEFT JOIN lb_films f ON f.slug = w.slug ORDER BY w.pos`).all() as any;
  }
  watched(): Map<number, { rating: number | null; date: string | null }> {
    return new Map((this.db.prepare('SELECT tmdb, rating, date FROM lb_watched').all() as any[]).map((r) => [r.tmdb, { rating: r.rating, date: r.date }]));
  }

  async sync() {
    const user = this.user;
    if (!user || this.running) return;
    this.running = true;
    this.error = null;
    try {
      await this.syncWatchlist(user);
      this.onChange();
      await this.syncDiary(user);
      await this.resolveIds();
      kvSet(this.db, 'lb_synced', String(Date.now()));
      this.onChange();
    } catch (e) {
      this.error = (e as Error).message;
    } finally { this.running = false; }
  }

  private async syncWatchlist(user: string) {
    const items: { slug: string; name: string; year: number | null }[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { status, text } = await this.get(`/${encodeURIComponent(user)}/watchlist/${page > 1 ? `page/${page}/` : ''}`);
      if (status === 404) throw new Error(`Letterboxd user "${user}" not found`);
      if (status !== 200) throw new Error(`Letterboxd returned ${status}`);
      const found = parseWatchlistPage(text);
      items.push(...found);
      if (found.length < 28 || !text.includes(`/watchlist/page/${page + 1}/`)) break;
      await sleep(GAP_MS);
    }
    const now = Date.now();
    const up = this.db.prepare('INSERT OR REPLACE INTO lb_watchlist (slug, pos, name, year, synced) VALUES (?, ?, ?, ?, ?)');
    this.db.exec('BEGIN');
    try {
      items.forEach((it, i) => up.run(it.slug, i, it.name, it.year, now));
      this.db.prepare('DELETE FROM lb_watchlist WHERE synced != ?').run(now);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  /** Recent diary entries: watched films + ratings, with TMDB ids. */
  private async syncDiary(user: string) {
    const { status, text } = await this.get(`/${encodeURIComponent(user)}/rss/`);
    if (status !== 200) return;
    const up = this.db.prepare('INSERT OR REPLACE INTO lb_watched (tmdb, rating, date, name) VALUES (?, ?, ?, ?)');
    for (const d of parseDiary(text)) up.run(d.tmdb, d.rating, d.date, d.name);
  }

  /** Each film's TMDB id, read once from its Letterboxd page and cached forever. */
  private async resolveIds() {
    const todo = this.db.prepare(`SELECT w.slug FROM lb_watchlist w LEFT JOIN lb_films f ON f.slug = w.slug WHERE f.slug IS NULL ORDER BY w.pos LIMIT ?`)
      .all(MAX_LOOKUPS_PER_RUN) as { slug: string }[];
    const put = this.db.prepare('INSERT OR REPLACE INTO lb_films (slug, tmdb, kind, fetched) VALUES (?, ?, ?, ?)');
    let n = 0;
    for (const { slug } of todo) {
      await sleep(GAP_MS);
      try {
        const { status, text } = await this.get(`/film/${encodeURIComponent(slug)}/`);
        if (status !== 200) continue;
        const id = Number(/data-tmdb-id="(\d+)"/.exec(text)?.[1]) || null;
        const kind = /data-tmdb-type="([a-z]+)"/.exec(text)?.[1] ?? null;
        put.run(slug, id, kind, Date.now());
        if (++n % 25 === 0) this.onChange(); // show progress as ids come in
      } catch {}
    }
  }

  start() {
    const tick = () => { this.sync().catch(() => {}); };
    setTimeout(tick, 5000);
    setInterval(tick, 60 * 60_000).unref();
    return tick;
  }
}
