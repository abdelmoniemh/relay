import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderSlot, type Worker } from '../src/slot.ts';

function worker(slot: ProviderSlot) {
  const w = { busy: false, kicks: 0, stops: 0, kick() { if (slot.mayRun(w)) { w.kicks++; w.busy = true; } }, async stop() { w.stops++; w.busy = false; } } satisfies Worker & Record<string, unknown>;
  slot.work(w);
  return w;
}

test('background work runs only while nothing holds the connection, one worker at a time', () => {
  const slot = new ProviderSlot();
  let streaming = true;
  slot.hold({ active: () => streaming });
  const a = worker(slot), b = worker(slot);
  a.kick();
  assert.equal(a.kicks, 0, 'a stream holds it');
  streaming = false;
  a.kick(); b.kick();
  assert.equal(a.kicks, 1);
  assert.equal(b.kicks, 0, 'not alongside another worker');
});

test('clear() stops busy workers and waits; released() lets them start again', async () => {
  const slot = new ProviderSlot();
  const a = worker(slot);
  a.kick();
  assert.ok(a.busy);
  const t0 = Date.now();
  await slot.clear();
  assert.equal(a.stops, 1);
  assert.ok(!a.busy);
  assert.ok(Date.now() - t0 >= 350, 'gives the provider a moment to drop the connection');
  const t1 = Date.now();
  await slot.clear();
  assert.ok(Date.now() - t1 < 50, 'nothing to stop: no wait');
  slot.released();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(a.kicks, 2);
});
