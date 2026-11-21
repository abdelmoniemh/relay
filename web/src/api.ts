import type { Category, Item, Kind, Programme, Progress, RankedSource, SportEvent, ReminderInfo } from '@shared/protocol.ts';
import { signal } from '@preact/signals';
import { persisted } from './storage.ts';
import { canHevc, isTizen } from './env.ts';
import type { Sort, SeriesInfo, MovieInfo, TitleCard, BrowseRow, VersionInfo, TitleDetail } from '@shared/protocol.ts';
export type { Sort, SeriesInfo, MovieInfo, TitleCard, BrowseRow, VersionInfo, TitleDetail };

const sameOrigin = location.protocol.startsWith('http') && !__TIZEN__ ? location.origin : '';
// Only an address someone set is saved: the page's own origin must follow wherever it's opened from (LAN, Tailscale).
export const server = persisted<string>('server', (v) => v || sameOrigin || __DEFAULT_SERVER__, (v) => (v === sameOrigin ? null : v));
export const token = persisted<string | null>('token', (v) => v);
export const myDeviceId = persisted<string | null>('device', (v) => v);

export function setServer(url: string) { server.value = url.replace(/\/+$/, ''); }
export function setCredentials(t: string | null, id: string | null) { token.value = t; myDeviceId.value = id; }

