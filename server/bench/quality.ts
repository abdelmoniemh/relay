// Quality bench: runs candidate conversion settings over test clips and measures what matters for watching:
//   VMAF (vs an ideal reference: same clip processed on the CPU with the best filters, no encode),
//   CAMBI (banding, lower is better), combing (% of output frames idet still sees as interlaced),
//   speed (x real time), time to first byte, output bitrate, audio layout.
// Usage: node bench/quality.ts [--clip <substr>] [--cand <substr>] [--real] [--json out.json]
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ensureClips, realClips, type Clip } from './clips.ts';
import { transcodeArgs, videoFilter, outFps, LEGACY, LIVE, VOD, type EncoderProfile, type TxOpts, type SourceInfo } from '../src/media.ts';

export const OUT_DIR = resolve(import.meta.dirname, '.out');

export interface Candidate {
  name: string;
  profile: EncoderProfile;
  mode?: 'full' | 'audio';
  /** What the production code would know about the source. Legacy knew nothing. */
  info?: (c: Clip) => SourceInfo | null;
  opts?: Partial<TxOpts>;
  only?: (c: Clip) => boolean;
}

export interface Result {
  clip: string; cand: string; ok: boolean; err?: string;
  vmaf?: number; vmaf1?: number; cambi?: number; combed?: number; speed?: number; ttfbMs?: number; mbps?: number;
  frames?: number; fps?: number; acodec?: string; channels?: number; audible?: boolean; file?: string; args?: string[];
}

const P = (base: EncoderProfile, over: Partial<EncoderProfile>): EncoderProfile => ({ ...base, ...over, name: over.name ?? base.name });
const notAudio = (c: Clip) => c.name !== 'ac3-1080p25-h264';
const is10 = (c: Clip) => (c.info.bitDepth ?? 8) > 8 && !c.info.hdr;

export const CANDIDATES: Candidate[] = [
  { name: 'legacy', profile: LEGACY, info: () => null, opts: { dither: 'truncate' }, only: notAudio },
  { name: 'new', profile: LIVE, only: (c) => notAudio(c) && !c.vod },
  { name: 'new-vod', profile: VOD, only: (c) => notAudio(c) && c.vod },
  // encoder sweeps (live clips)
  { name: 'p5', profile: P(LIVE, { preset: 'p5' }), only: (c) => !c.vod && !c.info.hdr },
  { name: 'p6', profile: P(LIVE, { preset: 'p6' }), only: (c) => !c.vod && !c.info.hdr },
  { name: 'p7', profile: P(LIVE, { preset: 'p7' }), only: (c) => !c.vod && !c.info.hdr },
  { name: 'cq17', profile: P(LIVE, { cq: 17 }), only: (c) => !c.vod },
  { name: 'cq21', profile: P(LIVE, { cq: 21 }), only: (c) => !c.vod },
  { name: 'no-lookahead', profile: P(LIVE, { lookahead: 0 }), only: (c) => !c.vod },
  { name: 'no-bframes', profile: P(LIVE, { bf: 0 }), only: (c) => !c.vod },
  { name: 'no-aq', profile: P(LIVE, { aq: false }), only: (c) => !c.vod },
  { name: 'p5-ll', profile: P(LIVE, { tune: 'll', lookahead: 0, bf: 0 }), only: (c) => !c.vod },
  // 10-bit -> 8-bit
  { name: 'dither-truncate', profile: LIVE, opts: { dither: 'truncate' }, only: is10 },
  { name: 'dither-swscale', profile: LIVE, opts: { dither: 'swscale' }, only: is10 },
  // deinterlacing
  { name: 'deint-frame', profile: LIVE, opts: { deintFrame: true }, only: (c) => !!c.info.interlaced },
  // movies
  { name: 'vod-p5', profile: P(VOD, { preset: 'p5', multipass: 'disabled' }), only: (c) => c.vod && notAudio(c) },
  { name: 'vod-cq16', profile: P(VOD, { cq: 16 }), only: (c) => c.vod && notAudio(c) },
  // audio-only conversion
  { name: 'audio-legacy', profile: LEGACY, mode: 'audio', info: () => null, only: (c) => !notAudio(c) },
  { name: 'audio-new', profile: VOD, mode: 'audio', only: (c) => !notAudio(c) },
];

