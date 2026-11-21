import type { DeviceKind } from '@shared/protocol.ts';
import { t } from './i18n.ts';

export const isTizen = __TIZEN__ || typeof window.tizen !== 'undefined';
export const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isMobile = isIOS || /Android|Mobile/.test(navigator.userAgent);
/** Can this device decode HEVC itself? TV hardware and Apple devices can; most desktop browsers can't. */
export const canHevc = isTizen || (() => {
  try { return ['hvc1.1.6.L120.90', 'hvc1.2.4.L153.B0'].some((c) => MediaSource.isTypeSupported(`video/mp4; codecs="${c}"`)); } catch { return false; }
})();
export const deviceKind: DeviceKind = isTizen ? 'tv' : isMobile ? 'phone' : 'desktop';
export const defaultName = isTizen ? 'Samsung TV' : isIOS ? 'iPhone' : isMobile ? 'Phone' : 'Linux PC';

/** TMDB images can be fetched at any size: never download 600px+ posters for 180px tiles. */
export function img(url: string | null | undefined, w: 92 | 154 | 185 | 342 | 500 | 780 | 1280 = 185) {
  if (!url) return undefined;
  return url.replace(/(image\.tmdb\.org\/t\/p\/)[^/]+\//, `$1w${w}/`);
}

export const fmtTime = (s: number) => {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + ':' + String(sec).padStart(2, '0');
};
export const clock = (unix: number) => new Date(unix * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
/** "Today", "Yesterday", "Tomorrow", else "Sat 22 Nov". */
export function dayLabel(unix: number) {
  const d = new Date(unix * 1000), now = new Date();
  const off = (n: number) => { const x = new Date(now); x.setDate(now.getDate() + n); return x; };
  if (sameDay(d, now)) return t('Today');
  if (sameDay(d, off(-1))) return t('Yesterday');
  if (sameDay(d, off(1))) return t('Tomorrow');
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}
/** A start time: "20:00" today, else "Tomorrow 20:00" / "Sat 22 Nov 20:00". */
export const startsAt = (unix: number) => { const d = new Date(unix * 1000); return sameDay(d, new Date()) ? clock(unix) : `${dayLabel(unix)} ${clock(unix)}`; };
