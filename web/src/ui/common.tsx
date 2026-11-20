import type { Programme } from '@shared/protocol.ts';
import { clock } from '../env.ts';
import { displayName } from '@shared/domain.ts';

export function Logo({ src, name, size = 40 }: { src?: string | null; name: string; size?: number }) {
  return src
    ? <img class="logo" src={src} width={size} height={size} loading="lazy" decoding="async" alt="" onError={(e) => ((e.currentTarget as HTMLImageElement).style.visibility = 'hidden')} />
    : <div class="logo ph" style={{ width: size, height: size }}>{displayName(name).slice(0, 2)}</div>;
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
      <span class="t tnum">{clock(p.start)}</span> {p.title}
      <div class="bar thin"><i style={{ width: `${Math.max(0, Math.min(100, ((now - p.start) / (p.stop - p.start)) * 100))}%` }} /></div>
    </div>
  );
}
