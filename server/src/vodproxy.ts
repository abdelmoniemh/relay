// Local range proxy between ffmpeg and the provider, for movie/episode files.
//
// Every seek restarts ffmpeg, and ffmpeg opening an MKV at a position makes ~5 range requests: the header, the
// SeekHead and Cues at the end of the file, back to the start, and only then the position asked for. Each one is
// a fresh provider request that first bounces through a redirect, and the provider is slow to answer a request
// that follows a closed one (measured: 5.8s to the first segment, 4 of the 5 requests being metadata).
//
// Here: the redirect is resolved once per title and reused, and metadata reads (near the start or the end of the
// file) are kept in memory, so a repeat seek costs one provider request. Cache hits are answered with a short 206
// (just the cached bytes); if ffmpeg wants more it asks again from where that ended (its -reconnect handles it).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';

const UA = 'Relay/1.0 (like VLC/3.0.20)';
/** Reads starting this close to either end of the file are metadata (MKV header/Cues, MP4 moov, AVI index). */
const META_ZONE = 32 * 1024 * 1024;
/** Bytes kept per metadata read. */
const CHUNK = 2 * 1024 * 1024;
/** Reads kept per title from seek positions (ffprobe finding the keyframe, then ffmpeg reading the same spot). */
const RECENT = 3;
/** Titles kept (each holds a few chunks). */
const MAX_TITLES = 8;
const DEBUG = !!process.env.RELAY_DEBUG_VOD;

interface Title {
  src: string;
  /** Where the provider redirected us (reusable for range requests). */
  loc: string | null;
  size: number | null;
  /** meta: header/index reads (kept); otherwise one of the last few reads at a seek position. */
  chunks: { start: number; buf: Buffer; meta: boolean }[];
}

export class VodProxy {
  private titles = new Map<string, Title>();
  private port = 0;
  private ready: Promise<void>;
  /** For tests/logs: provider requests made, cache hits served. */
  stats = { upstream: 0, hits: 0 };

  private log: (m: string) => void;

  constructor(log: (m: string) => void = () => {}) {
    this.log = log;
    const srv = createServer((req, res) => { this.handle(req, res).catch((e) => { this.log(`vodproxy: ${(e as Error).message}`); if (!res.headersSent) res.writeHead(502); res.end(); }); });
    this.ready = new Promise((resolve) => srv.listen(0, '127.0.0.1', () => { this.port = (srv.address() as AddressInfo).port; resolve(); }));
    srv.unref();
  }

  /** Local URL to give ffmpeg instead of the provider's. */
  async url(src: string): Promise<string> {
    await this.ready;
    const key = createHash('sha1').update(src).digest('hex').slice(0, 20);
    const ext = /\.(\w{2,4})$/.exec(new URL(src).pathname)?.[1] ?? 'bin';
    if (!this.titles.has(key)) this.titles.set(key, { src, loc: null, size: null, chunks: [] });
    this.touch(key);
    return `http://127.0.0.1:${this.port}/${key}.${ext}`;
  }

  private touch(key: string) {
    const t = this.titles.get(key)!;
    this.titles.delete(key); this.titles.set(key, t); // most recent last
    while (this.titles.size > MAX_TITLES) this.titles.delete(this.titles.keys().next().value!);
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const key = /^\/([0-9a-f]{20})\./.exec(req.url ?? '')?.[1];
    const t = key ? this.titles.get(key) : undefined;
    if (!t) { res.writeHead(404); res.end(); return; }
    const off = Number(/bytes=(\d+)-/.exec(req.headers.range ?? '')?.[1] ?? 0);

    const hit = t.size != null ? t.chunks.find((c) => off >= c.start && off < c.start + c.buf.length) : undefined;
    if (hit) {
      this.stats.hits++;
      const part = hit.buf.subarray(off - hit.start);
      res.writeHead(206, {
        'content-type': 'application/octet-stream', 'accept-ranges': 'bytes', 'content-length': part.length,
        'content-range': `bytes ${off}-${off + part.length - 1}/${t.size}`,
      });
      res.end(part);
      if (DEBUG) this.log(`vodproxy: ${off} from memory (${part.length} bytes)`);
      return;
    }

    const ac = new AbortController();
    res.on('close', () => ac.abort());
    const t0 = Date.now();
    const up = await this.fetchUpstream(t, off, ac.signal);
    if (DEBUG) this.log(`vodproxy: ${off} → ${up.status} in ${Date.now() - t0}ms`);
    if (!up.body || (up.status !== 200 && up.status !== 206)) {
      res.writeHead(up.status === 416 ? 416 : 502); res.end(); await up.body?.cancel().catch(() => {}); return;
    }
    const size = Number(/\/(\d+)$/.exec(up.headers.get('content-range') ?? '')?.[1] ?? (up.status === 200 ? up.headers.get('content-length') : NaN));
    if (Number.isFinite(size) && size > 0) t.size = size;
    const headers: Record<string, string> = { 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes' };
    for (const h of ['content-length', 'content-range']) { const v = up.headers.get(h); if (v) headers[h] = v; }
    res.writeHead(up.status, headers);

    // Keep the first CHUNK bytes of every read: metadata for good, seek positions briefly.
    const meta = t.size != null && (off < META_ZONE || off >= t.size - META_ZONE);
    const keep: Buffer[] = []; let kept = 0, saved = false;
    const save = () => {
      if (t.size == null || !kept || saved) return;
      saved = true;
      const buf = Buffer.concat(keep);
      t.chunks = t.chunks.filter((c) => c.start < off || c.start >= off + buf.length); // replace overlapping smaller ones
      t.chunks.push({ start: off, buf, meta });
      const recent = t.chunks.filter((c) => !c.meta);
      if (recent.length > RECENT) t.chunks = t.chunks.filter((c) => c.meta || recent.indexOf(c) >= recent.length - RECENT);
    };
    try {
      for await (const chunk of up.body as AsyncIterable<Uint8Array>) {
        if (kept < CHUNK) { const b = Buffer.from(chunk.subarray(0, CHUNK - kept)); keep.push(b); kept += b.length; if (kept >= CHUNK) save(); }
        if (!res.write(chunk)) await new Promise<void>((r) => {
          const done = () => { res.off('drain', done); res.off('close', done); r(); };
          res.on('drain', done); res.on('close', done);
        });
        if (res.destroyed) break;
      }
    } catch { /* aborted: the client moved on */ }
    // Ended or abandoned early: whatever arrived is still the file's bytes at this offset (and it's about what
    // ffmpeg reads here before seeking away).
    save();
    res.end();
  }

  private async fetchUpstream(t: Title, off: number, signal: AbortSignal): Promise<Response> {
    const headers = { 'user-agent': UA, range: `bytes=${off}-` };
    if (t.loc) {
      this.stats.upstream++;
      const r = await fetch(t.loc, { headers, signal }).catch(() => null);
      if (r && (r.status === 200 || r.status === 206)) return r;
      await r?.body?.cancel().catch(() => {});
      t.loc = null; // expired: resolve the redirect again
    }
    this.stats.upstream++;
    const r = await fetch(t.src, { headers, signal });
    if (r.url && r.url !== t.src) t.loc = r.url;
    return r;
  }
}
