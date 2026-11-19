import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Transcoder } from '../src/transcode.ts';

const tx = new Transcoder();

test('end to end: an interlaced live source comes out progressive at field rate, playable', { skip: !tx.available, timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-tx-'));
  try {
    const src = join(dir, 'in.ts');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=50', '-f', 'lavfi', '-i', 'sine=r=48000', '-t', '3',
      '-vf', 'tinterlace=mode=interleave_top,setfield=tff', '-c:v', 'libx264', '-flags', '+ildct+ilme', '-x264opts', 'tff=1', '-c:a', 'mp2', '-f', 'mpegts', src]);
    const { proc, first } = await tx.start(src, 0, () => {}, 'test', { info: { vcodec: 'h264', fps: 25, interlaced: true, bitDepth: 8, acodec: 'mp2', channels: 2 } });
    const chunks = [first];
    proc.stdout.on('data', (d: Buffer) => chunks.push(d));
    await new Promise((r) => proc.on('exit', r));
    const out = join(dir, 'out.ts');
    writeFileSync(out, Buffer.concat(chunks));
    const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-of', 'json', '-show_entries', 'stream=codec_type,codec_name,avg_frame_rate,channels', out], { encoding: 'utf8' }));
    const v = j.streams.find((s: any) => s.codec_type === 'video'), a = j.streams.find((s: any) => s.codec_type === 'audio');
    assert.equal(v.codec_name, 'h264'); assert.equal(v.avg_frame_rate, '50/1');
    assert.equal(a.codec_name, 'aac'); assert.equal(a.channels, 2);
    const err = spawnSync('ffmpeg', ['-hide_banner', '-i', out, '-an', '-vf', 'idet', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
    const m = [...err.matchAll(/Multi frame detection: TFF:\s*(\d+)\s*BFF:\s*(\d+)\s*Progressive:\s*(\d+)/g)].pop()!;
    const [t, b, p] = m.slice(1).map(Number);
    assert.ok(t + b < 0.1 * (t + b + p), `still combed: TFF ${t} BFF ${b} progressive ${p}`);
  } finally { await tx.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('a newer start supersedes one still starting (no fight over the provider connection)', { skip: !tx.available, timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-tx-'));
  try {
    const src = join(dir, 'in.ts');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25', '-t', '20', '-c:v', 'libx264', '-f', 'mpegts', src]);
    const logs: string[] = [];
    const a = tx.start(src, 3, (m) => logs.push(`a ${m}`), 'pc', { vod: true });
    const b = tx.start(src, 10, (m) => logs.push(`b ${m}`), 'pc', { vod: true });
    await assert.rejects(a, /superseded/);
    const { proc } = await b;
    assert.ok(tx.owns(proc), 'the newer request owns the running conversion');
    assert.equal(logs.filter((l) => l.startsWith('a') && /started/.test(l)).length, 0, logs.join('; '));
    const ac = new AbortController(); ac.abort();
    await assert.rejects(tx.start(src, 0, () => {}, 'pc', { vod: true, signal: ac.signal }), /superseded/);
  } finally { await tx.stop(); rmSync(dir, { recursive: true, force: true }); }
});