function run(cmd: string, args: string[]): Promise<{ out: string; err: string; code: number | null }> {
  return new Promise((res) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => res({ out, err, code }));
  });
}

/** Encode with exactly the production arguments, streaming to a file (measures time to first byte like the API does). */
async function encode(clip: Clip, cand: Candidate, file: string, gpu: boolean) {
  const info = cand.info ? cand.info(clip) : clip.info;
  const args = transcodeArgs(clip.file, { gpu, bench: true, vod: clip.vod, mode: cand.mode ?? 'full', info, profile: cand.profile, ...cand.opts });
  const t0 = performance.now();
  let first = 0;
  const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const ws = createWriteStream(file);
  let err = '';
  p.stderr.on('data', (d) => (err = (err + d).slice(-3000)));
  p.stdout.once('data', () => { first = performance.now(); });
  p.stdout.pipe(ws);
  const code: number | null = await new Promise((r) => p.on('close', r));
  await new Promise((r) => ws.close(r));
  return { args, code, err: err.trim(), ttfbMs: Math.round(first - t0), wall: (performance.now() - t0) / 1000 };
}

async function streamInfo(file: string) {
  const r = await run('ffprobe', ['-v', 'error', '-of', 'json', '-count_packets', '-show_entries',
    'stream=codec_type,codec_name,channels,nb_read_packets,avg_frame_rate:format=duration', file]);
  const j = JSON.parse(r.out || '{}');
  const v = (j.streams ?? []).find((s: any) => s.codec_type === 'video');
  const a = (j.streams ?? []).find((s: any) => s.codec_type === 'audio');
  const [n, d] = String(v?.avg_frame_rate ?? '0/1').split('/').map(Number);
  return { frames: Number(v?.nb_read_packets ?? 0), fps: d ? n / d : 0, dur: Number(j.format?.duration ?? 0), acodec: a?.codec_name, channels: a?.channels };
}

async function combing(file: string): Promise<number> {
  const r = await run('ffmpeg', ['-hide_banner', '-i', file, '-an', '-vf', 'idet', '-f', 'null', '-']);
  // ffmpeg 9 prints the summary twice (the first from a discarded graph, all zeros): use the last one.
  const m = [...r.err.matchAll(/Multi frame detection: TFF:\s*(\d+)\s*BFF:\s*(\d+)\s*Progressive:\s*(\d+)\s*Undetermined:\s*(\d+)/g)].pop();
  if (!m) return NaN;
  const [t, b, p, u] = m.slice(1).map(Number);
  return +(100 * (t + b) / Math.max(1, t + b + p + u)).toFixed(1);
}

async function audible(file: string): Promise<boolean> {
  const r = await run('ffmpeg', ['-hide_banner', '-i', file, '-vn', '-af', 'astats=measure_overall=RMS_level:measure_perchannel=none', '-f', 'null', '-']);
  const m = /RMS level dB:\s*(-?[\d.]+|-inf)/.exec(r.err);
  return !!m && m[1] !== '-inf' && Number(m[1]) > -60;
}

/** VMAF + CAMBI vs the ideal reference, both scaled to 1080p. */
async function vmaf(clip: Clip, file: string, outRate: number) {
  const ideal = videoFilter(clip.info, { gpu: false, dither: 'error_diffusion' });
  const refFps = outFps(clip.info);
  // Compare raw planes: identical colour tags on both sides stop ffmpeg from colour-converting one input.
  const fit = 'scale=1920:1080:flags=bicubic,format=yuv420p,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709,setpts=PTS-STARTPTS';
  const log = `${file}.vmaf.json`;
  const graph = `[0:v]${Math.abs(outRate - refFps) > 0.5 ? `fps=${refFps},` : ''}${fit}[d];[1:v]${ideal},${fit}[r];`
    + `[d][r]libvmaf=log_fmt=json:log_path=${log}:n_threads=16:feature=name=cambi`;
  const r = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-i', clip.file, '-lavfi', graph, '-f', 'null', '-']);
  if (r.code !== 0) throw new Error(`vmaf: ${r.err.trim().split('\n').pop()}`);
  const j = JSON.parse((await import('node:fs')).readFileSync(log, 'utf8'));
  const frames = (j.frames ?? []).map((f: any) => f.metrics.vmaf as number).sort((a: number, b: number) => a - b);
  return { vmaf: +j.pooled_metrics.vmaf.mean.toFixed(2), vmaf1: +(frames[Math.floor(frames.length * 0.01)] ?? 0).toFixed(2), cambi: +j.pooled_metrics.cambi.mean.toFixed(3) };
}

