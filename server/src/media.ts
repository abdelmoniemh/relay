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
  name: 'live', preset: 'p5', tune: 'hq', bf: 3, bref: 'middle', lookahead: 20, aq: true, multipass: 'disabled',
  cq: 19, maxrateM: 30, gopSec: 2, x264Preset: 'faster', crf: 19,
};
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
  userAgent?: string;
  output?: string;
}

const UA = 'Relay/1.0 (like VLC/3.0.20)';

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
export function videoFilter(info: SourceInfo | null | undefined, o: Pick<TxOpts, 'gpu' | 'dither' | 'deintFrame'>): string {
  const deint = info?.interlaced ? (o.deintFrame ? 'send_frame' : 'send_field') : null;
  const dither = o.dither ?? 'swscale'; // bench: CAMBI 5.8 vs 8.6 (error diffusion) at 1/3 the bitrate
  // HDR -> SDR BT.709: linearise, map primaries, tone map (hable keeps highlight detail), back to 8-bit with error diffusion.
  // (ordered dither: error diffusion is serial and halves the speed; bench shows no banding advantage after encoding)
  const tonemap = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,'
    + 'zscale=t=bt709:m=bt709:r=tv:dither=ordered,format=yuv420p';
  // CPU tone mapping can't keep up with 4K (0.6x real time on 16 cores): map at 1440p, scaled down on the GPU first (1.4x).
  const hdrCap = isHdr(info) && (info?.height ?? 0) > HDR_MAX_H;
  const to8 = dither === 'error_diffusion' ? 'zscale=dither=error_diffusion,format=yuv420p' : 'format=yuv420p';
  if (o.gpu) {
    const parts: string[] = [];
    if (deint) parts.push(`bwdif_cuda=mode=${deint}:parity=auto:deint=all`);
    if (isHdr(info)) parts.push(...(hdrCap ? [`scale_cuda=-2:${HDR_MAX_H}:format=p010le:interp_algo=lanczos`] : []), 'hwdownload', 'format=p010le', tonemap);
    else if (is10(info) && dither !== 'truncate') parts.push('hwdownload', 'format=p010le', to8);
    else parts.push('scale_cuda=format=nv12');
    return parts.join(',');
  }
  const parts: string[] = [];
  if (deint) parts.push(`bwdif=mode=${deint}:parity=auto:deint=all`);
  if (isHdr(info)) parts.push(...(hdrCap ? [`zscale=w=-2:h=${HDR_MAX_H}:f=lanczos`] : []), tonemap);
  else if (is10(info) && dither === 'error_diffusion') parts.push(to8);
  else parts.push("scale=w='min(iw,3840)':h=-2", 'format=yuv420p');
  return parts.join(',');
}

/** Audio: keep AAC untouched; otherwise AAC with the source's channel layout (up to 5.1). */
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

export function transcodeArgs(src: string, o: TxOpts): string[] {
  const vod = !!o.vod, mode = o.mode ?? 'full', info = o.info ?? null;
  const p = o.profile ?? (vod ? VOD : LIVE);
  const net = !o.bench && /^https?:/.test(src);
  const input = [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-fflags', '+genpts+discardcorrupt',
    ...(net ? ['-user_agent', o.userAgent ?? UA] : []),
    ...(!vod ? ['-probesize', '2M', '-analyzeduration', '1500000'] : []), // live: start fast
    ...(vod && !o.bench ? ['-readrate', '1', '-readrate_initial_burst', '30'] : []), // movies: real-time after a 30s head start
    ...(o.startAt && o.startAt > 0 ? ['-ss', String(o.startAt)] : []),
    ...(net && vod ? ['-reconnect', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '4'] : []),
  ];
  // B-frames need a little mux delay or DTS can fall behind the PCR.
  const out = [
    '-map', '0:v:0', '-map', '0:a:0?', ...audioArgs(info, vod),
    '-f', 'mpegts', '-muxdelay', p.bf ? '0.2' : '0', '-muxpreload', '0', o.output ?? 'pipe:1',
  ];
  if (mode === 'audio') return [...input, '-i', src, '-c:v', 'copy', ...out];
  const fps = outFps(info, o);
  const hw = o.gpu ? ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'] : [];
  return [...input, ...hw, '-i', src, '-vf', videoFilter(info, o), ...encoderArgs(p, o.gpu, fps), ...out];
}
