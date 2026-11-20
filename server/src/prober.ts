// Measures real stream quality while nothing is playing: resolution, fps, codec, bitrate, time-to-first-byte,
// and how much backlog the provider replays (≈ start delay). Never runs while a stream is active — the provider
// allows one connection — and aborts instantly when someone presses play.
import { spawn } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import { USER_AGENT, type Provider } from './xtream.ts';
import type { ProviderSlot, Worker } from './slot.ts';
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Probe } from './quality.ts';
import type { SourceInfo } from './media.ts';

const CAPTURE_MS = 4500;
const CAPTURE_MAX = 12 * 1024 * 1024;
const TTL_S = 60 * 60;            // re-check after an hour
const MAX_PER_HOUR = 240;         // be gentle with the provider
const SAMPLES_MAX = 40;           // RELAY_SAMPLES=1 keeps the captured bytes for the quality bench (data/samples)

export class Prober implements Worker {
  private db: DatabaseSync;
  private provider: Provider;
  private slot: ProviderSlot;
  private urgent: number[] = [];   // user asked (event opened)
  private background: () => number[];
  private ctl: AbortController | null = null;
  private running: Promise<void> | null = null;
  private recent: number[] = [];
  private log: (m: string) => void;
  private get: ReturnType<DatabaseSync['prepare']>;
  private put: ReturnType<DatabaseSync['prepare']>;
  active: number | null = null;
  private vodQueue: { id: string; url: string }[] = [];

  constructor(db: DatabaseSync, provider: Provider, slot: ProviderSlot, opts: { background: () => number[]; log?: (m: string) => void }) {
    this.db = db; this.provider = provider; this.slot = slot; this.background = opts.background; this.log = opts.log ?? (() => {});
    slot.work(this);
    this.get = db.prepare('SELECT * FROM probes WHERE sid = ?');
    this.put = db.prepare(`INSERT OR REPLACE INTO probes (sid, at, ok, width, height, fps, vcodec, acodec, kbps, ttfb_ms, backlog_s, err, interlaced, bitdepth, hdr, channels)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    setInterval(() => this.kick(), 1500).unref();
  }

  results(sids: number[]): Map<number, Probe> {
    const m = new Map<number, Probe>();
    if (!sids.length) return m;
    for (let i = 0; i < sids.length; i += 500) {
      const chunk = sids.slice(i, i + 500);
      const rows = this.db.prepare(`SELECT * FROM probes WHERE sid IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as unknown as Probe[];
      for (const r of rows) m.set(r.sid, r);
    }
    return m;
  }

  /** Queue streams the user is looking at right now (front of the line, even if checked recently-ish). */
  request(sids: number[]) {
    const now = Date.now() / 1000;
    const fresh = this.results(sids);
    for (const s of sids.reverse()) {
      const p = fresh.get(s);
      if (p && now - p.at < 20 * 60) continue;
      if (!this.urgent.includes(s)) this.urgent.unshift(s);
    }
    this.urgent = this.urgent.slice(0, 60);
  }

  pending() { return this.urgent.length; }

  /** What a device actually decoded while watching: free verification, no extra connection. */
  observed(sid: number, o: { width: number; height: number; fps?: number | null; vcodec?: string | null; kbps?: number | null }) {
    const prev = this.get.get(sid) as Probe | undefined;
    this.put.run(sid, Math.floor(Date.now() / 1000), 1, o.width, o.height, o.fps ?? prev?.fps ?? null, o.vcodec ?? prev?.vcodec ?? null,
      prev?.acodec ?? null, o.kbps ?? prev?.kbps ?? null, prev?.ttfb_ms ?? null, prev?.backlog_s ?? null, null,
      prev?.interlaced ?? null, prev?.bitdepth ?? null, prev?.hdr ?? null, prev?.channels ?? null);
  }

  /** Is a probe holding the provider connection right now? */
  get busy() { return !!this.running; }

  /** Stop probing now; resolves when the provider connection is closed. */
  async stop() {
    this.stopping = true;
    this.ctl?.abort();
    await this.running?.catch(() => {});
    this.stopping = false;
  }
  private stopping = false;

