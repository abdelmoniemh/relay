import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timeshiftUrl, catchupSource, streamUrls } from '../src/xtream.ts';

const p = { base: 'http://prov.example:8080', user: 'u', pass: 'p' };
// 2026-11-19 10:45:00 UTC
const t = Date.UTC(2026, 10, 19, 10, 45) / 1000;

test('timeshift URL uses the provider clock (incl. DST-less winter offset)', () => {
  assert.equal(timeshiftUrl(p, 497001, t, 30, 'Europe/Amsterdam'), 'http://prov.example:8080/timeshift/u/p/30/2026-11-19:11-45/497001.ts');
  assert.equal(timeshiftUrl(p, 497001, t, 30, 'UTC'), 'http://prov.example:8080/timeshift/u/p/30/2026-11-19:10-45/497001.ts');
  assert.equal(timeshiftUrl(p, 1, t, 0.2, 'UTC').split('/')[6], '1', 'at least one minute');
});

test('catch-up from inside a programme: the minute before plus seconds to skip; ends at its end', () => {
  const prog = { start: t, stop: t + 1800 };
  const c = catchupSource(p, 9, prog, 125, t + 99999);
  assert.match(c.url, /\/timeshift\/u\/p\/28\/\d{4}-\d\d-\d\d:\d\d-47\/9\.ts$/); // 10:47, 28 minutes left
  assert.equal(c.skip, 5);
  assert.equal(catchupSource(p, 9, prog, 0, t + 99999).skip, 0);
});

test('start over (programme still on air) only asks for what has aired', () => {
  const c = catchupSource(p, 9, { start: t, stop: t + 3600 }, 0, t + 600);
  assert.match(c.url, /\/timeshift\/u\/p\/10\//);
});

test('a catch-up item streams from the archive', () => {
  const [u] = streamUrls(p, { id: 'l9', kind: 'live', name: 'x', catchup: { start: t, stop: t + 1800 } });
  assert.match(u, /\/timeshift\/u\/p\/30\//);
  assert.deepEqual(streamUrls(p, { id: 'l9', kind: 'live', name: 'x' }), ['http://prov.example:8080/live/u/p/9.m3u8', 'http://prov.example:8080/live/u/p/9.ts']);
});
