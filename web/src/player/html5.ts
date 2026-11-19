import type { LoadOpts, Player, PlayerEvent } from './types.ts';
import { isIOS } from '../env.ts';

const HEVC_KEY = 'relay.hevc';
const hevcIds: Set<string> = (() => { try { return new Set(JSON.parse(localStorage.getItem(HEVC_KEY) ?? '[]')); } catch { return new Set<string>(); } })();
/** Can this browser decode HEVC itself (Safari, Chrome/Edge on Windows/Mac with a hardware decoder)? */
const canHevc = (() => { try { return MediaSource.isTypeSupported('video/mp4; codecs="hvc1.2.4.L153.B0"') || MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L120.90"'); } catch { return false; } })();
const saveHevc = () => { try { localStorage.setItem(HEVC_KEY, JSON.stringify([...hevcIds].slice(-1000))); } catch {} };

type TxMode = 'full' | 'audio';

/**
 * Browser / iPhone player.
 *  - Live: raw MPEG-TS via mpegts.js (≈0.5s to first frame); HLS via hls.js or native.
 *  - Movies: direct file; if the browser can't decode the video (HEVC) or the audio (AC3/DTS), switches to the
 *    server's conversion, which is a progressive stream from an offset — we keep position/duration/seek ourselves.
 */
export class Html5Player implements Player {
  private v: HTMLVideoElement;
  private engine: { destroy(): void } | null = null;
  private cb: (e: PlayerEvent, d?: string) => void = () => {};
  private gen = 0;
  private mse = typeof MediaSource !== 'undefined' || typeof (window as any).ManagedMediaSource !== 'undefined';
  private nativeHls: boolean;
  private opts: LoadOpts | null = null;
  /** Converted movie: media time 0 of the stream corresponds to this position in the movie. null = direct playback. */
  private txOffset: number | null = null;
  private txMode: TxMode = 'full';
  private parked: number | null = null; // converted movie paused long enough that we released the stream
  private parkTimer: ReturnType<typeof setTimeout> | undefined;
  private audioCheck: ReturnType<typeof setTimeout> | undefined;
  private media: { fps?: number; vcodec?: string; transcoded: boolean } = { transcoded: false };
  /** iPhone/iPad: playlist URL of the server's HLS session for the converted movie. */
  private hlsSession: string | null = null;

  constructor(video: HTMLVideoElement) {
    this.v = video;
    // Prefer MSE engines (faster start, better live handling); native HLS only on iOS or browsers without MSE.
    this.nativeHls = !!video.canPlayType('application/vnd.apple.mpegurl') && (isIOS || !this.mse);
    const fire = (e: PlayerEvent) => () => this.cb(e);
    video.addEventListener('playing', () => { clearTimeout(this.parkTimer); this.cb('playing'); this.scheduleAudioCheck(); });
    video.addEventListener('pause', () => { this.cb('paused'); this.maybePark(); });
    video.addEventListener('waiting', fire('waiting'));
    video.addEventListener('ended', fire('ended'));
    video.addEventListener('timeupdate', fire('time'));
    video.addEventListener('loadedmetadata', () => {
      // Direct movie whose video track can't be decoded (e.g. HEVC in MKV): metadata loads but there's no picture.
      if (this.isDirectVod() && video.videoWidth === 0 && video.videoHeight === 0) this.toVodTranscode('full', this.v.currentTime || this.opts!.startAt);
    });
    video.addEventListener('error', () => {
      if (!this.v.getAttribute('src')) return;
      if (this.isDirectVod()) { this.toVodTranscode('full', this.opts!.startAt); return; }
      this.cb('error', video.error?.message || 'Playback error');
    });
  }

  on(cb: (e: PlayerEvent, d?: string) => void) { this.cb = cb; }

  /** Playing a movie file as-is, with a conversion to fall back on if this browser can't decode it. */
  private isDirectVod() { return !!this.opts && !this.opts.live && this.txOffset === null && !!(this.nativeHls ? this.opts.hlsUrl : this.opts.transcodeUrl); }

  async load(urls: string[], o: LoadOpts) {
    this.stop();
    this.opts = o;
    this.txOffset = null; this.parked = null;
    const gen = ++this.gen;
    const hls = urls.find((u) => u.endsWith('.m3u8'));
    const ts = urls.find((u) => u.endsWith('.ts'));
    const v = this.v;
    if (o.live && ts && this.mse && !this.nativeHls) {
      // Channels we already know are HEVC go straight to the server's GPU transcode: no failed first attempt.
      const useTx = !!o.transcodeUrl && !canHevc && (o.hevc || (!!o.id && hevcIds.has(o.id)));
      if (await this.mpegts(useTx ? o.transcodeUrl! : ts, gen, useTx ? undefined : o)) return;
    }
    if (!o.live && this.nativeHls && o.hlsUrl && !/\.(mp4|m4v|mov)$/i.test(urls[0] ?? '')) {
      // iPhone Safari can't open MKV/AVI at all: straight to the server's HLS version.
      this.startVodTranscode('full', o.startAt);
      return;
    }
    if (!o.live && o.tx && o.transcodeUrl && this.mse && !this.nativeHls && !(o.tx === 'full' && canHevc)) {
      // Known not to play directly here: go straight to the conversion.
      this.startVodTranscode(o.tx, o.startAt);
      return;
    }
    if (hls && (o.live || !urls[0].match(/\.(mp4|mkv|avi|mov|m4v|ts)$/))) {
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

  /** Chrome plays AC3/E-AC3/DTS movies silently: if no audio got decoded after a few seconds, convert the audio. */
  private scheduleAudioCheck() {
    clearTimeout(this.audioCheck);
    if (!this.isDirectVod()) return;
    const v = this.v as HTMLVideoElement & { webkitAudioDecodedByteCount?: number; audioTracks?: { length: number } };
    if (v.webkitAudioDecodedByteCount === undefined) return; // not Chromium: can't tell
    const start = v.currentTime, gen = this.gen;
    this.audioCheck = setTimeout(() => {
      if (gen !== this.gen || !this.isDirectVod() || v.paused || v.currentTime - start < 2) return;
      if (v.webkitAudioDecodedByteCount === 0 && !v.muted) this.toVodTranscode('audio', v.currentTime);
    }, 3500);
  }

  private toVodTranscode(mode: TxMode, at: number) {
    if (!this.opts?.transcodeUrl) return;
    if (this.opts.id) { hevcIds.add(this.opts.id); saveHevc(); }
    this.cb('waiting');
    this.startVodTranscode(mode, at);
  }

  private startVodTranscode(mode: TxMode, at: number) {
    const gen = ++this.gen;
    this.engine?.destroy(); this.engine = null;
    const v = this.v;
    v.pause();
    if (v.getAttribute('src') != null) { v.removeAttribute('src'); v.load(); } // release the direct connection first
    this.txMode = mode;
    this.txOffset = Math.max(0, Math.floor(at));
    this.parked = null;
    if (this.nativeHls) { this.releaseHls(); this.startHls(gen); return; }
    const url = `${this.opts!.transcodeUrl}&mode=${mode}&start=${this.txOffset}`;
    this.mpegts(url, gen);
  }

  /** iPhone/iPad: ask the server for an HLS version starting at txOffset and play it natively. */
  private async startHls(gen: number) {
    const base = this.opts!.hlsUrl!;
    try {
      const r = await fetch(`${base}&start=${this.txOffset}`, { method: 'POST' });
      const j = await r.json().catch(() => ({})) as { url?: string; error?: string };
      const url = j.url ? new URL(j.url, base).href : null;
      if (gen !== this.gen) { if (url) this.deleteHls(url); return; } // stopped/seeked meanwhile: don't hold the connection
      if (!r.ok || !url) { this.cb('error', j.error ?? `Conversion failed (HTTP ${r.status})`); return; }
      this.hlsSession = url;
      this.v.src = url;
      this.v.play().catch(() => {});
    } catch {
      if (gen === this.gen) this.cb('error', 'Could not reach the server for the converted movie');
    }
  }

  private deleteHls(url: string) { fetch(url.replace('/index.m3u8?', '?'), { method: 'DELETE', keepalive: true }).catch(() => {}); }
  /** Tell the server to stop the HLS conversion (frees the provider connection right away). */
  private releaseHls() { if (this.hlsSession) this.deleteHls(this.hlsSession); this.hlsSession = null; }

  /** Paused for a while on a converted movie: stop the stream (frees the provider connection) and resume later. */
  private maybePark() {
    clearTimeout(this.parkTimer);
    if (this.txOffset === null) return;
    this.parkTimer = setTimeout(() => {
      if (!this.v.paused || this.txOffset === null) return;
      this.parked = this.position();
      this.gen++;
      this.engine?.destroy(); this.engine = null;
      if (this.hlsSession) { this.releaseHls(); this.v.removeAttribute('src'); this.v.load(); }
    }, 30_000);
  }

  /** MPEG-TS via mpegts.js (live channels, and converted movies). With `fallback`, switches to the conversion if undecodable. */
  private async mpegts(url: string, gen: number, fallback?: LoadOpts): Promise<boolean> {
    const { default: mpegts } = await import('mpegts.js');
    if (gen !== this.gen) return true;
    if (!mpegts.isSupported()) return false;
    const v = this.v;
    const p = mpegts.createPlayer({ type: 'mpegts', isLive: true, url }, {
      enableWorker: true, enableStashBuffer: false, stashInitialSize: 256 * 1024, lazyLoad: false, autoCleanupSourceBuffer: true,
      // Providers replay a ~20-30s backlog on connect: that's what makes channels start instantly. By default we
      // play it continuously like VLC does; for live sports (lowLatency) we chase the live edge instead.
      ...(this.opts?.lowLatency && this.opts.live
        ? { liveBufferLatencyChasing: true, liveBufferLatencyMaxLatency: 6, liveBufferLatencyMinRemain: 1.5 }
        : { liveBufferLatencyChasing: false, liveSync: false }),
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
      this.mpegts(fallback!.transcodeUrl!, gen);
    };
    p.on(mpegts.Events.ERROR, (type: string, detail: string, info: any) => {
      if (gen !== this.gen || switched) return;
      if (fallback?.transcodeUrl && /hvc|hev|unsupported/i.test(`${detail} ${info?.msg ?? ''}`)) return toTranscode();
      this.cb('error', `${type}: ${detail}`);
    });
    p.on(mpegts.Events.MEDIA_INFO, (mi: any) => {
      const codec = String(mi?.videoCodec ?? '');
      if (gen === this.gen) this.media = { fps: mi?.fps || undefined, vcodec: codec.startsWith('hvc') || codec.startsWith('hev') ? 'hevc' : codec.startsWith('avc') ? 'h264' : codec || undefined, transcoded: !fallback && url.includes('/api/transcode/') };
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

  info() {
    const v = this.v;
    if (!v.videoWidth || this.media.transcoded) return null; // a converted stream says nothing about the source
    return { width: v.videoWidth, height: v.videoHeight, fps: this.media.fps, vcodec: this.media.vcodec };
  }

  play() {
    if (this.parked !== null) { const at = this.parked; this.startVodTranscode(this.txMode, at); return; }
    this.v.play().catch(() => {});
  }
  pause() { this.v.pause(); }
  seek(t: number) {
    if (!Number.isFinite(t)) return;
    const d = this.duration();
    t = Math.max(0, d ? Math.min(t, d - 1) : t);
    if (this.txOffset !== null) {
      // Inside what's already buffered: seek locally; otherwise restart the conversion at the new position.
      // (HLS: anything already converted is seekable; mpegts.js: only what's buffered)
      const rel = t - this.txOffset, b = this.hlsSession ? this.v.seekable : this.v.buffered;
      for (let i = 0; i < b.length; i++) if (rel >= b.start(i) && rel <= b.end(i) - 1) { this.v.currentTime = rel; return; }
      this.cb('waiting');
      this.startVodTranscode(this.txMode, t);
      return;
    }
    this.v.currentTime = t;
  }
  stop() {
    this.gen++;
    clearTimeout(this.parkTimer); clearTimeout(this.audioCheck);
    this.releaseHls();
    this.engine?.destroy();
    this.engine = null;
    this.v.pause();
    if (this.v.getAttribute('src') != null) { this.v.removeAttribute('src'); this.v.load(); } // aborts the HTTP connection
  }
  position() {
    if (this.parked !== null) return this.parked;
    return (this.txOffset ?? 0) + (this.v.currentTime || 0);
  }
  duration() {
    if (this.txOffset !== null) {
      if (this.opts?.duration) return this.opts.duration;
      return this.hlsSession && Number.isFinite(this.v.duration) ? this.txOffset + this.v.duration : 0;
    }
    const d = this.v.duration;
    return Number.isFinite(d) ? d : 0;
  }
  paused() { return this.parked !== null || this.v.paused; }
  setVolume(d: number | 'mute') {
    if (d === 'mute') this.v.muted = !this.v.muted;
    else { this.v.muted = false; this.v.volume = Math.max(0, Math.min(1, this.v.volume + d)); }
  }
}
