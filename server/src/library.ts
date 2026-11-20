// Movie/series browsing on top of `titles` (one row per film/show) and its versions (provider copies).
import type { UserData } from './userdata.ts';
import { LANG_BITS } from './vod.ts';
import { encodeGenres, genreLike } from './genres.ts';
import type { ProviderDetails } from './details.ts';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { Item } from '../../shared/protocol.ts';
import type { Tmdb } from './tmdb.ts';
import { kvGet, kvSet } from './db.ts';
import type { Letterboxd } from './letterboxd.ts';

const GENRE_ROWS = ['Action', 'Comedy', 'Drama', 'Thriller', 'Crime', 'Horror', 'Science Fiction', 'Animation', 'Family', 'Adventure', 'Mystery', 'Romance', 'Documentary', 'Fantasy', 'War', 'Reality', 'Kids'];

export interface TitleCard {
  tid: number; kind: 'movie' | 'series'; name: string; year: number | null; poster: string | null; rating: number | null; uhd: boolean;
  langs: string[]; progress?: { position: number; duration: number; label?: string };
  tmdb?: number | null;
  wl?: boolean;            // on the Letterboxd watchlist
  watched?: number | true; // logged on Letterboxd (rating 0.5-5, or true if unrated)
  fresh?: boolean;         // added by the provider in the last 2 weeks
  added?: number | null;
}
export interface Row { id: string; title: string; items: TitleCard[]; more?: Record<string, string> }
export interface VersionInfo {
  item: Item; lang: string; uhd: boolean; hdr: boolean; dv: boolean; dolby: boolean; src: string | null; score: number; label: string;
  probe?: { width: number | null; height: number | null; hdr: string | null; vcodec: string | null; acodec: string | null; channels: number | null; alangs: string | null; slangs: string | null };
}
export interface Device { tv: boolean; hevcOk: boolean }

const CARD = `tid, kind, name, year, poster, rating, uhd, lmask, tmdb, added`;
const toCard = (r: any): TitleCard => ({
  tid: r.tid, kind: r.kind, name: r.name, year: r.year, poster: r.poster, rating: r.rating, uhd: !!r.uhd,
  langs: Object.entries(LANG_BITS).filter(([, b]) => r.lmask & b).map(([l]) => l),
  tmdb: r.tmdb ?? null, added: r.added ?? null,
});

export class Library {
  private db: DatabaseSync;
  private tmdb: Tmdb;
  private stmts = new Map<string, StatementSync>();
  private rowCache = new Map<string, { at: number; rows: Row[] }>();
  langs: string[];

  private lb: Letterboxd;
  private wlCache: { at: number; tids: number[]; missing: { name: string; year: number | null }[]; total: number } | null = null;
  /** Provider per-film info (plot, cast, genre...) — used when TMDB has nothing yet. */

  private userData: UserData;
  private details: ProviderDetails;

  constructor(db: DatabaseSync, tmdb: Tmdb, userData: UserData, details: ProviderDetails, lb: Letterboxd) {
    this.db = db; this.tmdb = tmdb; this.userData = userData; this.details = details; this.lb = lb;
    this.langs = JSON.parse(kvGet(db, 'vod_langs') ?? '["en","ar"]');
  }

  get mask() { return this.langs.reduce((m, l) => m | (LANG_BITS[l as keyof typeof LANG_BITS] ?? 0), 0) || 1; }
  setLangs(langs: string[]) { this.langs = langs.filter((l) => l in LANG_BITS); kvSet(this.db, 'vod_langs', JSON.stringify(this.langs)); this.invalidate(); }
  invalidate() { this.rowCache.clear(); this.wlCache = null; }

  // ---------------- Letterboxd watchlist ----------------

