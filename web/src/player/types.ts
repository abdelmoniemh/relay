export type PlayerEvent = 'playing' | 'paused' | 'waiting' | 'ended' | 'error' | 'time';
export interface LoadOpts { startAt: number; live: boolean; uhd?: boolean }

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
  on(cb: (e: PlayerEvent, detail?: string) => void): void;
}
