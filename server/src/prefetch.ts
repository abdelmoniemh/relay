// Background work on movies/episodes, done only while nothing is streaming (the provider allows one connection):
// the track list + chapters (skip-intro / credits markers), then a seek-bar thumbnail sprite.
// Titles are queued when played, and the next episode when one starts. A stream starting aborts it right away;
// thumbnails already made are kept, and it carries on later.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { markersFrom, type Markers, type TrackStore } from './tracks.ts';
import type { ProviderSlot, Worker } from './slot.ts';
import { isVodId } from '../../shared/domain.ts';

/** Sprite layout: 10×10 tiles of 160 px wide frames. */
export const THUMB_COLS = 10, THUMB_ROWS = 10, THUMB_W = 160, THUMB_H = 90;
const THUMBS = THUMB_COLS * THUMB_ROWS;
/** Gap between provider requests (each thumbnail is one range request). */
const PACE_MS = 700;

export interface Extras {
  markers: Markers;
  duration: number | null;
  thumbs: { interval: number; cols: number; rows: number; w: number; h: number } | null;
}

export class Prefetcher implements Worker {
  private queue: { id: string; url: () => Promise<string>; thumbs: boolean }[] = [];
  private running = false;
  private proc: ChildProcess | null = null;
  private dir: string;
  private tracks: TrackStore;
  private slot: ProviderSlot;
  private loop: Promise<void> = Promise.resolve();
  private log: (m: string) => void;

  private pace: number;

  constructor(dataDir: string, tracks: TrackStore, slot: ProviderSlot, log: (m: string) => void = () => {}, paceMs = PACE_MS) {
    this.pace = paceMs;
    this.dir = join(dataDir, 'thumbs');
    mkdirSync(this.dir, { recursive: true });
    this.tracks = tracks; this.slot = slot; this.log = log;
    slot.work(this);
    setInterval(() => this.kick(), 20_000).unref();
  }

  /** What's known about a title (never touches the provider). */
  extras(id: string): Extras | null {
    const t = this.tracks.get(id);
    if (!t) return null;
    const duration = t.duration ?? null;
    const done = existsSync(this.sprite(id)) && duration;
    return { markers: markersFrom(t.chapters, duration), duration, thumbs: done ? { interval: duration! / THUMBS, cols: THUMB_COLS, rows: THUMB_ROWS, w: THUMB_W, h: THUMB_H } : null };
  }
  sprite(id: string) { return join(this.dir, `${id.replace(/[^\w-]/g, '')}.jpg`); }

  /** Queue a title (url resolved lazily: it goes through the VOD proxy). Most recent first. */
  /** `thumbs: false`: only read its tracks and quality (title pages, for every version). */
  want(id: string, url: () => Promise<string>, { thumbs = true } = {}) {
    if (!isVodId(id) || (this.tracks.get(id) && (!thumbs || existsSync(this.sprite(id))))) return;
    const prev = this.queue.find((q) => q.id === id);
    this.queue = [{ id, url, thumbs: thumbs || !!prev?.thumbs }, ...this.queue.filter((q) => q.id !== id)].slice(0, 40);
    this.kick();
  }

  /** Is it using the provider connection right now? */
  get busy() { return this.running; }
  wants() { return this.queue.length > 0; }
  /** Resolves when the queue has been worked through (or interrupted). For tests. */
  async idle() { while (this.running) await new Promise((r) => setTimeout(r, 50)); }

  /** Stop now (a stream needs the provider connection); resolves once it's closed. */
  async stop() {
    this.stopping = true;
    if (this.proc && this.proc.exitCode === null) this.proc.kill('SIGKILL');
    await this.loop;
    this.stopping = false;
  }
  private stopping = false;
  private canRun() { return !this.stopping && this.slot.mayRun(this); }

  kick() {
    if (this.running || !this.queue.length || !this.canRun()) return;
    this.running = true;
    this.loop = this.work().catch((e) => this.log(`prefetch: ${(e as Error).message}`)).finally(() => { this.running = false; });
  }

  private async work() {
    while (this.queue.length && this.canRun()) {
      const job = this.queue[0];
      const url = await job.url();
      let t = this.tracks.get(job.id);
      if (!t) t = await this.tracks.probe(job.id, url).catch((e) => { this.log(`prefetch ${job.id}: ${(e as Error).message.split('\n')[0]}`); return undefined; });
      if (!t || !t.duration || !t.vcodec || !job.thumbs) { this.queue.shift(); continue; }
      if (!(await this.thumbnails(job.id, url, t.duration))) return; // interrupted: resume later
      this.queue.shift();
    }
  }

  /** One keyframe every duration/100 seconds, tiled into one JPEG. Returns false if interrupted. */
  private async thumbnails(id: string, url: string, duration: number): Promise<boolean> {
    if (existsSync(this.sprite(id))) return true;
    const work = join(this.dir, `.${id}`);
    mkdirSync(work, { recursive: true });
    const have = new Set(readdirSync(work));
    for (let i = 0; i < THUMBS; i++) {
      const f = `${String(i).padStart(3, '0')}.jpg`;
      if (have.has(f)) continue;
      if (!this.canRun()) return false;
      const at = (i + 0.5) * (duration / THUMBS);
      const ok = await this.run(['-hide_banner', '-loglevel', 'error', '-nostdin', '-skip_frame', 'nokey', '-ss', at.toFixed(2), '-i', url,
        '-frames:v', '1', '-vf', `scale=${THUMB_W}:-2:flags=bicubic`, '-q:v', '6', '-y', join(work, f)]);
      if (!ok && !this.canRun()) return false;
      await new Promise((r) => setTimeout(r, this.pace));
    }
    // Any frame that failed: repeat the previous one so the tiles stay in place.
    let last = '';
    for (let i = 0; i < THUMBS; i++) {
      const f = join(work, `${String(i).padStart(3, '0')}.jpg`);
      if (existsSync(f)) last = f; else if (last) await this.run(['-v', 'error', '-i', last, '-y', f]);
    }
    const tmp = join(this.dir, `.${id}.jpg`);
    if (!(await this.run(['-hide_banner', '-loglevel', 'error', '-framerate', '1', '-i', join(work, '%03d.jpg'),
      '-vf', `scale=${THUMB_W}:${THUMB_H}:force_original_aspect_ratio=decrease,pad=${THUMB_W}:${THUMB_H}:-1:-1,tile=${THUMB_COLS}x${THUMB_ROWS}`, '-frames:v', '1', '-q:v', '5', '-y', tmp]))) return true;
    renameSync(tmp, this.sprite(id));
    rmSync(work, { recursive: true, force: true });
    this.log(`thumbnails ready: ${id}`);
    return true;
  }

  private run(args: string[]): Promise<boolean> {
    return new Promise((resolve) => {
      const p = spawn('ffmpeg', args, { stdio: 'ignore' });
      this.proc = p;
      const t = setTimeout(() => p.kill('SIGKILL'), 30_000);
      p.on('exit', (code) => { clearTimeout(t); if (this.proc === p) this.proc = null; resolve(code === 0); });
      p.on('error', () => { clearTimeout(t); resolve(false); });
    });
  }
}
