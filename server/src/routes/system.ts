import type { ClientMsg, DeviceKind } from '../../../shared/protocol.ts';
import { kvGet, kvSet } from '../db.ts';
import { isSyncing, runSync } from '../sync.ts';
import type { FastifyInstance } from 'fastify';
import { type ApiCtx, isLocal } from './http.ts';

export function registerSystemRoutes(app: FastifyInstance, ctx: ApiCtx) {
  const { db, catalog, auth, hub, provider, prober, tmdb, library, tmdbTick, letterboxd, lbTick, refreshVersion } = ctx;
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
    pairingCode: auth.pairingCode(), regions: catalog.regions, vodLangs: library.langs, letterboxd: letterboxd.status(),
    tmdb: { enabled: tmdb.enabled, enriched: tmdb.enriched, lastError: tmdb.lastError,
      pending: (db.prepare('SELECT count(*) AS n FROM titles WHERE tmdb IS NOT NULL AND meta_at IS NULL AND (lmask & ?) != 0').get(library.mask) as { n: number }).n },
    probing: prober.active, probeQueue: prober.pending(), liveSynced: Number(kvGet(db, 'live_synced') ?? 0),
  }));

  app.post('/api/sync', async () => {
    runSync(provider, ['catalog', 'epg']).then(() => { refreshVersion(); }).catch((e) => app.log.error(e));
    return { started: true };
  });

  app.put('/api/settings', async (req, reply) => {
    const b = req.body as { regions?: string[]; vodLangs?: string[]; tmdbKey?: string; letterboxd?: string };
    if (typeof b.letterboxd === 'string') { letterboxd.setUser(b.letterboxd); library.invalidate(); if (letterboxd.user) lbTick(); }
    if (Array.isArray(b.vodLangs)) { library.setLangs(b.vodLangs.map(String)); tmdbTick(); }
    if (typeof b.tmdbKey === 'string') {
      const k = b.tmdbKey.trim();
      if (k && !(await tmdb.verify(k))) return reply.code(400).send({ error: 'TMDB rejected that key' });
      kvSet(db, 'tmdb_key', k);
      library.invalidate();
      if (k) tmdbTick();
    }
    if (Array.isArray(b.regions)) { catalog.regions = b.regions.map((r) => String(r).toUpperCase().replace(/[^A-Z0-9]/g, '')).filter(Boolean).slice(0, 50); kvSet(db, 'regions', JSON.stringify(catalog.regions)); }
    refreshVersion();
    return { ok: true };
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
