// The IPTV provider (Xtream Codes API): every URL it serves, how we identify ourselves, and its clock.
import type { Item } from '../../shared/protocol.ts';

/** Sent on every request to the provider: some refuse unknown clients. */
export const USER_AGENT = 'Relay/1.0 (like VLC/3.0.20)';

export interface ProviderCreds {
  base: string; // e.g. http://host:port
  user: string;
  pass: string;
}

/** What's needed to find something's stream: a catalog item, or a channel's archive programme. */
export type StreamRef = Pick<Item, 'id' | 'kind'> & { ext?: string | null; catchup?: Item['catchup'] };

/** A provider rating out of 5 (it sends `rating_5based`, or only `rating` out of 10). */
export function rating5(x: { rating_5based?: unknown; rating?: unknown }): number | null {
  const five = Number(x.rating_5based), ten = Number(x.rating);
  return five > 0 ? five : ten > 0 ? ten / 2 : null;
}

export class Provider {
  readonly creds: ProviderCreds;
  /** Archive (timeshift) URLs take a start time on the provider's local clock. */
  timezone: string;

  constructor(creds: ProviderCreds, timezone = 'UTC') {
    this.creds = creds;
    this.timezone = timezone;
  }

  api(action?: string, extra: Record<string, string> = {}) {
    const q = new URLSearchParams({ username: this.creds.user, password: this.creds.pass, ...(action ? { action } : {}), ...extra });
    return `${this.creds.base}/player_api.php?${q}`;
  }
  async json<T = any>(action?: string, extra: Record<string, string> = {}, timeoutMs = 120_000): Promise<T> {
    const url = this.api(action, extra);
    const res = await fetch(url, { headers: { 'user-agent': USER_AGENT, 'accept-encoding': 'gzip' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.replace(/password=[^&]+/, 'password=***')}`);
    return (await res.json()) as T;
  }
  /** Reads the provider's timezone (server_info.timezone). */
  async loadTimezone(): Promise<string> {
    const tz = (await this.json<any>(undefined, {}, 15_000))?.server_info?.timezone;
    if (typeof tz !== 'string' || !tz) throw new Error('no server_info.timezone');
    this.timezone = tz;
    return tz;
  }

  // ---- files ----
  xmltv() { return `${this.creds.base}/xmltv.php?username=${encodeURIComponent(this.creds.user)}&password=${encodeURIComponent(this.creds.pass)}`; }
  /** Downloads a large body (the guide). */
  async download(url: string, timeoutMs = 300_000) {
    const res = await fetch(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url.replace(/\/[^/]+\/[^/]+\/(\d+)/, '/***/***/$1').replace(/password=[^&]+/, 'password=***')}`);
    return res.body;
  }
  private path(kind: string, sid: string | number, ext: string) { return `${this.creds.base}/${kind}/${this.creds.user}/${this.creds.pass}/${sid}.${ext}`; }
  live(sid: string | number, fmt: 'ts' | 'm3u8' = 'ts') { return this.path('live', sid, fmt); }

  /**
   * A channel's archive from `start` (unix seconds; whole minutes only) for `minutes`.
   * Format: /timeshift/<user>/<pass>/<minutes>/<YYYY-MM-DD:HH-MM>/<stream>.ts
   */
  timeshift(sid: string | number, start: number, minutes: number): string {
    const d = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: this.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(start * 1000)).map((x) => [x.type, x.value]));
    return `${this.creds.base}/timeshift/${this.creds.user}/${this.creds.pass}/${Math.max(1, Math.ceil(minutes))}/${d.year}-${d.month}-${d.day}:${d.hour}-${d.minute}/${sid}.ts`;
  }
  /**
   * Catch-up from `at` seconds into a programme: the provider only starts on whole minutes, so this is the URL
   * from the minute before, plus the seconds to skip. Ends at the programme's end (or now, if it's on air).
   */
  catchup(sid: string | number, prog: { start: number; stop: number }, at = 0, now = Date.now() / 1000) {
    const from = prog.start + Math.max(0, at);
    const minute = Math.floor(from / 60) * 60;
    return { url: this.timeshift(sid, minute, (Math.min(prog.stop, now) - minute) / 60), skip: from - minute };
  }

  /** Direct playback URLs for a device. Live: HLS first (works everywhere, CORS *), TS as fallback. */
  urls(ref: StreamRef): string[] {
    const sid = ref.id.slice(1);
    if (ref.kind === 'live' && ref.catchup) return [this.catchup(sid, ref.catchup).url];
    switch (ref.kind) {
      case 'live': return [this.live(sid, 'm3u8'), this.live(sid, 'ts')];
      case 'movie': return [this.path('movie', sid, ref.ext || 'mp4')];
      case 'episode': return [this.path('series', sid, ref.ext || 'mp4')];
      default: return [];
    }
  }
  /** The one URL the server itself reads: live as one continuous TS connection, a file as itself. */
  source(ref: StreamRef): string {
    const u = this.urls(ref);
    return ref.kind === 'live' && !ref.catchup ? (u.find((x) => x.endsWith('.ts')) ?? u[0]) : u[0];
  }
}
