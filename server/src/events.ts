// Builds a list of sports events (live + upcoming) from two signals:
//  1. EPG programmes on sports channels ("Valencia vs Real Madrid - Spanish LaLiga") -> every copy of that channel
//  2. Event channels whose *name* is the fixture ("Live Football 04 : Portugal vs Denmark 19:45 pm")
// Fixtures are merged across channels by team identity; later airings of the same fixture are treated as replays.
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Item } from '../../shared/protocol.ts';
import { EURO_FOOTBALL, implausibleKickoff, matchKey, parseMatch, sportOf, zonedToUnix } from './normalize.ts';
import { toItem, type Catalog } from './catalog.ts';
import { claimed, rankSources, type Probe } from './quality.ts';
import type * as Shared from '../../shared/protocol.ts';
import type { Sport } from '../../shared/protocol.ts';

/** An event as the index builds it (the API adds the source count). */
export type SportEvent = Omit<Shared.SportEvent, 'sourceCount'>;

interface Row { sid: number; name: string; icon: string | null; cat: string | null; epg: string | null; ext: string | null; rating: number | null; archive: number; fam: number | null; region: string | null; catname: string | null }
interface Airing { implausible?: boolean; key: string; home: string; away: string; competition: string | null; sport: Sport; start: number | null; stop: number | null; live: boolean; famIds: Set<number>; sids: Set<number> }

const FOOTBALL_MINUTES = 135;
const SPORTY_CAT = /SPORT|PPV|EVENT|FOOTBALL|SOCCER|LEAGUE|BEIN|DAZN|TNT|SKY|ESPN|TSN|FOX|NBC|CBS|PEACOCK|FUBO|THMANYAH|SHAHID|STARZPLAY|ALKASS|SSC|ABU DHABI|UEFA|EPL|NFL|NBA|NHL|MLB|UFC|F1|GOLF|TENNIS|CRICKET|RUGBY|BOXING|⚽/i;