export async function bench(opts: { clip?: string; cand?: string; real?: boolean; gpu?: boolean } = {}): Promise<Result[]> {
  mkdirSync(OUT_DIR, { recursive: true });
  const gpu = opts.gpu ?? true;
  const clips = [...ensureClips(), ...(opts.real ? realClips() : [])].filter((c) => !opts.clip || c.name.includes(opts.clip));
  const results: Result[] = [];
  for (const clip of clips) {
    const srcDur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', clip.file], { encoding: 'utf8' }));
    for (const cand of CANDIDATES) {
      if (cand.only && !cand.only(clip) && !(clip.real && ['legacy', 'new'].includes(cand.name))) continue;
      if (clip.real && cand.only && !cand.only(clip) ) continue;
      if (opts.cand && !cand.name.includes(opts.cand)) continue;
      const file = join(OUT_DIR, `${clip.name}__${cand.name}.ts`);
      const res: Result = { clip: clip.name, cand: cand.name, ok: false, file };
      try {
        const e = await encode(clip, cand, file, gpu);
        res.args = e.args;
        if (e.code !== 0) throw new Error(e.err.split('\n').pop() || `exit ${e.code}`);
        const si = await streamInfo(file);
        Object.assign(res, { ttfbMs: e.ttfbMs, speed: +(srcDur / e.wall).toFixed(2), frames: si.frames, fps: +si.fps.toFixed(2),
          mbps: +((statSync(file).size * 8) / Math.max(0.1, si.dur || srcDur) / 1e6).toFixed(2), acodec: si.acodec, channels: si.channels });
        res.audible = await audible(file);
        if (cand.mode !== 'audio') {
          Object.assign(res, await vmaf(clip, file, si.fps));
          if (clip.info.interlaced) res.combed = await combing(file);
        }
        res.ok = true;
      } catch (err) { res.err = (err as Error).message.slice(0, 200); }
      results.push(res);
      process.stderr.write(`${fmt(res)}\n`);
    }
  }
  return results;
}

const pad = (s: unknown, n: number) => String(s ?? '').padEnd(n);
export function fmt(r: Result) {
  if (!r.ok) return `${pad(r.clip, 28)} ${pad(r.cand, 16)} FAILED ${r.err}`;
  return `${pad(r.clip, 28)} ${pad(r.cand, 16)} vmaf ${pad(r.vmaf ?? '-', 6)} 1%low ${pad(r.vmaf1 ?? '-', 6)} cambi ${pad(r.cambi ?? '-', 6)} combed ${pad(r.combed ?? '-', 5)}% `
    + `speed ${pad(r.speed + 'x', 7)} ttfb ${pad(r.ttfbMs + 'ms', 7)} ${pad(r.mbps + 'Mb/s', 10)} ${r.fps}fps ${r.acodec ?? '-'}/${r.channels ?? '-'}ch${r.audible ? '' : ' SILENT'}`;
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const arg = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const results = await bench({ clip: arg('--clip'), cand: arg('--cand'), real: a.includes('--real'), gpu: !a.includes('--cpu') });
  const path = arg('--json') ?? join(OUT_DIR, 'results.json');
  writeFileSync(path, JSON.stringify(results, null, 1));
  console.log(`\n${results.length} runs, ${results.filter((r) => !r.ok).length} failed -> ${path}`);
}
