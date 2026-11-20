import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/hub.ts';
import type { Item, ServerMsg } from '../../shared/protocol.ts';

const movie: Item = { id: 'm1', kind: 'movie', name: 'Film', ext: 'mkv' };
const live: Item = { id: 'l7', kind: 'live', name: 'BBC' };

function setup(opts: { timeout?: number } = {}) {
  const events: string[] = [];
  const saved = new Map<string, number>();
  const hub = new Hub({
    listDevices: () => [{ id: 'tv', name: 'TV', kind: 'tv' }, { id: 'pc', name: 'PC', kind: 'desktop' }, { id: 'ph', name: 'Phone', kind: 'phone' }],
    saveProgress: (i, p) => saved.set(i.id, p),
    resumePosition: (i) => saved.get(i.id) ?? 0,
    stopTimeoutMs: opts.timeout ?? 200,
    urls: () => ['u'],
  });
  const inbox: Record<string, ServerMsg[]> = { tv: [], pc: [], ph: [] };
  const offs: Record<string, () => void> = {};
  for (const d of Object.keys(inbox)) offs[d] = hub.connect(d, (m) => { inbox[d].push(m); if (m.t !== 'state' && m.t !== 'hello') events.push(`${d}:${m.t}`); });
  return { hub, inbox, events, saved, offs };
}

test('handoff stops the old device before granting the new one, and resumes position', async () => {
  const { hub, events } = setup();
  await hub.handle('tv', { t: 'play', item: movie });
  await hub.handle('tv', { t: 'heartbeat', position: 100, duration: 3600, paused: false });
  const p = hub.handle('pc', { t: 'takeover' });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(events, ['tv:granted', 'tv:stop'], 'pc must not be granted before tv acks');
  await hub.handle('tv', { t: 'stopped', position: 104, duration: 3600 });
  await p;
  assert.deepEqual(events, ['tv:granted', 'tv:stop', 'pc:granted']);
  assert.equal(hub.getLease()?.deviceId, 'pc');
  assert.equal(hub.getLease()?.position, 104);
});

test('grant proceeds after timeout when the holder never acks', async () => {
  const { hub, events } = setup({ timeout: 50 });
  await hub.handle('tv', { t: 'play', item: live });
  const t = Date.now();
  await hub.handle('ph', { t: 'play', item: live });
  assert.ok(Date.now() - t >= 45);
  assert.deepEqual(events, ['tv:granted', 'tv:stop', 'ph:granted']);
});

test('offline holder is skipped; lease survives disconnect for "continue here"', async () => {
  const { hub, events, offs } = setup();
  await hub.handle('tv', { t: 'play', item: movie, startAt: 50 });
  offs.tv();
  assert.equal(hub.getLease()?.deviceId, 'tv');
  await hub.handle('pc', { t: 'takeover' });
  assert.deepEqual(events, ['tv:granted', 'pc:granted']);
});

test('heartbeat from a non-holder is told to stop', async () => {
  const { hub, events } = setup();
  await hub.handle('tv', { t: 'play', item: live });
  await hub.handle('pc', { t: 'heartbeat', position: 1, duration: 0, paused: false });
  assert.deepEqual(events, ['tv:granted', 'pc:stop']);
});

test('user stop clears lease and saves progress; resume uses it', async () => {
  const { hub, saved } = setup();
  await hub.handle('tv', { t: 'play', item: movie });
  await hub.handle('tv', { t: 'stopped', position: 900, duration: 3600 });
  assert.equal(hub.getLease(), null);
  assert.equal(saved.get('m1'), 900);
  const got: ServerMsg[] = [];
  hub.connect('ph', (m) => got.push(m));
  await hub.handle('ph', { t: 'play', item: movie });
  assert.deepEqual(got.find((m) => m.t === 'granted'), { t: 'granted', item: movie, startAt: 900, urls: ['u'] });
});

test('sendTo forwards play to target; concurrent plays are serialized', async () => {
  const { hub, inbox, events } = setup();
  await hub.handle('ph', { t: 'sendTo', target: 'tv', item: live });
  assert.ok(inbox.tv.some((m) => m.t === 'play' && m.from === 'ph'));
  await hub.handle('tv', { t: 'play', item: live });
  const a = hub.handle('pc', { t: 'play', item: movie });
  const b = hub.handle('ph', { t: 'play', item: live });
  await new Promise((r) => setTimeout(r, 10));
  await hub.handle('tv', { t: 'stopped', position: 0, duration: 0 });
  await new Promise((r) => setTimeout(r, 10));
  await hub.handle('pc', { t: 'stopped', position: 5, duration: 100 });
  await Promise.all([a, b]);
  assert.deepEqual(events.filter((e) => e !== 'tv:play'), ['tv:granted', 'tv:stop', 'pc:granted', 'pc:stop', 'ph:granted']);
});

test('server-side streams are released when the lease moves or stops, before the new grant', async () => {
  const moved: (string | null)[] = [];
  const order: string[] = [];
  const hub = new Hub({
    listDevices: () => [{ id: 'pc', name: 'PC', kind: 'desktop' }, { id: 'tv', name: 'TV', kind: 'tv' }],
    saveProgress: () => {}, resumePosition: () => 0, urls: () => [], stopTimeoutMs: 50,
    leaseMoved: (d) => { moved.push(d); order.push(`moved:${d}`); },
  });
  hub.connect('pc', (m) => m.t === 'granted' && order.push('pc:granted'));
  hub.connect('tv', (m) => m.t === 'granted' && order.push('tv:granted'));
  await hub.handle('pc', { t: 'play', item: live });
  await hub.handle('tv', { t: 'play', item: live });
  assert.deepEqual(order, ['moved:pc', 'pc:granted', 'moved:tv', 'tv:granted']);
  await hub.handle('tv', { t: 'stopped', position: 0, duration: 0 });
  assert.deepEqual(moved.at(-1), null);
});

test('items the catalog refuses are never granted', async () => {
  const got: ServerMsg[] = [];
  const hub = new Hub({ listDevices: () => [{ id: 'tv', name: 'TV', kind: 'tv' }], saveProgress: () => {}, resumePosition: () => 0, urls: () => ['u'], allowed: (i) => i.id !== 'm666' });
  hub.connect('tv', (m) => got.push(m));
  await hub.handle('tv', { t: 'play', item: { id: 'm666', kind: 'movie', name: 'x' } });
  assert.equal(got.some((m) => m.t === 'granted'), false);
  assert.equal(hub.getLease(), null);
});

test('catch-up programmes start where asked; live channels always at the live edge', async () => {
  const { hub, inbox } = setup();
  await hub.handle('ph', { t: 'play', item: { ...live, catchup: { start: 1000, stop: 2800 } }, startAt: 300 });
  const g = inbox.ph.find((m) => m.t === 'granted') as Extract<ServerMsg, { t: 'granted' }>;
  assert.equal(g.startAt, 300);
  await hub.handle('ph', { t: 'play', item: live, startAt: 300 });
  const g2 = inbox.ph.filter((m) => m.t === 'granted').pop() as Extract<ServerMsg, { t: 'granted' }>;
  assert.equal(g2.startAt, 0);
});
