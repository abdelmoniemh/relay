// Ranking stream copies by *measured* quality (falls back to what the name claims, marked unverified).
import type { Item, RankedSource } from '../../shared/protocol.ts';

export interface Probe {
  sid: number; at: number; ok: number; width: number | null; height: number | null; fps: number | null;
  vcodec: string | null; acodec: string | null; kbps: number | null; ttfb_ms: number | null; backlog_s: number | null; err: string | null;
  interlaced?: number | null; bitdepth?: number | null; hdr?: string | null; channels?: number | null;
}


const FRESH_S = 3 * 3600;
/** A "live" stream replaying minutes of backlog is a looping slate ("no event", "coming soon"), not a broadcast. */
const LOOP_BACKLOG_S = 120;

/** Picture-quality points for bitrate, relative to what the resolution/frame rate needs (HEVC ≈ 1.6× as efficient). */
export function rateScore(kbps: number, w: number, h: number, fps: number, hevc: boolean): number {
  const bpp = (kbps * 1000 * (hevc ? 1.6 : 1)) / Math.max(1, w * h * Math.max(fps, 1));
  return 20 * Math.min(1.25, bpp / 0.08); // ~0.08 bits/pixel = clean H.264 at broadcast rates
}

export function claimed(name: string) {
  // ignore brand prefixes like "8K:" / "4K|" - they aren't the stream's quality
  const n = name.normalize('NFKC').toUpperCase().replace(/^\s*[A-Z0-9]{2,5}\s*[|:]\s*/, '');
  const height = /\b(UHD|4K|8K|3840|2160)/.test(n) ? 2160 : /\b(FHD|1080)/.test(n) ? 1080 : /\bHD\b|RAW/.test(n) ? 1080 : /\b(SD|LQ|576|480)\b/.test(n) ? 480 : 720;
  const fps = /\b(50|60)\s*FPS/.test(n) ? 50 : 25;
  return { height, fps, hevc: /HEVC|H\.?265/.test(n) };
}

const hScore = (h: number) => (h >= 2000 ? 100 : h >= 1400 ? 88 : h >= 1000 ? 80 : h >= 700 ? 55 : h >= 540 ? 35 : 20);
const hLabel = (h: number, scan = 'p') => (h >= 2000 ? '4K' : h >= 1400 ? `1440${scan}` : `${h}${scan}`);

export function rankSources(src: { item: Item; fam: number }[], probes: Map<string, Probe>, opts: { hevcOk: boolean }): RankedSource[] {
  const now = Date.now() / 1000;
  const out = src.map(({ item, fam }): RankedSource => {
    const p = probes.get(item.id);
    if (p && now - p.at < FRESH_S) {
      if (!p.ok) return { item, fam, score: -100, verified: true, dead: true, label: `Offline${p.err ? ` (${p.err.slice(0, 40)})` : ''}`, checkedAt: p.at };
      const h = p.height ?? 0, w = p.width ?? Math.round((h * 16) / 9), hevc = /hevc|h265/i.test(p.vcodec ?? '');
      const interlaced = !!p.interlaced;
      // 1080i25 carries 50 pictures a second (fields): after deinterlacing it is as smooth as 50p.
      const fps = Math.round((p.fps ?? 25) * (interlaced ? 2 : 1));
      if ((p.kbps ?? 0) < 400 || (p.backlog_s ?? 0) > LOOP_BACKLOG_S) {
        // A still image / "no event" slate, or a loop: technically up, nothing to watch.
        return { item, fam, score: -50, verified: true, height: h, fps, kbps: p.kbps ?? undefined, checkedAt: p.at, dead: true, label: 'No signal (placeholder)' };
      }
      let score = hScore(h) + (fps >= 48 ? 12 : 0) + rateScore(p.kbps ?? 0, w, h, fps, hevc) - Math.min((p.ttfb_ms ?? 0) / 200, 10) + 5;
      if (hevc && !opts.hevcOk) score -= 6; // needs server-side conversion: ~1s slower start
      if (interlaced) score -= 3;           // deinterlacing is good, but a native progressive copy is better
      return {
        item, fam, score, verified: true, height: h, fps, kbps: p.kbps ?? undefined, hevc, interlaced, ttfb: p.ttfb_ms ?? undefined, checkedAt: p.at,
        label: `${hLabel(h, interlaced ? 'i' : 'p')}${fps} · ${((p.kbps ?? 0) / 1000).toFixed(1)} Mb/s${hevc ? ' · HEVC' : ''}`,
      };
    }
    const c = claimed(item.name);
    let score = hScore(c.height) + (c.fps >= 48 ? 12 : 0) - 15;
    if (c.hevc && !opts.hevcOk) score -= 6;
    return { item, fam, score, verified: false, height: c.height, hevc: c.hevc, label: `claims ${hLabel(c.height)}${c.hevc ? ' HEVC' : ''}` };
  });
  return out.sort((a, b) => b.score - a.score);
}
