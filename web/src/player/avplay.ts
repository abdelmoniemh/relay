import type { LoadOpts, Player, PlayerEvent } from './types.ts';

/** Samsung Tizen hardware player: decodes TS/HLS/MKV natively, 4K capable, renders on a plane behind the web layer. */
export class AvPlayer implements Player {
  private av = window.webapis.avplay;
  private cb: (e: PlayerEvent, d?: string) => void = () => {};
  private rect = { x: 0, y: 0, w: 1920, h: 1080 };
  private isPaused = false;
  private gen = 0;

  on(cb: (e: PlayerEvent, d?: string) => void) { this.cb = cb; }

  setRect(r: { x: number; y: number; w: number; h: number }) {
    this.rect = r;
    try { if (this.state() !== 'NONE' && this.state() !== 'IDLE') this.av.setDisplayRect(r.x, r.y, r.w, r.h); } catch {}
  }

  private state(): string { try { return this.av.getState(); } catch { return 'NONE'; } }

  async load(urls: string[], o: LoadOpts) {
    this.stop();
    const gen = ++this.gen;
    // TS for live: the hardware demuxer starts instantly without waiting for an HLS segment.
    const url = o.live ? (urls.find((u) => u.endsWith('.ts')) ?? urls[0]) : urls[0];
    const av = this.av;
    av.open(url);
    av.setListener({
      onbufferingstart: () => this.cb('waiting'),
      onbufferingcomplete: () => this.cb('playing'),
      oncurrentplaytime: () => this.cb('time'),
      onstreamcompleted: () => this.cb('ended'),
      onerror: (e: string) => gen === this.gen && this.cb('error', String(e)),
    });
    try { av.setBufferingParam('PLAYER_BUFFER_FOR_PLAY', 'PLAYER_BUFFER_SIZE_IN_SECOND', o.live ? 2 : 4); } catch {}
    try { av.setBufferingParam('PLAYER_BUFFER_FOR_RESUME', 'PLAYER_BUFFER_SIZE_IN_SECOND', o.live ? 3 : 6); } catch {}
    if (o.uhd) try { av.setStreamingProperty('SET_MODE_4K', 'TRUE'); } catch {}
    av.setDisplayRect(this.rect.x, this.rect.y, this.rect.w, this.rect.h);
    await new Promise<void>((resolve, reject) => av.prepareAsync(resolve, reject)).catch((e) => { if (gen === this.gen) this.cb('error', String(e)); throw e; });
    if (gen !== this.gen) return;
    if (o.startAt > 0) await new Promise<void>((r) => av.seekTo(o.startAt * 1000, r, r));
    av.play();
    this.isPaused = false;
    this.cb('playing');
  }

  play() { try { this.av.play(); this.isPaused = false; this.cb('playing'); } catch {} }
  pause() { try { this.av.pause(); this.isPaused = true; this.cb('paused'); } catch {} }
  seek(t: number) { try { this.av.seekTo(Math.max(0, t) * 1000, () => this.cb('time'), () => {}); } catch {} }
  stop() {
    this.gen++;
    try { const s = this.state(); if (s !== 'NONE' && s !== 'IDLE') this.av.stop(); this.av.close(); } catch {}
  }
  position() { try { return this.av.getCurrentTime() / 1000; } catch { return 0; } }
  duration() { try { const d = this.av.getDuration() / 1000; return d > 0 && d < 1e6 ? d : 0; } catch { return 0; } }
  paused() { return this.isPaused; }
  setVolume(d: number | 'mute') {
    const a = window.tizen?.tvaudiocontrol;
    if (!a) return;
    if (d === 'mute') a.setMute(!a.isMute());
    else if (d > 0) a.setVolumeUp(); else a.setVolumeDown();
  }
}