  /** Watchlist films that are available here, in Letterboxd order (+ the ones that aren't). */
  private watchlistResolved() {
    if (this.wlCache && Date.now() - this.wlCache.at < 60_000) return this.wlCache;
    const wl = this.lb.user ? this.lb.watchlist() : [];
    const byTmdb = this.st(`SELECT tid FROM titles WHERE kind = ? AND tmdb = ? AND (lmask & ?) != 0`);
    const byName = this.st(`SELECT tid FROM titles WHERE kind = 'movie' AND year = ? AND name = ? COLLATE NOCASE AND (lmask & ?) != 0 LIMIT 1`);
    const tids: number[] = [], missing: { name: string; year: number | null }[] = [];
    for (const w of wl) {
      const hit = (w.tmdb ? (byTmdb.get('movie', w.tmdb, this.mask) ?? byTmdb.get('series', w.tmdb, this.mask)) : byName.get(w.year ?? 0, w.name, this.mask)) as { tid: number } | undefined;
      if (hit && !tids.includes(hit.tid)) tids.push(hit.tid);
      else if (!hit) missing.push({ name: w.name, year: w.year });
    }
    this.wlCache = { at: Date.now(), tids, missing, total: wl.length };
    return this.wlCache;
  }

  /** Add watchlist/watched/new flags; watchlist titles first (stable) when `prioritize`. */
  decorate(cards: TitleCard[], prioritize = true): TitleCard[] {
    if (!this.lb.user) return cards;
    const wl = new Set(this.watchlistResolved().tids);
    const watched = this.lb.watched();
    const twoWeeks = Date.now() / 1000 - 14 * 86400;
    const out = cards.map((c) => {
      const w = c.tmdb ? watched.get(c.tmdb) : undefined;
      return { ...c, wl: wl.has(c.tid), watched: w ? (w.rating ?? (true as const)) : undefined, fresh: !!c.added && c.added > twoWeeks } as TitleCard;
    });
    return prioritize ? [...out.filter((c) => c.wl && !c.watched), ...out.filter((c) => !(c.wl && !c.watched))] : out;
  }

  watchlistRow(limit = 60): { items: TitleCard[]; available: number; total: number; missing: { name: string; year: number | null }[] } {
    const r = this.watchlistResolved();
    if (!r.tids.length) return { items: [], available: 0, total: r.total, missing: r.missing };
    const rows = this.db.prepare(`SELECT ${CARD} FROM titles WHERE tid IN (${r.tids.map(() => '?').join(',')})`).all(...r.tids) as any[];
    const by = new Map(rows.map((x) => [x.tid, toCard(x)]));
    let items = this.decorate(r.tids.map((t) => by.get(t)!).filter(Boolean), false).filter((c) => !c.watched);
    // Newly available ones first: that's the news.
    items = [...items.filter((c) => c.fresh), ...items.filter((c) => !c.fresh)];
    return { items: items.slice(0, limit), available: items.length, total: r.total, missing: r.missing };
  }

  private st(sql: string) {
    let s = this.stmts.get(sql);
    if (!s) this.stmts.set(sql, (s = this.db.prepare(sql)));
    return s;
  }

  private byTmdb(kind: string, ids: number[], limit = 30): TitleCard[] {
    if (!ids.length) return [];
    const rows = this.db.prepare(`SELECT ${CARD}, tmdb FROM titles WHERE kind = ? AND (lmask & ?) != 0 AND tmdb IN (${ids.map(() => '?').join(',')})`)
      .all(kind, this.mask, ...ids) as any[];
    const by = new Map(rows.map((r) => [r.tmdb, r]));
    return ids.map((i) => by.get(i)).filter(Boolean).slice(0, limit).map(toCard);
  }

  private query(kind: string, where: string, order: string, args: unknown[] = [], limit = 30): TitleCard[] {
    return (this.st(`SELECT ${CARD} FROM titles WHERE kind = ? AND (lmask & ?) != 0 ${where} ORDER BY ${order} LIMIT ?`)
      .all(kind, this.mask, ...(args as any[]), limit) as any[]).map(toCard);
  }

