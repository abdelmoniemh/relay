import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { markersFrom, TrackStore } from '../src/tracks.ts';
import { Prefetcher } from '../src/prefetch.ts';

let ok = true;
try { execFileSync('ffmpeg', ['-version']); } catch { ok = false; }

test('markers from chapter names', () => {
  const ch = (title: string, start: number, end: number) => ({ title, start, end });
  assert.deepEqual(markersFrom([ch('Prime Video', 0, 5), ch('Scene 2', 5, 1047), ch('Title Sequence', 1047, 1056), ch('Scene 12', 1056, 3582), ch('End Credits', 3582, 3700)], 3700),
    { intro: [1047, 1056], credits: 3582 });
  assert.deepEqual(markersFrom([ch('Previously on', 0, 60), ch('Opening', 60, 150), ch('Episode', 150, 2500), ch('Credits', 2500, 2600)], 2600),
    { recap: [0, 60], intro: [60, 150], credits: 2500 });
  assert.deepEqual(markersFrom([ch('Part 01', 0, 2645), ch('Credits', 2645, 2790)], 2790), { credits: 2645 });
  assert.deepEqual(markersFrom([ch('Opening credits', 0, 600)], 3000), {}, 'a 10-minute "opening" is not an intro to skip');
  assert.deepEqual(markersFrom([ch('Credits for the guest', 300, 400)], 3000), {}, 'credits early in the film are not the end');
  assert.deepEqual(markersFrom(undefined), {});
});

test('prefetch: tracks, chapters and a 10x10 thumbnail sprite, idle only', { skip: !ok }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'prefetch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const meta = join(dir, 'ch.txt'), f = join(dir, 'e1.mkv');
  writeFileSync(meta, ';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1\nSTART=0\nEND=10\ntitle=Intro\n[CHAPTER]\nTIMEBASE=1/1\nSTART=10\nEND=50\ntitle=Episode\n[CHAPTER]\nTIMEBASE=1/1\nSTART=50\nEND=60\ntitle=End Credits\n');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25', '-i', meta, '-map_metadata', '1', '-map_chapters', '1', '-t', '60',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', f]);
  let idle = false;
  const store = new TrackStore({}, () => {});
  const pf = new Prefetcher(dir, store, () => idle, () => {}, 0);
  pf.want('e1', async () => f);
  await pf.idle();
  assert.equal(pf.extras('e1'), null, 'nothing while a stream is active');
  idle = true;
  pf.want('e1', async () => f);
  await new Promise((r) => setTimeout(r, 50));
  await pf.idle();
  const x = pf.extras('e1')!;
  assert.deepEqual(x.markers, { intro: [0, 10], credits: 50 });
  assert.ok(x.thumbs && Math.abs(x.thumbs.interval - 0.6) < 0.01);
  assert.ok(existsSync(pf.sprite('e1')));
  const size = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', pf.sprite('e1')]).toString().trim();
  assert.equal(size, '1600,900');
});
