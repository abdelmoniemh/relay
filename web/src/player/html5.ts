import type { LoadOpts, Player, PlayerEvent } from './types.ts';
import { isIOS } from '../env.ts';

const HEVC_KEY = 'relay.hevc';
const hevcIds: Set<string> = (() => { try { return new Set(JSON.parse(localStorage.getItem(HEVC_KEY) ?? '[]')); } catch { return new Set<string>(); } })();
/** Can this browser decode HEVC itself (Safari, Chrome/Edge on Windows/Mac with a hardware decoder)? */
const canHevc = (() => { try { return MediaSource.isTypeSupported('video/mp4; codecs="hvc1.2.4.L153.B0"') || MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L120.90"'); } catch { return false; } })();
const saveHevc = () => { try { localStorage.setItem(HEVC_KEY, JSON.stringify([...hevcIds].slice(-1000))); } catch {} };

/** Browser / iPhone player. Live: raw MPEG-TS via mpegts.js (≈0.5s to first frame); HLS via hls.js or native. */
export class Html5Player implements Player {
  private v: HTMLVideoElement;
  private engine: { destroy(): void } | null = null;
  private cb: (e: PlayerEvent, d?: string) => void = () => {};
  private gen = 0;
  private mse = typeof MediaSource !== 'undefined' || typeof (window as any).ManagedMediaSource !== 'undefined';
  private nativeHls: boolean;

  constructor(video: HTMLVideoElement) {
    this.v = video;
    // Prefer MSE engines (faster start, better live handling); native HLS only on iOS or browsers without MSE.
    this.nativeHls = !!video.canPlayType('application/vnd.apple.mpegurl') && (isIOS || !this.mse);
    const fire = (e: PlayerEvent) => () => this.cb(e);
    video.addEventListener('playing', fire('playing'));
    video.addEventListener('pause', fire('paused'));
    video.addEventListener('waiting', fire('waiting'));
    video.addEventListener('ended', fire('ended'));
    video.addEventListener('timeupdate', fire('time'));
    video.addEventListener('error', () => this.v.getAttribute('src') && this.cb('error', video.error?.message || 'Playback error'));
  }

  on(cb: (e: PlayerEvent, d?: string) => void) { this.cb = cb; }

  async load(urls: string[], o: LoadOpts) {
    this.stop();
    const gen = ++this.gen;
    const hls = urls.find((u) => u.endsWith('.m3u8'));
    const ts = urls.find((u) => u.endsWith('.ts'));
    const v = this.v;
    if (o.live && ts && this.mse && !this.nativeHls) {
      // Channels we already know are HEVC go straight to the server's GPU transcode: no failed first attempt.
      const useTx = !!o.transcodeUrl && !canHevc && (o.hevc || (!!o.id && hevcIds.has(o.id)));
      if (await this.mpegts(useTx ? o.transcodeUrl! : ts, gen, useTx ? undefined : o, useTx)) return;
    }
    if (hls && (o.live || !urls[0].match(/\.(mp4|mkv|avi|mov)$/))) {
      if (this.nativeHls) { v.src = hls; }
      else {
        const { default: Hls } = await import('hls.js');
        if (gen !== this.gen) return;
        const h = new Hls({ enableWorker: true, lowLatencyMode: false, startFragPrefetch: true, maxBufferLength: 30, backBufferLength: 30, liveSyncDurationCount: 2 });
        h.on(Hls.Events.ERROR, (_e, d) => d.fatal && gen === this.gen && this.cb('error', d.details));
        h.loadSource(hls);
        h.attachMedia(v);
        this.engine = h;
      }
    } else {
      v.src = urls[0];
    }
    if (o.startAt > 0) {
      const seek = () => { v.currentTime = o.startAt; };
      v.readyState >= 1 ? seek() : v.addEventListener('loadedmetadata', seek, { once: true });
    }
    v.play().catch(() => {});
  }

  /** Live MPEG-TS via mpegts.js. With `fallback`, switches to the transcode URL if the codec isn't decodable here. */
  private async mpegts(url: string, gen: number, fallback?: LoadOpts, _transcoded = false): Promise<boolean> {
    const { default: mpegts } = await import('mpegts.js');
    if (gen !== this.gen) return true;
    if (!mpegts.isSupported()) return false;
    const v = this.v;
    const p = mpegts.createPlayer({ type: 'mpegts', isLive: true, url }, {
      enableWorker: true, enableStashBuffer: false, stashInitialSize: 256 * 1024, lazyLoad: false, autoCleanupSourceBuffer: true,
      // Direct streams: jump to the live edge. Transcoded streams arrive in a 3x burst: drift to the edge by
      // playing slightly faster instead of skipping (no visible jumps).
      // Providers replay a ~20-30s backlog on connect: that's what makes channels start instantly. Play it
      // continuously like VLC does: skipping to the live edge would show visible jumps.
      liveBufferLatencyChasing: false, liveSync: false,
    } as any);
    let switched = false;
    const toTranscode = () => {
      if (switched || gen !== this.gen) return;
      switched = true;
      if (fallback?.id) { hevcIds.add(fallback.id); saveHevc(); }
      this.cb('waiting');
      // Free the provider connection first, then let the server open its own.
      this.engine?.destroy();
      this.engine = null;
      this.mpegts(fallback!.transcodeUrl!, gen, undefined, true);
    };
    p.on(mpegts.Events.ERROR, (type: string, detail: string, info: any) => {
      if (gen !== this.gen || switched) return;
      if (fallback?.transcodeUrl && /hvc|hev|unsupported/i.test(`${detail} ${info?.msg ?? ''}`)) return toTranscode();
      this.cb('error', `${type}: ${detail}`);
    });
    p.on(mpegts.Events.MEDIA_INFO, (mi: any) => {
      const codec = String(mi?.videoCodec ?? '');
      if (gen !== this.gen || !codec || MediaSource.isTypeSupported(`video/mp4; codecs="${codec}"`)) return;
      if (fallback?.transcodeUrl) return toTranscode();
      this.cb('error', `This browser can't decode ${/^(hvc|hev)/.test(codec) ? 'HEVC/H.265' : codec} video`);
    });
    p.attachMediaElement(v);
    p.load();
    this.engine = { destroy: () => { try { p.pause(); p.unload(); p.detachMediaElement(); p.destroy(); } catch {} } };
    v.play().catch(() => {});
    return true;
  }

  play() { this.v.play().catch(() => {}); }
  pause() { this.v.pause(); }
  seek(t: number) { if (Number.isFinite(t)) this.v.currentTime = Math.max(0, Math.min(t, this.duration() || t)); }
  stop() {
    this.gen++;
    this.engine?.destroy();
    this.engine = null;
    this.v.pause();
    if (this.v.getAttribute('src') != null) { this.v.removeAttribute('src'); this.v.load(); } // aborts the HTTP connection
  }
  position() { return this.v.currentTime || 0; }
  duration() { const d = this.v.duration; return Number.isFinite(d) ? d : 0; }
  paused() { return this.v.paused; }
  setVolume(d: number | 'mute') {
    if (d === 'mute') this.v.muted = !this.v.muted;
    else { this.v.muted = false; this.v.volume = Math.max(0, Math.min(1, this.v.volume + d)); }
  }
}