  /** Continue watching for this kind: latest unfinished movie, or latest episode per series, as title cards. */
  continueRow(kind: 'movie' | 'series'): TitleCard[] {
    const rows = this.userData.unfinished(kind === 'movie' ? 'movie' : 'episode');
    const out: TitleCard[] = [];
    const seen = new Set<number>();
    for (const r of rows) {
      const it = r.item;
      const ref = kind === 'movie' ? it.id : it.seriesId;
      if (!ref) continue;
      const k = ref[0] === 'm' ? 'movie' : 'series';
      const t = this.st(`SELECT ${CARD} FROM titles WHERE tid = (SELECT tid FROM items WHERE kind = ? AND sid = ?)`).get(k, Number(ref.slice(1))) as any;
      if (!t || seen.has(t.tid)) continue;
      seen.add(t.tid);
      out.push({ ...toCard(t), progress: { position: r.position, duration: r.duration, label: kind === 'series' ? `S${it.season} · E${it.episode}` : undefined } });
      if (out.length >= 20) break;
    }
    return out;
  }

  async rows(kind: 'movie' | 'series'): Promise<Row[]> {
    const key = `${kind}:${this.mask}`;
    const hit = this.rowCache.get(key);
    const rows: Row[] = hit && Date.now() - hit.at < 5 * 60_000 ? hit.rows : await this.buildRows(kind);
    if (!hit || hit.rows !== rows) this.rowCache.set(key, { at: Date.now(), rows });
    const cont = this.continueRow(kind);
    const out: Row[] = [];
    if (cont.length) out.push({ id: 'continue', title: 'Continue watching', items: cont });
    const wl = this.watchlistRow();
    const wlItems = wl.items.filter((c) => c.kind === kind);
    if (wlItems.length) out.push({ id: 'watchlist', title: `Your Letterboxd watchlist · ${wl.available} of ${wl.total} available`, items: wlItems, more: { wl: '1', sort: 'watchlist' } });
    return [...out, ...rows.map((r) => ({ ...r, items: this.decorate(r.items) }))];
  }

  private async buildRows(kind: 'movie' | 'series'): Promise<Row[]> {
    const rows: Row[] = [];
    const year = new Date().getFullYear();
    const add = (id: string, title: string, items: TitleCard[], more?: Record<string, string>) => { if (items.length >= 4) rows.push({ id, title, items, more }); };
    if (this.tmdb.enabled) {
      // a failed list leaves its row out; Settings shows why (TMDB status)
      const safe = async (w: Parameters<Tmdb['list']>[1]) => { try { return await this.tmdb.list(kind, w); } catch (e) { this.tmdb.lastError = (e as Error).message; return []; } };
      add('trending', 'Trending this week', this.byTmdb(kind, await safe('trending')), { sort: 'popular' });
      add('popular', 'Popular', this.byTmdb(kind, await safe('popular')), { sort: 'popular' });
      if (kind === 'movie') add('now', 'In cinemas & just released', this.byTmdb(kind, await safe('now_playing')));
    }
    add('new', kind === 'movie' ? 'New releases' : 'New & returning', this.query(kind, 'AND year >= ?', 'added DESC', [year - 1]), { sort: 'added', year_from: String(year - 1) });
    add('added', 'Recently added', this.query(kind, '', 'added DESC'), { sort: 'added' });
    if (kind === 'movie') add('imdb', 'IMDb Top 250', this.query(kind, 'AND top250 IS NOT NULL', 'top250'), { top250: '1' });
    add('top', 'Top rated', this.query(kind, "AND rating >= 3.7 AND (votes IS NULL OR votes >= 300)", 'rating DESC, popularity DESC NULLS LAST'), { sort: 'rating' });
    add('uhd', 'In 4K', this.query(kind, 'AND uhd = 1', 'popularity DESC NULLS LAST, added DESC'), { uhd: '1' });
    if (this.langs.includes('ar')) add('arabic', kind === 'movie' ? 'Arabic movies' : 'Arabic series', this.query(kind, "AND (lmask & 2) != 0 AND (orig_lang = 'ar' OR orig_lang IS NULL)", 'added DESC'), { lang: 'ar', sort: 'added' });
    for (const g of this.genres(kind).slice(0, 14)) {
      add(`g:${g.name}`, g.name, this.query(kind, 'AND genres LIKE ?', 'popularity DESC NULLS LAST, added DESC', [genreLike(g.name)]), { genre: g.name });
    }
    return rows;
  }

