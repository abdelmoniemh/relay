// What people did: favourite channels/titles and how far they watched. The only module that touches those tables.
import type { DatabaseSync } from 'node:sqlite';
import type { Item, Progress } from '../../shared/protocol.ts';
import { FINISHED, MIN_RESUME_S, isFinished } from '../../shared/domain.ts';

export class UserData {
  private db: DatabaseSync;
  private st: Record<string, ReturnType<DatabaseSync['prepare']>>;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.st = {
      favs: db.prepare('SELECT json FROM favorites ORDER BY added DESC'),
      favPut: db.prepare('INSERT OR REPLACE INTO favorites (item, json, added) VALUES (?, ?, ?)'),
      favDel: db.prepare('DELETE FROM favorites WHERE item = ?'),
      save: db.prepare(`INSERT INTO progress (item, json, position, duration, updated, series) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(item) DO UPDATE SET json = excluded.json, position = excluded.position, duration = excluded.duration, updated = excluded.updated`),
      one: db.prepare('SELECT position, duration FROM progress WHERE item = ?'),
      // Latest unfinished movie/episode, one row per series.
      continue: db.prepare(`SELECT json, position, duration, updated FROM progress p
        WHERE json->>'kind' IN ('movie','episode') AND duration > 0 AND position > ${MIN_RESUME_S} AND position < duration * ${FINISHED}
          AND (series IS NULL OR updated = (SELECT max(updated) FROM progress q WHERE q.series = p.series))
        ORDER BY updated DESC LIMIT 30`),
      recent: db.prepare(`SELECT json FROM progress WHERE json->>'kind' = 'live' ORDER BY updated DESC LIMIT 20`),
    };
  }

  favorites(): Item[] { return (this.st.favs.all() as { json: string }[]).map((r) => JSON.parse(r.json)); }
  addFavorite(item: Item) { this.st.favPut.run(item.id, JSON.stringify(item), Date.now()); }
  removeFavorite(id: string) { this.st.favDel.run(id); }

  // ---- watching ----
  saveProgress(item: Item, position: number, duration: number) {
    this.st.save.run(item.id, JSON.stringify(item), position, duration, Date.now(), item.seriesId ?? null);
  }
  /** Where to resume: the saved position, unless it was watched to the end. */
  resumePosition(id: string): number {
    const r = this.st.one.get(id) as { position: number; duration: number } | undefined;
    return r && r.duration > 0 && !isFinished(r.position, r.duration) ? r.position : 0;
  }
  continueWatching(): Progress[] {
    return (this.st.continue.all() as any[]).map((r) => ({ item: JSON.parse(r.json), position: r.position, duration: r.duration, updated: r.updated }));
  }
  /** Unfinished movies or episodes, newest first. */
  unfinished(kind: 'movie' | 'episode', limit = 60): Progress[] {
    return (this.db.prepare(`SELECT json, position, duration, updated FROM progress
      WHERE json->>'kind' = ? AND duration > 0 AND position > ${MIN_RESUME_S} AND position < duration * ${FINISHED} ORDER BY updated DESC LIMIT ?`)
      .all(kind, limit) as any[]).map((r) => ({ item: JSON.parse(r.json), position: r.position, duration: r.duration, updated: r.updated }));
  }
  recentChannels(): Item[] { return (this.st.recent.all() as { json: string }[]).map((r) => JSON.parse(r.json)); }
  /** [position, duration] per item id. */
  progressOf(ids: string[]): Record<string, [number, number]> {
    if (!ids.length) return {};
    const rows = this.db.prepare(`SELECT item, position, duration FROM progress WHERE item IN (${ids.map(() => '?').join(',')})`).all(...ids) as any[];
    return Object.fromEntries(rows.map((r) => [r.item, [r.position, r.duration]]));
  }
}
