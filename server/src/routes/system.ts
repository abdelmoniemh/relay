import type { ClientMsg, DeviceKind } from '../../../shared/protocol.ts';
import { syncedAt } from '../db.ts';
import { isSyncing, runSync } from '../sync.ts';
import type { FastifyInstance } from 'fastify';
import { type ApiCtx, isLocal } from './http.ts';

export function registerSystemRoutes(app: FastifyInstance, ctx: ApiCtx) {
  const { db, catalog, auth, hub, provider, tmdb, library, letterboxd, lbTick, catalogChanged } = ctx;
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
    catalogSynced: syncedAt(db, 'catalog'), epgSynced: syncedAt(db, 'epg'),
    pairingCode: auth.pairingCode(), regions: catalog.regions, vodLangs: library.langs, letterboxd: letterboxd.status(),
    tmdb: { enabled: tmdb.enabled, enriched: tmdb.enriched, lastError: tmdb.lastError, pending: tmdb.pending(library.mask) },
  }));

  app.post('/api/sync', async () => {
    runSync(provider, ['catalog', 'epg']).then(catalogChanged).catch((e) => app.log.error(e));
    return { started: true };
  });

  app.put('/api/settings', async (req, reply) => {
    const b = req.body as { regions?: string[]; vodLangs?: string[]; tmdbKey?: string; letterboxd?: string };
    // check first, so a rejected key doesn't leave the other changes half applied
    const key = typeof b.tmdbKey === 'string' ? b.tmdbKey.trim() : null;
    if (key && !(await tmdb.verify(key))) return reply.code(400).send({ error: 'TMDB rejected that key' });
    if (typeof b.letterboxd === 'string') { letterboxd.setUser(b.letterboxd); if (letterboxd.user) lbTick(); }
    if (Array.isArray(b.vodLangs)) library.setLangs(b.vodLangs.map(String));
    if (key != null) tmdb.setKey(key);
    if (Array.isArray(b.regions)) catalog.setRegions(b.regions.map(String));
    catalogChanged(); // what clients see may have changed: new version, rebuilt rows, titles to enrich
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
