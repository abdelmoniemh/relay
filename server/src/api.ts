import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Services } from './routes/http.ts';
import { registerSystemRoutes } from './routes/system.ts';
import { registerCatalogRoutes } from './routes/catalog.ts';
import { registerLibraryRoutes } from './routes/library.ts';
import { registerStreamsRoutes } from './routes/streams.ts';
import { registerRemindersRoutes } from './routes/reminders.ts';

/** Reachable without a device token. The service worker's /api/push/due checks its subscription secret itself. */
const PUBLIC = new Set(['/api/ping', '/api/pair', '/api/push/due']);

export function registerApi(app: FastifyInstance, services: Services) {
  const { catalog, auth } = services;

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (!path.startsWith('/api/') || PUBLIC.has(path)) return;
    const h = req.headers.authorization;
    const token = h?.startsWith('Bearer ') ? h.slice(7) : (req.query as any)?.token;
    const id = auth.verify(token);
    if (!id) return reply.code(401).send({ error: 'unpaired' });
    req.deviceId = id;
  });

  const cached = (req: FastifyRequest, reply: FastifyReply) => {
    const etag = `W/"${catalog.version}"`;
    reply.header('etag', etag).header('cache-control', 'private, no-cache');
    if (req.headers['if-none-match'] === etag) { reply.code(304).send(); return true; }
    return false;
  };

  const ctx = { ...services, cached };
  registerSystemRoutes(app, ctx);
  registerCatalogRoutes(app, ctx);
  registerLibraryRoutes(app, ctx);
  registerStreamsRoutes(app, ctx);
  registerRemindersRoutes(app, ctx);
}
