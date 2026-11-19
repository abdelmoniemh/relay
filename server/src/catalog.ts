import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { Category, Item, Kind, Programme } from '../../shared/protocol.ts';

const PREFIX: Record<string, string> = { live: 'l', movie: 'm', series: 's', episode: 'e' };
const KIND_OF: Record<string, Kind> = { l: 'live', m: 'movie', s: 'series', e: 'episode' };

export const itemId = (kind: Kind, sid: number | string) => PREFIX[kind] + sid;
export const parseId = (id: string) => ({ kind: KIND_OF[id[0]], sid: Number(id.slice(1)) });

interface Row { kind: Kind; sid: number; name: string; icon: string | null; cat: string | null; epg: string | null; ext: string | null; rating: number | null; archive: number }

const COLS = 'kind, sid, name, icon, cat, epg, ext, rating, archive';

export function toItem(r: Row): Item {
  const it: Item = { id: itemId(r.kind, r.sid), kind: r.kind, name: r.name, icon: r.icon, cat: r.cat };
  if (r.kind === 'live') { if (r.epg) it.epg = r.epg; if (r.archive) it.archive = r.archive; }
  else { if (r.ext) it.ext = r.ext; if (r.rating) it.rating = r.rating; }
  return it;
}

export type Sort = 'default' | 'added' | 'name' | 'rating';
const ORDER: Record<Sort, string> = { default: 'sort', added: 'added DESC', name: 'name COLLATE NOCASE', rating: 'rating DESC NULLS LAST' };

/** All catalog reads go through prepared statements cached here. */
export class Catalog {
  private db: DatabaseSync;
  private stmts = new Map<string, StatementSync>();
  showAdult = false;
  version = '0';
  /** Live TV regions to show (category prefixes like UK, US, CA, AR). Empty = everything. */
  regions: string[] = [];

  constructor(db: DatabaseSync) { this.db = db; }

  private st(sql: string) {
    let s = this.stmts.get(sql);
    if (!s) this.stmts.set(sql, (s = this.db.prepare(sql)));
    return s;
  }

  private adult(alias = '') { return this.showAdult ? '' : ` AND ${alias}adult = 0`; }
  /** SQL fragment restricting live rows to the chosen regions (values are sanitized, so they can be inlined). */
  regionSql(kind: Kind | null, alias = '') {
    if (!this.regions.length || (kind && kind !== 'live')) return '';
    const list = this.regions.map((r) => `'${r.replace(/[^A-Z0-9]/g, '')}'`).join(',');
    return kind ? ` AND ${alias}region IN (${list})` : ` AND (${alias}kind != 'live' OR ${alias}region IN (${list}))`;
  }

  categories(kind: Kind): Category[] {
    return this.st(`SELECT id, name, count FROM categories WHERE kind = ? AND count > 0${this.adult()}${this.regionSql(kind)} ORDER BY sort`).all(kind) as unknown as Category[];
  }

  items(kind: Kind, cat: string | null, sort: Sort, offset: number, limit: number): { items: Item[]; total: number } {
    const where = `kind = ? AND sep = 0${cat ? ' AND cat = ?' : ''}${this.adult()}${this.regionSql(kind)}`;
    const args: (string | number)[] = cat ? [kind, cat] : [kind];
    const rows = this.st(`SELECT ${COLS} FROM items WHERE ${where} ORDER BY ${ORDER[sort] ?? 'sort'} LIMIT ? OFFSET ?`).all(...args, limit, offset) as unknown as Row[];
    const total = offset === 0 && rows.length < limit ? rows.length
      : (this.st(`SELECT count(*) AS n FROM items WHERE ${where}`).get(...args) as { n: number }).n;
    return { items: rows.map(toItem), total };
  }

  get(id: string): Item | null {
    const { kind, sid } = parseId(id);
    if (!kind || kind === 'episode') return null;
    const r = this.st(`SELECT ${COLS} FROM items WHERE kind = ? AND sid = ?`).get(kind, sid) as Row | undefined;
    return r ? toItem(r) : null;
  }

