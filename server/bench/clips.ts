// Synthetic test clips, each aimed at one weakness of the conversion. Generated once into bench/.clips/.
// Real provider samples (captured by the prober when RELAY_SAMPLES=1) are added from data/samples/.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SourceInfo } from '../src/media.ts';

export const CLIP_DIR = resolve(import.meta.dirname, '.clips');

export interface Clip {
  name: string;
  file: string;
  info: SourceInfo;
  vod: boolean;
  /** What the clip stresses (shown in the report). */
  why: string;
  real?: boolean;
}

const SEC = 8;
const ff = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });

const SYNTH: (Omit<Clip, 'file'> & { make: (out: string) => void })[] = [
  {
    name: 'grain-1080p50-hevc10', vod: false, why: 'high motion + temporal grain (crowd/pitch), 10-bit HEVC live',
    info: { vcodec: 'hevc', width: 1920, height: 1080, fps: 50, interlaced: false, bitDepth: 10, hdr: null, acodec: 'aac', channels: 2 },
    make: (out) => ff(['-f', 'lavfi', '-i', `testsrc2=s=1920x1080:r=50,noise=alls=6:allf=t+u,format=yuv420p10le`, '-f', 'lavfi', '-i', 'sine=f=440:r=48000',
      '-t', String(SEC), '-c:v', 'hevc_nvenc', '-preset', 'p7', '-profile:v', 'main10', '-b:v', '12M', '-c:a', 'aac', '-b:a', '128k', '-f', 'mpegts', out]),
  },
  {
    name: 'gradient-1080p25-hevc10', vod: false, why: 'dark slow gradient: banding when 10-bit is cut to 8-bit',
    info: { vcodec: 'hevc', width: 1920, height: 1080, fps: 25, interlaced: false, bitDepth: 10, hdr: null, acodec: 'aac', channels: 2 },
    make: (out) => ff(['-f', 'lavfi', '-i', `color=c=black:s=1920x1080:r=25,format=yuv420p10le,geq=lum='64+180*X/W+20*sin(T/2+Y/200)':cb=512:cr=512`,
      '-f', 'lavfi', '-i', 'sine=f=330:r=48000', '-t', String(SEC), '-c:v', 'hevc_nvenc', '-preset', 'p7', '-profile:v', 'main10', '-b:v', '20M',
      '-c:a', 'aac', '-f', 'mpegts', out]),
  },
  {
    name: 'interlaced-1080i25-h264', vod: false, why: 'true 1080i: combing in browsers that do not deinterlace',
    info: { vcodec: 'h264', width: 1920, height: 1080, fps: 25, interlaced: true, bitDepth: 8, hdr: null, acodec: 'mp2', channels: 2 },
    make: (out) => ff(['-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=50', '-f', 'lavfi', '-i', 'sine=f=550:r=48000', '-t', String(SEC),
      '-vf', 'tinterlace=mode=interleave_top,setfield=tff', '-c:v', 'libx264', '-preset', 'fast', '-flags', '+ildct+ilme', '-x264opts', 'tff=1', '-crf', '16',
      '-c:a', 'mp2', '-f', 'mpegts', out]),
  },
  {
    name: 'hdr10-2160p24-hevc10', vod: true, why: '4K HDR10 movie with 5.1 AC3: tone mapping, surround, 4K speed',
    info: { vcodec: 'hevc', width: 3840, height: 2160, fps: 24, interlaced: false, bitDepth: 10, hdr: 'pq', acodec: 'ac3', channels: 6 },
    make: (out) => ff(['-f', 'lavfi', '-i', 'testsrc2=s=3840x2160:r=24', '-f', 'lavfi', '-i', 'sine=f=220:r=48000',
      '-t', String(SEC), '-filter_complex', '[1:a]pan=5.1|c0=c0|c1=c0|c2=c0|c3=c0|c4=c0|c5=c0[a]',
      '-map', '0:v', '-map', '[a]',
      '-vf', 'zscale=tin=bt709:t=smpte2084:pin=bt709:p=bt2020:min=bt709:m=bt2020nc:npl=400,format=yuv420p10le',
      '-c:v', 'hevc_nvenc', '-preset', 'p5', '-profile:v', 'main10', '-b:v', '25M',
      '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc', '-c:a', 'ac3', '-b:a', '448k', '-f', 'mpegts', out]),
  },
  {
    name: 'ac3-1080p25-h264', vod: true, why: 'H.264 movie with 5.1 AC3: audio-only conversion',
    info: { vcodec: 'h264', width: 1920, height: 1080, fps: 25, interlaced: false, bitDepth: 8, hdr: null, acodec: 'ac3', channels: 6 },
    make: (out) => ff(['-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=25', '-f', 'lavfi', '-i', 'sine=f=440:r=48000', '-t', String(SEC),
      '-filter_complex', '[1:a]pan=5.1|c0=c0|c1=c0|c2=c0|c3=c0|c4=c0|c5=c0[a]', '-map', '0:v', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-c:a', 'ac3', '-b:a', '448k', '-f', 'mpegts', out]),
  },
];

export function ensureClips(): Clip[] {
  mkdirSync(CLIP_DIR, { recursive: true });
  const out: Clip[] = [];
  for (const s of SYNTH) {
    const file = join(CLIP_DIR, `${s.name}.ts`);
    if (!existsSync(file)) { process.stderr.write(`generating ${s.name}...\n`); s.make(file); }
    const { make: _m, ...c } = s;
    out.push({ ...c, file });
  }
  return out;
}

export const REAL_DIR = resolve(import.meta.dirname, '.real');

/** Real provider samples: data/samples/<sid>.ts + <sid>.json (SourceInfo written by the prober).
 *  The prober rotates that folder while it runs, so they are first copied into bench/.real (kept between runs).
 *  Placeholders (still frames, < 400 kb/s) are skipped, and at most `perKind` clips of each codec/size/rate/scan. */
export function realClips(from = resolve(import.meta.dirname, '../data/samples'), perKind = 2): Clip[] {
  mkdirSync(REAL_DIR, { recursive: true });
  if (existsSync(from)) for (const f of readdirSync(from)) if (!existsSync(join(REAL_DIR, f))) copyFileSync(join(from, f), join(REAL_DIR, f));
  const seen = new Map<string, number>();
  return readdirSync(REAL_DIR).filter((f) => f.endsWith('.ts')).sort().flatMap((f) => {
    const meta = join(REAL_DIR, f.replace(/\.ts$/, '.json'));
    if (!existsSync(meta)) return [];
    const m = JSON.parse(readFileSync(meta, 'utf8')) as SourceInfo & { name?: string };
    const file = join(REAL_DIR, f);
    let sec = 0;
    try { sec = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString()) || 0; } catch { return []; }
    if (sec < 2 || (statSync(file).size * 8) / sec / 1000 < 400) return []; // placeholder / too short
    const kind = `${m.height}${m.interlaced ? 'i' : 'p'}${Math.round(m.fps ?? 0)}-${m.vcodec}`;
    const n = seen.get(kind) ?? 0;
    if (n >= perKind) return [];
    seen.set(kind, n + 1);
    return [{ name: `real-${f.replace(/\.ts$/, '')}-${kind}`, file, info: m, vod: false, why: m.name ?? 'provider sample', real: true }];
  });
}
