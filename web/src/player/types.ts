import type { StreamQuery } from '@shared/streams.ts';
import type { MediaTrackInfo } from '@shared/protocol.ts';
export type PlayerEvent = 'playing' | 'paused' | 'waiting' | 'ended' | 'error' | 'time';
/**
 * Why playback failed, said where it happens (playback.ts puts it in words). 'server': the server explained it
 * itself (e.g. outside the archive): its message is shown as it is.
 */
export type PlayError = 'stalled' | 'unreachable' | 'unpaired' | 'conversion' | 'network' | 'format' | 'server' | 'other';
export interface LoadOpts {
  /** The server's versions of this item (conversion, HLS, archive): built with streamUrl() from these. */
  stream?: { base: string; id: string; query: StreamQuery };
  /** A programme from a channel's archive. */
  catchup?: boolean;
  startAt: number;
  live: boolean;
  uhd?: boolean;
  id?: string;
  hevc?: boolean;
  /** Live sports: jump to the live edge instead of playing the provider's backlog. */
  lowLatency?: boolean;
  /** Known runtime (movies), used when the browser only sees a transcoded stream. */
  duration?: number;
  /** Server says this movie needs converting for browsers ('audio' = AC3/DTS audio only, 'full' = HEVC video). */
  tx?: 'full' | 'audio';
  /** Interlaced live source: browsers don't deinterlace, so take the server's deinterlaced (50p) conversion. */
  interlaced?: boolean;
  /** Preferred audio language (ISO code) and subtitle language ('off' = none), for movies/episodes. */
  alang?: string | null;
  slang?: string;
  /** Data saver: everything through the server's 720p ~3 Mbps conversion (away from home / mobile data). */
  lowData?: boolean;
}

/** Audio / subtitle tracks of what's playing (movies through the server's HLS). */
export interface MediaTracks {
  audio: MediaTrackInfo[];
  subs: (MediaTrackInfo & { forced?: boolean })[];
  /** Index into `audio` / `subs` of the one playing / shown (-1 = subtitles off). */
  audioSel: number;
  subSel: number;
}

export interface Player {
  load(urls: string[], opts: LoadOpts): Promise<void>;
  play(): void;
  pause(): void;
  seek(t: number): void;
  /** Must release the network connection to the provider as fast as possible. */
  stop(): void;
  position(): number;
  duration(): number;
  paused(): boolean;
  setVolume(delta: number | 'mute'): void;
  /** For hardware video planes (Tizen) — screen rect the video should occupy. */
  setRect?(r: { x: number; y: number; w: number; h: number }): void;
  /** For 'error', `detail` is a PlayError and `raw` the engine's own text (logged). */
  on(cb: (e: PlayerEvent, detail?: string, raw?: string) => void): void;
  /** What is actually being decoded right now (for passive quality verification). */
  info?(): { width: number; height: number; fps?: number; vcodec?: string; kbps?: number } | null;
  /** Tracks of the current item, and switching between them (also from the native iOS menu). */
  tracks?(): MediaTracks | null;
  setAudio?(i: number): void;
  setSub?(i: number): void;
  /** Called when the user picks a language (any menu): lets the app remember it. */
  onLangs?(cb: (kind: 'audio' | 'sub', lang: string) => void): void;
}
