// One HLS session's files: what they're called, which ones a player may fetch, and the playlists built from them.
// The conversion writes them (transcode.ts), the API serves them; both follow the names here.
//
// Single (live channel, catch-up, a movie whose tracks aren't known): index.m3u8 + seg<k>.m4s.
// Movie with its languages: master.m3u8 → idx_v.m3u8 (video) + idx_a<i>.m3u8 per audio track (alternate renditions:
// iOS lists them in its audio menu), segments seg_<variant>_<k>.m4s, and sub_<n>.vtt per text subtitle track, served
// as subtitle playlists cut to the video's segments (ffmpeg's HLS muxer carries one subtitle per video variant only).
import { trackName, type Tracks, type SubTrack } from './tracks.ts';

/** Segment length (seconds). */
export const SEGMENT_S = 4;
/** Most audio / subtitle tracks put in one movie session (some files carry 20+ languages). */
const MAX_AUDIO = 8, MAX_SUBS = 12;

export interface VodLayout { tracks: Tracks; audio: number[]; subs: number[] }
export function vodLayout(tracks: Tracks, defAudio: number): VodLayout {
  // The default track first (it becomes the default rendition), then the others in file order.
  const audio = tracks.audio.map((a) => a.n).sort((x, y) => (x === defAudio ? -1 : y === defAudio ? 1 : x - y)).slice(0, MAX_AUDIO);
  const subs = tracks.subs.filter((t) => t.text).map((t) => t.n).slice(0, MAX_SUBS);
  return { tracks, audio, subs };
}

/** File names of a session (for ffmpeg: patterns with %v / %05d). */
export function sessionFiles(layout: VodLayout | null) {
  const variants = layout ? ['v', ...layout.audio.map((_, i) => `a${i}`)] : null;
  return {
    entry: layout ? 'master.m3u8' : 'index.m3u8',
    video: layout ? 'idx_v.m3u8' : 'index.m3u8',
    /** ffmpeg -hls_segment_filename / playlist name / -var_stream_map names */
    segmentPattern: layout ? 'seg_%v_%05d.m4s' : 'seg%05d.m4s',
    playlistPattern: layout ? 'idx_%v.m3u8' : 'index.m3u8',
    streamMap: layout ? [layout.audio.length ? 'v:0,agroup:aud,name:v' : 'v:0,name:v', ...layout.audio.map((_, i) => `a:${i},agroup:aud,name:a${i}${i === 0 ? ',default:yes' : ''}`)] : null,
    subVtt: (n: number) => `sub_${n}.vtt`,
    segments: (k: number) => { const s = String(k).padStart(5, '0'); return variants ? variants.map((v) => `seg_${v}_${s}.m4s`) : [`seg${s}.m4s`]; },
    videoSegment: (name: string) => { const m = (layout ? /^seg_v_(\d+)\.m4s$/ : /^seg(\d+)\.m4s$/).exec(name); return m ? Number(m[1]) : null; },
  };
}

/** Files a player may fetch from a session (anything else is refused). */
export const isSessionFile = (name: string) => /^((index|master|idx_(v|a\d+))\.m3u8|init(_\d+)?\.mp4|seg(_(v|a\d+)_)?\d+\.m4s|sub_\d+\.vtt)$/.test(name);

// Subtitle playlists and segments are built by the API, not written by ffmpeg.
export const subPlaylistName = (n: number) => `sub_${n}.m3u8`;
export const subSegmentName = (n: number, k: number) => `sub_${n}_${k}.vtt`;
export function parseSubName(name: string): { n: number; k: number | null } | null {
  const m = /^sub_(\d+)(?:_(\d+)\.vtt|\.m3u8)$/.exec(name);
  return m ? { n: Number(m[1]), k: m[2] != null ? Number(m[2]) : null } : null;
}

/** Name in the player's menu: language, the file's title, and what kind of subtitles. */
export const subName = (s: SubTrack) => trackName(s, s.forced ? ' (forced)' : s.sdh ? ' (SDH)' : '');

