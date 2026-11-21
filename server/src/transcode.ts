// On-the-fly HEVC -> H.264 for browsers that can't decode HEVC (Chrome on Linux).
// Uses NVDEC/NVENC when available (≈3x realtime on an RTX 3060 for 1080p50 10-bit, near-zero CPU),
// falls back to software x264. Only one transcode at a time: the provider allows one connection.
import { spawn, execFileSync, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { transcodeArgs, inputArgs, videoArgs, videoPlan, MOBILE_H, type SourceInfo, type TxMode } from './media.ts';
import { sessionFiles, isSessionFile, hlsOutputArgs, type VodLayout } from './hls.ts';
import { ProviderSlot } from './slot.ts';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where HLS sessions (iPhone movie playback) write their segments. On disk, not /tmp: /tmp is RAM here and
 * a whole movie (4K ≈ 20–40 GB) would fill it. Old segments are pruned while playing (HLS_KEEP_BEHIND).
 */
const DEFAULT_HLS_ROOT = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'relay-hls');
/** Segments (4s each, so ≈20 min) kept behind the newest one the player asked for; seeking further back restarts. */
const HLS_KEEP_BEHIND = 300;
/** No playlist/segment request for this long (app closed, phone locked): free the provider connection. */
const HLS_IDLE_MS = 45_000;
export interface HlsStart {
  src: string;
  /** Movies: position to start at (seconds). */
  startAt?: number;
  /** Expected video codec (corrected as soon as ffmpeg reports the real one). */
  guess: string | null;
  /** Device the session belongs to (a lease moving elsewhere stops it). */
  owner: string | null;
  live?: boolean;
  /** A movie with its languages; null = one audio track, no subtitles. */
  layout?: VodLayout | null;
  /** Catch-up: seconds to drop from the start (the provider starts on whole minutes). */
  skip?: number;
  /** Data saver: always encoded, 720p ~3 Mbps. */
  low?: boolean;
  /** What's known about the source (deinterlacing, HDR tone mapping when encoding). */
  info?: SourceInfo | null;
  log?: (m: string) => void;
}

type Proc = ChildProcessByStdio<null, Readable, Readable>;

function detectGpu(): boolean {
  try {
    const enc = execFileSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 5000 });
    const hw = execFileSync('ffmpeg', ['-hide_banner', '-hwaccels'], { encoding: 'utf8', timeout: 5000 });
    return enc.includes('h264_nvenc') && hw.includes('cuda');
  } catch { return false; }
}

export class Transcoder {
  readonly available: boolean;
  readonly gpu: boolean;
  private current: Proc | null = null;
  owner: string | null = null;
  private slot: ProviderSlot;
  /** Starts and probes in progress: the connection counts as taken before ffmpeg even runs. */
  private claims = 0;
  /** Killed processes that haven't exited yet: a new provider connection waits for these. */
  private dying = new Set<Promise<void>>();
  /** Bumped by every start(): an older start still retrying gives up instead of killing the newer one's process. */
  private startGen = 0;

  /** Current HLS session (iPhone/iPad Safari can't play MKV/AVI, raw MPEG-TS or HEVC in TS-based HLS, but plays fMP4 HLS natively). */
  private hls: { sid: string; dir: string; proc: Proc; lastHit: number; pruned: number; layout: VodLayout | null } | null = null;

  private root: string;

