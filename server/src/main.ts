import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import compress from '@fastify/compress';
import cors from '@fastify/cors';
import fstatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { constants as zlib } from 'node:zlib';
import qrcode from 'qrcode-terminal';
import { config, parseProvider } from './config.ts';
import { openDb } from './db.ts';
import { Catalog } from './catalog.ts';
import { Auth } from './auth.ts';
import { Hub } from './hub.ts';
import { registerApi } from './api.ts';
import { scheduleSync } from './sync.ts';
import { apiUrl, getJson, streamUrls, setProviderTz } from './xtream.ts';
import { Transcoder, HevcRegistry } from './transcode.ts';
import { kvGet, kvSet } from './db.ts';
import { EventsIndex } from './events.ts';
import { Prober } from './prober.ts';
import { Reminders } from './reminders.ts';
import { VodProxy } from './vodproxy.ts';
import { TrackStore } from './tracks.ts';
import { Prefetcher } from './prefetch.ts';
import { Tmdb } from './tmdb.ts';
import { Library } from './library.ts';
import { Letterboxd } from './letterboxd.ts';
import type { Item } from '../../shared/protocol.ts';

const provider = parseProvider();
const db = openDb(config.dbPath);
const catalog = new Catalog(db);
const auth = new Auth(db);
const transcoder = new Transcoder();
const hevc = new HevcRegistry(JSON.parse(kvGet(db, 'hevc_ids') ?? '[]'), (entries) => kvSet(db, 'hevc_ids', JSON.stringify(entries)));
process.on('exit', () => { transcoder.stop(); });
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { transcoder.stop().finally(() => process.exit(0)); });

const upsertProgress = db.prepare(`INSERT INTO progress (item, json, position, duration, updated, series) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(item) DO UPDATE SET json = excluded.json, position = excluded.position, duration = excluded.duration, updated = excluded.updated`);
const getProgress = db.prepare('SELECT position, duration FROM progress WHERE item = ?');

// Catch-up URLs take the provider's local time: learn its timezone (kept for offline starts; refreshed daily).
setProviderTz(kvGet(db, 'provider_tz') ?? 'UTC');
const loadTz = () => getJson(apiUrl(provider), 15_000)
  .then((j: any) => { const tz = j?.server_info?.timezone; if (typeof tz === 'string' && tz) { setProviderTz(tz); kvSet(db, 'provider_tz', tz); } })
  .catch(() => {});
loadTz(); setInterval(loadTz, 24 * 3600_000).unref();

const reminders = new Reminders(db);
const vodProxy = new VodProxy((m) => app.log.warn(m));
const trackStore = new TrackStore(JSON.parse(kvGet(db, 'vod_tracks') ?? '{}'), (entries) => kvSet(db, 'vod_tracks', JSON.stringify(Object.fromEntries(entries))));
const events = new EventsIndex(db);
const tmdb = new Tmdb(db, () => process.env.TMDB_API_KEY || process.env.TMDB_TOKEN || kvGet(db, 'tmdb_key'), (m) => app.log.warn(m));
const library = new Library(db, tmdb);
library.providerInfo = (sid) => getJson(apiUrl(provider, 'get_vod_info', { vod_id: String(sid) }), 8000);
const tmdbTick = tmdb.start(() => library.mask, () => library.invalidate());
const letterboxd = new Letterboxd(db, () => library.invalidate());
library.lb = letterboxd;
const lbTick = letterboxd.start();
// Background quality checks: only while no device holds a stream. Sources of live/soon events first, football first.
let hubRef: Hub | null = null;
let prefetchRef: Prefetcher | null = null;
const prober = new Prober(db, provider, {
  canRun: () => !!hubRef && !hubRef.streamActive() && !transcoder.owner && !prefetchRef?.busy,
  background: () => {
    const now = Date.now() / 1000;
    const list = events.list(catalog.regions, catalog.version, () => new Map(), { hevcOk: true })
      .filter((e) => e.status === 'live' || (e.start != null && e.start - now < 3 * 3600))
      .sort((a, b) => (a.sport === 'football' ? 0 : 1) - (b.sport === 'football' ? 0 : 1));
    return list.flatMap((e) => e.sources.slice(0, 25).map((s) => Number(s.item.id.slice(1))));
  },
  log: (m) => app.log.info(m),
});
// Skip-intro markers and seek thumbnails for titles being watched: same idle-only rule, never alongside the prober.
const prefetcher = new Prefetcher(config.dataDir, trackStore, () => !!hubRef && !hubRef.streamActive() && !transcoder.owner && !prober.busy, (m) => app.log.info(m));
prefetchRef = prefetcher;

