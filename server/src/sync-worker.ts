// Runs in a worker thread: pulls the full catalog + EPG from the provider into SQLite
// without blocking the API / WebSocket event loop. WAL keeps readers on the old snapshot until commit.
import { parentPort, workerData } from 'node:worker_threads';
import { openDb, kvSet } from './db.ts';
import { Provider, type ProviderCreds } from './xtream.ts';
import { parseXmltv } from './epg.ts';
import { channelKey, isAdultCategory, isAdultChannel, regionOf } from './normalize.ts';
import { classify, parseTmdb, titleKey, type Lang } from './vod.ts';

const { dbPath, provider: creds, epgUrl, what } = workerData as {
  dbPath: string; provider: ProviderCreds; epgUrl: string | null; what: Array<'catalog' | 'live' | 'epg'>;
};
const provider = new Provider(creds);
const db = openDb(dbPath);
const log = (msg: string) => parentPort?.postMessage({ log: msg });

const KINDS = [
  { kind: 'live', cats: 'get_live_categories', items: 'get_live_streams', id: 'stream_id', icon: 'stream_icon' },
  { kind: 'movie', cats: 'get_vod_categories', items: 'get_vod_streams', id: 'stream_id', icon: 'stream_icon' },
  { kind: 'series', cats: 'get_series_categories', items: 'get_series', id: 'series_id', icon: 'cover' },
] as const;

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

