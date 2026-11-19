// Measures real stream quality while nothing is playing: resolution, fps, codec, bitrate, time-to-first-byte,
// and how much backlog the provider replays (≈ start delay). Never runs while a stream is active — the provider
// allows one connection — and aborts instantly when someone presses play.
import { spawn } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import type { Provider } from './config.ts';
import type { Probe } from './quality.ts';

const CAPTURE_MS = 4500;
const CAPTURE_MAX = 12 * 1024 * 1024;
const TTL_S = 60 * 60;            // re-check after an hour
const MAX_PER_HOUR = 240;         // be gentle with the provider

export class Prober {
  private db: DatabaseSync;
  private provider: Provider;
  private canRun: () => boolean;
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

  constructor(db: DatabaseSync, provider: Provider, opts: { canRun: () => boolean; background: () => number[]; log?: (m: string) => void }) {
    this.db = db; this.provider = provider; this.canRun = opts.canRun; this.background = opts.background; this.log = opts.log ?? (() => {});
    this.get = db.prepare('SELECT * FROM probes WHERE sid = ?');
    this.put = db.prepare(`INSERT OR REPLACE INTO probes (sid, at, ok, width, height, fps, vcodec, acodec, kbps, ttfb_ms, backlog_s, err)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    setInterval(() => this.tick(), 1500).unref();
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
      prev?.acodec ?? null, o.kbps ?? prev?.kbps ?? null, prev?.ttfb_ms ?? null, prev?.backlog_s ?? null, null);
  }

  /** Stop probing now; resolves when the provider connection is closed. Returns true if a probe was running. */
  async abort(): Promise<boolean> {
    const was = !!this.ctl;
    this.ctl?.abort();
    await this.running?.catch(() => {});
    return was;
  }

  /** Movie/series files: read the header for real resolution, HDR, audio format and languages. */
  requestVod(list: { id: string; url: string }[]) {
    const fresh = new Set((this.db.prepare(`SELECT id FROM vod_probes WHERE at > ? AND id IN (${list.map(() => '?').join(',') || "''"})`)
      .all(Math.floor(Date.now() / 1000) - 30 * 86400, ...list.map((l) => l.id)) as { id: string }[]).map((r) => r.id));
    for (const l of list.reverse()) if (!fresh.has(l.id) && !this.vodQueue.some((q) => q.id === l.id)) this.vodQueue.unshift(l);
    this.vodQueue = this.vodQueue.slice(0, 40);
  }

  private tick() {
    if (this.running || !this.canRun()) return;
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
    const url = `${this.provider.base}/live/${this.provider.user}/${this.provider.pass}/${sid}.ts`;
    const t0 = performance.now();
    const chunks: Buffer[] = [];
    let size = 0, ttfb = 0;
    const timer = setTimeout(() => ctl.abort(), CAPTURE_MS + 6000);
    try {
      const res = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'Relay/1.0 (like VLC/3.0.20)' } });
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
      const info = await ffprobe(Buffer.concat(chunks));
      if (!info.height) throw new Error('no video');
      const kbps = info.mediaSec > 0.5 ? Math.round((size * 8) / info.mediaSec / 1000) : null;
      this.put.run(sid, Math.floor(Date.now() / 1000), 1, info.width, info.height, info.fps, info.vcodec, info.acodec, kbps, ttfb,
        Math.max(0, +(info.mediaSec - wall).toFixed(1)), null);
      this.log(`probe ${sid}: ${info.width}x${info.height}@${info.fps} ${info.vcodec} ${kbps}kbps ttfb ${ttfb}ms`);
    } catch (e) {
      if (ctl.signal.aborted && !(size > 50_000) && performance.now() - t0 < CAPTURE_MS + 5900) {
        // aborted because someone pressed play: don't record a failure
        if (!this.canRun()) { this.urgent.unshift(sid); return; }
      }
      const msg = (e as Error).message;
      if (!ctl.signal.aborted || msg !== 'This operation was aborted') {
        this.put.run(sid, Math.floor(Date.now() / 1000), 0, null, null, null, null, null, null, ttfb || null, null, msg.slice(0, 80));
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
    const p = spawn('ffprobe', ['-v', 'error', '-of', 'json', '-probesize', '5M', '-analyzeduration', '2000000', '-user_agent', 'Relay/1.0',
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

function ffprobe(buf: Buffer): Promise<{ width: number | null; height: number | null; fps: number | null; vcodec: string | null; acodec: string | null; mediaSec: number }> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffprobe', ['-v', 'error', '-of', 'json', '-show_streams', '-select_streams', 'v:0', '-show_entries',
      'stream=codec_name,width,height,avg_frame_rate,r_frame_rate:packet=pts_time', '-show_packets', '-i', 'pipe:0'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', reject);
    p.on('close', async () => {
      try {
        const j = JSON.parse(out || '{}');
        const v = j.streams?.[0] ?? {};
        const rate = (s?: string) => { if (!s) return null; const [a, b] = s.split('/').map(Number); return b ? a / b : null; };
        let fps = rate(v.avg_frame_rate) || rate(v.r_frame_rate);
        if (fps && fps > 120) fps = rate(v.r_frame_rate);
        const pts = (j.packets ?? []).map((x: any) => Number(x.pts_time)).filter((x: number) => Number.isFinite(x));
        const mediaSec = pts.length > 1 ? Math.max(...pts) - Math.min(...pts) : 0;
        resolve({ width: v.width ?? null, height: v.height ?? null, fps: fps ? Math.round(fps * 100) / 100 : null, vcodec: v.codec_name ?? null, acodec: await audioCodec(buf), mediaSec });
      } catch (e) { reject(e); }
    });
    p.stdin.on('error', () => {});
    p.stdin.end(buf);
  });
}

function audioCodec(buf: Buffer): Promise<string | null> {
  return new Promise((resolve) => {
    const p = spawn('ffprobe', ['-v', 'error', '-of', 'csv=p=0', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-i', 'pipe:0'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => resolve(out.trim().split('\n')[0] || null));
    p.on('error', () => resolve(null));
    p.stdin.on('error', () => {});
    p.stdin.end(buf.subarray(0, Math.min(buf.length, 2 * 1024 * 1024)));
  });
}
