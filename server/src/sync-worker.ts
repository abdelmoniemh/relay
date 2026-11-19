// Runs in a worker thread: pulls the full catalog + EPG from the provider into SQLite
// without blocking the API / WebSocket event loop. WAL keeps readers on the old snapshot until commit.
import { parentPort, workerData } from 'node:worker_threads';
import { openDb, kvSet } from './db.ts';
import { apiUrl, getJson, getStream, xmltvUrl } from './xtream.ts';
import { parseXmltv } from './epg.ts';
import { channelKey, regionOf } from './normalize.ts';
import type { Provider } from './config.ts';

const { dbPath, provider, epgUrl, what } = workerData as {
  dbPath: string; provider: Provider; epgUrl: string | null; what: Array<'catalog' | 'live' | 'epg'>;
};
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
  const ins = db.prepare(`INSERT OR IGNORE INTO items (kind, sid, name, icon, cat, sort, epg, ext, rating, added, archive, adult, sep)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  // Download all catalogs concurrently (network-bound), import sequentially (CPU/disk-bound).
  const t0 = performance.now();
  const kinds = only ? KINDS.filter((k) => k.kind === only) : KINDS;
  const downloads = kinds.map((k) => Promise.all([getJson<any[]>(apiUrl(provider, k.cats)), getJson<any[]>(apiUrl(provider, k.items))]));
  downloads.forEach((d) => d.catch(() => {}));
  for (let ki = 0; ki < kinds.length; ki++) {
    const k = kinds[ki];
    const [cats, items] = await downloads[ki];
    const t1 = performance.now();
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM categories WHERE kind = ?').run(k.kind);
      db.prepare('DELETE FROM items WHERE kind = ?').run(k.kind);
      cats.forEach((c, i) => insCat.run(k.kind, String(c.category_id), String(c.category_name ?? ''), i));
      for (let i = 0; i < items.length; i++) {
        const x = items[i];
        const name = String(x.name ?? '').trim();
        const sep = /^[#=*\-_ ]{2,}.*[#=*\-_ ]{2,}$/.test(name) ? 1 : 0; // provider "##### 4K #####" dividers
        ins.run(
          k.kind, Number(x[k.id]), name, x[k.icon] || null, x.category_id != null ? String(x.category_id) : null,
          num(x.num) ?? i, x.epg_channel_id || null, x.container_extension || null,
          num(x.rating_5based ?? x.rating), num(x.added ?? x.last_modified), num(x.tv_archive_duration) ?? 0,
          x.is_adult ? 1 : 0, sep,
        );
      }
      db.prepare(`UPDATE categories SET count = (SELECT count(*) FROM items i WHERE i.kind = categories.kind AND i.cat = categories.id AND i.sep = 0),
        adult = EXISTS (SELECT 1 FROM items i WHERE i.kind = categories.kind AND i.cat = categories.id AND i.adult = 1)
        WHERE kind = ?`).run(k.kind);
      assignRegions(k.kind);
      if (k.kind === 'live') assignFamilies();
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
  const body = await getStream(epgUrl || xmltvUrl(provider));
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
