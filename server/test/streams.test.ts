import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streamUrl, readStreamQuery } from '../../shared/streams.ts';

test('stream URLs keep the wire format the installed TV app also sends', () => {
  const u = new URL(streamUrl('http://pc:8787', 'transcode', 'm5', { token: 'T', ext: 'mkv', mode: 'audio', start: 600, failed: true, alang: 'eng', q: undefined, cs: undefined }));
  assert.equal(u.pathname, '/api/transcode/m5.ts');
  assert.deepEqual(Object.fromEntries(u.searchParams), { token: 'T', ext: 'mkv', mode: 'audio', start: '600', failed: '1', alang: 'eng' }, 'empty fields left out');
  assert.equal(new URL(streamUrl('', 'hls', 'l7', { token: 'T', cs: 100, ce: 200, q: 'low' }), 'http://x').pathname, '/api/hls/l7');
  assert.match(streamUrl('b', 'catchup', 'l7', { start: 0 }), /^b\/api\/catchup\/l7\.ts\?start=0$/, 'a 0 start is sent');
});

test('the server reads back what clients send', () => {
  const q = readStreamQuery(Object.fromEntries(new URL(streamUrl('http://x', 'hls', 'm1', { token: 'T', start: 12.5, slang: 'off', alang: 'ar', failed: false })).searchParams));
  assert.equal(q.start, 12.5); assert.equal(q.slang, 'off'); assert.equal(q.alang, 'ar'); assert.equal(q.failed, false); assert.equal(q.cs, undefined);
});
