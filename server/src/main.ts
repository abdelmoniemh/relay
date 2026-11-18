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
import { streamUrls } from './xtream.ts';
import type { Item } from '../../shared/protocol.ts';

const provider = parseProvider();
const db = openDb(config.dbPath);
const catalog = new Catalog(db);
const auth = new Auth(db);

const upsertProgress = db.prepare(`INSERT INTO progress (item, json, position, duration, updated, series) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(item) DO UPDATE SET json = excluded.json, position = excluded.position, duration = excluded.duration, updated = excluded.updated`);
const getProgress = db.prepare('SELECT position, duration FROM progress WHERE item = ?');

const hub = new Hub({
  listDevices: () => auth.devices(),
  saveProgress: (item: Item, position, duration) => upsertProgress.run(item.id, JSON.stringify(item), position, duration, Date.now(), item.seriesId ?? null),
  resumePosition: (item) => {
    const r = getProgress.get(item.id) as { position: number; duration: number } | undefined;
    return r && r.duration > 0 && r.position < r.duration * 0.95 ? r.position : 0;
  },
  urls: (item) => streamUrls(provider, item),
  log: (m) => app.log.info(m),
});

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info', transport: undefined }, trustProxy: false });
await app.register(cors, { origin: true });
await app.register(compress, { threshold: 1024, brotliOptions: { params: { [zlib.BROTLI_PARAM_QUALITY]: 4 } }, zlibOptions: { level: 5 } });
await app.register(websocket);
registerApi(app, { db, catalog, auth, hub, provider });

if (existsSync(config.webDir)) {
  await app.register(fstatic, {
    root: config.webDir,
    setHeaders: (res: any, path: string) => res.header('cache-control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'),
  });
  app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api/') ? reply.code(404).send({ error: 'not found' }) : reply.sendFile('index.html')));
}

scheduleSync(db, provider, () => {
  catalog.version = `${Date.now()}.${catalog.showAdult ? 1 : 0}`;
});

await app.listen({ host: '0.0.0.0', port: config.port });

const lan = Object.values(networkInterfaces()).flat().filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n!.address);
const url = `http://${lan[0] ?? 'localhost'}:${config.port}`;
console.log(`\n  Relay is running:\n${lan.map((ip) => `    http://${ip}:${config.port}`).join('\n')}\n  Pairing code: ${auth.pairingCode()} (also shown in Settings on any paired device)\n`);
qrcode.generate(`relay://pair?url=${encodeURIComponent(url)}&code=${auth.pairingCode()}`, { small: true });
