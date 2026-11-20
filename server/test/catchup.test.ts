import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Provider } from '../src/xtream.ts';

const creds = { base: 'http://prov.example:8080', user: 'u', pass: 'p' };
const p = new Provider(creds, 'UTC');
// 2026-11-19 10:45:00 UTC
const t = Date.UTC(2026, 10, 19, 10, 45) / 1000;

test('timeshift URL uses the provider clock (incl. DST-less winter offset)', () => {
  assert.equal(new Provider(creds, 'Europe/Amsterdam').timeshift(497001, t, 30), 'http://prov.example:8080/timeshift/u/p/30/2026-11-19:11-45/497001.ts');
  assert.equal(p.timeshift(497001, t, 30), 'http://prov.example:8080/timeshift/u/p/30/2026-11-19:10-45/497001.ts');
  assert.equal(p.timeshift(1, t, 0.2).split('/')[6], '1', 'at least one minute');
});

test('catch-up from inside a programme: the minute before plus seconds to skip; ends at its end', () => {
  const prog = { start: t, stop: t + 1800 };
  const c = p.catchup(9, prog, 125, t + 99999);
  assert.match(c.url, /\/timeshift\/u\/p\/28\/\d{4}-\d\d-\d\d:\d\d-47\/9\.ts$/); // 10:47, 28 minutes left
  assert.equal(c.skip, 5);
  assert.equal(p.catchup(9, prog, 0, t + 99999).skip, 0);
});

test('start over (programme still on air) only asks for what has aired', () => {
  const c = p.catchup(9, { start: t, stop: t + 3600 }, 0, t + 600);
  assert.match(c.url, /\/timeshift\/u\/p\/10\//);
});

test('a catch-up item streams from the archive', () => {
  const [u] = p.urls({ id: 'l9', kind: 'live', catchup: { start: t, stop: t + 1800 } });
  assert.match(u, /\/timeshift\/u\/p\/30\//);
  assert.deepEqual(p.urls({ id: 'l9', kind: 'live' }), ['http://prov.example:8080/live/u/p/9.m3u8', 'http://prov.example:8080/live/u/p/9.ts']);
});