  /** Channel +/-: next/previous live channel within the same category, wrapping. */
  neighbor(id: string, dir: 1 | -1): Item | null {
    const cur = this.get(id);
    if (!cur || cur.kind !== 'live') return null;
    const s = (this.st(`SELECT sort FROM items WHERE kind='live' AND sid = ?`).get(parseId(id).sid) as { sort: number }).sort;
    const cmp = dir > 0 ? '>' : '<', ord = dir > 0 ? 'ASC' : 'DESC';
    const base = `SELECT ${COLS} FROM items WHERE kind='live' AND cat = ? AND sep = 0${this.adult()}`;
    const r = (this.st(`${base} AND sort ${cmp} ? ORDER BY sort ${ord} LIMIT 1`).get(cur.cat ?? null, s)
      ?? this.st(`${base} ORDER BY sort ${ord} LIMIT 1`).get(cur.cat ?? null)) as Row | undefined;
    return r ? toItem(r) : null;
  }

  search(q: string, kind: Kind | null, limit: number): Item[] {
    const terms = q.normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
    if (!terms.length || terms.join('').length < 2) return [];
    const match = terms.map((t) => `"${t}"*`).join(' ');
    const sql = `SELECT ${COLS.split(', ').map((c) => 'i.' + c).join(', ')} FROM items_fts f JOIN items i ON i.rid = f.rowid
      WHERE items_fts MATCH ? AND i.sep = 0${kind ? ' AND i.kind = ?' : ''}${this.adult('i.')}${this.regionSql(kind, 'i.')} ORDER BY rank LIMIT ?`;
    const rows = (kind ? this.st(sql).all(match, kind, limit) : this.st(sql).all(match, limit)) as unknown as Row[];
    return rows.map(toItem);
  }

  /** Now + next programme for many channels in one query. */
  nowNext(chs: string[], now = Math.floor(Date.now() / 1000)): Record<string, Programme[]> {
    const out: Record<string, Programme[]> = {};
    const q = this.st(`SELECT start, stop, title, descr AS desc FROM epg WHERE ch = ? AND stop > ? ORDER BY start LIMIT 2`);
    for (const ch of chs) out[ch] = q.all(ch, now) as unknown as Programme[];
    return out;
  }

  guide(chs: string[], from: number, to: number): Record<string, Programme[]> {
    const out: Record<string, Programme[]> = {};
    const q = this.st(`SELECT start, stop, title, descr AS desc FROM epg WHERE ch = ? AND stop > ? AND start < ? ORDER BY start`);
    for (const ch of chs) out[ch] = q.all(ch, from, to) as unknown as Programme[];
    return out;
  }

  private countsCache: { v: string; c: Record<string, number> } | null = null;
  regionList(): { code: string; channels: number }[] {
    return this.st(`SELECT region AS code, count(*) AS channels FROM items WHERE kind = 'live' AND sep = 0 AND region IS NOT NULL GROUP BY region ORDER BY channels DESC`).all() as any;
  }

  /** All copies of a live channel (same family), for switching sources. */
  family(id: string): { item: Item; fam: number }[] {
    const { sid } = parseId(id);
    const r = this.st(`SELECT fam FROM items WHERE kind = 'live' AND sid = ?`).get(sid) as { fam: number | null } | undefined;
    if (!r?.fam) { const it = this.get(id); return it ? [{ item: it, fam: -sid }] : []; }
    const rows = this.st(`SELECT ${COLS}, fam FROM items WHERE kind = 'live' AND fam = ? AND sep = 0${this.adult()}${this.regionSql('live')} LIMIT 100`).all(r.fam) as unknown as (Row & { fam: number })[];
    return rows.map((x) => ({ item: toItem(x), fam: x.fam }));
  }

  counts() {
    if (this.countsCache?.v === this.version) return this.countsCache.c;
    const c = Object.fromEntries((this.st(`SELECT kind, count(*) AS n FROM items WHERE sep = 0 GROUP BY kind`).all() as { kind: string; n: number }[]).map((r) => [r.kind, r.n]));
    this.countsCache = { v: this.version, c };
    return c;
  }
}
