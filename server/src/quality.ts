// Ranking stream copies by *measured* quality (falls back to what the name claims, marked unverified).
import type { Item } from '../../shared/protocol.ts';

export interface Probe {
  sid: number; at: number; ok: number; width: number | null; height: number | null; fps: number | null;
  vcodec: string | null; acodec: string | null; kbps: number | null; ttfb_ms: number | null; backlog_s: number | null; err: string | null;
}

export interface RankedSource {
  item: Item;
  fam: number;
  score: number;
  verified: boolean;
  label: string;  // "1080p50 · 8.1 Mb/s" / "HD (unverified)" / "Offline"
  dead?: boolean;
  height?: number; fps?: number; kbps?: number; hevc?: boolean; ttfb?: number; checkedAt?: number;
}

const FRESH_S = 3 * 3600;

function claimed(name: string) {
  // ignore brand prefixes like "8K:" / "4K|" - they aren't the stream's quality
  const n = name.normalize('NFKC').toUpperCase().replace(/^\s*[A-Z0-9]{2,5}\s*[|:]\s*/, '');
  const height = /\b(UHD|4K|8K|3840|2160)/.test(n) ? 2160 : /\b(FHD|1080)/.test(n) ? 1080 : /\bHD\b|RAW/.test(n) ? 1080 : /\b(SD|LQ|576|480)\b/.test(n) ? 480 : 720;
  const fps = /\b(50|60)\s*FPS/.test(n) ? 50 : 25;
  return { height, fps, hevc: /HEVC|H\.?265/.test(n) };
}

const hScore = (h: number) => (h >= 2000 ? 100 : h >= 1400 ? 88 : h >= 1000 ? 80 : h >= 700 ? 55 : h >= 540 ? 35 : 20);
const hLabel = (h: number) => (h >= 2000 ? '4K' : h >= 1400 ? '1440p' : `${h}p`);

export function rankSources(src: { item: Item; fam: number }[], probes: Map<number, Probe>, opts: { hevcOk: boolean }): RankedSource[] {
  const now = Date.now() / 1000;
  const out = src.map(({ item, fam }): RankedSource => {
    const p = probes.get(Number(item.id.slice(1)));
    if (p && now - p.at < FRESH_S) {
      if (!p.ok) return { item, fam, score: -100, verified: true, dead: true, label: `Offline${p.err ? ` (${p.err.slice(0, 40)})` : ''}`, checkedAt: p.at };
      const h = p.height ?? 0, fps = Math.round(p.fps ?? 25), hevc = /hevc|h265/i.test(p.vcodec ?? '');
      if ((p.kbps ?? 0) < 400) {
        // A still image / "no event" slate: technically up, nothing to watch.
        return { item, fam, score: -50, verified: true, height: h, fps, kbps: p.kbps ?? undefined, checkedAt: p.at, dead: true, label: 'No signal (placeholder)' };
      }
      let score = hScore(h) + (fps >= 48 ? 12 : 0) + Math.min((p.kbps ?? 0) / 1000, 20) - Math.min((p.ttfb_ms ?? 0) / 200, 10) + 5;
      if (hevc && !opts.hevcOk) score -= 6; // needs server-side conversion: ~1s slower start
      return {
        item, fam, score, verified: true, height: h, fps, kbps: p.kbps ?? undefined, hevc, ttfb: p.ttfb_ms ?? undefined, checkedAt: p.at,
        label: `${hLabel(h)}${fps} · ${((p.kbps ?? 0) / 1000).toFixed(1)} Mb/s${hevc ? ' · HEVC' : ''}`,
      };
    }
    const c = claimed(item.name);
    let score = hScore(c.height) + (c.fps >= 48 ? 12 : 0) - 15;
    if (c.hevc && !opts.hevcOk) score -= 6;
    return { item, fam, score, verified: false, height: c.height, hevc: c.hevc, label: `claims ${hLabel(c.height)}${c.hevc ? ' HEVC' : ''}` };
  });
  return out.sort((a, b) => b.score - a.score);
}
