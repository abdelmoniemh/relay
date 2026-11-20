// What every route module gets, and small helpers they share.
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { Kind } from '../../../shared/protocol.ts';
import type { Catalog } from '../catalog.ts';
import type { Auth } from '../auth.ts';
import type { Hub } from '../hub.ts';
import type { Provider } from '../xtream.ts';
import type { Transcoder } from '../transcode.ts';
import type { MediaFacts } from '../facts.ts';
import type { EventsIndex } from '../events.ts';
import type { Prober } from '../prober.ts';
import type { Tmdb } from '../tmdb.ts';
import type { Library } from '../library.ts';
import type { Letterboxd } from '../letterboxd.ts';
import type { Reminders } from '../reminders.ts';
import type { VodProxy } from '../vodproxy.ts';
import type { TrackStore } from '../tracks.ts';
import type { Prefetcher } from '../prefetch.ts';
import type { UserData } from '../userdata.ts';
import type { ProviderDetails } from '../details.ts';

declare module 'fastify' { interface FastifyRequest { deviceId: string } }

export interface Services {
  db: DatabaseSync; userData: UserData; details: ProviderDetails; catalog: Catalog; auth: Auth; hub: Hub; provider: Provider; transcoder: Transcoder; facts: MediaFacts;
  events: EventsIndex; prober: Prober; tmdb: Tmdb; library: Library; tmdbTick: () => void; letterboxd: Letterboxd; lbTick: () => void;
  reminders: Reminders; vodProxy: VodProxy; trackStore: TrackStore; prefetcher: Prefetcher;
}
export interface ApiCtx extends Services {
  /** Catalog responses are immutable until the next sync: answers 304 when the client already has this version. */
  cached: (req: FastifyRequest, reply: FastifyReply) => boolean;
  /** The catalog changed (sync, regions): new version, rebuilt events. */
  refreshVersion: () => void;
}

export const KINDS = new Set<Kind>(['live', 'movie', 'series']);
export const isLocal = (ip: string) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
export const clamp = (v: unknown, lo: number, hi: number, d: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.floor(n))) : d; };