const hub = new Hub({
  listDevices: () => auth.devices(),
  saveProgress: (item: Item, position, duration) => upsertProgress.run(item.id, JSON.stringify(item), position, duration, Date.now(), item.seriesId ?? null),
  resumePosition: (item) => {
    const r = getProgress.get(item.id) as { position: number; duration: number } | undefined;
    return r && r.duration > 0 && r.position < r.duration * 0.95 ? r.position : 0;
  },
  urls: (item) => streamUrls(provider, item),
  leaseMoved: async (deviceId) => {
    // Free every server-side use of the provider connection before the new device starts.
    prefetcher.abort();
    const probing = await prober.abort();
    await transcoder.releaseExcept(deviceId);
    if (probing) await new Promise((r) => setTimeout(r, 400)); // give the provider a moment to release the slot
  },
  txMode: (item) => hevc.mode(item.id),
  interlaced: (item) => item.kind === 'live' && !!prober.results([Number(item.id.slice(1))]).get(Number(item.id.slice(1)))?.interlaced,
  allowed: (item) => catalog.playable(item),
  log: (m) => app.log.info(m),
});

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info', transport: undefined }, trustProxy: false });
await app.register(cors, { origin: true });
await app.register(compress, { threshold: 1024, brotliOptions: { params: { [zlib.BROTLI_PARAM_QUALITY]: 4 } }, zlibOptions: { level: 5 } });
await app.register(websocket);
hubRef = hub;
registerApi(app, { db, catalog, auth, hub, provider, transcoder, hevc, events, prober, tmdb, library, tmdbTick, letterboxd, lbTick, reminders, vodProxy, trackStore, prefetcher });
// Reminders: every open app shows it; an "auto-start" device starts playing; installed apps get a notification.
reminders.start((r) => {
  hub.broadcast({ t: 'reminder', reminder: { id: r.id, item: r.item, title: r.title, start: r.start, stop: r.stop, eventId: r.eventId, autoplay: r.autoplay } });
  if (r.autoplay && !hub.sendPlay(r.autoplay, r.item, 'reminder', r.eventId)) app.log.warn(`reminder ${r.title}: ${r.autoplay} is offline, not auto-starting`);
}, (m) => app.log.warn(m));
app.log.warn(`transcoding: ${transcoder.available ? (transcoder.gpu ? 'NVENC (GPU)' : 'x264 (CPU)') : 'unavailable (install ffmpeg)'}`);

if (existsSync(config.webDir)) {
  await app.register(fstatic, {
    root: config.webDir,
    setHeaders: (res: any, path: string) => res.header('cache-control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'),
  });
  app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api/') ? reply.code(404).send({ error: 'not found' }) : reply.sendFile('index.html')));
}

scheduleSync(db, provider, () => {
  catalog.version = `${Date.now()}.${catalog.regions.join('')}`;
  events.invalidate();
  library.invalidate();
  tmdbTick();
});

await app.listen({ host: '0.0.0.0', port: config.port });

const lan = Object.values(networkInterfaces()).flat().filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n!.address);
const url = `http://${lan[0] ?? 'localhost'}:${config.port}`;
console.log(`\n  Relay is running:\n${lan.map((ip) => `    http://${ip}:${config.port}`).join('\n')}\n  Pairing code: ${auth.pairingCode()} (also shown in Settings on any paired device)\n`);
qrcode.generate(`relay://pair?url=${encodeURIComponent(url)}&code=${auth.pairingCode()}`, { small: true });
