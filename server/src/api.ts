import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { ClientMsg, DeviceKind, Item, Kind, Progress } from '../../shared/protocol.ts';
import { Catalog, itemId, parseId, type Sort } from './catalog.ts';
import type { Auth } from './auth.ts';
import type { Hub } from './hub.ts';
import type { Provider } from './config.ts';
import { apiUrl, getJson, streamUrls } from './xtream.ts';
import { kvGet, kvSet } from './db.ts';
import { isSyncing, runSync } from './sync.ts';
import type { Transcoder, HevcRegistry } from './transcode.ts';
import type { EventsIndex } from './events.ts';
import type { Prober } from './prober.ts';
import { rankSources } from './quality.ts';

declare module 'fastify' { interface FastifyRequest { deviceId: string } }

const KINDS = new Set<Kind>(['live', 'movie', 'series']);
const isLocal = (ip: string) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
const clamp = (v: unknown, lo: number, hi: number, d: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.floor(n))) : d; };

export function registerApi(app: FastifyInstance, ctx: { db: DatabaseSync; catalog: Catalog; auth: Auth; hub: Hub; provider: Provider; transcoder: Transcoder; hevc: HevcRegistry; events: EventsIndex; prober: Prober }) {
  const { db, catalog, auth, hub, provider, transcoder, hevc, events, prober } = ctx;
  const refreshVersion = () => { catalog.version = `${kvGet(db, 'catalog_synced') ?? 0}.${kvGet(db, 'live_synced') ?? 0}.${kvGet(db, 'epg_synced') ?? 0}.${catalog.showAdult ? 1 : 0}.${catalog.regions.join('')}`; events.invalidate(); };
  catalog.showAdult = kvGet(db, 'show_adult') === '1';
  catalog.regions = JSON.parse(kvGet(db, 'regions') ?? '["UK","US","CA","AR","4K"]');
  refreshVersion();

  // ---- auth ----
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/') || req.url.startsWith('/api/pair') || req.url.startsWith('/api/ping')) return;
    const h = req.headers.authorization;
    const token = h?.startsWith('Bearer ') ? h.slice(7) : (req.query as any)?.token;
    const id = auth.verify(token);
    if (!id) return reply.code(401).send({ error: 'unpaired' });
    req.deviceId = id;
  });

  /** Catalog responses are immutable until the next sync: let clients revalidate cheaply with 304s. */
  const cached = (req: FastifyRequest, reply: FastifyReply) => {
    const etag = `W/"${catalog.version}"`;
    reply.header('etag', etag).header('cache-control', 'private, no-cache');
    if (req.headers['if-none-match'] === etag) { reply.code(304).send(); return true; }
    return false;
  };

  app.get('/api/ping', async () => ({ ok: true, name: 'relay' }));

  app.post('/api/pair', async (req, reply) => {
    const b = (req.body ?? {}) as { code?: string; name?: string; kind?: DeviceKind };
    const kind: DeviceKind = b.kind === 'tv' || b.kind === 'phone' ? b.kind : 'desktop';
    const r = auth.pair(b.code?.trim(), b.name ?? kind, kind, isLocal(req.ip));
    if (!r) return reply.code(403).send({ error: 'Wrong or expired pairing code' });
    hub.broadcastState();
    return r;
  });

  app.get('/api/status', async () => ({
    syncing: isSyncing(), counts: catalog.counts(),
    catalogSynced: Number(kvGet(db, 'catalog_synced') ?? 0), epgSynced: Number(kvGet(db, 'epg_synced') ?? 0),
    showAdult: catalog.showAdult, pairingCode: auth.pairingCode(), regions: catalog.regions,
    probing: prober.active, probeQueue: prober.pending(), liveSynced: Number(kvGet(db, 'live_synced') ?? 0),
  }));

  app.post('/api/sync', async () => {
    runSync(provider, ['catalog', 'epg']).then(() => { refreshVersion(); }).catch((e) => app.log.error(e));
    return { started: true };
  });

  app.put('/api/settings', async (req) => {
    const b = req.body as { showAdult?: boolean; regions?: string[] };
    if (typeof b.showAdult === 'boolean') { catalog.showAdult = b.showAdult; kvSet(db, 'show_adult', b.showAdult ? '1' : '0'); }
    if (Array.isArray(b.regions)) { catalog.regions = b.regions.map((r) => String(r).toUpperCase().replace(/[^A-Z0-9]/g, '')).filter(Boolean).slice(0, 50); kvSet(db, 'regions', JSON.stringify(catalog.regions)); }
    refreshVersion();
    return { ok: true };
  });

  // ---- catalog ----
  app.get('/api/categories/:kind', async (req, reply) => {
    const kind = (req.params as any).kind as Kind;
    if (!KINDS.has(kind)) return reply.code(400).send({ error: 'bad kind' });
    if (cached(req, reply)) return;
    return catalog.categories(kind);
  });

  app.get('/api/items/:kind', async (req, reply) => {
    const kind = (req.params as any).kind as Kind;
    if (!KINDS.has(kind)) return reply.code(400).send({ error: 'bad kind' });
    if (cached(req, reply)) return;
    const q = req.query as Record<string, string>;
    return catalog.items(kind, q.cat || null, (q.sort as Sort) || 'default', clamp(q.offset, 0, 1e7, 0), clamp(q.limit, 1, 500, 100));
  });

  app.get('/api/item/:id', async (req, reply) => catalog.get((req.params as any).id) ?? reply.code(404).send({ error: 'not found' }));

  app.get('/api/neighbor/:id', async (req, reply) => {
    const dir = (req.query as any).dir === 'prev' ? -1 : 1;
    return catalog.neighbor((req.params as any).id, dir) ?? reply.code(404).send({ error: 'none' });
  });

  app.get('/api/search', async (req, reply) => {
    if (cached(req, reply)) return;
    const q = req.query as Record<string, string>;
    const kind = KINDS.has(q.kind as Kind) ? (q.kind as Kind) : null;
    return catalog.search(String(q.q ?? '').slice(0, 100), kind, clamp(q.limit, 1, 200, 60));
  });

  app.get('/api/epg/now', async (req) => {
    const chs = String((req.query as any).ch ?? '').split(',').filter(Boolean).slice(0, 300);
    return catalog.nowNext(chs);
  });

  app.get('/api/epg/guide', async (req) => {
    const q = req.query as Record<string, string>;
    const now = Math.floor(Date.now() / 1000);
    const from = clamp(q.from, 0, 1e10, now - 3600), to = clamp(q.to, 0, 1e10, now + 4 * 3600);
    return catalog.guide(String(q.ch ?? '').split(',').filter(Boolean).slice(0, 200), from, Math.min(to, from + 2 * 86400));
  });

  // Movie details (plot, duration, backdrop) — fetched lazily from the provider, memoized.
  const vodInfo = new Map<number, { at: number; v: any }>();
  app.get('/api/movie/:id', async (req, reply) => {
    const { kind, sid } = parseId((req.params as any).id);
    if (kind !== 'movie') return reply.code(400).send({ error: 'bad id' });
    const hit = vodInfo.get(sid);
    if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.v;
    const r = await getJson<any>(apiUrl(provider, 'get_vod_info', { vod_id: String(sid) }), 15_000);
    const i = r?.info ?? {};
    const v = {
      plot: i.plot || i.description || null, genre: i.genre || null, year: i.releasedate?.slice(0, 4) || i.year || null,
      duration: Number(i.duration_secs) || null, backdrop: i.backdrop_path?.[0] || null, cast: i.cast || null,
      director: i.director || null, rating: Number(i.rating) || null, trailer: i.youtube_trailer || null,
    };
    if (vodInfo.size > 2000) vodInfo.clear();
    vodInfo.set(sid, { at: Date.now(), v });
    return v;
  });

  // Series → seasons → episodes. Cached in SQLite for 6h.
  const seriesSt = { get: db.prepare('SELECT json, fetched FROM series_cache WHERE sid = ?'), put: db.prepare('INSERT OR REPLACE INTO series_cache (sid, json, fetched) VALUES (?, ?, ?)') };
  app.get('/api/series/:id', async (req, reply) => {
    const { kind, sid } = parseId((req.params as any).id);
    if (kind !== 'series') return reply.code(400).send({ error: 'bad id' });
    const hit = seriesSt.get.get(sid) as { json: string; fetched: number } | undefined;
    if (hit && Date.now() - hit.fetched < 6 * 3600_000) return reply.type('application/json').send(hit.json);
    const r = await getJson<any>(apiUrl(provider, 'get_series_info', { series_id: String(sid) }), 20_000);
    const parent = catalog.get(itemId('series', sid));
    const info = r?.info ?? {};
    const seasons = Object.entries<any[]>(r?.episodes ?? {})
      .map(([s, eps]) => ({
        season: Number(s),
        episodes: eps.map((e): Item & { plot?: string; duration?: number } => ({
          id: itemId('episode', e.id), kind: 'episode', name: e.title || `Episode ${e.episode_num}`,
          icon: e.info?.movie_image || null, ext: e.container_extension || 'mp4', seriesId: itemId('series', sid),
          season: Number(s), episode: Number(e.episode_num), plot: e.info?.plot || undefined,
          duration: Number(e.info?.duration_secs) || undefined,
        })).sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0)),
      }))
      .sort((a, b) => a.season - b.season);
    const out = {
      id: itemId('series', sid), name: info.name || parent?.name || '', cover: info.cover || parent?.icon || null,
      backdrop: info.backdrop_path?.[0] || null, plot: info.plot || null, genre: info.genre || null,
      year: info.releaseDate?.slice(0, 4) || info.release_date?.slice(0, 4) || null, rating: Number(info.rating_5based) || parent?.rating || null,
      seasons,
    };
    const json = JSON.stringify(out);
    seriesSt.put.run(sid, json, Date.now());
    return reply.type('application/json').send(json);
  });

  app.get('/api/stream/:id', async (req) => {
    const id = (req.params as any).id as string;
    const { kind } = parseId(id);
    return { urls: streamUrls(provider, { id, kind, name: '', ext: (req.query as any).ext }) };
  });

  // HEVC -> H.264 stream for browsers without an HEVC decoder. Raw MPEG-TS, consumed by mpegts.js.
  app.get('/api/transcode/:id', async (req, reply) => {
    const id = String((req.params as any).id).replace(/\.ts$/, '');
    const q = req.query as Record<string, string>;
    const { kind } = parseId(id);
    if (!kind || kind === 'series') return reply.code(400).send({ error: 'bad id' });
    if (!transcoder.available) return reply.code(501).send({ error: 'ffmpeg is not installed on the server' });
    const mode = q.mode === 'audio' ? 'audio' : 'full';
    hevc.add(id, mode);
    const urls = streamUrls(provider, { id, kind, name: '', ext: q.ext });
    const src = kind === 'live' ? (urls.find((u) => u.endsWith('.ts')) ?? urls[0]) : urls[0];
    let started;
    try { started = await transcoder.start(src, Number(q.start) || 0, (m) => app.log.warn(m), req.deviceId, { vod: kind !== 'live', mode }); }
    catch (e) { return reply.code(502).send({ error: `Transcode failed: ${(e as Error).message}` }); }
    const { proc, first } = started;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'video/mp2t', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
    res.write(first);
    proc.stdout.pipe(res);
    const end = () => { if (transcoder.owns(proc)) transcoder.stop(); else if (proc.exitCode === null) proc.kill('SIGKILL'); };
    res.on('close', end);
    req.raw.socket?.once('close', end);
    proc.on('exit', () => res.end());
  });

  // ---- sports events & sources ----
  const hevcOk = (q: Record<string, string>) => q.hevc === '1';
  app.get('/api/regions', async () => ({ enabled: catalog.regions, all: catalog.regionList() }));
  app.get('/api/events', async (req) => {
    const q = req.query as Record<string, string>;
    let list = events.list(catalog.regions, catalog.version, (sids) => prober.results(sids), { hevcOk: hevcOk(q) });
    if (q.sport) list = list.filter((e) => e.sport === q.sport);
    if (q.q) { const t = q.q.toLowerCase(); list = list.filter((e) => `${e.title} ${e.competition ?? ''}`.toLowerCase().includes(t)); }
    return list.map((e) => ({ ...e, sourceCount: e.sources.length, sources: q.full ? e.sources : e.sources.slice(0, 3) }));
  });
  app.get('/api/events/:id', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const e = events.list(catalog.regions, catalog.version, (sids) => prober.results(sids), { hevcOk: hevcOk(q) }).find((x) => x.id === (req.params as any).id);
    if (!e) return reply.code(404).send({ error: 'Event not found (finished?)' });
    return { ...e, sourceCount: e.sources.length };
  });
  app.get('/api/family/:id', async (req) => {
    const fam = catalog.family((req.params as any).id);
    return rankSources(fam, prober.results(fam.map((f) => Number(f.item.id.slice(1)))), { hevcOk: hevcOk(req.query as any) });
  });
  /** Check these streams' real quality as soon as the connection is free. */
  app.post('/api/probe', async (req) => {
    const ids = ((req.body as any)?.ids ?? []) as string[];
    prober.request(ids.filter((i) => i.startsWith('l')).map((i) => Number(i.slice(1))).filter(Number.isFinite).slice(0, 60));
    return { queued: prober.pending(), active: prober.active, blocked: hub.streamActive() };
  });

  app.post('/api/observed', async (req) => {
    const b = req.body as { id?: string; width?: number; height?: number; fps?: number; vcodec?: string; kbps?: number };
    if (!b?.id?.startsWith('l') || !(Number(b.height) > 0)) return { ok: false };
    prober.observed(Number(b.id.slice(1)), { width: Number(b.width), height: Number(b.height), fps: b.fps ? Number(b.fps) : null, vcodec: b.vcodec ?? null, kbps: b.kbps ? Number(b.kbps) : null });
    return { ok: true };
  });

  app.get('/api/capabilities', async () => ({ transcode: transcoder.available, gpu: transcoder.gpu }));

  // ---- library: favorites / continue watching / recent channels ----
  app.get('/api/favorites', async () =>
    (db.prepare('SELECT json FROM favorites ORDER BY added DESC').all() as { json: string }[]).map((r) => JSON.parse(r.json) as Item));
  app.put('/api/favorites/:id', async (req) => {
    const it = req.body as Item;
    db.prepare('INSERT OR REPLACE INTO favorites (item, json, added) VALUES (?, ?, ?)').run((req.params as any).id, JSON.stringify(it), Date.now());
    return { ok: true };
  });
  app.delete('/api/favorites/:id', async (req) => {
    db.prepare('DELETE FROM favorites WHERE item = ?').run((req.params as any).id);
    return { ok: true };
  });

  app.get('/api/continue', async () => {
    // Latest unfinished movie/episode, one row per series.
    const rows = db.prepare(`SELECT json, position, duration, updated FROM progress p
      WHERE json->>'kind' IN ('movie','episode') AND duration > 0 AND position > 30 AND position < duration * 0.95
        AND (series IS NULL OR updated = (SELECT max(updated) FROM progress q WHERE q.series = p.series))
      ORDER BY updated DESC LIMIT 30`).all() as any[];
    return rows.map((r): Progress => ({ item: JSON.parse(r.json), position: r.position, duration: r.duration, updated: r.updated }));
  });
  app.get('/api/recent', async () =>
    (db.prepare(`SELECT json FROM progress WHERE json->>'kind' = 'live' ORDER BY updated DESC LIMIT 20`).all() as { json: string }[]).map((r) => JSON.parse(r.json) as Item));
  app.get('/api/progress', async (req) => {
    const ids = String((req.query as any).ids ?? '').split(',').filter(Boolean).slice(0, 500);
    if (!ids.length) return {};
    const rows = db.prepare(`SELECT item, position, duration FROM progress WHERE item IN (${ids.map(() => '?').join(',')})`).all(...ids) as any[];
    return Object.fromEntries(rows.map((r) => [r.item, [r.position, r.duration]]));
  });

  // ---- devices ----
  app.get('/api/devices', async () => auth.devices());
  app.put('/api/devices/:id', async (req) => { auth.rename((req.params as any).id, (req.body as any).name); hub.broadcastState(); return { ok: true }; });
  app.delete('/api/devices/:id', async (req) => { auth.remove((req.params as any).id); hub.broadcastState(); return { ok: true }; });

  // ---- realtime ----
  app.get('/ws', { websocket: true }, (socket, req) => {
    const deviceId = auth.verify((req.query as any).token);
    if (!deviceId) { socket.close(4001, 'unpaired'); return; }
    const off = hub.connect(deviceId, (m) => { if (socket.readyState === 1) socket.send(JSON.stringify(m)); });
    socket.on('message', (raw) => {
      let msg: ClientMsg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      hub.handle(deviceId, msg).catch((e) => app.log.error(e));
    });
    socket.on('close', off);
  });
}
