import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTracks, pickAudio, pickSub, probeTracks, trackName, type Tracks } from '../src/tracks.ts';
import { lang2 } from '../../shared/domain.ts';
import { subtitlePlaylist, subtitleSegment, masterPlaylist, parseVtt } from '../src/hls.ts';

let ok = true;
try { execFileSync('ffmpeg', ['-version']); } catch { ok = false; }

const T: Tracks = {
  vcodec: 'h264',
  audio: [
    { n: 0, lang: 'pol', title: null, codec: 'ac3', channels: 6, def: false },
    { n: 1, lang: 'eng', title: 'Commentary', codec: 'ac3', channels: 2, def: false },
    { n: 2, lang: 'eng', title: null, codec: 'dts', channels: 6, def: true },
    { n: 3, lang: 'ara', title: null, codec: 'aac', channels: 2, def: false },
  ],
  subs: [
    { n: 0, lang: 'eng', title: 'Forced', codec: 'subrip', forced: true, sdh: false, text: true },
    { n: 1, lang: 'eng', title: 'SDH', codec: 'subrip', forced: false, sdh: true, text: true },
    { n: 2, lang: 'eng', title: null, codec: 'subrip', forced: false, sdh: false, text: true },
    { n: 3, lang: 'ara', title: null, codec: 'hdmv_pgs_subtitle', forced: false, sdh: false, text: false },
    { n: 4, lang: 'ara', title: null, codec: 'ass', forced: false, sdh: false, text: true },
  ],
};

test('audio: preferred language (2- or 3-letter), else the file default', () => {
  assert.equal(pickAudio(T, 'ar'), 3);
  assert.equal(pickAudio(T, 'ara'), 3);
  assert.equal(pickAudio(T, 'en'), 1); // first English track in file order
  assert.equal(pickAudio(T, 'ja'), 2); // no Japanese: file default
  assert.equal(pickAudio(T, null), 2);
  assert.equal(pickAudio({ ...T, audio: [] }, 'en'), -1);
});

test('subtitles: plain over SDH over forced; text only; forced ones shown when off', () => {
  assert.equal(pickSub(T, 'en', 'eng'), 2);
  assert.equal(pickSub(T, 'ar', 'eng'), 4); // the PGS Arabic track can't be shown
  assert.equal(pickSub(T, 'off', 'eng'), 0); // forced English with English audio
  assert.equal(pickSub(T, 'off', 'pol'), -1);
  assert.equal(pickSub(T, null, 'ara'), -1);
});

test('track names and language codes', () => {
  assert.equal(trackName({ lang: 'eng', title: null }), 'English');
  assert.equal(trackName({ lang: 'ara', title: null }), 'Arabic');
  assert.equal(trackName({ lang: 'eng', title: 'Commentary' }), 'English (Commentary)');
  assert.equal(trackName({ lang: null, title: 'Director' }), 'Director');
  assert.equal(lang2('ger'), 'de'); assert.equal(lang2('en-GB'), 'en');
});

test('parses ffprobe streams (cover art is not the video)', () => {
  const t = parseTracks(JSON.stringify({ streams: [
    { codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } },
    { codec_type: 'video', codec_name: 'hevc', disposition: {} },
    { codec_type: 'audio', codec_name: 'eac3', channels: 6, tags: { language: 'eng' }, disposition: { default: 1 } },
    { codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'und', title: 'English (forced)' }, disposition: {} },
    { codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', tags: { language: 'fre' }, disposition: { hearing_impaired: 1 } },
  ] }));
  assert.equal(t.vcodec, 'hevc');
  assert.deepEqual(t.audio, [{ n: 0, lang: 'eng', title: null, codec: 'eac3', channels: 6, def: true }]);
  assert.equal(t.subs[0].lang, null); assert.equal(t.subs[0].forced, true); assert.equal(t.subs[0].text, true);
  assert.equal(t.subs[1].text, false); assert.equal(t.subs[1].sdh, true);
});

