// Browser acceptance: plays MPEG-TS files in headless Chrome through mpegts.js, configured like the app's player,
// and reports what really got decoded (resolution, frames, drops, audio, errors).
// Usage: node bench/browser.ts [file.ts ...]   (default: every file in bench/.out)
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { OUT_DIR } from './quality.ts';

export interface PlayResult {
  file: string; ok: boolean; err?: string;
  width?: number; height?: number; played?: number; frames?: number; dropped?: number;
  audioBytes?: number; channels?: number; vcodec?: string; acodec?: string;
}

const MPEGTS = [resolve(import.meta.dirname, '../../web/node_modules/mpegts.js/dist/mpegts.js'),
  resolve(import.meta.dirname, '../../node_modules/mpegts.js/dist/mpegts.js')].find(existsSync)!;
const CHROME = ['google-chrome-stable', 'chromium', 'google-chrome'].find((c) => {
  try { return !!spawn('which', [c]).pid; } catch { return false; }
}) ?? 'google-chrome-stable';

const PAGE = `<!doctype html><html><body><video id=v autoplay playsinline style="width:640px"></video>
<script src="/mpegts.js"></script><script>
window.run = (url, secs) => new Promise((done) => {
  const v = document.getElementById('v'); const out = { errors: [], log: [], diag: { supported: mpegts.isSupported(), h264: MediaSource.isTypeSupported('video/mp4; codecs="avc1.640028"'), aac: MediaSource.isTypeSupported('audio/mp4; codecs="mp4a.40.2"'), feat: JSON.stringify(mpegts.getFeatureList()) } };
  fetch(location.origin + url).then((r) => r.arrayBuffer()).then((b) => { out.diag.fetched = b.byteLength; }).catch((e) => { out.diag.fetchErr = String(e); });
  mpegts.LoggingControl.applyConfig({ enableAll: true }); mpegts.LoggingControl.addLogListener((l, m) => { if (out.log.length < 15) out.log.push(m); });
  const p = mpegts.createPlayer({ type: 'mpegts', isLive: true, url: location.origin + url }, {
    enableWorker: !!window.WORKER, enableStashBuffer: false, stashInitialSize: 256 * 1024, lazyLoad: false,
    autoCleanupSourceBuffer: true, liveBufferLatencyChasing: false, liveSync: false });
  p.on(mpegts.Events.ERROR, (t, d, i) => out.errors.push(t + ':' + d + ':' + (i && i.msg || '')));
  p.on(mpegts.Events.MEDIA_INFO, (mi) => { out.vcodec = mi.videoCodec; out.acodec = mi.audioCodec; out.channels = mi.audioChannelCount; });
  v.addEventListener('error', () => out.errors.push('video:' + (v.error && v.error.message)));
  p.attachMediaElement(v); p.load(); v.play().catch(() => {}); // the app ignores this too ("interrupted by a new load")
  setTimeout(() => {
    const q = v.getVideoPlaybackQuality();
    Object.assign(out, { width: v.videoWidth, height: v.videoHeight, played: v.currentTime, frames: q.totalVideoFrames,
      dropped: q.droppedVideoFrames, audioBytes: v.webkitAudioDecodedByteCount, rs: v.readyState, ns: v.networkState, src: v.src.slice(0, 30), buf: v.buffered.length, stats: p.statisticsInfo, vis: document.visibilityState });
    p.destroy(); done(out);
  }, secs * 1000);
});
</script></body></html>`;

async function cdp(wsUrl: string) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const waiting = new Map<number, (m: any) => void>();
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (!m.id && process.env.DEBUG && /console|exception|Log\.entry/i.test(m.method)) console.error('[page]', JSON.stringify(m.params).slice(0, 400));
    waiting.get(m.id)?.(m); waiting.delete(m.id);
  };
  const send = (method: string, params: object = {}, sessionId?: string) => new Promise<any>((r) => {
    const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId }));
  });
  return { send, close: () => ws.close() };
}

export async function playAll(files: string[], secs = 5): Promise<PlayResult[]> {
  const server = createServer((req, res) => {
    const u = new URL(req.url!, 'http://x');
    if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); return; }
    if (u.pathname === '/mpegts.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); createReadStream(MPEGTS).pipe(res); return; }
    const f = files.find((x) => basename(x) === decodeURIComponent(u.pathname.slice(3)));
    if (u.pathname.startsWith('/f/') && f) { res.writeHead(200, { 'content-type': 'video/mp2t' }); createReadStream(f).pipe(res); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  const prof = mkdtempSync(join(tmpdir(), 'relay-chrome-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${prof}`, '--no-first-run',
    '--autoplay-policy=no-user-gesture-required', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  const out: PlayResult[] = [];
  try {
    let port2 = '';
    for (let i = 0; i < 100 && !port2; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try { port2 = readFileSync(join(prof, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch {}
    }
    if (!port2) throw new Error('chrome did not start');
    const ver = await (await fetch(`http://127.0.0.1:${port2}/json/version`)).json();
    const c = await cdp(ver.webSocketDebuggerUrl);
    const { targetId } = (await c.send('Target.createTarget', { url: `http://127.0.0.1:${port}/` })).result;
    const { sessionId } = (await c.send('Target.attachToTarget', { targetId, flatten: true })).result;
    await c.send('Runtime.enable', {}, sessionId); await c.send('Log.enable', {}, sessionId);
    await c.send('Page.bringToFront', {}, sessionId); await c.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
    await new Promise((r) => setTimeout(r, 1500));
    for (const f of files) {
      const r = await c.send('Runtime.evaluate', { expression: `run('/f/${encodeURIComponent(basename(f))}', ${secs})`, awaitPromise: true, returnByValue: true }, sessionId);
      if (process.env.DEBUG) console.error(JSON.stringify(r).slice(0, 600));
      const v = r.result?.result?.value ?? {};
      const errs: string[] = v.errors ?? [];
      const res: PlayResult = { file: basename(f), ...v, ok: false };
      delete (res as any).errors; const log: string[] = v.log ?? []; delete (res as any).log;
      if (process.env.DEBUG) console.error(log.join('\n'));
      const hasAudio = !!v.acodec;
      res.ok = !errs.length && v.height > 0 && v.played > 1 && v.frames > 0 && (v.dropped ?? 0) / Math.max(1, v.frames) < 0.05 && (!hasAudio || v.audioBytes > 0);
      if (!res.ok) res.err = errs.join(' | ') || (v.height ? (hasAudio && !v.audioBytes ? 'no audio decoded' : `played ${v.played}s, dropped ${v.dropped}/${v.frames}`) : 'no picture');
      out.push(res);
      process.stderr.write(`${res.ok ? 'PLAYS ' : 'FAILS '} ${res.file.padEnd(48)} ${v.width}x${v.height} ${v.vcodec ?? ''} ${v.acodec ?? '-'}/${v.channels ?? '-'}ch frames ${v.frames} dropped ${v.dropped} audio ${v.audioBytes}B${res.err ? '  ' + res.err : ''}\n`);
    }
    c.close();
  } finally {
    chrome.kill('SIGKILL'); server.close();
    await new Promise((r) => setTimeout(r, 300));
    try { rmSync(prof, { recursive: true, force: true }); } catch {}
  }
  return out;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const files = args.length ? args.map((a) => resolve(a)) : readdirSync(OUT_DIR).filter((f) => f.endsWith('.ts')).map((f) => join(OUT_DIR, f));
  const r = await playAll(files);
  console.log(`\n${r.filter((x) => x.ok).length}/${r.length} play correctly`);
  process.exitCode = r.every((x) => x.ok) ? 0 : 1;
}
