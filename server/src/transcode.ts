// On-the-fly HEVC -> H.264 for browsers that can't decode HEVC (Chrome on Linux).
// Uses NVDEC/NVENC when available (≈3x realtime on an RTX 3060 for 1080p50 10-bit, near-zero CPU),
// falls back to software x264. Only one transcode at a time: the provider allows one connection.
import { spawn, execFileSync, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

type Proc = ChildProcessByStdio<null, Readable, Readable>;

function detectGpu(): boolean {
  try {
    const enc = execFileSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 5000 });
    const hw = execFileSync('ffmpeg', ['-hide_banner', '-hwaccels'], { encoding: 'utf8', timeout: 5000 });
    return enc.includes('h264_nvenc') && hw.includes('cuda');
  } catch { return false; }
}

/** Items that turned out to be HEVC, shared with every device so browsers skip the failed direct attempt. */
export class HevcRegistry {
  private ids: Set<string>;
  private save: (ids: string[]) => void;
  constructor(initial: string[], save: (ids: string[]) => void) { this.ids = new Set(initial); this.save = save; }
  has(id: string) { return this.ids.has(id); }
  add(id: string) { if (!this.ids.has(id)) { this.ids.add(id); this.save([...this.ids].slice(-5000)); } }
}

export class Transcoder {
  readonly available: boolean;
  readonly gpu: boolean;
  private current: Proc | null = null;
  /** Device the running transcode belongs to. */
  owner: string | null = null;
  /** Killed processes that haven't exited yet: a new provider connection waits for these. */
  private dying = new Set<Promise<void>>();

  constructor() {
    let ok = true;
    try { execFileSync('ffmpeg', ['-version'], { timeout: 5000 }); } catch { ok = false; }
    this.available = ok;
    this.gpu = ok && detectGpu();
  }

  private args(src: string, gpu: boolean, startAt: number): string[] {
    const input = [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-fflags', '+genpts+discardcorrupt', '-user_agent', 'Relay/1.0 (like VLC/3.0.20)',
      ...(startAt > 0 ? ['-ss', String(startAt)] : []),
    ];
    const out = [
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
      '-f', 'mpegts', '-muxdelay', '0', '-muxpreload', '0', 'pipe:1',
    ];
    return gpu
      ? [...input, '-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda', '-i', src,
        '-vf', 'scale_cuda=format=nv12', '-c:v', 'h264_nvenc', '-preset', 'p2', '-tune', 'll',
        '-rc', 'vbr', '-cq', '22', '-b:v', '0', '-maxrate', '25M', '-bufsize', '25M', '-g', '50', '-bf', '0', ...out]
      : [...input, '-i', src,
        '-vf', 'scale=w=min(iw\\,1920):h=-2,format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
        '-crf', '22', '-maxrate', '12M', '-bufsize', '12M', '-g', '50', ...out];
  }

  /** Kills the running transcode; resolves once the process (and its provider connection) is really gone. */
  stop(): Promise<void> {
    const p = this.current;
    this.current = null;
    this.owner = null;
    if (!p || p.exitCode !== null || p.signalCode !== null) return Promise.resolve();
    const gone = new Promise<void>((resolve) => {
      p.once('exit', () => resolve());
      p.kill('SIGKILL');
      setTimeout(resolve, 1000);
    });
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
  async start(src: string, startAt = 0, log: (m: string) => void = () => {}, owner: string | null = null): Promise<{ proc: Proc; first: Buffer }> {
    await this.stop();
    await Promise.all([...this.dying]);
    this.owner = owner;
    let lastErr = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 600 * attempt));
      const gpu = this.gpu && attempt < 3; // last resort: software path
      const proc = spawn('ffmpeg', this.args(src, gpu, startAt), { stdio: ['ignore', 'pipe', 'pipe'] }) as Proc;
      this.current = proc;
      this.owner = owner;
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
      try {
        const first = await new Promise<Buffer>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('no output after 15s')), 15_000);
          proc.stdout.once('data', (b: Buffer) => { clearTimeout(timer); resolve(b); });
          proc.once('exit', (code) => { clearTimeout(timer); reject(new Error(`ffmpeg exited ${code}: ${stderr.trim().split('\n').pop() ?? ''}`)); });
        });
        log(`transcode started (${gpu ? 'nvenc' : 'x264'}, attempt ${attempt + 1})`);
        return { proc, first };
      } catch (e) {
        lastErr = (e as Error).message;
        if (this.current === proc) await this.stop();
        else if (proc.exitCode === null) proc.kill('SIGKILL');
        log(`transcode attempt ${attempt + 1} failed: ${lastErr}`);
      }
    }
    throw new Error(lastErr);
  }

  owns(p: Proc) { return this.current === p; }
}
