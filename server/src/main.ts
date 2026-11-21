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
import { Provider } from './xtream.ts';
import { Transcoder } from './transcode.ts';
import { MediaFacts } from './facts.ts';
import { claimed } from './quality.ts';
import { UserData } from './userdata.ts';
import { ProviderDetails } from './details.ts';
import { kvGet, kvSet } from './db.ts';
import { EventsIndex } from './events.ts';
import { Prober } from './prober.ts';
import { Reminders } from './reminders.ts';
import { VodProxy } from './vodproxy.ts';
import { TrackStore } from './tracks.ts';
import { Prefetcher } from './prefetch.ts';
import { ProviderSlot } from './slot.ts';
import { Tmdb } from './tmdb.ts';
import { Library } from './library.ts';
import { Letterboxd } from './letterboxd.ts';
import type { Item } from '../../shared/protocol.ts';

// first: every service below logs through it
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info', transport: undefined }, trustProxy: false });
const provider = new Provider(parseProvider());
const db = openDb(config.dbPath);
const catalog = new Catalog(db);
const auth = new Auth(db);
// The provider allows one connection: everything that opens one goes through the slot.
const slot = new ProviderSlot();
const transcoder = new Transcoder(slot);
process.on('exit', () => { transcoder.stop(); });
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { transcoder.stop().finally(() => process.exit(0)); });

const userData = new UserData(db);

// Catch-up URLs take the provider's local time: learn its timezone (kept for offline starts; refreshed daily).
provider.timezone = kvGet(db, 'provider_tz') ?? 'UTC';
const loadTz = () => provider.loadTimezone()
  .then((tz) => kvSet(db, 'provider_tz', tz))
  .catch((e) => app.log.warn(`provider timezone: ${(e as Error).message} (catch-up uses ${provider.timezone})`));
loadTz(); setInterval(loadTz, 24 * 3600_000).unref();

const reminders = new Reminders(db);
const vodProxy = new VodProxy((m) => app.log.warn(m));
const trackStore = new TrackStore(JSON.parse(kvGet(db, 'vod_tracks') ?? '{}'), (entries) => kvSet(db, 'vod_tracks', JSON.stringify(Object.fromEntries(entries))),
  (id, t) => facts.recordProbe(id, t));
const events = new EventsIndex(db, catalog);
const tmdb = new Tmdb(db, process.env.TMDB_API_KEY || process.env.TMDB_TOKEN || null, (m) => app.log.warn(m));
const details = new ProviderDetails(db, provider, catalog);
const letterboxd = new Letterboxd(db, () => library.invalidate());
const library = new Library(db, tmdb, userData, details, letterboxd);
const tmdbTick = tmdb.start(() => library.mask, () => library.invalidate());
const lbTick = letterboxd.start();
// Background quality checks: sources of live/soon events first, football first.
const prober = new Prober(db, provider, slot, {
  background: () => events.soonSources(),
  log: (m) => app.log.info(m),
});
// Skip-intro markers and seek thumbnails for titles being watched.
const prefetcher = new Prefetcher(config.dataDir, trackStore, slot, (m) => app.log.info(m));
const facts = new MediaFacts(db, prober, trackStore);

const hub = new Hub({
  listDevices: () => auth.devices(),
  saveProgress: (item: Item, position, duration) => userData.saveProgress(item, position, duration),
  resumePosition: (item) => userData.resumePosition(item.id),
  urls: (item) => provider.urls(item),
  leaseMoved: async (deviceId) => {
    // Free every server-side use of the provider connection before the new device starts.
    // held until the hub has set the lease (it then counts as a holder): no probe can slip in meanwhile
    const release = slot.claim();
    try { await slot.clear(); await transcoder.releaseExcept(deviceId); } finally { release(); }
  },
  txMode: (item) => facts.browserNeeds(item.id),
  interlaced: (item) => item.kind === 'live' && !item.catchup && !!facts.source(item.id)?.interlaced,
  uhd: (item) => (facts.source(item.id)?.height ?? 0) >= 2000 || claimed(item.name).height >= 2160,
  allowed: (item) => catalog.playable(item),
  log: (m) => app.log.info(m),
});
// A device streaming straight from the provider holds the connection too.
slot.hold({ active: () => hub.streamActive() });

await app.register(cors, { origin: true });
await app.register(compress, { threshold: 1024, brotliOptions: { params: { [zlib.BROTLI_PARAM_QUALITY]: 4 } }, zlibOptions: { level: 5 } });
await app.register(websocket);
/** A sync finished or the regions changed. */
function catalogChanged() { catalog.refresh(); events.invalidate(); library.invalidate(); tmdbTick(); }
registerApi(app, { catalogChanged, userData, details, catalog, auth, hub, provider, transcoder, facts, events, prober, tmdb, library, tmdbTick, letterboxd, lbTick, reminders, vodProxy, trackStore, prefetcher });
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

scheduleSync(db, provider, catalogChanged);

await app.listen({ host: '0.0.0.0', port: config.port });

const lan = Object.values(networkInterfaces()).flat().filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n!.address);
const url = `http://${lan[0] ?? 'localhost'}:${config.port}`;
console.log(`\n  Relay is running:\n${lan.map((ip) => `    http://${ip}:${config.port}`).join('\n')}\n  Pairing code: ${auth.pairingCode()} (also shown in Settings on any paired device)\n`);
qrcode.generate(`relay://pair?url=${encodeURIComponent(url)}&code=${auth.pairingCode()}`, { small: true });