/** Event channels are named in the local time of the service that lists them. */
function zoneFor(name: string, region: string | null, catname: string | null): string {
  if (/^AU\s*\(/.test(name)) return 'Australia/Sydney';
  if (EURO_FOOTBALL.test(`${name} ${catname ?? ''}`) || /\b(EPL|UEFA)\b/i.test(`${name} ${catname ?? ''}`)) return 'Europe/London';
  switch (region) {
    case 'US': return 'America/New_York';
    case 'CA': return 'America/Toronto';
    case 'AR': return 'Asia/Riyadh';
    default: return 'Europe/London';
  }
}

export class EventsIndex {
  private db: DatabaseSync;
  private cache: { key: string; at: number; events: SportEvent[] } | null = null;

  private catalog: Catalog;

  constructor(db: DatabaseSync, catalog: Catalog) { this.db = db; this.catalog = catalog; }

  invalidate() { this.cache = null; }

  private build(now: number): SportEvent[] {
    const db = this.db;
    const rows = db.prepare(`SELECT i.sid, i.name, i.icon, i.cat, i.epg, i.ext, i.rating, i.archive, i.fam, i.region, c.name AS catname
      FROM items i LEFT JOIN categories c ON c.kind = 'live' AND c.id = i.cat
      WHERE i.kind = 'live' AND i.sep = 0${this.catalog.regionSql('live', 'i.')}`).all() as unknown as Row[];

    // family -> members, family -> dominant EPG id (majority vote; providers mislabel single copies)
    const fams = new Map<number, Row[]>();
    for (const r of rows) {
      const f = r.fam ?? -r.sid;
      let a = fams.get(f);
      if (!a) fams.set(f, (a = []));
      a.push(r);
    }
    const famsByEpg = new Map<string, number[]>();
    for (const [f, members] of fams) {
      if (!members.some((m) => m.catname && SPORTY_CAT.test(m.catname))) continue;
      const votes = new Map<string, number>();
      for (const m of members) if (m.epg) { const e = m.epg.toLowerCase(); votes.set(e, (votes.get(e) ?? 0) + 1); }
      let best: string | null = null, n = 0;
      for (const [e, c] of votes) if (c > n) { best = e; n = c; }
      if (best) { let l = famsByEpg.get(best); if (!l) famsByEpg.set(best, (l = [])); l.push(f); }
    }

    const airings: Airing[] = [];
    // 1) EPG
    const progs = db.prepare(`SELECT ch, start, stop, title, descr FROM epg
      WHERE start > ? AND start < ? AND stop > ? AND (title LIKE '% v %' OR title LIKE '% vs%' OR title LIKE '% v. %' OR descr LIKE '% v %' OR descr LIKE '% vs %')`)
      
      .all(now - 36 * 3600, now + 36 * 3600, now - 36 * 3600) as { ch: string; start: number; stop: number; title: string; descr: string | null }[];
    for (const p of progs) {
      const famIds = famsByEpg.get(p.ch.toLowerCase());
      if (!famIds) continue;
      const m = parseMatch(p.title) ?? (/(live|football|soccer)/i.test(p.title) && p.descr ? parseMatch(p.descr.split(/[.!]/)[0]) : null);
      if (!m || m.replay) continue;
      const implausible = !m.live && implausibleKickoff(m.competition, p.title, p.start); // e.g. 03:00 UK "kickoff"
      const catNames = famIds.flatMap((f) => fams.get(f)!.map((x) => x.catname ?? '')).slice(0, 5).join(' ');
      airings.push({
        key: matchKey(m), home: m.home, away: m.away, competition: m.competition,
        sport: sportOf(m.competition, p.title, p.descr, catNames), start: p.start, stop: p.stop, live: m.live,
        famIds: new Set(famIds), sids: new Set(), implausible,
      });
    }
    // 2) Event channels named after the fixture
    for (const r of rows) {
      if (!/\sv(s|\.)?\s/i.test(r.name)) continue;
      const m = parseMatch(r.name);
      if (!m || m.replay) continue;
      const tz = m.when?.tz ?? zoneFor(r.name, r.region, r.catname);
      let start = m.when ? zonedToUnix(m.when, tz, now) : null;
      // Time-only listings are for the provider's current day: after midnight they still describe yesterday.
      if (start != null && m.when && m.when.day == null) {
        const localHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(new Date(now * 1000)));
        if (localHour < 7 && start > now + 6 * 3600) start -= 86400;
      }
      if (start != null && (start < now - 4 * 3600 || start > now + 7 * 86400)) continue;
      airings.push({
        key: matchKey(m), home: m.home, away: m.away, competition: m.competition ?? cleanCat(r.catname),
        sport: sportOf(m.competition, r.catname, r.name), start, stop: start ? start + FOOTBALL_MINUTES * 60 : null, live: false,
        famIds: new Set(), sids: new Set([r.sid]),
      });
    }

    // Merge airings of the same fixture. The earliest airing is the real one; airings that start well after it are replays.
    const byKey = new Map<string, Airing[]>();
    for (const a of airings) { let l = byKey.get(a.key); if (!l) byKey.set(a.key, (l = [])); l.push(a); }
    const rowBySid = new Map(rows.map((r) => [r.sid, r]));
    const events: SportEvent[] = [];
    for (const [key, list] of byKey) {
      const timed = list.filter((a) => a.start != null).sort((a, b) => a.start! - b.start!);
      // Earliest airing at an impossible kickoff time => the match was played earlier; everything here is a replay.
      if (timed[0]?.implausible && !list.some((a) => a.sids.size)) continue;
      const first = timed.find((a) => !a.implausible)?.start ?? null;
      const main = list.filter((a) => !a.implausible && (a.start == null || first == null || a.start - first < 100 * 60));
      if (!main.length) continue;
      const start = first;
      const stop = main.reduce<number | null>((s, a) => (a.stop != null && (s == null || a.stop > s) ? a.stop : s), null);
      if (stop != null && stop < now) continue;
      const sids = new Set<number>();
      for (const a of main) { a.sids.forEach((s) => sids.add(s)); a.famIds.forEach((f) => fams.get(f)?.forEach((m) => sids.add(m.sid))); }
      if (!sids.size) continue;
      const head = main.find((a) => a.competition) ?? main[0];
      const sport = main.find((a) => a.sport !== 'other')?.sport ?? 'other';
      const status: SportEvent['status'] = start == null ? 'unknown' : start - 15 * 60 <= now ? 'live' : 'upcoming';
      const items = [...sids].map((s) => rowBySid.get(s)!).filter(Boolean);
      events.push({
        id: createHash('sha1').update(key + ':' + (start ? Math.floor(start / 86400) : 'x')).digest('base64url').slice(0, 12),
        title: `${head.home} v ${head.away}`, home: head.home, away: head.away, competition: head.competition, sport,
        start, stop, status, sources: items.map((r) => ({ item: toItem({ ...r, kind: 'live' }), fam: r.fam ?? -r.sid })) as any,
      });
    }
    const rank = { live: 0, unknown: 1, upcoming: 2 } as const;
    events.sort((a, b) => rank[a.status] - rank[b.status] || (a.start ?? 0) - (b.start ?? 0));
    return events;
  }

  /** Sources worth checking in the background: events live or starting within 3 h, football first (25 per event). */
  soonSources(): string[] {
    const now = Math.floor(Date.now() / 1000);
    return this.built()
      .filter((e) => e.status === 'live' || (e.start != null && e.start - now < 3 * 3600))
      .sort((a, b) => (a.sport === 'football' ? 0 : 1) - (b.sport === 'football' ? 0 : 1))
      // the 25 most promising copies by name (best claimed picture first)
      .flatMap((e) => (e.sources as unknown as { item: Item }[]).map((s) => ({ id: s.item.id, c: claimed(s.item.name) }))
        .sort((a, b) => b.c.height - a.c.height || b.c.fps - a.c.fps).slice(0, 25).map((s) => s.id));
  }

  /** Cached for 60s; rankings applied per request (they depend on the device and fresh probes). */
  /** Events with their unranked sources, rebuilt after a minute or a catalog change. */
  private built(): SportEvent[] {
    const now = Math.floor(Date.now() / 1000);
    const key = this.catalog.version; // includes the regions
    if (!this.cache || this.cache.key !== key || now - this.cache.at > 60) this.cache = { key, at: now, events: this.build(now) };
    return this.cache.events;
  }

  list(probes: (ids: string[]) => Map<string, Probe>, opts: { hevcOk: boolean }): SportEvent[] {
    return this.built().map((e) => {
      const raw = e.sources as unknown as { item: Item; fam: number }[];
      const pm = probes(raw.map((s) => s.item.id));
      const sources = rankSources(raw, pm, opts);
      const offline = sources.length > 0 && sources.every((x) => x.dead);
      return { ...e, sources, offline };
    });
  }
}

const cleanCat = (c: string | null) => (c ? c.normalize('NFKC').replace(/^[A-Z0-9]{2,5}\s*[|:]\s*/, '').replace(/\b(PPV|VIP|RAW|HD|SD|UHD|4K|8K)\b/g, '').replace(/[^\p{L}\p{N} +&]/gu, ' ').replace(/\s+/g, ' ').trim() || null : null);
