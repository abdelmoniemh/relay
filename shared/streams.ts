// How a client asks the server for a stream: the paths and query fields, one definition for both sides.
// (The installed TV app sends exactly these names: change them only together with a TV rebuild.)
import type { MediaTrackInfo } from './protocol.ts';

type StreamKind = 'transcode' | 'hls' | 'catchup';
const PATH: Record<StreamKind, (id: string) => string> = {
  transcode: (id) => `/api/transcode/${id}.ts`, // MPEG-TS for desktop browsers (mpegts.js)
  hls: (id) => `/api/hls/${id}`,                // POST: starts an HLS session (iPhone/iPad)
  catchup: (id) => `/api/catchup/${id}.ts`,     // the archive stream itself (TV)
};

export interface StreamQuery {
  token?: string;
  ext?: string | null;
  /** Catch-up: the programme (unix seconds). */
  cs?: number; ce?: number;
  /** Seconds into the movie / programme. */
  start?: number;
  /** Data saver. */
  q?: 'low';
  /** Desktop conversion: the whole picture, or only the audio. */
  mode?: 'full' | 'audio';
  /** This browser failed to play the original (the server learns it). */
  failed?: boolean;
  alang?: string | null;
  /** Subtitle language, or 'off'. */
  slang?: string;
}

export function streamUrl(base: string, kind: StreamKind, id: string, q: StreamQuery): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v != null && v !== '' && v !== false) p.set(k, v === true ? '1' : String(v));
  return `${base}${PATH[kind](id)}?${p}`;
}

const num = (v: unknown) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
export function readStreamQuery(raw: Record<string, string | undefined>): StreamQuery {
  return {
    token: raw.token, ext: raw.ext || null, cs: num(raw.cs), ce: num(raw.ce), start: num(raw.start),
    q: raw.q === 'low' ? 'low' : undefined, mode: raw.mode === 'audio' ? 'audio' : raw.mode === 'full' ? 'full' : undefined,
    failed: raw.failed === '1', alang: raw.alang || null, slang: raw.slang || undefined,
  };
}

/** Answer to POST /api/hls/:id. */
export interface HlsStarted {
  url: string;
  /** DELETE this to end the session (frees the provider connection right away). */
  stop: string;
  audio: MediaTrackInfo[];
  subs: (MediaTrackInfo & { forced?: boolean })[];
  defSub: number;
  /** Movie position at the stream's 0:00 (a keyframe at or before what was asked for). */
  offset: number;
}
