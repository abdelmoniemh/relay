// Pure ffmpeg command building for the browser conversion (HEVC / interlaced / HDR / AC3 -> H.264 + AAC in MPEG-TS).
// Kept free of side effects so the quality bench (bench/quality.ts) and the tests exercise exactly what production runs.

/** What we know about a source before opening it (from the prober / movie probe). Unknown fields = null. */
export interface SourceInfo {
  vcodec?: string | null;
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  interlaced?: boolean | null;
  bitDepth?: number | null;
  /** 'pq' (HDR10 / Dolby Vision with HDR10 base), 'hlg', or null for SDR / unknown. */
  hdr?: 'pq' | 'hlg' | null;
  acodec?: string | null;
  channels?: number | null;
}

export interface EncoderProfile {
  name: string;
  preset: string;          // NVENC p1..p7
  tune: 'hq' | 'll' | 'ull';
  bf: number;              // B-frames
  bref: 'disabled' | 'middle' | 'each';
  lookahead: number;       // frames (0 = off)
  aq: boolean;             // spatial + temporal AQ
  multipass: 'disabled' | 'qres' | 'fullres';
  cq: number;
  maxrateM: number;
  gopSec: number;
  x264Preset: string;      // software fallback
  crf: number;
}

/** The previous production settings, kept for comparison in the bench. */
export const LEGACY: EncoderProfile = {
  name: 'legacy', preset: 'p2', tune: 'll', bf: 0, bref: 'disabled', lookahead: 0, aq: false, multipass: 'disabled',
  cq: 22, maxrateM: 25, gopSec: 1, x264Preset: 'veryfast', crf: 22,
};

// Chosen with bench/quality.ts — see bench/README.md for the numbers behind them.
export const LIVE: EncoderProfile = {
  name: 'live', preset: 'p4', tune: 'hq', bf: 3, bref: 'middle', lookahead: 20, aq: true, multipass: 'disabled',
  cq: 19, maxrateM: 30, gopSec: 2, x264Preset: 'faster', crf: 19,
};
/** Data saver (away from home / mobile data): 720p at ~3 Mbps. */
export const MOBILE: EncoderProfile = {
  name: 'mobile', preset: 'p4', tune: 'hq', bf: 2, bref: 'middle', lookahead: 16, aq: true, multipass: 'disabled',
  cq: 27, maxrateM: 3, gopSec: 2, x264Preset: 'veryfast', crf: 26,
};
export const MOBILE_H = 720;
export const VOD: EncoderProfile = {
  name: 'vod', preset: 'p7', tune: 'hq', bf: 3, bref: 'middle', lookahead: 32, aq: true, multipass: 'qres',
  cq: 18, maxrateM: 40, gopSec: 2, x264Preset: 'medium', crf: 18,
};

export type TxMode = 'full' | 'audio';
export type Dither = 'truncate' | 'swscale' | 'error_diffusion';

export interface TxOpts {
  gpu: boolean;
  startAt?: number;
  vod?: boolean;
  mode?: TxMode;
  info?: SourceInfo | null;
  profile?: EncoderProfile;
  /** Bench: read the input as fast as possible (no real-time pacing, no network options). */
  bench?: boolean;
  /** 10-bit -> 8-bit conversion method. */
  dither?: Dither;
  /** Only send frames for one field-pair (25p) instead of one per field (50p) when deinterlacing. */
  deintFrame?: boolean;
  /** Audio track (0-based among audio streams) to keep; default the first. */
  audio?: number;
  /** Seconds to drop from the start of the output (catch-up: the provider only starts on whole minutes). */
  skip?: number;
  /** Data saver: picture no taller than this (with the MOBILE profile). */
  maxHeight?: number;
}

import { USER_AGENT as UA } from './xtream.ts';

/** Tallest picture we tone map in real time (see videoFilter). */
export const HDR_MAX_H = 1440;

export const isHdr = (i?: SourceInfo | null) => i?.hdr === 'pq' || i?.hdr === 'hlg';
const is10 = (i?: SourceInfo | null) => (i?.bitDepth ?? 8) > 8;

/** Output frame rate after deinterlacing (bwdif send_field doubles it). */
export function outFps(info: SourceInfo | null | undefined, o: Pick<TxOpts, 'deintFrame'> = {}): number {
  const f = info?.fps && info.fps > 0 ? info.fps : 25;
  return info?.interlaced && !o.deintFrame ? f * 2 : f;
}