test('subtitle playlists mirror the video segments; cues land in every segment they overlap', () => {
  const video = '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:5\n#EXTINF:4.000000,\nseg_v_00000.m4s\n#EXTINF:4.000000,\nseg_v_00001.m4s\n#EXTINF:2.500000,\nseg_v_00002.m4s\n#EXT-X-ENDLIST\n';
  const pl = subtitlePlaylist(video, 7, '?token=x');
  assert.match(pl, /#EXT-X-TARGETDURATION:5/);
  assert.deepEqual(pl.match(/^sub_7_\d+\.vtt\?token=x$/gm), ['sub_7_0.vtt?token=x', 'sub_7_1.vtt?token=x', 'sub_7_2.vtt?token=x']);
  assert.match(pl, /#EXT-X-ENDLIST/);
  const vtt = 'WEBVTT\n\n00:01.000 --> 00:02.000\nfirst\n\n00:03.500 --> 00:05.000 align:start\nacross\n\n01:00:00.000 --> 01:00:01.000\nlate\n';
  assert.equal(parseVtt(vtt).length, 3);
  assert.equal(parseVtt(vtt)[2].start, 3600);
  const s0 = subtitleSegment(video, vtt, 0), s1 = subtitleSegment(video, vtt, 1), s2 = subtitleSegment(video, vtt, 2);
  assert.match(s0, /^WEBVTT\n/); assert.match(s0, /first/); assert.match(s0, /across/);
  assert.match(s1, /across/); assert.doesNotMatch(s1, /first/);
  assert.doesNotMatch(s2, /-->/);
});

test('movie session end to end: all audio languages, subtitles in sync, readable names', { skip: !ok }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tracks-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  process.env.XDG_CACHE_HOME = dir; // the Transcoder clears its HLS folder on start: never the real one
  const { Transcoder } = await import('../src/transcode.ts');
  const { vodLayout } = await import('../src/hls.ts');
  const srt = join(dir, 's.srt'), mkv = join(dir, 'm.mkv');
  writeFileSync(srt, '1\n00:00:01,000 --> 00:00:03,000\nHello from English\n\n2\n00:00:09,000 --> 00:00:11,000\nLater line\n');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25', '-f', 'lavfi', '-i', 'sine=f=440', '-f', 'lavfi', '-i', 'sine=f=880', '-i', srt,
    '-t', '16', '-map', '0', '-map', '1', '-map', '2', '-map', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-c:a', 'ac3', '-c:s', 'srt',
    '-metadata:s:a:0', 'language=pol', '-metadata:s:a:1', 'language=eng', '-metadata:s:s:0', 'language=eng', mkv]);
  const tracks = await probeTracks(mkv);
  assert.deepEqual(tracks.audio.map((a) => a.lang), ['pol', 'eng']);
  const layout = vodLayout(tracks, pickAudio(tracks, 'en'));
  assert.deepEqual(layout.audio, [1, 0], 'preferred language first (it becomes the default rendition)');

  const tx = new Transcoder();
  const r = await tx.startHls({ src: mkv, guess: tracks.vcodec, owner: null, layout });
  t.after(() => tx.stop());
  assert.equal(r.entry, 'master.m3u8');
  await new Promise((res) => setTimeout(res, 2500)); // let it write a few segments
  const info = tx.hlsInfo(r.sid)!;
  const master = masterPlaylist(readFileSync(join(info.dir, 'master.m3u8'), 'utf8'), layout, 0, '?token=x');
  assert.match(master, /TYPE=AUDIO.*NAME="English",AUTOSELECT=YES.*DEFAULT=YES.*URI="idx_a0\.m3u8"|TYPE=AUDIO.*DEFAULT=YES.*NAME="English"/);
  assert.match(master, /NAME="Polish".*LANGUAGE="pol"/);
  assert.match(master, /TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="eng",DEFAULT=YES/);
  assert.match(master, /#EXT-X-STREAM-INF:.*SUBTITLES="subs"/);
  assert.ok(tx.hlsFile(r.sid, 'seg_a1_00000.m4s'), 'second audio rendition segments exist');

  const video = readFileSync(tx.hlsFile(r.sid, 'idx_v.m3u8')!, 'utf8');
  const vtt = readFileSync(tx.hlsFile(r.sid, 'sub_0.vtt')!, 'utf8');
  const first = subtitleSegment(video, vtt, 0);
  assert.match(first, /Hello from English/);
  const cue = parseVtt(first)[0];
  assert.ok(Math.abs(cue.start - 1) < 0.2, `cue at ${cue.start}s, should be ~1s (in sync with the picture)`);
});

test('a seek lands on the keyframe before it, and keyframeAt says which', { skip: !ok }, async (t) => {
  const { keyframeAt } = await import('../src/tracks.ts');
  const dir = mkdtempSync(join(tmpdir(), 'kf-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = join(dir, 'g.mkv');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25', '-t', '40', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '250', '-keyint_min', '250', '-sc_threshold', '0', f]);
  assert.equal(await keyframeAt(f, 15), 10);
  assert.equal(await keyframeAt(f, 25), 20);
  assert.equal(await keyframeAt(f, 3), 0);
});
