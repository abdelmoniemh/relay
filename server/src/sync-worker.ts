// Runs in a worker thread: pulls the full catalog + EPG from the provider into SQLite
// without blocking the API / WebSocket event loop. WAL keeps readers on the old snapshot until commit.
import { parentPort, workerData } from 'node:worker_threads';
import { openDb, kvSet } from './db.ts';
import { apiUrl, getJson, getStream, xmltvUrl } from './xtream.ts';
import { parseXmltv } from './epg.ts';
import type { Provider } from './config.ts';

const { dbPath, provider, epgUrl, what } = workerData as {
  dbPath: string; provider: Provider; epgUrl: string | null; what: Array<'catalog' | 'epg'>;
};
const db = openDb(dbPath);
const log = (msg: string) => parentPort?.postMessage({ log: msg });

const KINDS = [
  { kind: 'live', cats: 'get_live_categories', items: 'get_live_streams', id: 'stream_id', icon: 'stream_icon' },
  { kind: 'movie', cats: 'get_vod_categories', items: 'get_vod_streams', id: 'stream_id', icon: 'stream_icon' },
  { kind: 'series', cats: 'get_series_categories', items: 'get_series', id: 'series_id', icon: 'cover' },
] as const;

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

async function syncCatalog() {
  const insCat = db.prepare('INSERT INTO categories (kind, id, name, sort, count) VALUES (?, ?, ?, ?, 0)');
  const ins = db.prepare(`INSERT OR IGNORE INTO items (kind, sid, name, icon, cat, sort, epg, ext, rating, added, archive, adult, sep)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  // Download all catalogs concurrently (network-bound), import sequentially (CPU/disk-bound).
  const t0 = performance.now();
  const downloads = KINDS.map((k) => Promise.all([getJson<any[]>(apiUrl(provider, k.cats)), getJson<any[]>(apiUrl(provider, k.items))]));
  downloads.forEach((d) => d.catch(() => {}));
  for (let ki = 0; ki < KINDS.length; ki++) {
    const k = KINDS[ki];
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
        const sep = /^[#=*\-_ ]{3,}.*[#=*\-_ ]{3,}$/.test(name) ? 1 : 0; // provider "##### 4K #####" dividers
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
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    log(`${k.kind}: ${items.length} items, ${cats.length} categories (ready after ${((t1 - t0) / 1000).toFixed(1)}s, import ${((performance.now() - t1) / 1000).toFixed(1)}s)`);
  }
  const t = performance.now();
  db.exec(`INSERT INTO items_fts(items_fts) VALUES ('rebuild')`);
  db.exec('PRAGMA optimize');
  log(`search index rebuilt in ${((performance.now() - t) / 1000).toFixed(1)}s`);
  kvSet(db, 'catalog_synced', String(Date.now()));
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
      from: now - 12 * 3600, to: now + 3 * 86400, keep: used.size ? (ch) => used.has(ch) : undefined,
    });
    db.exec('COMMIT');
    log(`epg: ${n} programmes for ${used.size} channels in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  kvSet(db, 'epg_synced', String(Date.now()));
}

try {
  if (what.includes('catalog')) await syncCatalog();
  if (what.includes('epg')) await syncEpg();
  parentPort?.postMessage({ done: true });
} catch (e) {
  parentPort?.postMessage({ error: (e as Error).message });
} finally {
  db.close();
}