  /** `root`: where sessions write their segments (tests use their own folder: it's emptied on start). */
  constructor(slot: ProviderSlot = new ProviderSlot(), root = DEFAULT_HLS_ROOT) {
    this.slot = slot; this.root = root;
    slot.hold({ active: () => !!this.current || this.claims > 0 });
    let ok = true;
    try { execFileSync('ffmpeg', ['-version'], { timeout: 5000 }); } catch { ok = false; }
    this.available = ok;
    this.gpu = ok && detectGpu();
    for (const d of root === DEFAULT_HLS_ROOT ? [root, join(tmpdir(), 'relay-hls')] : [root]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
    setInterval(() => {
      const h = this.hls;
      if (h && h.proc.exitCode === null && h.proc.signalCode === null && Date.now() - h.lastHit > HLS_IDLE_MS) this.stop();
    }, 10_000).unref();
  }

  /**
   * Starts an HLS session; resolves once the first segment is ready to play.
   * `guess` is the expected video codec. ffmpeg reports the real one as it opens the file: if the guess
   * was wrong (e.g. HEVC copied without Apple's tag, or MPEG-4 that needs converting) it restarts right away.
   * That's much faster than a separate ffprobe, which costs an extra provider connection that the provider
   * keeps counting for a moment (so the real one then fails and has to retry).
   */
  startHls(o: HlsStart) { return this.claim(() => this.doStartHls(o)); }
  private async doStartHls(o: HlsStart): Promise<{ sid: string; vcodec: string | null; entry: string }> {
    const { src, owner, live = false, layout = null, skip = 0, low = false, info = null } = o;
    const log = o.log ?? (() => {});
    const startAt = live ? 0 : o.startAt ?? 0;
    const files = sessionFiles(layout);
    // A newer start (seek, switch) supersedes this one: it must give up, never kill the newer one's process.
    const my = ++this.startGen;
    const gone = () => my !== this.startGen;
    await this.stop();
    await Promise.all([...this.dying]);
    await this.slot.clear();
    let vcodec = o.guess, lastErr = '', corrected = false;
    for (let attempt = 0; attempt < 3;) {
      if (attempt) await new Promise((r) => setTimeout(r, 600 * attempt));
      if (gone()) throw new Error('superseded');
      const t0 = Date.now();
      const sid = randomBytes(12).toString('base64url');
      const dir = join(this.root, sid);
      mkdirSync(dir, { recursive: true });
      const gpu = this.gpu && attempt < 2;
      const plan = videoPlan(vcodec, low);
      const args = [
        ...inputArgs(src, { vod: !live, startAt, skip, plan, gpu, verbose: true }),
        ...hlsOutputArgs({ layout, dir, live, abr: low ? '128k' : '192k',
          video: videoArgs(plan, { gpu, info, vcodec, vod: !live, maxHeight: low ? MOBILE_H : undefined, container: 'fmp4' }) }),
      ];
      const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] }) as Proc;
      this.current = proc; this.owner = owner;
      this.hls = { sid, dir, proc, lastHit: Date.now(), pruned: 0, layout };
      let stderr = '', head = '', detected: string | null | undefined;
      proc.stderr.on('data', (d) => {
        stderr = (stderr + d).slice(-2000);
        if (detected !== undefined) return;
        head += d;
        // First real video stream of the input (cover art in MKVs shows up as an "attached pic" video stream).
        const line = head.split('\n').find((l) => /Stream #0:\d+.*: Video: /.test(l) && !/attached pic/.test(l));
        if (line) detected = /Video: (\w+)/.exec(line)![1];
        else if (/Stream mapping|Output #0/.test(head) || head.length > 64_000) detected = null;
      });
      proc.stdout.resume();
      const wrong = () => detected != null && (videoPlan(detected, low) !== videoPlan(vcodec, low) || (videoPlan(detected, low) === 'copy' && detected !== vcodec));
      try {
        await new Promise<void>((resolve, reject) => {
          const tick = setInterval(() => {
            if (wrong()) { clearInterval(tick); reject(new Error('codec')); return; }
            let pl = '';
            try { pl = readFileSync(join(dir, files.video), 'utf8'); } catch {}
            if (pl.split('\n').some((l) => files.videoSegment(l) != null)) { clearInterval(tick); resolve(); }
            else if (proc.exitCode !== null || proc.signalCode !== null) { clearInterval(tick); reject(new Error(wrong() ? 'codec' : `ffmpeg exited ${proc.exitCode ?? proc.signalCode}: ${stderr.trim().split('\n').pop() ?? ''}`)); }
            else if (Date.now() - t0 > 25_000) { clearInterval(tick); reject(new Error('no output after 25s')); }
          }, 100);
        });
        const how = videoPlan(vcodec, low) === 'copy' ? `copy ${vcodec}` : `${low ? 'data saver ' : ''}${gpu ? 'nvenc' : 'x264'}`;
        const langs = layout && (layout.audio.length > 1 || layout.subs.length) ? `, ${layout.audio.length} audio, ${layout.subs.length} subs` : '';
        log(`hls started in ${Date.now() - t0}ms (${live ? 'live, ' : ''}${how}${langs}${startAt ? ` @${Math.round(startAt)}s` : ''}, attempt ${attempt + 1})`);
        return { sid, vcodec: detected ?? vcodec, entry: files.entry };
      } catch (e) {
        if (this.current === proc) await this.stop(); else if (proc.exitCode === null) proc.kill('SIGKILL');
        if (gone()) throw new Error('superseded');
        if ((e as Error).message === 'codec' && !corrected) {
          log(`hls: source is ${detected}, not ${vcodec ?? 'unknown'}: restarting`);
          vcodec = detected!; corrected = true;
          await new Promise((r) => setTimeout(r, 300)); // let the provider drop the connection we just closed
          continue; // not a failure: doesn't use up an attempt
        }
        lastErr = (e as Error).message;
        log(`hls attempt ${attempt + 1} failed: ${lastErr}`);
        attempt++;
      }
    }
    throw new Error(lastErr);
  }

