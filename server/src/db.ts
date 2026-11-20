import { DatabaseSync } from 'node:sqlite';

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 10000;
    PRAGMA temp_store = MEMORY;
    PRAGMA mmap_size = 268435456;
    PRAGMA cache_size = -65536;

    CREATE TABLE IF NOT EXISTS categories (
      kind TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, sort INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 0, adult INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (kind, id)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS items (
      rid INTEGER PRIMARY KEY,
      kind TEXT NOT NULL,            -- live | movie | series
      sid INTEGER NOT NULL,          -- provider stream/series id
      name TEXT NOT NULL,
      icon TEXT, cat TEXT, sort INTEGER NOT NULL,
      epg TEXT, ext TEXT, rating REAL, added INTEGER,
      archive INTEGER NOT NULL DEFAULT 0, adult INTEGER NOT NULL DEFAULT 0, sep INTEGER NOT NULL DEFAULT 0,
      UNIQUE (kind, sid)
    );
    CREATE INDEX IF NOT EXISTS items_cat ON items (kind, cat, sort);
    CREATE INDEX IF NOT EXISTS items_added ON items (kind, added DESC);
    CREATE INDEX IF NOT EXISTS items_sort ON items (kind, sep, adult, sort);
    CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5 (
      name, content='items', content_rowid='rid', tokenize='unicode61 remove_diacritics 2'
    );

    CREATE TABLE IF NOT EXISTS epg (
      ch TEXT NOT NULL, start INTEGER NOT NULL, stop INTEGER NOT NULL, title TEXT NOT NULL, descr TEXT,
      PRIMARY KEY (ch, start)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS series_cache (sid INTEGER PRIMARY KEY, json TEXT NOT NULL, fetched INTEGER NOT NULL);

    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, name TEXT NOT NULL, kind TEXT NOT NULL,
      created INTEGER NOT NULL, last_seen INTEGER
    );
    CREATE TABLE IF NOT EXISTS favorites (item TEXT PRIMARY KEY, json TEXT NOT NULL, added INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS progress (
      item TEXT PRIMARY KEY, json TEXT NOT NULL, position REAL NOT NULL, duration REAL NOT NULL,
      updated INTEGER NOT NULL, series TEXT
    );
    CREATE INDEX IF NOT EXISTS progress_updated ON progress (updated DESC);
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);

    -- One row per film/show; provider copies (items) point here via items.tid. Rows persist across syncs
    -- (stable ids, TMDB metadata kept); titles whose copies all disappeared are removed.
    CREATE TABLE IF NOT EXISTS titles (
      tid INTEGER PRIMARY KEY, kind TEXT NOT NULL, tkey TEXT NOT NULL UNIQUE, tmdb INTEGER,
      name TEXT NOT NULL, year INTEGER, poster TEXT, backdrop TEXT, rating REAL, added INTEGER,
      lmask INTEGER NOT NULL DEFAULT 0, uhd INTEGER NOT NULL DEFAULT 0, nver INTEGER NOT NULL DEFAULT 0, top250 INTEGER, seen INTEGER,
      genres TEXT, plot TEXT, cast TEXT, director TEXT, trailer TEXT, runtime INTEGER,
      popularity REAL, votes INTEGER, orig_lang TEXT, collection INTEGER, meta_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS titles_added ON titles (kind, added DESC);
    CREATE INDEX IF NOT EXISTS titles_rating ON titles (kind, rating DESC);
    CREATE INDEX IF NOT EXISTS titles_pop ON titles (kind, popularity DESC);
    CREATE INDEX IF NOT EXISTS titles_tmdb ON titles (kind, tmdb);
    CREATE INDEX IF NOT EXISTS titles_year ON titles (kind, year);
    CREATE VIRTUAL TABLE IF NOT EXISTS titles_fts USING fts5 (name, content='titles', content_rowid='tid', tokenize='unicode61 remove_diacritics 2');
    CREATE TABLE IF NOT EXISTS tmdb_cache (k TEXT PRIMARY KEY, json TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS vod_probes (
      id TEXT PRIMARY KEY, at INTEGER NOT NULL, ok INTEGER NOT NULL, width INTEGER, height INTEGER, hdr TEXT,
      vcodec TEXT, acodec TEXT, channels INTEGER, alangs TEXT, slangs TEXT, err TEXT
    );

    -- Measured stream quality (one row per live stream, latest probe wins).
    CREATE TABLE IF NOT EXISTS probes (
      sid INTEGER PRIMARY KEY, at INTEGER NOT NULL, ok INTEGER NOT NULL,
      width INTEGER, height INTEGER, fps REAL, vcodec TEXT, acodec TEXT, kbps INTEGER,
      ttfb_ms INTEGER, backlog_s REAL, err TEXT
    );
  `);
  // migrations for databases created by earlier versions
  const cols = (db.prepare(`PRAGMA table_info(categories)`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('adult')) db.exec('ALTER TABLE categories ADD COLUMN adult INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('region')) db.exec('ALTER TABLE categories ADD COLUMN region TEXT');
  const icols = (db.prepare(`PRAGMA table_info(items)`).all() as { name: string }[]).map((c) => c.name);
  if (!icols.includes('region')) db.exec('ALTER TABLE items ADD COLUMN region TEXT');
  if (!icols.includes('fam')) db.exec('ALTER TABLE items ADD COLUMN fam INTEGER');
  for (const [c, t] of [['tmdb', 'INTEGER'], ['meta', 'TEXT'], ['lang', 'TEXT'], ['vq', 'TEXT'], ['vsrc', 'TEXT'], ['tid', 'INTEGER']] as const) {
    if (!icols.includes(c)) db.exec(`ALTER TABLE items ADD COLUMN ${c} ${t}`);
  }
  db.exec('CREATE INDEX IF NOT EXISTS items_tid ON items (tid) WHERE tid IS NOT NULL');
  db.exec('CREATE INDEX IF NOT EXISTS items_fam ON items (fam) WHERE fam IS NOT NULL');
  db.exec('CREATE INDEX IF NOT EXISTS items_epg ON items (epg) WHERE epg IS NOT NULL');
  const pcols = (db.prepare(`PRAGMA table_info(probes)`).all() as { name: string }[]).map((c) => c.name);
  for (const [c, t] of [['interlaced', 'INTEGER'], ['bitdepth', 'INTEGER'], ['hdr', 'TEXT'], ['channels', 'INTEGER']] as const) {
    if (!pcols.includes(c)) db.exec(`ALTER TABLE probes ADD COLUMN ${c} ${t}`);
  }
  return db;
}

export function kvGet(db: DatabaseSync, k: string): string | null {
  const r = db.prepare('SELECT v FROM kv WHERE k = ?').get(k) as { v: string } | undefined;
  return r?.v ?? null;
}
export function kvSet(db: DatabaseSync, k: string, v: string) {
  db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
}

/** When a part of the catalog was last synced (ms): written by the sync worker, read by the scheduler and the catalog. */
export type SyncPart = 'catalog' | 'live' | 'epg';
export const syncedAt = (db: DatabaseSync, part: SyncPart) => Number(kvGet(db, `${part}_synced`) ?? 0);
export const markSynced = (db: DatabaseSync, part: SyncPart) => kvSet(db, `${part}_synced`, String(Date.now()));
