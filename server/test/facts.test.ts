import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MediaFacts } from '../src/facts.ts';
import { TrackStore } from '../src/tracks.ts';
import type { Prober } from '../src/prober.ts';

function setup(probes: Record<number, any> = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE items (kind TEXT, sid INTEGER, name TEXT);
    CREATE TABLE vod_probes (id TEXT PRIMARY KEY, at INTEGER, ok INTEGER, width INTEGER, height INTEGER, hdr TEXT, vcodec TEXT, acodec TEXT, channels INTEGER, alangs TEXT, slangs TEXT, err TEXT)`);
  const prober = { results: (ids: string[]) => new Map(ids.filter((id) => probes[Number(id.slice(1))]).map((id) => [id, { sid: Number(id.slice(1)), ok: 1, ...probes[Number(id.slice(1))] }])) } as unknown as Prober;
  const tracks = new TrackStore({}, () => {});
  return { db, facts: new MediaFacts(db, prober, tracks), tracks };
}

test('browsers need a conversion for HEVC video and AC3/DTS audio, from what was measured', () => {
  const { db, facts } = setup({ 7: { vcodec: 'hevc' }, 8: { vcodec: 'h264', bitdepth: 8 } });
  assert.equal(facts.browserNeeds('l7'), 'full');
  assert.equal(facts.browserNeeds('l8'), undefined);
  db.prepare("INSERT INTO vod_probes VALUES ('m1', 0, 1, 1920, 1080, 'sdr', 'h264', 'ac3', 6, '', '', NULL)").run();
  assert.equal(facts.browserNeeds('m1'), 'audio');
  assert.equal(facts.source('m1')?.hdr, null);
});

test('learned failures count, but not "video" on measured plain H.264 (the old registry recorded any conversion)', () => {
  const { facts } = setup({ 8: { vcodec: 'h264', bitdepth: 8 } });
  facts.learn('l8', 'full');
  facts.learn('l9', 'full');
  assert.equal(facts.browserNeeds('l8'), undefined, 'measured H.264 plays in browsers');
  assert.equal(facts.browserNeeds('l9'), 'full', 'nothing measured: trust the failure');
  facts.learn('m2', 'audio');
  assert.equal(facts.browserNeeds('m2'), 'audio');
});

test('codec guess: known first, else from the name / extension', () => {
  const { db, facts } = setup({ 7: { vcodec: 'h264' } });
  db.prepare("INSERT INTO items VALUES ('movie', 3, 'Film 2160p x265'), ('movie', 4, 'Film 1080p')").run();
  assert.equal(facts.videoCodec('l7'), 'h264');
  assert.equal(facts.videoCodec('l99'), 'hevc');
  assert.equal(facts.videoCodec('m3', 'mkv'), 'hevc');
  assert.equal(facts.videoCodec('m4', 'mkv'), 'h264');
  assert.equal(facts.videoCodec('m5', 'avi'), null);
});
