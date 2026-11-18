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
  `);
  // migrations for databases created by earlier versions
  const cols = (db.prepare(`PRAGMA table_info(categories)`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('adult')) db.exec('ALTER TABLE categories ADD COLUMN adult INTEGER NOT NULL DEFAULT 0');
  return db;
}

export function kvGet(db: DatabaseSync, k: string): string | null {
  const r = db.prepare('SELECT v FROM kv WHERE k = ?').get(k) as { v: string } | undefined;
  return r?.v ?? null;
}
export function kvSet(db: DatabaseSync, k: string, v: string) {
  db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
}
