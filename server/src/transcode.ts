// On-the-fly HEVC -> H.264 for browsers that can't decode HEVC (Chrome on Linux).
// Uses NVDEC/NVENC when available (≈3x realtime on an RTX 3060 for 1080p50 10-bit, near-zero CPU),
// falls back to software x264. Only one transcode at a time: the provider allows one connection.
import { spawn, execFileSync, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { transcodeArgs, encoderArgs, VOD, type SourceInfo } from './media.ts';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Where HLS sessions (iPhone movie playback) write their segments. */
const HLS_ROOT = join(tmpdir(), 'relay-hls');
/** No playlist/segment request for this long (app closed, phone locked): free the provider connection. */
const HLS_IDLE_MS = 45_000;

type Proc = ChildProcessByStdio<null, Readable, Readable>;

function detectGpu(): boolean {
  try {
    const enc = execFileSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 5000 });
    const hw = execFileSync('ffmpeg', ['-hide_banner', '-hwaccels'], { encoding: 'utf8', timeout: 5000 });
    return enc.includes('h264_nvenc') && hw.includes('cuda');
  } catch { return false; }
}

export type TxMode = 'full' | 'audio';

/** Items browsers can't play directly (HEVC video / AC3-DTS audio), shared with every device so they skip the failed try. */
export class HevcRegistry {
  private ids: Map<string, TxMode>;
  private save: (entries: [string, TxMode][]) => void;
  constructor(initial: unknown, save: (entries: [string, TxMode][]) => void) {
    // older format was a plain id list (all HEVC)
    this.ids = new Map(Array.isArray(initial) ? initial.map((x: any): [string, TxMode] => (Array.isArray(x) ? [x[0], x[1]] : [x, 'full'])) : []);
    this.save = save;
  }
  has(id: string) { return this.ids.has(id); }
  mode(id: string): TxMode | undefined { return this.ids.get(id); }
  add(id: string, mode: TxMode = 'full') {
    if (this.ids.get(id) === mode || (this.ids.get(id) === 'full' && mode === 'audio')) return;
    this.ids.set(id, mode);
    this.save([...this.ids].slice(-5000));
  }
}

export class Transcoder {
  readonly available: boolean;
  readonly gpu: boolean;
  private current: Proc | null = null;
  /** Device the running transcode belongs to. */
  owner: string | null = null;
  /** Killed processes that haven't exited yet: a new provider connection waits for these. */
  private dying = new Set<Promise<void>>();
  /** Bumped by every start(): an older start still retrying gives up instead of killing the newer one's process. */
  private startGen = 0;

  /** Current HLS session (iPhone/iPad Safari can't play MKV/AVI or raw MPEG-TS, but plays HLS natively). */
  private hls: { sid: string; dir: string; proc: Proc; lastHit: number } | null = null;

  constructor() {
    let ok = true;
    try { execFileSync('ffmpeg', ['-version'], { timeout: 5000 }); } catch { ok = false; }
    this.available = ok;
    this.gpu = ok && detectGpu();
    try { rmSync(HLS_ROOT, { recursive: true, force: true }); } catch {}
    setInterval(() => {
      const h = this.hls;
      if (h && h.proc.exitCode === null && h.proc.signalCode === null && Date.now() - h.lastHit > HLS_IDLE_MS) this.stop();
    }, 10_000).unref();
  }

  /**
   * HLS (fMP4 segments) for Safari. H.264/HEVC video is copied untouched; anything else is encoded to H.264.
   * Audio always becomes stereo AAC (AC3/DTS/… in MKV are the usual reason a file won't play).
   */
  private hlsArgs(src: string, startAt: number, vcodec: string | null, gpu: boolean, dir: string): string[] {
    const video = vcodec === 'h264' ? ['-c:v', 'copy']
      : vcodec === 'hevc' ? ['-c:v', 'copy', '-tag:v', 'hvc1']
      : gpu ? [...encoderArgs({ ...VOD, gopSec: 4 }, true, 24), '-pix_fmt', 'yuv420p']
      : ['-vf', 'scale=w=min(iw\\,1920):h=-2,format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-maxrate', '12M', '-bufsize', '12M', '-g', '96'];
    return [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-fflags', '+genpts+discardcorrupt', '-user_agent', 'Relay/1.0 (like VLC/3.0.20)',
      '-readrate', '1', '-readrate_initial_burst', '45',
      ...(startAt > 0 ? ['-ss', String(startAt)] : []),
      '-reconnect', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '4',
      '-i', src,
      '-map', '0:v:0', '-map', '0:a:0?', ...video,
      '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-max_muxing_queue_size', '2048',
      '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0', '-hls_playlist_type', 'event',
      '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
      '-hls_segment_filename', join(dir, 'seg%05d.m4s'), '-hls_flags', 'independent_segments+temp_file',
      join(dir, 'index.m3u8'),
    ];
  }