export class HttpError extends Error { status: number; constructor(s: number, m: string) { super(m); this.status = s; } }

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(server.value + path, {
    method,
    headers: { ...(token.value ? { authorization: `Bearer ${token.value}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { setCredentials(null, null); throw new HttpError(401, 'unpaired'); }
  if (!res.ok) throw new HttpError(res.status, (await res.json().catch(() => ({}))).error ?? res.statusText);
  return res.json();
}

/** In-memory cache for catalog GETs: revisiting a screen is instant; HTTP ETags handle freshness across sessions. */
const memo = new Map<string, Promise<any>>();
function cachedGet<T>(path: string): Promise<T> {
  let p = memo.get(path);
  if (!p) {
    p = req<T>('GET', path).catch((e) => { memo.delete(path); throw e; });
    if (memo.size > 400) memo.delete(memo.keys().next().value!);
    memo.set(path, p);
  }
  return p;
}
export const clearCache = () => memo.clear();

const hevcParam = () => (canHevc ? '1' : '0');

/** Skip-intro / credits markers and the seek-bar thumbnail sprite of a movie or episode (when prepared). */
export interface Extras {
  markers: { intro?: [number, number]; recap?: [number, number]; credits?: number };
  duration: number | null;
  thumbs: { interval: number; cols: number; rows: number; w: number; h: number } | null;
}

export interface LbStatus { user: string | null; fromConfig: boolean; watchlist: number; resolved: number; watched: number; syncedAt: number | null; error: string | null; syncing: boolean }
export interface Status { syncing: boolean; counts: Record<string, number>; catalogSynced: number; epgSynced: number; pairingCode: string; regions: string[]; vodLangs: string[]; letterboxd: LbStatus; tmdb: { enabled: boolean; enriched: number; pending: number; lastError: string | null } }

export const api = {
  ping: () => req<{ ok: boolean }>('GET', '/api/ping'),
  pair: (code: string, name: string, kind: string) => req<{ token: string; deviceId: string }>('POST', '/api/pair', { code, name, kind }),
  status: () => req<Status>('GET', '/api/status'),
  sync: () => req('POST', '/api/sync'),
  settings: (s: { regions?: string[]; vodLangs?: string[]; tmdbKey?: string; letterboxd?: string }) => req('PUT', '/api/settings', s).then(() => clearCache()),
  categories: (kind: Kind) => cachedGet<Category[]>(`/api/categories/${kind}`),
  items: (kind: Kind, cat: string | null, sort: Sort, offset: number, limit: number) =>
    cachedGet<{ items: Item[]; total: number }>(`/api/items/${kind}?${new URLSearchParams({ ...(cat ? { cat } : {}), sort, offset: String(offset), limit: String(limit) })}`),
  item: (id: string) => cachedGet<Item>(`/api/item/${id}`),
  neighbor: (id: string, dir: 'next' | 'prev') => req<Item>('GET', `/api/neighbor/${id}?dir=${dir}`),
  search: (q: string, kind?: Kind) => cachedGet<Item[]>(`/api/search?${new URLSearchParams({ q, ...(kind ? { kind } : {}) })}`),
  nowNext: (chs: string[]) => req<Record<string, Programme[]>>('GET', `/api/epg/now?ch=${encodeURIComponent(chs.join(','))}`),
  guide: (chs: string[], from: number, to: number) => req<Record<string, Programme[]>>('GET', `/api/epg/guide?ch=${encodeURIComponent(chs.join(','))}&from=${from}&to=${to}`),
  series: (id: string) => cachedGet<SeriesInfo>(`/api/series/${id}`),
  movie: (id: string) => cachedGet<MovieInfo>(`/api/movie/${id}`),
  favorites: () => req<Item[]>('GET', '/api/favorites'),
  addFavorite: (it: Item) => req('PUT', `/api/favorites/${it.id}`, it),
  removeFavorite: (id: string) => req('DELETE', `/api/favorites/${id}`),
  continueWatching: () => req<Progress[]>('GET', '/api/continue'),
  recent: () => req<Item[]>('GET', '/api/recent'),
  progress: (ids: string[]) => req<Record<string, [number, number]>>('GET', `/api/progress?ids=${ids.join(',')}`),
  events: (opts: { sport?: string; q?: string } = {}) => req<SportEvent[]>('GET', `/api/events?${new URLSearchParams({ ...opts, hevc: hevcParam() } as any)}`),
  event: (id: string) => req<SportEvent>('GET', `/api/events/${id}?hevc=${hevcParam()}`),
  family: (id: string) => req<RankedSource[]>('GET', `/api/family/${id}?hevc=${hevcParam()}`),
  probe: (ids: string[]) => req<{ queued: number; active: number | null; blocked: boolean }>('POST', '/api/probe', { ids }),
  extras: (id: string) => req<Extras>('GET', `/api/extras/${encodeURIComponent(id)}`),
  prefetch: (items: { id: string; ext?: string | null }[]) => req('POST', '/api/prefetch', { items }),
  reminders: () => req<ReminderInfo[]>('GET', '/api/reminders'),
  addReminder: (r: { itemId: string; title: string; start: number; stop: number | null; eventId: string | null; autoplay: string | null }) => req<ReminderInfo>('POST', '/api/reminders', r),
  removeReminder: (id: string) => req('DELETE', `/api/reminders/${encodeURIComponent(id)}`),
  pushKey: () => req<{ key: string }>('GET', '/api/push/key'),
  pushSubscribe: (endpoint: string) => req<{ secret: string }>('POST', '/api/push/subscribe', { endpoint }),
  pushUnsubscribe: (endpoint: string) => req('POST', '/api/push/unsubscribe', { endpoint }),
  clientLog: (msg: string) => req('POST', '/api/clientlog', { msg }).catch(() => {}),
  observed: (o: { id: string; width: number; height: number; fps?: number; vcodec?: string; kbps?: number }) => req('POST', '/api/observed', o),
  browse: (kind: 'movie' | 'series') => req<BrowseRow[]>('GET', `/api/browse/${kind}`),
  genres: (kind: 'movie' | 'series') => cachedGet<{ name: string; count: number }[]>(`/api/genres/${kind}`),
  titles: (kind: 'movie' | 'series', f: Record<string, string>, offset: number, limit: number) =>
    cachedGet<{ items: TitleCard[]; total: number }>(`/api/titles/${kind}?${new URLSearchParams({ ...f, offset: String(offset), limit: String(limit) })}`),
  titleSearch: (q: string, kind?: 'movie' | 'series') => cachedGet<TitleCard[]>(`/api/title-search?${new URLSearchParams({ q, ...(kind ? { kind } : {}) })}`),
  title: (tid: number) => req<TitleDetail>('GET', `/api/title/${tid}?dev=${isTizen ? 'tv' : 'desktop'}&hevc=${hevcParam()}`),
  watchlist: () => req<{ items: TitleCard[]; available: number; total: number; missing: { name: string; year: number | null }[]; status: LbStatus }>('GET', '/api/watchlist'),
  titleOf: (itemId: string) => cachedGet<{ tid: number }>(`/api/title-of/${itemId}`),
  regions: () => req<{ enabled: string[]; all: { code: string; channels: number }[] }>('GET', '/api/regions'),
  devices: () => req<{ id: string; name: string; kind: string }[]>('GET', '/api/devices'),
  renameDevice: (id: string, name: string) => req('PUT', `/api/devices/${id}`, { name }),
  removeDevice: (id: string) => req('DELETE', `/api/devices/${id}`),
};

export const favorites = signal<Map<string, Item>>(new Map());
export async function loadFavorites() {
  const list = await api.favorites();
  favorites.value = new Map(list.map((i) => [i.id, i]));
}
export async function toggleFavorite(it: Item) {
  const m = new Map(favorites.value);
  if (m.has(it.id)) { m.delete(it.id); favorites.value = m; await api.removeFavorite(it.id); }
  else { m.set(it.id, it); favorites.value = m; await api.addFavorite(it); }
}
