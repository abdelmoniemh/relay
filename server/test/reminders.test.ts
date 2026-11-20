import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createPublicKey, verify } from 'node:crypto';
import { Reminders, LEAD_S } from '../src/reminders.ts';

const fresh = () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
  return { db, r: new Reminders(db) };
};
const ch = { id: 'l7', kind: 'live' as const, name: 'Sky Sports' };

test('fires once, a minute before the start', () => {
  const { r } = fresh();
  const now = 1_800_000_000;
  const a = r.add({ item: ch, title: 'Match', start: now + 600, stop: now + 7200, eventId: null, autoplay: 'tv' });
  assert.equal(r.add({ item: ch, title: 'Match', start: now + 600, stop: null, eventId: null, autoplay: null }).id, a.id, 'same programme = same reminder');
  assert.deepEqual(r.takeDue(now), []);
  assert.deepEqual(r.takeDue(now + 600 - LEAD_S).map((x) => x.title), ['Match']);
  assert.deepEqual(r.takeDue(now + 600), [], 'not twice');
  assert.equal(r.recentlyFired(now + 600).length, 1);
  assert.equal(r.recentlyFired(now + 600 + 3600).length, 0);
});

test('missed by more than half an hour (server was off): not fired late', () => {
  const { r } = fresh();
  const now = 1_800_000_000;
  r.add({ item: ch, title: 'Old', start: now - 3600, stop: null, eventId: null, autoplay: null });
  assert.deepEqual(r.takeDue(now), []);
});

test('VAPID: key persists and the JWT verifies with the public key', () => {
  const { db, r } = fresh();
  assert.equal(new Reminders(db).publicKey, r.publicKey, 'same key after a restart');
  const auth = r.vapidAuth('https://web.push.apple.com/abc', 1_800_000_000);
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(auth)!;
  assert.ok(m);
  const body = JSON.parse(Buffer.from(m[2], 'base64url').toString());
  assert.equal(body.aud, 'https://web.push.apple.com');
  assert.match(body.sub, /^mailto:/);
  const pub = Buffer.from(m[4], 'base64url');
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url')));
});

test('subscriptions: https only, stable secret, unsubscribe', () => {
  const { r } = fresh();
  assert.throws(() => r.subscribe('http://evil/x', 'ph'));
  const s = r.subscribe('https://web.push.apple.com/x', 'ph');
  assert.equal(r.subscribe('https://web.push.apple.com/x', 'ph'), s);
  assert.ok(r.validSecret(s)); assert.ok(!r.validSecret('nope'));
  r.unsubscribe('https://web.push.apple.com/x');
  assert.ok(!r.validSecret(s));
});
