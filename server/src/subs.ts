// HLS subtitle playlists for a movie session, built from the growing WebVTT file ffmpeg writes per track.
// Segments mirror the video playlist (same count and durations), so Safari loads subtitles in step with the picture.
// ffmpeg's own HLS muxer can only carry one subtitle track per video variant, which is why this exists.

import type { VodLayout } from './transcode.ts';
import { trackName } from './tracks.ts';

interface Seg { start: number; dur: number }

/** Segments of the video playlist with their start times. */
function videoSegments(videoPl: string): { segs: Seg[]; ended: boolean; target: number } {
  const segs: Seg[] = [];
  let t = 0;
  for (const m of videoPl.matchAll(/^#EXTINF:([\d.]+)/gm)) { const d = Number(m[1]); segs.push({ start: t, dur: d }); t += d; }
  const target = Number(/^#EXT-X-TARGETDURATION:(\d+)/m.exec(videoPl)?.[1] ?? 4);
  return { segs, ended: /^#EXT-X-ENDLIST/m.test(videoPl), target };
}

export function subtitlePlaylist(videoPl: string, n: number, tok: string): string {
  const { segs, ended, target } = videoSegments(videoPl);
  return [
    '#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${target}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:EVENT',
    ...segs.flatMap((s, i) => [`#EXTINF:${s.dur.toFixed(6)},`, `sub_${n}_${i}.vtt${tok}`]),
    ...(ended ? ['#EXT-X-ENDLIST'] : []), '',
  ].join('\n');
}

const toSec = (ts: string) => {
  const p = ts.trim().split(':').map(Number);
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
};

export interface Cue { start: number; end: number; block: string }

/** Cues of a WebVTT document (blocks with a timing line; NOTE/STYLE blocks are dropped). */
export function parseVtt(vtt: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of vtt.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const m = /^\s*([\d:.]+)\s+-->\s+([\d:.]+)/.exec(lines[i]);
    if (!m) continue;
    cues.push({ start: toSec(m[1]), end: toSec(m[2]), block: lines.slice(i).join('\n').trim() });
  }
  return cues;
}

/** Segment `k` of a subtitle track: the cues overlapping that video segment (a cue spanning two segments is in both). */
export function subtitleSegment(videoPl: string, vtt: string, k: number): string {
  const seg = videoSegments(videoPl).segs[k];
  const out = ['WEBVTT', 'X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000', ''];
  if (seg) {
    const end = seg.start + seg.dur;
    for (const c of parseVtt(vtt)) if (c.end > seg.start && c.start < end) out.push(c.block, '');
  }
  return out.join('\n');
}

/** ffmpeg's master playlist, with readable audio names and the subtitle tracks (which ffmpeg can't add itself). */
export function masterPlaylist(pl: string, layout: VodLayout | null, ds: number, tok: string): string {
  if (!layout) return pl;
  const t = layout.tracks;
  pl = pl.replace(/^#EXT-X-MEDIA:TYPE=AUDIO,(.*)URI="idx_a(\d+)\.m3u8"/gm, (line, _attrs, i) => {
    const a = t.audio.find((x) => x.n === layout.audio[Number(i)]);
    if (!a) return line;
    const named = line.replace(/NAME="[^"]*"/, `NAME="${trackName(a)}",AUTOSELECT=YES`);
    return a.lang && !/LANGUAGE=/.test(named) ? named.replace(/,URI=/, `,LANGUAGE="${a.lang}",URI=`) : named;
  });
  if (!layout.subs.length) return pl;
  const media = layout.subs.map((n) => {
    const s = t.subs.find((x) => x.n === n)!;
    const name = trackName(s, s.forced ? ' (forced)' : s.sdh ? ' (SDH)' : '');
    return `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="${name}"${s.lang ? `,LANGUAGE="${s.lang}"` : ''},DEFAULT=${n === ds ? 'YES' : 'NO'},AUTOSELECT=${n === ds ? 'YES' : 'NO'},FORCED=${s.forced ? 'YES' : 'NO'}${s.sdh ? ',CHARACTERISTICS="public.accessibility.describes-music-and-sound"' : ''},URI="sub_${n}.m3u8${tok}"`;
  });
  return pl.replace(/^(#EXT-X-STREAM-INF:.*)$/m, `${media.join('\n')}\n$1,SUBTITLES="subs"`);
}