  /** Path of a file in the live HLS session, or null. Every hit keeps the session alive. */
  hlsFile(sid: string, name: string): string | null {
    const h = this.hls;
    if (!h || h.sid !== sid || !isSessionFile(name)) return null;
    const p = join(h.dir, name);
    if (!existsSync(p)) return null;
    h.lastHit = Date.now();
    // Keep disk use bounded: drop segments far behind what the player is fetching.
    const files = sessionFiles(h.layout), n = files.videoSegment(name);
    for (const upto = n != null ? n - HLS_KEEP_BEHIND : 0; h.pruned < upto; h.pruned++) {
      for (const f of files.segments(h.pruned)) rm(join(h.dir, f), { force: true }).catch(() => {});
    }
    return p;
  }

  /** The running session's folder and languages (for the subtitle playlists the API builds). */
  hlsInfo(sid: string): { dir: string; layout: VodLayout | null } | null {
    const h = this.hls;
    return h && h.sid === sid ? { dir: h.dir, layout: h.layout } : null;
  }

  /** Ends the HLS session if it's this one (the player stopped). */
  stopHls(sid: string) { return this.hls?.sid === sid ? this.stop() : Promise.resolve(); }



  private async claim<T>(fn: () => Promise<T>): Promise<T> {
    this.claims++;
    try { return await fn(); }
    finally { this.claims--; if (!this.claims && !this.current) this.slot.released(); }
  }

  /**
   * Run `fn` with the provider connection to itself (e.g. reading a file's header before converting it):
   * the running conversion and any background work are stopped first.
   */
  withConnection<T>(fn: () => Promise<T>): Promise<T> {
    return this.claim(async () => { await this.stop(); await Promise.all([...this.dying]); await this.slot.clear(); return fn(); });
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
    gone.finally(() => { this.dying.delete(gone); if (!this.current && !this.claims) this.slot.released(); });
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
  start(...a: Parameters<Transcoder['doStart']>) { return this.claim(() => this.doStart(...a)); }
  private async doStart(src: string, startAt = 0, log: (m: string) => void = () => {}, owner: string | null = null, opts: { vod?: boolean; mode?: TxMode; info?: SourceInfo | null; signal?: AbortSignal; audio?: number; skip?: number; low?: boolean } = {}): Promise<{ proc: Proc; first: Buffer }> {
    const my = ++this.startGen;
    const gone = () => my !== this.startGen || !!opts.signal?.aborted;
    await this.stop();
    await Promise.all([...this.dying]);
    await this.slot.clear();
    this.owner = owner;
    let lastErr = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 600 * attempt));
      if (gone()) throw new Error('superseded');
      const gpu = this.gpu && attempt < 3; // last resort: software path
      const proc = spawn('ffmpeg', transcodeArgs(src, { gpu, startAt, vod: !!opts.vod, mode: opts.low ? 'full' : opts.mode ?? 'full', info: opts.info ?? null, audio: opts.audio, skip: opts.skip, maxHeight: opts.low ? MOBILE_H : undefined }), { stdio: ['ignore', 'pipe', 'pipe'] }) as Proc;
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
        log(`transcode started (${!opts.low && opts.mode === 'audio' ? 'audio only' : `${opts.low ? 'data saver ' : ''}${gpu ? 'nvenc' : 'x264'}`}${startAt ? ` @${Math.round(startAt)}s` : ''}, attempt ${attempt + 1})`);
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