async function syncCatalog(only?: 'live') {
  const insCat = db.prepare('INSERT INTO categories (kind, id, name, sort, count) VALUES (?, ?, ?, ?, 0)');
  const ins = db.prepare(`INSERT OR IGNORE INTO items (kind, sid, name, icon, cat, sort, epg, ext, rating, added, archive, adult, sep, tmdb, meta)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  // Download all catalogs concurrently (network-bound), import sequentially (CPU/disk-bound).
  const t0 = performance.now();
  const kinds = only ? KINDS.filter((k) => k.kind === only) : KINDS;
  const downloads = kinds.map((k) => Promise.all([provider.json<any[]>(k.cats), provider.json<any[]>(k.items)]));
  downloads.forEach((d) => d.catch(() => {}));
  for (let ki = 0; ki < kinds.length; ki++) {
    const k = kinds[ki];
    const [cats, items] = await downloads[ki];
    const t1 = performance.now();
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM categories WHERE kind = ?').run(k.kind);
      db.prepare('DELETE FROM items WHERE kind = ?').run(k.kind);
      // Adult content is never stored: flagged items, adult categories, and known adult live channels.
      const adultCats = new Set(cats.filter((c) => isAdultCategory(String(c.category_name ?? ''))).map((c) => String(c.category_id)));
      cats.forEach((c, i) => { if (!adultCats.has(String(c.category_id))) insCat.run(k.kind, String(c.category_id), String(c.category_name ?? ''), i); });
      let skipped = 0;
      for (let i = 0; i < items.length; i++) {
        const x = items[i];
        const name = String(x.name ?? '').trim();
        const cat = x.category_id != null ? String(x.category_id) : null;
        if (x.is_adult || (cat && adultCats.has(cat)) || (k.kind === 'live' && isAdultChannel(name))) { skipped++; continue; }
        const sep = /^[#=*\-_ ]{2,}.*[#=*\-_ ]{2,}$/.test(name) ? 1 : 0; // provider "##### 4K #####" dividers
        ins.run(
          k.kind, Number(x[k.id]), name, x[k.icon] || null, x.category_id != null ? String(x.category_id) : null,
          num(x.num) ?? i, x.epg_channel_id || null, x.container_extension || null,
          num(x.rating_5based ?? x.rating), num(x.added ?? x.last_modified), num(x.tv_archive_duration) ?? 0,
          0, sep, parseTmdb(x.tmdb),
          k.kind === 'series' ? seriesMeta(x) : k.kind === 'movie' && x.trailer ? JSON.stringify({ trailer: x.trailer }) : null,
        );
      }
      db.prepare(`UPDATE categories SET count = (SELECT count(*) FROM items i WHERE i.kind = categories.kind AND i.cat = categories.id AND i.sep = 0),
        adult = EXISTS (SELECT 1 FROM items i WHERE i.kind = categories.kind AND i.cat = categories.id AND i.adult = 1)
        WHERE kind = ?`).run(k.kind);
      assignRegions(k.kind);
      purgeLibrary();
      if (skipped) log(`${k.kind}: excluded ${skipped} adult items`);
      if (k.kind === 'live') assignFamilies();
      else buildTitles(k.kind);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    log(`${k.kind}: ${items.length} items, ${cats.length} categories (ready after ${((t1 - t0) / 1000).toFixed(1)}s, import ${((performance.now() - t1) / 1000).toFixed(1)}s)`);
  }
  const t = performance.now();
  db.exec(`INSERT INTO items_fts(items_fts) VALUES ('rebuild')`); // fast (~0.4s) even for the full catalog
  db.exec('PRAGMA optimize');
  log(`search index rebuilt in ${((performance.now() - t) / 1000).toFixed(1)}s`);
  kvSet(db, only ? 'live_synced' : 'catalog_synced', String(Date.now()));
  if (!only) kvSet(db, 'live_synced', String(Date.now()));
}

/** Provider series list already carries genre/plot/cast: keep it as a fallback for TMDB metadata. */
function seriesMeta(x: any): string | null {
  const m: Record<string, unknown> = {};
  if (x.genre) m.genre = String(x.genre);
  if (x.plot) m.plot = String(x.plot).slice(0, 1200);
  if (x.cast) m.cast = String(x.cast).slice(0, 300);
  if (x.director) m.director = String(x.director).slice(0, 120);
  const rd = x.releaseDate || x.release_date; if (rd) m.release = String(rd).slice(0, 10);
  const bd = Array.isArray(x.backdrop_path) ? x.backdrop_path[0] : x.backdrop_path; if (bd) m.backdrop = String(bd);
  if (x.youtube_trailer) m.trailer = String(x.youtube_trailer);
  return Object.keys(m).length ? JSON.stringify(m) : null;
}

const LANG_BIT: Record<Lang, number> = { en: 1, ar: 2, 'ar-sub': 4, other: 8 };

/** Classify every movie/series copy and merge copies into titles (by TMDB id, else name + year). */
function buildTitles(kind: string) {
  const t0 = performance.now();
  const syncId = Date.now();
  const rows = db.prepare(`SELECT i.rid, i.name, i.icon, i.rating, i.added, i.tmdb, i.meta, c.name AS catname
    FROM items i LEFT JOIN categories c ON c.kind = i.kind AND c.id = i.cat WHERE i.kind = ? AND i.sep = 0`).all(kind) as any[];
  const upItem = db.prepare('UPDATE items SET lang = ?, vq = ?, vsrc = ? WHERE rid = ?');
  interface Agg { key: string; tmdb: number | null; name: string; nameRank: number; year: number | null; poster: string | null; rating: number; added: number; lmask: number; uhd: number; nver: number; top250: number | null; meta: any; rids: number[] }
  const groups = new Map<string, Agg>();
  for (const r of rows) {
    const v = classify(r.name, r.catname ?? '');
    const vq = [v.uhd && 'uhd', v.hdr && 'hdr', v.dv && 'dv', v.dolby && 'dolby'].filter(Boolean).join(',');
    upItem.run(v.lang, vq || null, v.src, r.rid);
    const key = titleKey(kind, r.tmdb, v.name, v.year);
    let g = groups.get(key);
    // Display name: prefer an English copy's title, then Arabic, then anything
    const nameRank = v.lang === 'en' ? 3 : v.lang === 'ar' ? 2 : 1;
    if (!g) groups.set(key, (g = { key, tmdb: r.tmdb, name: v.name, nameRank, year: v.year, poster: r.icon, rating: 0, added: 0, lmask: 0, uhd: 0, nver: 0, top250: null, meta: null, rids: [] }));
    else if (nameRank > g.nameRank && v.name) { g.name = v.name; g.nameRank = nameRank; if (r.icon) g.poster = r.icon; }
    if (!g.poster && r.icon) g.poster = r.icon;
    if (!g.year && v.year) g.year = v.year;
    if (r.rating > g.rating) g.rating = r.rating;
    if (r.added > g.added) g.added = r.added;
    g.lmask |= LANG_BIT[v.lang];
    if (v.uhd && (v.lang === 'en' || v.lang === 'ar')) g.uhd = 1;
    g.nver++;
    if (v.top250 && (!g.top250 || v.top250 < g.top250)) g.top250 = v.top250;
    if (r.meta && (!g.meta || v.lang === 'en')) { try { g.meta = JSON.parse(r.meta); } catch {} }
    g.rids.push(r.rid);
  }
  const upsert = db.prepare(`INSERT INTO titles (kind, tkey, tmdb, name, year, poster, rating, added, lmask, uhd, nver, top250, seen, genres, plot, cast, director, trailer, backdrop)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tkey) DO UPDATE SET name = excluded.name, year = CASE WHEN titles.meta_at IS NULL THEN COALESCE(excluded.year, titles.year) ELSE titles.year END, poster = COALESCE(excluded.poster, titles.poster),
      rating = excluded.rating, added = excluded.added, lmask = excluded.lmask, uhd = excluded.uhd, nver = excluded.nver, top250 = excluded.top250,
      seen = excluded.seen,
      genres = CASE WHEN titles.meta_at IS NULL THEN excluded.genres ELSE titles.genres END,
      plot = CASE WHEN titles.meta_at IS NULL THEN excluded.plot ELSE titles.plot END,
      cast = CASE WHEN titles.meta_at IS NULL THEN excluded.cast ELSE titles.cast END,
      director = CASE WHEN titles.meta_at IS NULL THEN excluded.director ELSE titles.director END,
      trailer = COALESCE(titles.trailer, excluded.trailer),
      backdrop = COALESCE(titles.backdrop, excluded.backdrop)`);
  const getTid = db.prepare('SELECT tid FROM titles WHERE tkey = ?');
  const setTid = db.prepare('UPDATE items SET tid = ? WHERE rid = ?');
  for (const g of groups.values()) {
    const m = g.meta ?? {};
    const genres = m.genre ? ',' + String(m.genre).split(/\s*[,/&]\s*/).filter(Boolean).join(',') + ',' : null;
    upsert.run(kind, g.key, g.tmdb, g.name || '?', g.year, g.poster, g.rating || null, g.added || null, g.lmask, g.uhd, g.nver, g.top250, syncId,
      genres, m.plot ?? null, m.cast ?? null, m.director ?? null, m.trailer ?? null, m.backdrop ?? null);
    const tid = (getTid.get(g.key) as { tid: number }).tid;
    for (const rid of g.rids) setTid.run(tid, rid);
  }
  db.prepare('DELETE FROM titles WHERE kind = ? AND (seen IS NULL OR seen != ?)').run(kind, syncId);
  db.exec(`INSERT INTO titles_fts(titles_fts) VALUES ('rebuild')`);
  log(`${kind}: ${groups.size} titles from ${rows.length} copies (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
}

/** Favorites / history entries for things no longer in the catalog (e.g. adult content stored before) are removed. */
function purgeLibrary() {
  for (const t of ['favorites', 'progress']) {
    db.exec(`DELETE FROM ${t} WHERE (substr(item, 1, 1) = 'l' AND NOT EXISTS (SELECT 1 FROM items WHERE kind = 'live' AND sid = CAST(substr(${t}.item, 2) AS INTEGER)))
      OR (substr(item, 1, 1) = 'm' AND NOT EXISTS (SELECT 1 FROM items WHERE kind = 'movie' AND sid = CAST(substr(${t}.item, 2) AS INTEGER)))`);
  }
}

function assignRegions(kind: string) {
  const cats = db.prepare('SELECT id, name FROM categories WHERE kind = ?').all(kind) as { id: string; name: string }[];
  const up = db.prepare('UPDATE categories SET region = ? WHERE kind = ? AND id = ?');
  for (const c of cats) up.run(regionOf(c.name), kind, c.id);
  db.prepare('UPDATE items SET region = (SELECT region FROM categories c WHERE c.kind = items.kind AND c.id = items.cat) WHERE kind = ?').run(kind);
}

/** Union-find over live streams: same EPG id, or same region + cleaned name => same channel ("family"). */
function assignFamilies() {
  const rows = db.prepare(`SELECT sid, name, epg, region FROM items WHERE kind = 'live' AND sep = 0`).all() as { sid: number; name: string; epg: string | null; region: string | null }[];
  const parent = new Map<number, number>();
  const find = (x: number): number => { let r = x; while (parent.get(r) !== r) r = parent.get(r)!; let c = x; while (parent.get(c) !== r) { const n = parent.get(c)!; parent.set(c, r); c = n; } return r; };
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb)); };
  const byKey = new Map<string, number>();
  for (const r of rows) parent.set(r.sid, r.sid);
  for (const r of rows) {
    // Name only: providers mislabel EPG ids (e.g. a Main Event stream tagged SkySportsNews), which would chain
    // unrelated channels together. EPG ids are linked per family by majority vote at query time instead.
    const keys: string[] = [];
    const ck = channelKey(r.name);
    if (ck.length >= 3) keys.push(`n:${r.region ?? ''}:${ck}`);
    for (const k of keys) { const o = byKey.get(k); if (o === undefined) byKey.set(k, r.sid); else union(o, r.sid); }
  }
  const up = db.prepare(`UPDATE items SET fam = ? WHERE kind = 'live' AND sid = ?`);
  for (const r of rows) up.run(find(r.sid), r.sid);
}

