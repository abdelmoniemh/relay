import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transcodeArgs, videoFilter, audioArgs, outFps, LIVE, VOD, LEGACY } from '../src/media.ts';

const vf = (a: string[]) => a[a.indexOf('-vf') + 1];
const val = (a: string[], k: string) => a[a.indexOf(k) + 1];

test('interlaced sources are deinterlaced to field rate on the GPU', () => {
  const info = { interlaced: true, fps: 25, bitDepth: 8 };
  assert.match(videoFilter(info, { gpu: true }), /^bwdif_cuda=mode=send_field/);
  assert.equal(outFps(info), 50);
  assert.equal(val(transcodeArgs('in.ts', { gpu: true, info }), '-g'), '100'); // 2s GOP at 50 fps
});

test('progressive 8-bit SDR stays on the GPU', () => {
  assert.equal(videoFilter({ bitDepth: 8 }, { gpu: true }), 'scale_cuda=format=nv12');
  assert.equal(videoFilter(null, { gpu: true }), 'scale_cuda=format=nv12');
});

test('10-bit SDR is dithered (swscale by default), not truncated', () => {
  assert.equal(videoFilter({ bitDepth: 10 }, { gpu: true }), 'hwdownload,format=p010le,format=yuv420p');
  assert.equal(videoFilter({ bitDepth: 10 }, { gpu: true, dither: 'truncate' }), 'scale_cuda=format=nv12');
});

test('HDR is tone mapped to BT.709', () => {
  const f = videoFilter({ bitDepth: 10, hdr: 'pq' }, { gpu: true });
  assert.match(f, /tonemap=tonemap=hable/);
  assert.match(f, /zscale=t=bt709:m=bt709/);
  assert.ok(!f.includes('scale_cuda=-2'), '1080p HDR is not rescaled');
  assert.match(videoFilter({ bitDepth: 10, hdr: 'pq', height: 2160 }, { gpu: true }), /^scale_cuda=-2:1440:format=p010le/); // 4K: map at 1440p
});

test('colour tags are never forced (SD sources are BT.601)', () => {
  const a = transcodeArgs('in.ts', { gpu: true, info: { height: 576 } });
  for (const k of ['-colorspace', '-color_primaries', '-color_trc', '-bsf:v']) assert.ok(!a.includes(k), k);
});

test('audio: AAC is copied, surround kept, others become stereo AAC', () => {
  assert.deepEqual(audioArgs({ acodec: 'aac', channels: 6 }, true), ['-c:a', 'copy']);
  const s = audioArgs({ acodec: 'ac3', channels: 6 }, true);
  assert.equal(val(s, '-ac'), '6'); assert.equal(val(s, '-b:a'), '448k');
  const live = audioArgs({ acodec: 'mp2', channels: 2 }, false);
  assert.equal(val(live, '-ac'), '2'); assert.ok(live.includes('-af'));
});

test('profiles: live uses the live profile, movies the VOD profile with real-time pacing', () => {
  const live = transcodeArgs('http://x/live.ts', { gpu: true });
  assert.equal(val(live, '-preset'), LIVE.preset);
  assert.ok(!live.includes('-readrate'));
  const vod = transcodeArgs('http://x/m.mkv', { gpu: true, vod: true, startAt: 60 });
  assert.equal(val(vod, '-preset'), VOD.preset);
  assert.equal(val(vod, '-readrate'), '1');
  assert.ok(vod.indexOf('-ss') < vod.indexOf('-i'));
});

test('B-frames get a mux delay; legacy (no B-frames) keeps zero', () => {
  assert.equal(val(transcodeArgs('a', { gpu: true, profile: LIVE }), '-muxdelay'), '0.2');
  assert.equal(val(transcodeArgs('a', { gpu: true, profile: LEGACY }), '-muxdelay'), '0');
});

test('audio-only mode copies video', () => {
  const a = transcodeArgs('a', { gpu: true, mode: 'audio', info: { acodec: 'ac3', channels: 6 } });
  assert.equal(val(a, '-c:v'), 'copy'); assert.ok(!a.includes('-vf'));
});

test('software fallback uses CPU filters', () => {
  const a = transcodeArgs('a', { gpu: false, info: { interlaced: true, fps: 25 } });
  assert.match(vf(a), /^bwdif=mode=send_field/);
  assert.equal(val(a, '-c:v'), 'libx264');
});