  /** Movie/series files: read the header for real resolution, HDR, audio format and languages. */
  requestVod(list: { id: string; url: string }[]) {
    const fresh = new Set((this.db.prepare(`SELECT id FROM vod_probes WHERE at > ? AND id IN (${list.map(() => '?').join(',') || "''"})`)
      .all(Math.floor(Date.now() / 1000) - 30 * 86400, ...list.map((l) => l.id)) as { id: string }[]).map((r) => r.id));
    for (const l of list.reverse()) if (!fresh.has(l.id) && !this.vodQueue.some((q) => q.id === l.id)) this.vodQueue.unshift(l);
    this.vodQueue = this.vodQueue.slice(0, 40);
  }

  kick() {
    if (this.running || !this.slot.mayRun(this)) return;
    const vod = this.vodQueue.shift();
    if (vod) {
      this.running = this.probeVod(vod.id, vod.url).finally(() => { this.running = null; this.ctl = null; });
      return;
    }
    const now = Date.now();
    this.recent = this.recent.filter((t) => now - t < 3600_000);
    if (this.recent.length >= MAX_PER_HOUR) return;
    let sid = this.urgent.shift();
    if (sid == null) {
      const stale = this.background().filter((s) => { const p = this.get.get(s) as Probe | undefined; return !p || now / 1000 - p.at > TTL_S; });
      sid = stale[0];
    }
    if (sid == null) return;
    this.recent.push(now);
    this.running = this.probe(sid).finally(() => { this.running = null; this.ctl = null; this.active = null; });
  }

