import type { Item, Programme } from '@shared/protocol.ts';
import { clock, img } from '../env.ts';
import { favorites } from '../api.ts';

export function Logo({ src, name, size = 40 }: { src?: string | null; name: string; size?: number }) {
  return src
    ? <img class="logo" src={src} width={size} height={size} loading="lazy" decoding="async" alt="" onError={(e) => ((e.currentTarget as HTMLImageElement).style.visibility = 'hidden')} />
    : <div class="logo ph" style={{ width: size, height: size }}>{name.replace(/^[A-Z]{2,3}\s*[|:-]\s*/, '').slice(0, 2)}</div>;
}

export function Poster({ item, w = 185 }: { item: Item; w?: 154 | 185 | 342 }) {
  const src = img(item.icon, w);
  return src
    ? <img class="poster" src={src} loading="lazy" decoding="async" alt="" onError={(e) => ((e.currentTarget as HTMLImageElement).style.opacity = '0')} />
    : <div class="poster ph">{item.name.slice(0, 1)}</div>;
}

export function Star({ id }: { id: string }) {
  return favorites.value.has(id) ? <span class="star">★</span> : null;
}

export function ProgBar({ p, d }: { p: number; d: number }) {
  if (!d) return null;
  return <div class="bar"><i style={{ width: `${Math.min(100, (p / d) * 100)}%` }} /></div>;
}

export function NowLine({ list }: { list?: Programme[] }) {
  const p = list?.[0];
  if (!p) return null;
  const now = Date.now() / 1000;
  return (
    <div class="now">
      <span class="t">{clock(p.start)}</span> {p.title}
      <div class="bar thin"><i style={{ width: `${Math.max(0, Math.min(100, ((now - p.start) / (p.stop - p.start)) * 100))}%` }} /></div>
    </div>
  );
}

/** Strip provider prefixes like "UK| " or "NL - " for display. */
export const clean = (s: string) => s.replace(/^([A-Z0-9]{2,4}|4K)\s*[|:]\s*/, '').replace(/^[A-Z]{2,3} - /, '');
