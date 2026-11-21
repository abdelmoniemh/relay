import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankSources, rateScore, type Probe } from '../src/quality.ts';
import type { Item } from '../../shared/protocol.ts';

const now = Math.floor(Date.now() / 1000);
const item = (n: number, name = `Ch ${n}`): { item: Item; fam: number } => ({ item: { id: `l${n}`, kind: 'live', name }, fam: 1 });
const probe = (sid: number, o: Partial<Probe>): Probe => ({ sid, at: now, ok: 1, width: 1920, height: 1080, fps: 50, vcodec: 'h264', acodec: 'aac',
  kbps: 8000, ttfb_ms: 400, backlog_s: 15, err: null, interlaced: 0, bitdepth: 8, hdr: null, channels: 2, ...o });
const rank = (ps: Probe[], hevcOk = false) => rankSources(ps.map((p) => item(p.sid)), new Map(ps.map((p) => [`l${p.sid}`, p])), { hevcOk });

test('a looping slate (minutes of backlog) is a placeholder, even at a plausible bitrate', () => {
  const r = rank([probe(1, { fps: 30, kbps: 1050, backlog_s: 520 }), probe(2, { height: 720, width: 1280, kbps: 4000 })]);
  assert.equal(r[0].item.id, 'l2');
  assert.equal(r[1].dead, true);
  assert.match(r[1].label, /placeholder/);
});

test('1080i25 counts as 50 pictures/s and is flagged for deinterlacing', () => {
  const [s] = rank([probe(1, { fps: 25, interlaced: 1 })]);
  assert.equal(s.fps, 50); assert.equal(s.interlaced, true); assert.match(s.label, /^1080i50/);
});

test('a native progressive copy beats the same copy interlaced', () => {
  const r = rank([probe(1, { fps: 25, interlaced: 1 }), probe(2, { fps: 50 })]);
  assert.equal(r[0].item.id, 'l2');
});

test('bitrate is judged per pixel: a starved 1080p loses points vs a well-fed one', () => {
  assert.ok(rateScore(8000, 1920, 1080, 50, false) > rateScore(3000, 1920, 1080, 50, false));
  assert.ok(rateScore(4000, 1920, 1080, 50, true) > rateScore(4000, 1920, 1080, 50, false)); // HEVC is more efficient
  assert.equal(rateScore(1e6, 1920, 1080, 50, false), 25); // capped
  const r = rank([probe(1, { kbps: 2500 }), probe(2, { kbps: 9000 })]);
  assert.equal(r[0].item.id, 'l2');
});

test('higher resolution still wins at sane bitrates', () => {
  const r = rank([probe(1, { width: 1280, height: 720, fps: 60, kbps: 7000 }), probe(2, { fps: 60, kbps: 8200 })]);
  assert.equal(r[0].item.id, 'l2');
});