/** Video filter chain. GPU frames stay on the GPU unless a CPU-only step (tone mapping, dithering) is needed. */
export function videoFilter(info: SourceInfo | null | undefined, o: Pick<TxOpts, 'gpu' | 'dither' | 'deintFrame' | 'maxHeight'>): string {
  const maxH = o.maxHeight ?? 0;
  const cap = maxH ? Math.min(HDR_MAX_H, maxH) : HDR_MAX_H;
  /** Data saver: never taller than maxHeight (keeps smaller pictures as they are). */
  const fit = (f: 'scale' | 'scale_cuda', extra = '') => `${f}=w=-2:h='min(ih,${maxH})'${extra}`;
  const deint = info?.interlaced ? (o.deintFrame ? 'send_frame' : 'send_field') : null;
  const dither = o.dither ?? 'swscale'; // bench: CAMBI 5.8 vs 8.6 (error diffusion) at 1/3 the bitrate
  // HDR -> SDR BT.709, tone mapped with hable (keeps highlight detail). Ordered dither, not error diffusion: that is
  // serial and halves the speed, and the bench shows no banding advantage after encoding.
  const tonemap = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,'
    + 'zscale=t=bt709:m=bt709:r=tv:dither=ordered,format=yuv420p';
  // CPU tone mapping can't keep up with 4K (0.6x real time on 16 cores): map at 1440p, scaled down on the GPU first (1.4x).
  const hdrCap = isHdr(info) && ((info?.height ?? 0) > cap || (!!maxH && !info?.height));
  const to8 = dither === 'error_diffusion' ? 'zscale=dither=error_diffusion,format=yuv420p' : 'format=yuv420p';
  if (o.gpu) {
    const parts: string[] = [];
    if (deint) parts.push(`bwdif_cuda=mode=${deint}:parity=auto:deint=all`);
    if (isHdr(info)) parts.push(...(hdrCap ? [maxH ? `scale_cuda=w=-2:h='min(ih,${cap})':format=p010le:interp_algo=lanczos` : `scale_cuda=-2:${HDR_MAX_H}:format=p010le:interp_algo=lanczos`] : []), 'hwdownload', 'format=p010le', tonemap);
    else if (is10(info) && dither !== 'truncate') parts.push(...(maxH ? [fit('scale_cuda', ':format=p010le:interp_algo=lanczos')] : []), 'hwdownload', 'format=p010le', to8);
    else parts.push(maxH ? fit('scale_cuda', ':format=nv12:interp_algo=lanczos') : 'scale_cuda=format=nv12');
    return parts.join(',');
  }
  const parts: string[] = [];
  if (deint) parts.push(`bwdif=mode=${deint}:parity=auto:deint=all`);
  if (isHdr(info)) parts.push(...(hdrCap ? [`zscale=w=-2:h=${maxH ? Math.min(cap, info?.height || cap) : HDR_MAX_H}:f=lanczos`] : []), tonemap);
  else if (is10(info) && dither === 'error_diffusion') parts.push(...(maxH ? [fit('scale')] : []), to8);
  else parts.push(maxH ? fit('scale', ':flags=lanczos') : "scale=w='min(iw,3840)':h=-2", 'format=yuv420p');
  return parts.join(',');
}

export function audioArgs(info: SourceInfo | null | undefined, vod: boolean): string[] {
  if (info?.acodec === 'aac') return ['-c:a', 'copy'];
  const ch = Math.min(6, Math.max(1, info?.channels ?? 2));
  const surround = ch > 2;
  return [
    ...(vod ? [] : ['-af', 'aresample=async=1:first_pts=0']), // live: absorb provider timestamp gaps
    '-c:a', 'aac', '-ac', surround ? '6' : '2', '-b:a', surround ? '448k' : '224k',
  ];
}

// Colour tags: the source's own tags pass through (SD channels are BT.601, HD BT.709); tone-mapped frames carry
// BT.709 from zscale. Never force them: output -colorspace options also make ffmpeg insert a CPU scaler that
// can't take GPU frames.
export function encoderArgs(p: EncoderProfile, gpu: boolean, fps: number): string[] {
  const g = String(Math.max(1, Math.round(fps * p.gopSec)));
  if (gpu) {
    return [
      '-c:v', 'h264_nvenc', '-preset', p.preset, '-tune', p.tune, '-profile:v', 'high',
      '-rc', 'vbr', '-cq', String(p.cq), '-b:v', '0', '-maxrate', `${p.maxrateM}M`, '-bufsize', `${p.maxrateM * 2}M`,
      '-bf', String(p.bf), ...(p.bf ? ['-b_ref_mode', p.bref] : []),
      ...(p.lookahead ? ['-rc-lookahead', String(p.lookahead)] : []),
      ...(p.aq ? ['-spatial-aq', '1', '-temporal-aq', '1'] : []),
      ...(p.multipass !== 'disabled' ? ['-multipass', p.multipass] : []),
      '-g', g, '-forced-idr', '1'
    ];
  }
  return [
    '-c:v', 'libx264', '-preset', p.x264Preset, ...(p.tune === 'll' ? ['-tune', 'zerolatency'] : []),
    '-crf', String(p.crf), '-maxrate', `${p.maxrateM}M`, '-bufsize', `${p.maxrateM * 2}M`, '-g', g
  ];
}