async function syncEpg() {
  const t0 = performance.now();
  const used = new Set((db.prepare(`SELECT DISTINCT epg FROM items WHERE kind = 'live' AND epg IS NOT NULL`).all() as { epg: string }[]).map((r) => r.epg));
  const now = Math.floor(Date.now() / 1000);
  const ins = db.prepare('INSERT OR REPLACE INTO epg (ch, start, stop, title, descr) VALUES (?, ?, ?, ?, ?)');
  const body = await provider.download(epgUrl || provider.xmltv());
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM epg');
    const n = await parseXmltv(body, (r) => ins.run(r.ch, r.start, r.stop, r.title, r.desc ?? null), {
      from: now - 36 * 3600, to: now + 3 * 86400, keep: used.size ? (ch) => used.has(ch) : undefined,
    });
    db.exec('COMMIT');
    log(`epg: ${n} programmes for ${used.size} channels in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  kvSet(db, 'epg_synced', String(Date.now()));
}

try {
  if (what.includes('catalog')) await syncCatalog();
  else if (what.includes('live')) await syncCatalog('live');
  if (what.includes('epg')) await syncEpg();
  parentPort?.postMessage({ done: true });
} catch (e) {
  parentPort?.postMessage({ error: (e as Error).message });
} finally {
  db.close();
}
