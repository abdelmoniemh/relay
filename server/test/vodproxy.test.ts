import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { VodProxy } from '../src/vodproxy.ts';

let ok = true;
try { execFileSync('ffmpeg', ['-version']); } catch { ok = false; }

/** md5 of the frame decoded right after seeking to `at` in `url` (through ffmpeg's http + -reconnect, like production). */
// (async: the fake provider and the proxy live in this process and must keep answering)
const frameAt = async (url: string, at: number) => (await promisify(execFile)('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin',
  ...(url.startsWith('http') ? ['-reconnect', '1', '-reconnect_on_network_error', '1'] : []), '-ss', String(at), '-i', url, '-frames:v', '1', '-f', 'md5', '-'], { encoding: 'utf8', timeout: 30_000 })).stdout.trim();

test('seeks through the proxy: same frames, redirect resolved once, metadata from memory', { skip: !ok }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'vodproxy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'm.mkv');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25', '-f', 'lavfi', '-i', 'sine=r=48000',
    '-t', '60', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-c:a', 'aac', file]);
  const data = readFileSync(file);

  // Fake provider: /movie/... redirects to a play URL that serves byte ranges.
  const hits = { redirect: 0, ranges: 0 };
  const up = createServer((req, res) => {
    if (req.url!.startsWith('/movie/')) { hits.redirect++; res.writeHead(302, { location: '/play/tok/m.mkv' }); res.end(); return; }
    hits.ranges++;
    const off = Number(/bytes=(\d+)-/.exec(req.headers.range ?? '')?.[1] ?? 0);
    res.writeHead(206, { 'content-length': data.length - off, 'content-range': `bytes ${off}-${data.length - 1}/${data.length}`, 'accept-ranges': 'bytes' });
    res.end(data.subarray(off));
  });
  await new Promise<void>((r) => up.listen(0, '127.0.0.1', r));
  t.after(() => { up.closeAllConnections(); up.close(); });
  const src = `http://127.0.0.1:${(up.address() as AddressInfo).port}/movie/u/p/1.mkv`;

  const px = new VodProxy();
  const url = await px.url(src);
  assert.equal(await frameAt(url, 30), await frameAt(file, 30), 'same picture as the file itself');
  assert.equal(hits.redirect, 1, 'redirect resolved once, then reused');
  const cold = px.stats.upstream;

  assert.equal(await frameAt(url, 45), await frameAt(file, 45));
  const warm = px.stats.upstream - cold;
  assert.ok(warm < cold, `repeat seek needs fewer provider requests (${warm} vs ${cold})`);
  assert.ok(px.stats.hits > 0);
  assert.equal(hits.redirect, 1);
});