/** Movies: read this many seconds ahead before settling to real time (fills the player's buffer fast). */
export const HEAD_START_S = 45;

/** Copy the video as it is (browsers/Safari decode H.264 and HEVC), or encode it. Data saver always encodes. */
export type VideoPlan = 'copy' | 'encode';
export const videoPlan = (vcodec: string | null | undefined, low = false): VideoPlan => (!low && (vcodec === 'h264' || vcodec === 'hevc') ? 'copy' : 'encode');

export interface InputOpts {
  vod: boolean;
  startAt?: number;
  /** Seconds to drop from the output's start (catch-up starts on whole minutes). */
  skip?: number;
  plan: VideoPlan;
  gpu: boolean;
  /** Report the input on stderr (the HLS start reads its codec from there). */
  verbose?: boolean;
  bench?: boolean;
}

export function inputArgs(src: string, o: InputOpts): string[] {
  const net = !o.bench && /^https?:/.test(src);
  const skip = o.skip && o.skip > 0 ? o.skip : 0;
  return [
    '-hide_banner', '-loglevel', o.verbose ? 'info' : 'error', ...(o.verbose ? ['-nostats'] : []), '-nostdin',
    '-fflags', '+genpts+discardcorrupt', ...(net ? ['-user_agent', UA] : []),
    // Live: start fast; copying needs the codec parameters up front, so look a little further.
    ...(!o.vod ? ['-probesize', o.plan === 'copy' ? '5M' : '2M', '-analyzeduration', o.plan === 'copy' ? '2000000' : '1500000'] : []),
    ...(o.vod && !o.bench ? ['-readrate', '1', '-readrate_initial_burst', String(HEAD_START_S + skip)] : []),
    // From the start nothing needs to jump around the file, so read it straight through. Otherwise ffmpeg peeks
    // at the end (MKV cues, AVI index): every jump is a new provider request (measured: opening 1.5–9s → 0.5–0.8s).
    ...(o.vod ? (o.startAt && o.startAt > 0 ? ['-ss', String(o.startAt)] : net ? ['-seekable', '0'] : []) : []),
    ...(net && o.vod ? ['-reconnect', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '4'] : []),
    ...(o.plan === 'encode' && o.gpu ? ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'] : []),
    '-i', src,
    ...(skip ? ['-ss', String(skip)] : []),
  ];
}

/** Video options for the plan. `container` matters for copied HEVC: MP4/fMP4 (Safari) needs Apple's hvc1 tag. */
export function videoArgs(plan: VideoPlan, o: TxOpts & { vcodec?: string | null; container: 'mpegts' | 'fmp4' }): string[] {
  if (plan === 'copy') return o.vcodec === 'hevc' && o.container === 'fmp4' ? ['-c:v', 'copy', '-tag:v', 'hvc1'] : ['-c:v', 'copy'];
  const p = o.profile ?? (o.maxHeight ? MOBILE : o.vod ? VOD : LIVE);
  return ['-vf', videoFilter(o.info, o), ...encoderArgs(p, o.gpu, outFps(o.info, o))];
}

/** Desktop browsers: one MPEG-TS stream (mpegts.js) with the picked audio track. */
export function transcodeArgs(src: string, o: TxOpts): string[] {
  const vod = !!o.vod, info = o.info ?? null;
  const plan: VideoPlan = o.mode === 'audio' ? 'copy' : 'encode';
  const p = o.profile ?? (o.maxHeight ? MOBILE : vod ? VOD : LIVE);
  return [
    ...inputArgs(src, { vod, startAt: o.startAt, skip: o.skip, plan, gpu: o.gpu, bench: o.bench }),
    '-map', '0:v:0', '-map', `0:a:${o.audio && o.audio > 0 ? o.audio : 0}?`,
    ...videoArgs(plan, { ...o, container: 'mpegts' }),
    ...(o.maxHeight ? [...(vod ? [] : ['-af', 'aresample=async=1:first_pts=0']), '-c:a', 'aac', '-ac', '2', '-b:a', '128k'] : audioArgs(info, vod)),
    // B-frames need a little mux delay or DTS can fall behind the PCR.
    '-f', 'mpegts', '-muxdelay', p.bf ? '0.2' : '0', '-muxpreload', '0', 'pipe:1',
  ];
}