/** Every URI in a playlist gets the token: Safari's segment requests carry no auth header. */
export function withToken(pl: string, tok: string): string {
  return pl.replace(/^([^#\s][^\s?]*)$/gm, `$1${tok}`).replace(/URI="([^"?]+)"/g, `URI="$1${tok}"`);
}

interface Seg { start: number; dur: number }

/** Segments of the video playlist with their start times. */
function videoSegments(videoPl: string): { segs: Seg[]; ended: boolean; target: number } {
  const segs: Seg[] = [];
  let t = 0;
  for (const m of videoPl.matchAll(/^#EXTINF:([\d.]+)/gm)) { const d = Number(m[1]); segs.push({ start: t, dur: d }); t += d; }
  const target = Number(/^#EXT-X-TARGETDURATION:(\d+)/m.exec(videoPl)?.[1] ?? SEGMENT_S);
  return { segs, ended: /^#EXT-X-ENDLIST/m.test(videoPl), target };
}

export function subtitlePlaylist(videoPl: string, n: number, tok: string): string {
  const { segs, ended, target } = videoSegments(videoPl);
  return [
    '#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${target}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:EVENT',
    ...segs.flatMap((s, i) => [`#EXTINF:${s.dur.toFixed(6)},`, `${subSegmentName(n, i)}${tok}`]),
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
    const name = subName(s);
    return `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="${name}"${s.lang ? `,LANGUAGE="${s.lang}"` : ''},DEFAULT=${n === ds ? 'YES' : 'NO'},AUTOSELECT=${n === ds ? 'YES' : 'NO'},FORCED=${s.forced ? 'YES' : 'NO'}${s.sdh ? ',CHARACTERISTICS="public.accessibility.describes-music-and-sound"' : ''},URI="${subPlaylistName(n)}${tok}"`;
  });
  return pl.replace(/^(#EXT-X-STREAM-INF:.*)$/m, `${media.join('\n')}\n$1,SUBTITLES="subs"`);
}

/** ffmpeg output options for a session: mapping, audio, the HLS muxer and (movies) one .vtt per subtitle track. */
export function hlsOutputArgs(o: { layout: VodLayout | null; dir: string; live: boolean; video: string[]; abr: string }): string[] {
  const f = sessionFiles(o.layout), at = (name: string) => `${o.dir}/${name}`;
  const l = o.layout;
  if (l) return [
    '-map', '0:v:0', ...l.audio.flatMap((n) => ['-map', `0:a:${n}`]), ...o.video,
    '-c:a', 'aac', '-b:a', o.abr, '-ac', '2', '-max_muxing_queue_size', '4096',
    '-f', 'hls', '-hls_time', String(SEGMENT_S), '-hls_list_size', '0', '-hls_playlist_type', 'event',
    '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', at(f.segmentPattern), '-hls_flags', 'independent_segments+temp_file',
    '-master_pl_name', f.entry, '-var_stream_map', f.streamMap!.join(' '),
    at(f.playlistPattern),
    // Subtitles: a second output per track, flushed cue by cue.
    ...l.subs.flatMap((n) => ['-map', `0:s:${n}`, '-c:s', 'webvtt', '-flush_packets', '1', '-f', 'webvtt', at(f.subVtt(n))]),
  ];
  return [
    // Live: video optional, so a radio station that ends up here still plays.
    '-map', o.live ? '0:v:0?' : '0:v:0', '-map', '0:a:0?', ...o.video,
    ...(o.live ? ['-af', 'aresample=async=1:first_pts=0'] : []), // live: absorb provider timestamp gaps
    '-c:a', 'aac', '-b:a', o.abr, '-ac', '2', '-max_muxing_queue_size', '2048',
    '-f', 'hls', '-hls_time', String(SEGMENT_S),
    // Movies: every segment stays listed (seekable). Live: a sliding window; ffmpeg deletes what falls out.
    ...(o.live ? ['-hls_list_size', '8', '-hls_delete_threshold', '4'] : ['-hls_list_size', '0', '-hls_playlist_type', 'event']),
    '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', at(f.segmentPattern), '-hls_flags', `independent_segments+temp_file${o.live ? '+delete_segments' : ''}`,
    at(f.entry),
  ];
}