  /** Starts an HLS session; resolves with its id once the first segments are ready to play. */
  async startHls(src: string, startAt: number, vcodec: string | null, owner: string | null, log: (m: string) => void = () => {}): Promise<string> {
    await this.stop();
    await Promise.all([...this.dying]);
    let lastErr = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 600 * attempt));
      const sid = randomBytes(12).toString('base64url');
      const dir = join(HLS_ROOT, sid);
      mkdirSync(dir, { recursive: true });
      const gpu = this.gpu && attempt < 2;
      const proc = spawn('ffmpeg', this.hlsArgs(src, startAt, vcodec, gpu, dir), { stdio: ['ignore', 'pipe', 'pipe'] }) as Proc;
      this.current = proc; this.owner = owner;
      this.hls = { sid, dir, proc, lastHit: Date.now() };
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
      proc.stdout.resume();
      try {
        await new Promise<void>((resolve, reject) => {
          const t0 = Date.now();
          const tick = setInterval(() => {
            let pl = '';
            try { pl = readFileSync(join(dir, 'index.m3u8'), 'utf8'); } catch {}
            const segs = (pl.match(/^seg\d+\.m4s$/gm) ?? []).length;
            if (segs >= 2 || (segs >= 1 && pl.includes('#EXT-X-ENDLIST'))) { clearInterval(tick); resolve(); }
            else if (proc.exitCode !== null || proc.signalCode !== null) { clearInterval(tick); reject(new Error(`ffmpeg exited ${proc.exitCode ?? proc.signalCode}: ${stderr.trim().split('\n').pop() ?? ''}`)); }
            else if (Date.now() - t0 > 25_000) { clearInterval(tick); reject(new Error('no output after 25s')); }
          }, 150);
        });
        log(`hls started (${vcodec === 'h264' || vcodec === 'hevc' ? `copy ${vcodec}` : gpu ? 'nvenc' : 'x264'}${startAt ? ` @${Math.round(startAt)}s` : ''}, attempt ${attempt + 1})`);
        return sid;
      } catch (e) {
        lastErr = (e as Error).message;
        await this.stop();
        log(`hls attempt ${attempt + 1} failed: ${lastErr}`);
      }
    }
    throw new Error(lastErr);
  }

  /** Path of a file in the live HLS session, or null. Every hit keeps the session alive. */
  hlsFile(sid: string, name: string): string | null {
    const h = this.hls;
    if (!h || h.sid !== sid || !/^(index\.m3u8|init\.mp4|seg\d+\.m4s)$/.test(name)) return null;
    const p = join(h.dir, name);
    if (!existsSync(p)) return null;
    h.lastHit = Date.now();
    return p;
  }

  /** Ends the HLS session if it's this one (the player stopped). */
  stopHls(sid: string) { return this.hls?.sid === sid ? this.stop() : Promise.resolve(); }

  private args(src: string, gpu: boolean, startAt: number, vod: boolean, mode: TxMode, info: SourceInfo | null): string[] {
    return transcodeArgs(src, { gpu, startAt, vod, mode, info });
  }

  /** Kills the running transcode; resolves once the process (and its provider connection) is really gone. */
  stop(): Promise<void> {
    const p = this.current;
    const hls = this.hls;
    this.current = null;
    this.owner = null;
    this.hls = null;
    const cleanup = () => { if (hls) rm(hls.dir, { recursive: true, force: true }).catch(() => {}); };
    if (!p || p.exitCode !== null || p.signalCode !== null) { cleanup(); return Promise.resolve(); }
    const gone = new Promise<void>((resolve) => {
      p.once('exit', () => resolve());
      p.kill('SIGKILL');
      setTimeout(resolve, 1000);
    }).then(cleanup);
    this.dying.add(gone);
    gone.finally(() => this.dying.delete(gone));
    return gone;
  }

  /** Stop the transcode unless it belongs to `deviceId` (called whenever the lease moves). */
  releaseExcept(deviceId: string | null): Promise<void> {
    return this.current && this.owner !== deviceId ? this.stop() : Promise.resolve();
  }

  /**
   * Starts a transcode and resolves once ffmpeg produced its first bytes (or rejects).
   * Retries briefly: right after a handoff the provider may still count the previous connection.
   */
  async start(src: string, startAt = 0, log: (m: string) => void = () => {}, owner: string | null = null, opts: { vod?: boolean; mode?: TxMode; info?: SourceInfo | null; signal?: AbortSignal } = {}): Promise<{ proc: Proc; first: Buffer }> {
    const my = ++this.startGen;
    const gone = () => my !== this.startGen || !!opts.signal?.aborted;
    await this.stop();
    await Promise.all([...this.dying]);
    this.owner = owner;
    let lastErr = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 600 * attempt));
      if (gone()) throw new Error('superseded');
      const gpu = this.gpu && attempt < 3; // last resort: software path
      const proc = spawn('ffmpeg', this.args(src, gpu, startAt, !!opts.vod, opts.mode ?? 'full', opts.info ?? null), { stdio: ['ignore', 'pipe', 'pipe'] }) as Proc;
      this.current = proc;
      this.owner = owner;
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
      try {
        const first = await new Promise<Buffer>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('no output after 15s')), 15_000);
          proc.stdout.once('data', (b: Buffer) => { clearTimeout(timer); resolve(b); });
          proc.once('exit', (code, sig) => { clearTimeout(timer); reject(new Error(`ffmpeg exited ${code ?? sig}: ${stderr.trim().split('\n').pop() ?? ''}`)); });
        });
        if (gone()) { if (this.current === proc) await this.stop(); else proc.kill('SIGKILL'); throw new Error('superseded'); }
        log(`transcode started (${opts.mode === 'audio' ? 'audio only' : gpu ? 'nvenc' : 'x264'}${startAt ? ` @${Math.round(startAt)}s` : ''}, attempt ${attempt + 1})`);
        return { proc, first };
      } catch (e) {
        lastErr = (e as Error).message;
        if (lastErr === 'superseded') throw e;
        if (this.current === proc) await this.stop();
        else if (proc.exitCode === null) proc.kill('SIGKILL');
        log(`transcode attempt ${attempt + 1} failed: ${lastErr}`);
      }
    }
    throw new Error(lastErr);
  }

  owns(p: Proc) { return this.current === p; }
}
