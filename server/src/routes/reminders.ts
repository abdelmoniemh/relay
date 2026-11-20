import type { Item } from '../../../shared/protocol.ts';
import { parseId, displayName } from '../../../shared/domain.ts';
import type { FastifyInstance } from 'fastify';
import { type ApiCtx } from './http.ts';

export function registerRemindersRoutes(app: FastifyInstance, ctx: ApiCtx) {
  const { db, catalog, reminders } = ctx;
  // ---- reminders & notifications ----
  app.get('/api/reminders', async () => reminders.list());
  app.post('/api/reminders', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, any>;
    const id = String(b.itemId ?? b.item?.id ?? '');
    const { kind, sid } = parseId(id);
    const start = Number(b.start);
    if (kind !== 'live' || !catalog.playable({ id, kind })) return reply.code(400).send({ error: 'Reminders are for channels and events' });
    if (!(start > Date.now() / 1000 - 60)) return reply.code(400).send({ error: 'That has already started' });
    const row = db.prepare("SELECT name, icon, cat, epg, archive FROM items WHERE kind = 'live' AND sid = ?").get(sid) as any;
    const item: Item = { id, kind: 'live', name: row?.name ?? String(b.item?.name ?? id), icon: row?.icon ?? null, cat: row?.cat ?? null, epg: row?.epg ?? null, archive: row?.archive ?? 0 };
    const autoplay = typeof b.autoplay === 'string' && b.autoplay ? b.autoplay : null;
    return reminders.add({ item, title: String(b.title ?? item.name).slice(0, 200), start, stop: Number(b.stop) || null, eventId: b.eventId ? String(b.eventId) : null, autoplay });
  });
  app.delete('/api/reminders/:id', async (req) => { reminders.remove(String((req.params as any).id)); return { ok: true }; });
  app.get('/api/push/key', async () => ({ key: reminders.publicKey }));
  app.post('/api/push/subscribe', async (req, reply) => {
    const ep = String(((req.body ?? {}) as any).endpoint ?? '');
    try { return { secret: reminders.subscribe(ep, req.deviceId ?? null) }; } catch { return reply.code(400).send({ error: 'bad subscription' }); }
  });
  app.post('/api/push/unsubscribe', async (req) => { reminders.unsubscribe(String(((req.body ?? {}) as any).endpoint ?? '')); return { ok: true }; });
  app.get('/api/push/due', async (req, reply) => {
    if (!reminders.validSecret(String((req.query as any).k ?? ''))) return reply.code(403).send({ error: 'unknown subscription' });
    return reminders.recentlyFired().map((r) => ({ id: r.id, title: r.title, channel: displayName(r.item.name), start: r.start, icon: r.item.icon ?? null }));
  });
}