  private async probeVod(id: string, url: string) {
    const ctl = (this.ctl = new AbortController());
    try {
      const r = await probeVodUrl(url, ctl.signal);
      this.db.prepare(`INSERT OR REPLACE INTO vod_probes (id, at, ok, width, height, hdr, vcodec, acodec, channels, alangs, slangs, err) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
        .run(id, Math.floor(Date.now() / 1000), r.width, r.height, r.hdr, r.vcodec, r.acodec, r.channels, r.alangs, r.slangs);
      this.log(`vod probe ${id}: ${r.width}x${r.height} ${r.hdr} ${r.vcodec}/${r.acodec} ${r.channels}ch a:${r.alangs} s:${r.slangs}`);
    } catch (e) {
      if (ctl.signal.aborted) { this.vodQueue.unshift({ id, url }); return; } // someone pressed play: retry later
      this.db.prepare(`INSERT OR REPLACE INTO vod_probes (id, at, ok, err) VALUES (?, ?, 0, ?)`).run(id, Math.floor(Date.now() / 1000), (e as Error).message.slice(0, 80));
    }
  }

  private async probe(sid: number) {
    const ctl = (this.ctl = new AbortController());
    this.active = sid;
    const url = this.provider.live(sid);
    const t0 = performance.now();
    const chunks: Buffer[] = [];
    let size = 0, ttfb = 0;
    const timer = setTimeout(() => ctl.abort(), CAPTURE_MS + 6000);
    try {
      const res = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': USER_AGENT } });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      let first = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!first) { first = performance.now(); ttfb = Math.round(first - t0); }
        chunks.push(Buffer.from(value)); size += value.byteLength;
        if (size > CAPTURE_MAX || performance.now() - first > CAPTURE_MS) break;
      }
      await reader.cancel().catch(() => {});
      const wall = (performance.now() - (first || t0)) / 1000;
      ctl.abort(); // close the provider connection before analysing
      if (size < 50_000) throw new Error('no data');
      const buf = Buffer.concat(chunks);
      const info = await ffprobe(buf);
      if (!info.height) throw new Error('no video');
      const kbps = info.mediaSec > 0.5 ? Math.round((size * 8) / info.mediaSec / 1000) : null;
      const interlaced = await detectInterlace(buf, info.fieldOrder, info.fps);
      this.put.run(sid, Math.floor(Date.now() / 1000), 1, info.width, info.height, info.fps, info.vcodec, info.acodec, kbps, ttfb,
        Math.max(0, +(info.mediaSec - wall).toFixed(1)), null, interlaced ? 1 : 0, info.bitDepth, info.hdr, info.channels);
      this.log(`probe ${sid}: ${info.width}x${info.height}${interlaced ? 'i' : 'p'}@${info.fps} ${info.vcodec} ${info.bitDepth}bit ${info.hdr ?? 'sdr'} ${kbps}kbps ttfb ${ttfb}ms`);
      if (process.env.RELAY_SAMPLES === '1') saveSample(sid, buf, { vcodec: info.vcodec, width: info.width, height: info.height, fps: info.fps,
        interlaced, bitDepth: info.bitDepth, hdr: info.hdr, acodec: info.acodec, channels: info.channels });
    } catch (e) {
      if (ctl.signal.aborted && !(size > 50_000) && performance.now() - t0 < CAPTURE_MS + 5900) {
        // aborted because someone pressed play: don't record a failure
        if (this.stopping || !this.slot.mayRun(this)) { this.urgent.unshift(sid); return; }
      }
      const msg = (e as Error).message;
      if (!ctl.signal.aborted || msg !== 'This operation was aborted') {
        this.put.run(sid, Math.floor(Date.now() / 1000), 0, null, null, null, null, null, null, ttfb || null, null, msg.slice(0, 80), null, null, null, null);
        this.log(`probe ${sid} failed: ${msg}`);
      }
    } finally {
      clearTimeout(timer);
      ctl.abort();
    }
  }
}

function hdrOf(s: any): string {
  if ((s.side_data_list ?? []).some((d: any) => /DOVI|Dolby Vision/i.test(d.side_data_type ?? ''))) return 'dv';
  if (s.color_transfer === 'smpte2084') return 'hdr10';
  if (s.color_transfer === 'arib-std-b67') return 'hlg';
  return 'sdr';
}

export interface VodProbeResult { width: number | null; height: number | null; hdr: string; vcodec: string | null; acodec: string | null; channels: number | null; alangs: string; slangs: string }

/** ffprobe a remote movie file (reads the header + a little data). */
export function probeVodUrl(url: string, signal: AbortSignal): Promise<VodProbeResult> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffprobe', ['-v', 'error', '-of', 'json', '-probesize', '5M', '-analyzeduration', '2000000', '-user_agent', USER_AGENT,
      '-show_entries', 'stream=codec_type,codec_name,width,height,color_transfer,channels,side_data_list:stream_tags=language', '-i', url],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    const kill = () => p.kill('SIGKILL');
    signal.addEventListener('abort', kill, { once: true });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(kill, 20_000);
    p.on('close', (code) => {
      clearTimeout(timer); signal.removeEventListener('abort', kill);
      if (code !== 0) return reject(new Error(err.trim().split('\n').pop() || `ffprobe exit ${code}`));
      try {
        const st = (JSON.parse(out).streams ?? []) as any[];
        const v = st.find((s) => s.codec_type === 'video' && s.width);
        const a = st.filter((s) => s.codec_type === 'audio');
        const sub = st.filter((s) => s.codec_type === 'subtitle');
        const langs = (l: any[]) => [...new Set(l.map((s) => s.tags?.language).filter((x: string) => x && x !== 'und'))].join(',');
        resolve({ width: v?.width ?? null, height: v?.height ?? null, hdr: v ? hdrOf(v) : 'sdr', vcodec: v?.codec_name ?? null,
          acodec: a[0]?.codec_name ?? null, channels: a[0]?.channels ?? null, alangs: langs(a), slangs: langs(sub) });
      } catch (e) { reject(e); }
    });
  });
}

interface SampleInfo {
  width: number | null; height: number | null; fps: number | null; vcodec: string | null; acodec: string | null; mediaSec: number;
  bitDepth: number | null; hdr: 'pq' | 'hlg' | null; fieldOrder: string | null; channels: number | null;
}

/** SourceInfo the transcoder can use, from a probe row. */
export function probeToSource(p: Probe | undefined | null): SourceInfo | null {
  if (!p || !p.ok) return null;
  return { vcodec: p.vcodec, width: p.width, height: p.height, fps: p.fps, interlaced: p.interlaced == null ? null : !!p.interlaced,
    bitDepth: p.bitdepth ?? null, hdr: p.hdr === 'pq' || p.hdr === 'hlg' ? p.hdr : null, acodec: p.acodec, channels: p.channels ?? null };
}

function saveSample(sid: number, buf: Buffer, info: SourceInfo) {
  try {
    const dir = join(process.env.DATA_DIR ?? './data', 'samples');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sid}.ts`), buf);
    writeFileSync(join(dir, `${sid}.json`), JSON.stringify(info));
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(SAMPLES_MAX)) { unlinkSync(join(dir, f)); try { unlinkSync(join(dir, f.replace(/\.ts$/, '.json'))); } catch {} }
  } catch {}
}

