import type { Item } from '../../../shared/protocol.ts';
import { parseId } from '../../../shared/domain.ts';
import type { FastifyInstance } from 'fastify';
import { type ApiCtx, clamp } from './http.ts';

export function registerLibraryRoutes(app: FastifyInstance, ctx: ApiCtx) {
  const { db, userData, catalog, provider, library, letterboxd, details, prefetcher, vodProxy } = ctx;
  app.get('/api/movie/:id', async (req, reply) => {
    const { kind, sid } = parseId((req.params as any).id);
    if (kind !== 'movie') return reply.code(400).send({ error: 'bad id' });
    if (!catalog.get((req.params as any).id)) return reply.code(404).send({ error: 'not found' });
    return details.movie(sid);
  });
  app.get('/api/series/:id', async (req, reply) => {
    const { kind, sid } = parseId((req.params as any).id);
    if (kind !== 'series') return reply.code(400).send({ error: 'bad id' });
    return reply.type('application/json').send(await details.seriesJson(sid));
  });


  // ---- movies & series (titles = one entry per film/show, versions = provider copies) ----
  const device = (q: Record<string, string>) => ({ tv: q.dev === 'tv', hevcOk: q.hevc === '1' });
  const vkind = (k: string) => (k === 'series' ? 'series' : 'movie') as 'movie' | 'series';
  app.get('/api/browse/:kind', async (req) => library.rows(vkind((req.params as any).kind)));
  app.get('/api/watchlist', async () => ({ ...library.watchlistRow(500), status: letterboxd.status() }));
  app.get('/api/genres/:kind', async (req) => library.genres(vkind((req.params as any).kind)));
  app.get('/api/titles/:kind', async (req) => {
    const q = req.query as Record<string, string>;
    return library.grid(vkind((req.params as any).kind), q, Math.max(0, Number(q.offset) || 0), clamp(q.limit, 1, 200, 60));
  });
  app.get('/api/title-search', async (req) => {
    const q = req.query as Record<string, string>;
    return library.search(String(q.q ?? '').slice(0, 100), q.kind === 'movie' || q.kind === 'series' ? q.kind : null);
  });
  /** Which title does this provider copy belong to? (old favorites, category browsing) */
  app.get('/api/title-of/:id', async (req, reply) => {
    const { kind, sid } = parseId((req.params as any).id);
    if (!kind) return reply.code(404).send({ error: 'not found' });
    const r = db.prepare('SELECT tid FROM items WHERE kind = ? AND sid = ?').get(kind, sid) as { tid: number | null } | undefined;
    return r?.tid ? { tid: r.tid } : reply.code(404).send({ error: 'not found' });
  });
  app.get('/api/title/:tid', async (req, reply) => {
    const d = await library.detail(Number((req.params as any).tid), device(req.query as any));
    if (!d) return reply.code(404).send({ error: 'not found' });
    // Read the movie files (real quality, languages) while nothing is playing: one header read each, through the proxy.
    if (d.kind === 'movie') for (const v of d.versions.slice(0, 8)) prefetcher.want(v.item.id, () => vodProxy.url(provider.source(v.item)), { thumbs: false });
    return d;
  });


  // ---- favourites / continue watching / recent channels ----
  app.get('/api/favorites', async () => userData.favorites());
  app.put('/api/favorites/:id', async (req) => { userData.addFavorite({ ...(req.body as Item), id: (req.params as any).id }); return { ok: true }; });
  app.delete('/api/favorites/:id', async (req) => { userData.removeFavorite((req.params as any).id); return { ok: true }; });
  app.get('/api/continue', async () => userData.continueWatching());
  app.get('/api/recent', async () => userData.recentChannels());
  app.get('/api/progress', async (req) => userData.progressOf(String((req.query as any).ids ?? '').split(',').filter(Boolean).slice(0, 500)));
}