  genres(kind: string): { name: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const g of GENRE_ROWS) {
      const n = (this.st(`SELECT count(*) AS n FROM titles WHERE kind = ? AND (lmask & ?) != 0 AND genres LIKE ?`).get(kind, this.mask, genreLike(g)) as { n: number }).n;
      if (n >= 8) counts.set(g, n);
    }
    return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => GENRE_ROWS.indexOf(a.name) - GENRE_ROWS.indexOf(b.name));
  }

  grid(kind: string, f: Record<string, string>, offset: number, limit: number): { items: TitleCard[]; total: number } {
    const where: string[] = [], args: unknown[] = [];
    if (f.genre) { where.push('genres LIKE ?'); args.push(genreLike(f.genre)); }
    if (f.lang && LANG_BITS[f.lang as keyof typeof LANG_BITS]) { where.push('(lmask & ?) != 0'); args.push(LANG_BITS[f.lang as keyof typeof LANG_BITS]); }
    if (f.year_from) { where.push('year >= ?'); args.push(Number(f.year_from)); }
    if (f.year_to) { where.push('year <= ?'); args.push(Number(f.year_to)); }
    if (f.min_rating) { where.push('rating >= ?'); args.push(Number(f.min_rating) / 2); }
    if (f.uhd === '1') where.push('uhd = 1');
    if (f.top250 === '1') where.push('top250 IS NOT NULL');
    let wlOrder: number[] | null = null;
    if (f.wl === '1') {
      wlOrder = this.watchlistResolved().tids;
      where.push(`tid IN (${wlOrder.map(() => '?').join(',') || 'NULL'})`); args.push(...wlOrder);
    }
    const order = ({ popular: 'popularity DESC NULLS LAST, added DESC', added: 'added DESC', rating: 'rating DESC NULLS LAST, votes DESC NULLS LAST', year: 'year DESC NULLS LAST, added DESC', name: 'name COLLATE NOCASE' } as Record<string, string>)[f.sort ?? ''] ?? (f.top250 === '1' ? 'top250' : 'popularity DESC NULLS LAST, added DESC');
    const w = where.length ? 'AND ' + where.join(' AND ') : '';
    const wlSort = wlOrder && (f.sort === 'watchlist' || !f.sort);
    const ord = wlSort ? `CASE tid ${wlOrder!.map((t, i) => `WHEN ${Number(t)} THEN ${i}`).join(' ')} END` : order;
    const items = this.decorate((this.db.prepare(`SELECT ${CARD} FROM titles WHERE kind = ? AND (lmask & ?) != 0 ${w} ORDER BY ${ord} LIMIT ? OFFSET ?`)
      .all(kind, this.mask, ...(args as any[]), limit, offset) as any[]).map(toCard), false);
    const total = (this.st(`SELECT count(*) AS n FROM titles WHERE kind = ? AND (lmask & ?) != 0 ${w}`).get(kind, this.mask, ...(args as any[])) as { n: number }).n;
    return { items, total };
  }

  search(q: string, kind: string | null, limit = 40): TitleCard[] {
    const terms = q.normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
    if (!terms.length || terms.join('').length < 2) return [];
    const match = terms.map((t) => `"${t}"*`).join(' ');
    const rows = this.st(`SELECT t.tid, t.kind, t.name, t.year, t.poster, t.rating, t.uhd, t.lmask, t.tmdb, t.added FROM titles_fts f JOIN titles t ON t.tid = f.rowid
      WHERE titles_fts MATCH ? AND (t.lmask & ?) != 0 ${kind ? 'AND t.kind = ?' : ''} ORDER BY rank, t.popularity DESC NULLS LAST LIMIT ?`)
      .all(...([match, this.mask, ...(kind ? [kind] : []), limit] as any[])) as any[];
    return this.decorate(rows.map(toCard)); // watchlist matches first
  }

  /** Copies of a title in the visible languages, best first for this device. */
  versions(tid: number, dev: Device, origLang: string | null): VersionInfo[] {
    const rows = this.st(`SELECT i.kind, i.sid, i.name, i.icon, i.cat, i.ext, i.rating, i.lang, i.vq, i.vsrc, p.width, p.height, p.hdr AS phdr, p.vcodec, p.acodec, p.channels, p.alangs, p.slangs
      FROM items i LEFT JOIN vod_probes p ON p.id = (CASE i.kind WHEN 'movie' THEN 'm' ELSE 's' END) || i.sid
      WHERE i.tid = ? AND i.sep = 0`).all(tid) as any[];
    const prefer = origLang === 'ar' ? 'ar' : 'en';
    return rows.filter((r) => this.langs.includes(r.lang)).map((r): VersionInfo => {
      const q = new Set(String(r.vq ?? '').split(',').filter(Boolean));
      const height = r.height ?? (q.has('uhd') ? 2160 : null);
      const uhd = (height ?? 0) >= 2000, hdr = r.phdr ? r.phdr !== 'sdr' : q.has('hdr'), dv = r.phdr ? r.phdr === 'dv' : q.has('dv');
      let score = r.lang === prefer ? 100 : 60;
      score += uhd ? (dev.tv ? 25 : 8) : 0;
      score += hdr ? (dev.tv ? 8 : -6) : 0;    // HDR on an SDR desktop screen looks washed out
      score += dv ? (dev.tv ? 4 : -4) : 0;
      score += q.has('dolby') ? 2 : 0;
      score += r.vsrc && ['NF', 'AMZ', 'TOP', 'PRMT', 'UNV', 'MAX'].includes(r.vsrc) ? 4 : 0;
      if (r.ext === 'mp4' && !dev.tv) score += 2;
      if (r.vcodec === 'hevc' && !dev.hevcOk) score -= 3;
      if (r.acodec && /ac3|eac3|dts|truehd/.test(r.acodec) && !dev.tv) score -= 2; // browser needs audio conversion
      const parts = [
        r.lang === 'en' ? 'English' : r.lang === 'ar' ? 'Arabic' : r.lang,
        height ? (height >= 2000 ? '4K' : `${height}p`) : null,
        dv ? 'Dolby Vision' : hdr ? 'HDR' : null,
        r.acodec ? `${String(r.acodec).toUpperCase()}${r.channels ? ` ${r.channels > 6 ? '7.1' : r.channels === 6 ? '5.1' : r.channels === 2 ? '2.0' : r.channels}` : ''}` : q.has('dolby') ? 'Dolby audio' : null,
        r.vsrc ? ({ NF: 'Netflix', AMZ: 'Amazon', TOP: 'Blu-ray', PRMT: 'Paramount', UNV: 'Universal', MAX: 'HBO Max', PCOK: 'Peacock', SKY: 'Sky' } as Record<string, string>)[r.vsrc] ?? r.vsrc : null,
      ].filter(Boolean);
      const item: Item = { id: (r.kind === 'movie' ? 'm' : 's') + r.sid, kind: r.kind, name: r.name, icon: r.icon, cat: r.cat, ext: r.ext, rating: r.rating };
      return {
        item, lang: r.lang, uhd, hdr, dv, dolby: q.has('dolby'), src: r.vsrc, score, label: parts.join(' · '),
        probe: r.width || r.acodec ? { width: r.width, height: r.height, hdr: r.phdr, vcodec: r.vcodec, acodec: r.acodec, channels: r.channels, alangs: r.alangs, slangs: r.slangs } : undefined,
      };
    }).sort((a, b) => b.score - a.score);
  }

  async detail(tid: number, dev: Device) {
    const t = this.st('SELECT * FROM titles WHERE tid = ?').get(tid) as any;
    if (!t) return null;
    if (this.tmdb.enabled && t.tmdb && !t.meta_at) { try { await this.tmdb.enrich(tid, t.kind, t.tmdb); } catch {} }
    let fresh = this.st('SELECT * FROM titles WHERE tid = ?').get(tid) as any;
    if (!fresh.plot && !fresh.meta_at && fresh.kind === 'movie') {
      const sid = (this.st(`SELECT sid FROM items WHERE tid = ? AND kind = 'movie' ORDER BY (lang = 'en') DESC LIMIT 1`).get(tid) as { sid: number } | undefined)?.sid;
      if (sid) {
        try {
          const i = await this.details.movie(sid, 4000);
          {
            const genres = encodeGenres(i.genre);
            this.st(`UPDATE titles SET plot = COALESCE(NULLIF(?, ''), plot), genres = COALESCE(genres, ?), "cast" = COALESCE("cast", NULLIF(?, '')),
              director = COALESCE(director, NULLIF(?, '')), runtime = COALESCE(runtime, ?), backdrop = COALESCE(backdrop, ?), trailer = COALESCE(trailer, NULLIF(?, '')) WHERE tid = ?`)
              .run(i.plot ?? '', genres, (i.cast ?? '').slice(0, 300), i.director ?? '', i.duration ? Math.round(i.duration / 60) : null, i.backdrop, i.trailer ?? '', tid);
            fresh = this.st('SELECT * FROM titles WHERE tid = ?').get(tid) as any;
          }
        } catch {}
      }
    }
    const versions = this.versions(tid, dev, fresh.orig_lang);
    let similar: TitleCard[] = [], collection: TitleCard[] = [];
    if (this.tmdb.enabled && fresh.tmdb) {
      const timeout = <T>(p: Promise<T>, d: T) => Promise.race([p, new Promise<T>((r) => setTimeout(() => r(d), 3500))]).catch(() => d);
      const [rec, col] = await Promise.all([
        timeout(this.tmdb.recommendations(fresh.kind, fresh.tmdb), [] as number[]),
        fresh.collection ? timeout(this.tmdb.collection(fresh.collection), [] as number[]) : Promise.resolve([] as number[]),
      ]);
      similar = this.byTmdb(fresh.kind, rec.filter((x) => x !== fresh.tmdb), 20);
      collection = col.length > 1 ? this.byTmdb(fresh.kind, col, 20) : [];
    }
    if (similar.length < 6 && fresh.genres) {
      const g = String(fresh.genres).split(',').filter(Boolean).slice(0, 2);
      const extra = this.query(fresh.kind, `AND tid != ? AND ${g.map(() => 'genres LIKE ?').join(' AND ')}`, 'popularity DESC NULLS LAST, rating DESC', [tid, ...g.map(genreLike)], 20);
      similar = [...similar, ...extra.filter((e) => !similar.some((s) => s.tid === e.tid))].slice(0, 20);
    }
    const [me] = this.decorate([toCard(fresh)], false);
    return {
      ...toCard(fresh), backdrop: fresh.backdrop, plot: fresh.plot, genres: String(fresh.genres ?? '').split(',').filter(Boolean),
      cast: fresh.cast, director: fresh.director, trailer: fresh.trailer, runtime: fresh.runtime, votes: fresh.votes,
      top250: fresh.top250, origLang: fresh.orig_lang, versions, similar: this.decorate(similar), collection: this.decorate(collection, false),
      wl: me.wl, watched: me.watched,
    };
  }
}