function runProbe(args: string[], buf: Buffer): Promise<{ out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(args[0], args.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    p.on('close', () => resolve({ out, err }));
    p.on('error', () => resolve({ out, err }));
    p.stdin.on('error', () => {});
    p.stdin.end(buf);
  });
}

export async function ffprobe(buf: Buffer): Promise<SampleInfo> {
  const { out } = await runProbe(['ffprobe', '-v', 'error', '-of', 'json', '-show_streams', '-show_entries',
    'stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,pix_fmt,field_order,color_transfer,channels:packet=pts_time,stream_index',
    '-show_packets', '-select_streams', 'v:0', '-i', 'pipe:0'], buf);
  const j = JSON.parse(out || '{}');
  const v = j.streams?.[0] ?? {};
  const rate = (s?: string) => { if (!s) return null; const [a, b] = s.split('/').map(Number); return b ? a / b : null; };
  let fps = rate(v.avg_frame_rate) || rate(v.r_frame_rate);
  if (fps && fps > 120) fps = rate(v.r_frame_rate);
  const pts = (j.packets ?? []).map((x: any) => Number(x.pts_time)).filter((x: number) => Number.isFinite(x));
  const mediaSec = pts.length > 1 ? Math.max(...pts) - Math.min(...pts) : 0;
  const depth = /(\d+)(le|be)$/.exec(v.pix_fmt ?? '');
  const a = await runProbe(['ffprobe', '-v', 'error', '-of', 'json', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,channels', '-i', 'pipe:0'],
    buf.subarray(0, Math.min(buf.length, 2 * 1024 * 1024)));
  const as = JSON.parse(a.out || '{}').streams?.[0] ?? {};
  return {
    width: v.width ?? null, height: v.height ?? null, fps: fps ? Math.round(fps * 100) / 100 : null, vcodec: v.codec_name ?? null, mediaSec,
    bitDepth: v.pix_fmt ? (depth ? Number(depth[1]) : 8) : null,
    hdr: v.color_transfer === 'smpte2084' ? 'pq' : v.color_transfer === 'arib-std-b67' ? 'hlg' : null,
    fieldOrder: v.field_order ?? null, acodec: as.codec_name ?? null, channels: as.channels ?? null,
  };
}

/** Interlaced content? The container flag is often missing or wrong, so look at the pictures (idet) too. */
export async function detectInterlace(buf: Buffer, fieldOrder: string | null, fps?: number | null): Promise<boolean> {
  // Coded progressive at 50/60 frames a second can't be carrying weaved fields: motion blur and streaky
  // textures (race tracks, pitches) are what fool idet there (a real 50p MotoGP feed read TFF 75 / progressive 0).
  if (fieldOrder === 'progressive' && (fps ?? 0) >= 48) return false;
  const { err } = await runProbe(['ffmpeg', '-hide_banner', '-nostdin', '-i', 'pipe:0', '-an', '-frames:v', '150', '-vf', 'idet', '-f', 'null', '-'], buf);
  // ffmpeg prints the summary twice (the first from a discarded graph): use the last one
  const m = [...err.matchAll(/Multi frame detection: TFF:\s*(\d+)\s*BFF:\s*(\d+)\s*Progressive:\s*(\d+)/g)].pop();
  const [t, b, p] = m ? m.slice(1).map(Number) : [0, 0, 0];
  // Real interlacing has one consistent field order; busy synthetic/grainy pictures fool idet with a TFF/BFF mix.
  const dom = Math.max(t, b), idet = t + b + p >= 20 && dom >= 3 * Math.min(t, b) && dom > 2 * p;
  if (fieldOrder && /^(tt|bb|tb|bt)$/.test(fieldOrder)) return !(t + b + p >= 20 && p > 3 * (t + b)); // coded interlaced, unless clearly PsF
  if (fieldOrder === 'progressive') return idet && dom > 6 * p; // flagged progressive but visibly combed
  return idet;
}
