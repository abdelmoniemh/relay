import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { ffprobe, detectInterlace, probeToSource } from '../src/prober.ts';

const make = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=720x576:r=50', '-f', 'lavfi', '-i', 'sine=r=48000',
  '-t', '3', ...args, '-f', 'mpegts', 'pipe:1'], { maxBuffer: 64 << 20 });
let ok = true;
try { execFileSync('ffmpeg', ['-version']); } catch { ok = false; }

test('detects interlaced H.264 with MP2 audio', { skip: !ok }, async () => {
  const buf = make(['-vf', 'tinterlace=mode=interleave_top,setfield=tff', '-c:v', 'libx264', '-flags', '+ildct+ilme', '-x264opts', 'tff=1', '-c:a', 'mp2']);
  const i = await ffprobe(buf);
  assert.equal(i.vcodec, 'h264'); assert.equal(i.bitDepth, 8); assert.equal(i.acodec, 'mp2'); assert.equal(i.fps, 25);
  assert.equal(await detectInterlace(buf, i.fieldOrder), true);
});

test('progressive 10-bit HEVC PQ is not interlaced, is 10-bit HDR', { skip: !ok }, async () => {
  const buf = make(['-vf', 'format=yuv420p10le', '-c:v', 'libx265', '-x265-params', 'log-level=error:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc', '-preset', 'ultrafast',
    '-color_trc', 'smpte2084', '-color_primaries', 'bt2020', '-colorspace', 'bt2020nc', '-c:a', 'aac', '-ac', '6']);
  const i = await ffprobe(buf);
  assert.equal(i.vcodec, 'hevc'); assert.equal(i.bitDepth, 10); assert.equal(i.hdr, 'pq'); assert.equal(i.channels, 6);
  assert.equal(await detectInterlace(buf, i.fieldOrder), false);
});

test('probe rows map to SourceInfo', () => {
  const s = probeToSource({ sid: 1, at: 0, ok: 1, width: 1920, height: 1080, fps: 25, vcodec: 'h264', acodec: 'aac', kbps: 8000, ttfb_ms: 1, backlog_s: 1, err: null,
    interlaced: 1, bitdepth: 8, hdr: null, channels: 2 });
  assert.deepEqual(s, { vcodec: 'h264', width: 1920, height: 1080, fps: 25, interlaced: true, bitDepth: 8, hdr: null, acodec: 'aac', channels: 2 });
  assert.equal(probeToSource({ ok: 0 } as any), null);
});
