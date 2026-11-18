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

/** Direct playback URLs. HLS first for live (works everywhere, CORS *), TS as fallback. */
export function streamUrls(p: Provider, item: Item): string[] {
  const n = item.id.slice(1);
  const a = `${p.user}/${p.pass}/${n}`;
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
