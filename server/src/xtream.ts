import type { Provider } from './config.ts';
import type { Item } from '../../shared/protocol.ts';

const UA = 'Relay/1.0 (like VLC/3.0.20)';

export function apiUrl(p: Provider, action?: string, extra: Record<string, string> = {}) {
  const q = new URLSearchParams({ username: p.user, password: p.pass, ...(action ? { action } : {}), ...extra });
  return `${p.base}/player_api.php?${q}`;
}

export async function getJson<T = any>(url: string, timeoutMs = 120_000): Promise<T> {
  const res = await fetch(url, { headers: { 'user-agent': UA, 'accept-encoding': 'gzip' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.replace(/password=[^&]+/, 'password=***')}`);
  return (await res.json()) as T;
}

export async function getStream(url: string, timeoutMs = 300_000) {
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for EPG`);
  return res.body;
}

/** The provider's timezone: archive (timeshift) URLs take a start time on its local clock. */
let providerTz = 'UTC';
export function setProviderTz(tz: string) { if (tz) providerTz = tz; }

/**
 * A channel's archive from `start` (unix seconds; whole minutes only) for `minutes`.
 * Format: /timeshift/<user>/<pass>/<minutes>/<YYYY-MM-DD:HH-MM>/<stream>.ts
 */
export function timeshiftUrl(p: Provider, sid: string | number, start: number, minutes: number, tz = providerTz): string {
  const d = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(start * 1000)).map((x) => [x.type, x.value]));
  return `${p.base}/timeshift/${p.user}/${p.pass}/${Math.max(1, Math.ceil(minutes))}/${d.year}-${d.month}-${d.day}:${d.hour}-${d.minute}/${sid}.ts`;
}

/**
 * Catch-up stream from `at` seconds into a programme: the provider only starts on whole minutes, so this is
 * the URL from the minute before, plus the seconds to skip. Ends at the programme's end (or now, if it's on air).
 */
export function catchupSource(p: Provider, sid: string | number, prog: { start: number; stop: number }, at = 0, now = Date.now() / 1000) {
  const from = prog.start + Math.max(0, at);
  const minute = Math.floor(from / 60) * 60;
  return { url: timeshiftUrl(p, sid, minute, (Math.min(prog.stop, now) - minute) / 60), skip: from - minute };
}

/** Direct playback URLs. HLS first for live (works everywhere, CORS *), TS as fallback. */
export function streamUrls(p: Provider, item: Item): string[] {
  const n = item.id.slice(1);
  const a = `${p.user}/${p.pass}/${n}`;
  if (item.kind === 'live' && item.catchup) return [catchupSource(p, n, item.catchup).url];
  switch (item.kind) {
    case 'live':
      return [`${p.base}/live/${a}.m3u8`, `${p.base}/live/${a}.ts`];
    case 'movie':
      return [`${p.base}/movie/${a}.${item.ext || 'mp4'}`];
    case 'episode':
      return [`${p.base}/series/${a}.${item.ext || 'mp4'}`];
    default:
      return [];
  }
}

export function xmltvUrl(p: Provider) {
  return `${p.base}/xmltv.php?username=${encodeURIComponent(p.user)}&password=${encodeURIComponent(p.pass)}`;
}
