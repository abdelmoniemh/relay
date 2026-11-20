// Types shared by the server and the clients (the web app, also built for the TV). Rules about them: domain.ts.

export type Kind = 'live' | 'movie' | 'series' | 'episode';
export type DeviceKind = 'tv' | 'phone' | 'desktop';

/** `id`: kind-prefixed, see itemId() in domain.ts. */
export interface Item {
  id: string;
  kind: Kind;
  name: string;
  icon?: string | null;
  cat?: string | null;
  rating?: number | null;
  epg?: string | null; // epg channel id (live)
  archive?: number; // catch-up days (live)
  ext?: string | null; // container extension (vod/episode)
  seriesId?: string | null; // for episodes: parent series id (s123)
  season?: number | null;
  episode?: number | null;
  duration?: number | null; // seconds (movies/episodes), when known
  /** Live channel played from its archive: this programme (unix seconds), from its start. */
  catchup?: { start: number; stop: number; title?: string } | null;
}

export interface Category {
  id: string;
  name: string;
  count: number;
}

export interface Programme {
  start: number; // unix seconds
  stop: number;
  title: string;
  desc?: string;
}

export interface Progress {
  item: Item;
  position: number;
  duration: number;
  updated: number;
}

export interface DeviceInfo {
  id: string;
  name: string;
  kind: DeviceKind;
  online: boolean;
}

/** The single active stream allowed by the provider. */
export interface Lease {
  deviceId: string;
  item: Item;
  position: number;
  duration: number;
  paused: boolean;
  since: number;
}

export type RemoteCmd =
  | 'up' | 'down' | 'left' | 'right' | 'ok' | 'back' | 'home'
  | 'playpause' | 'seek' | 'chup' | 'chdown' | 'digit'
  | 'volup' | 'voldown' | 'mute' | 'stop';

// ---- client -> server ----
export type ClientMsg =
  | { t: 'play'; item: Item; startAt?: number } // request the lease for this device
  | { t: 'takeover' } // continue whatever is playing elsewhere, here
  | { t: 'heartbeat'; position: number; duration: number; paused: boolean }
  | { t: 'stopped'; position: number; duration: number } // ack of stop, or user stopped
  | { t: 'sendTo'; target: string; item?: Item; startAt?: number; eventId?: string } // item omitted = move current lease
  | { t: 'remote'; target: string; cmd: RemoteCmd; arg?: number | string };

// ---- server -> client ----
export type ServerMsg =
  | { t: 'hello'; deviceId: string }
  | { t: 'state'; devices: DeviceInfo[]; lease: Lease | null }
  | { t: 'granted'; item: Item; startAt: number; urls: string[]; hevc?: boolean; tx?: 'full' | 'audio'; interlaced?: boolean } // browsers can't play it directly: use the server conversion (interlaced: browsers don't deinterlace)
  | { t: 'stop'; reason: 'handoff' | 'remote'; to?: string }
  | { t: 'play'; item: Item; startAt?: number; from: string; eventId?: string } // asked to start playing (send-to)
  | { t: 'remote'; cmd: RemoteCmd; arg?: number | string; from: string }
  | { t: 'error'; message: string }
  | { t: 'reminder'; reminder: ReminderInfo }; // a reminded programme / event is about to start

export interface ReminderInfo {
  id: string;
  item: Item;
  title: string;
  start: number; // unix seconds
  stop: number | null;
  eventId: string | null;
  /** Device that starts playing it at the start time (null = just remind). */
  autoplay: string | null;
}

// ---- sports ----
export type Sport =
  | 'football' | 'basketball' | 'american-football' | 'hockey' | 'baseball' | 'tennis' | 'darts' | 'cricket'
  | 'rugby' | 'fighting' | 'motorsport' | 'golf' | 'snooker' | 'other';

export interface RankedSource {
  item: Item;
  fam: number;
  score: number;
  verified: boolean;
  label: string;
  dead?: boolean;
  height?: number; fps?: number; kbps?: number; hevc?: boolean; ttfb?: number; checkedAt?: number;
  interlaced?: boolean;
}

export interface SportEvent {
  id: string;
  title: string;
  home: string;
  away: string;
  competition: string | null;
  sport: Sport;
  start: number | null;
  stop: number | null;
  status: 'live' | 'upcoming' | 'unknown';
  offline?: boolean;
  sourceCount: number;
  sources: RankedSource[];
}
