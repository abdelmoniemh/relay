import type { Kind } from '../../../shared/protocol.ts';
import { type Sort } from '../catalog.ts';
import { rankSources } from '../quality.ts';
import type { FastifyInstance } from 'fastify';
import { type ApiCtx, KINDS, clamp } from './http.ts';

export function registerCatalogRoutes(app: FastifyInstance, ctx: ApiCtx) {
  const { catalog, events, prober, cached } = ctx;
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

  // ---- sports events & sources ----
  const hevcOk = (q: Record<string, string>) => q.hevc === '1';
  app.get('/api/regions', async () => ({ enabled: catalog.regions, all: catalog.regionList() }));
  app.get('/api/events', async (req) => {
    const q = req.query as Record<string, string>;
    let list = events.list((sids) => prober.results(sids), { hevcOk: hevcOk(q) });
    if (q.sport) list = list.filter((e) => e.sport === q.sport);
    if (q.q) { const t = q.q.toLowerCase(); list = list.filter((e) => `${e.title} ${e.competition ?? ''}`.toLowerCase().includes(t)); }
    return list.map((e) => ({ ...e, sourceCount: e.sources.length, sources: q.full ? e.sources : e.sources.slice(0, 3) }));
  });
  app.get('/api/events/:id', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const e = events.list((sids) => prober.results(sids), { hevcOk: hevcOk(q) }).find((x) => x.id === (req.params as any).id);
    if (!e) return reply.code(404).send({ error: 'Event not found (finished?)' });
    return { ...e, sourceCount: e.sources.length };
  });
  app.get('/api/family/:id', async (req) => {
    const fam = catalog.family((req.params as any).id);
    return rankSources(fam, prober.results(fam.map((f) => f.item.id)), { hevcOk: hevcOk(req.query as any) });
  });
  /** Check these streams' real quality as soon as the connection is free. */
  app.post('/api/probe', async (req) => {
    const ids = ((req.body as any)?.ids ?? []) as string[];
    prober.request(ids.slice(0, 60));
    return { ok: true };
  });

  app.post('/api/observed', async (req) => {
    const b = req.body as { id?: string; width?: number; height?: number; fps?: number; vcodec?: string; kbps?: number };
    if (!b?.id?.startsWith('l') || !(Number(b.height) > 0)) return { ok: false };
    prober.observed(String(b.id), { width: Number(b.width), height: Number(b.height), fps: b.fps ? Number(b.fps) : null, vcodec: b.vcodec ?? null, kbps: b.kbps ? Number(b.kbps) : null });
    return { ok: true };
  });
}
