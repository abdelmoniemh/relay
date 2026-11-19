import type { Category, Item, Kind, Programme, Progress, RankedSource, SportEvent } from '@shared/protocol.ts';
import { signal } from '@preact/signals';

const LS = { server: 'relay.server', token: 'relay.token', device: 'relay.device' };
const ls = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string | null) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

const sameOrigin = location.protocol.startsWith('http') && !__TIZEN__ ? location.origin : '';
export const server = signal<string>(ls.get(LS.server) || sameOrigin || __DEFAULT_SERVER__);
export const token = signal<string | null>(ls.get(LS.token));
export const myDeviceId = signal<string | null>(ls.get(LS.device));

export function setServer(url: string) { server.value = url.replace(/\/+$/, ''); ls.set(LS.server, server.value); }
export function setCredentials(t: string | null, id: string | null) {
  token.value = t; myDeviceId.value = id; ls.set(LS.token, t); ls.set(LS.device, id);
}

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

/** Can this device play HEVC without help? (TV hardware and Apple devices can; most desktop browsers can't.) */
function hevcParam() {
  try {
    if (__TIZEN__ || typeof (window as any).tizen !== 'undefined') return '1';
    return MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L120.90"') ? '1' : '0';
  } catch { return '0'; }
}

export type Sort = 'default' | 'added' | 'name' | 'rating';
export interface SeriesInfo {
  id: string; name: string; cover: string | null; backdrop: string | null; plot: string | null; genre: string | null; year: string | null; rating: number | null;
  seasons: { season: number; episodes: (Item & { plot?: string; duration?: number })[] }[];
}
export interface MovieInfo { plot: string | null; genre: string | null; year: string | null; duration: number | null; backdrop: string | null; cast: string | null; director: string | null; rating: number | null }
export interface TitleCard {
  tid: number; kind: 'movie' | 'series'; name: string; year: number | null; poster: string | null; rating: number | null; uhd: boolean;
  langs: string[]; progress?: { position: number; duration: number; label?: string };
}
export interface BrowseRow { id: string; title: string; items: TitleCard[]; more?: Record<string, string> }
export interface VersionInfo {
  item: Item; lang: string; uhd: boolean; hdr: boolean; dv: boolean; dolby: boolean; src: string | null; score: number; label: string;
  probe?: { width: number | null; height: number | null; hdr: string | null; vcodec: string | null; acodec: string | null; channels: number | null; alangs: string | null; slangs: string | null };
}
export interface TitleDetail extends TitleCard {
  backdrop: string | null; plot: string | null; genres: string[]; cast: string | null; director: string | null; trailer: string | null;
  runtime: number | null; votes: number | null; top250: number | null; origLang: string | null;
  versions: VersionInfo[]; similar: TitleCard[]; collection: TitleCard[];
}
export interface Status { syncing: boolean; counts: Record<string, number>; catalogSynced: number; epgSynced: number; liveSynced: number; pairingCode: string; regions: string[]; vodLangs: string[]; tmdb: { enabled: boolean; enriched: number; pending: number; lastError: string | null }; probing: number | null; probeQueue: number }

export const api = {
  ping: () => req<{ ok: boolean }>('GET', '/api/ping'),
  pair: (code: string, name: string, kind: string) => req<{ token: string; deviceId: string }>('POST', '/api/pair', { code, name, kind }),
  status: () => req<Status>('GET', '/api/status'),
  sync: () => req('POST', '/api/sync'),
  settings: (s: { regions?: string[]; vodLangs?: string[]; tmdbKey?: string }) => req('PUT', '/api/settings', s).then(() => clearCache()),
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
  observed: (o: { id: string; width: number; height: number; fps?: number; vcodec?: string; kbps?: number }) => req('POST', '/api/observed', o),
  browse: (kind: 'movie' | 'series') => req<BrowseRow[]>('GET', `/api/browse/${kind}`),
  genres: (kind: 'movie' | 'series') => cachedGet<{ name: string; count: number }[]>(`/api/genres/${kind}`),
  titles: (kind: 'movie' | 'series', f: Record<string, string>, offset: number, limit: number) =>
    cachedGet<{ items: TitleCard[]; total: number }>(`/api/titles/${kind}?${new URLSearchParams({ ...f, offset: String(offset), limit: String(limit) })}`),
  titleSearch: (q: string, kind?: 'movie' | 'series') => cachedGet<TitleCard[]>(`/api/title-search?${new URLSearchParams({ q, ...(kind ? { kind } : {}) })}`),
  title: (tid: number) => req<TitleDetail>('GET', `/api/title/${tid}?dev=${__TIZEN__ || typeof (window as any).tizen !== 'undefined' ? 'tv' : 'desktop'}&hevc=${hevcParam()}`),
  titleOf: (itemId: string) => cachedGet<{ tid: number }>(`/api/title-of/${itemId}`),
  regions: () => req<{ enabled: string[]; all: { code: string; channels: number }[] }>('GET', '/api/regions'),
  devices: () => req<{ id: string; name: string; kind: string }[]>('GET', '/api/devices'),
  renameDevice: (id: string, name: string) => req('PUT', `/api/devices/${id}`, { name }),
  removeDevice: (id: string) => req('DELETE', `/api/devices/${id}`),
};

// ---- favorites as a reactive set (used everywhere for the star) ----
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
