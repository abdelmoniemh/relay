import type { LoadOpts, MediaTracks, Player, PlayerEvent } from './types.ts';
import { isIOS } from '../env.ts';
import { api } from '../api.ts';

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
  /** Languages in that session (all of them are in the stream: iOS switches without restarting). */
  private mtracks: { audio: MediaTracks['audio']; subs: MediaTracks['subs']; defSub: number } | null = null;
  private langCb: (kind: 'audio' | 'sub', lang: string) => void = () => {};
  /** Ignore the track changes Safari makes by itself while a stream starts; only the user's picks count. */
  private langsSettled = 0;
  /** Seek waiting to restart the conversion (dragging the seek bar fires dozens of seeks: only the last one counts). */
  private pendingSeek: number | null = null;
  private seekTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(video: HTMLVideoElement) {
    this.v = video;
    // iOS only lets a video start with sound right after a tap. Our streams start later (after the server's
    // answer, 1-3s for a conversion), so Safari refused and left a black, paused picture at 0:00. A media
    // element that was once started during a tap keeps the permission: do that on the first tap.
    const at = video as HTMLVideoElement & { audioTracks?: any };
    at.audioTracks?.addEventListener?.('change', () => this.trackChanged('audio'));
    video.textTracks?.addEventListener?.('change', () => this.trackChanged('sub'));
    if (isIOS) {
      const unlock = () => {
        if (this.v.getAttribute('src') == null) { this.v.load(); this.v.play().catch(() => {}); }
        document.removeEventListener('touchend', unlock, true); document.removeEventListener('click', unlock, true);
      };
      document.addEventListener('touchend', unlock, true); document.addEventListener('click', unlock, true);
    }
    // Prefer MSE engines (faster start, better live handling); native HLS only on iOS or browsers without MSE.
    this.nativeHls = !!video.canPlayType('application/vnd.apple.mpegurl') && (isIOS || !this.mse);
    const fire = (e: PlayerEvent) => () => this.cb(e);
    video.addEventListener('playing', () => { clearTimeout(this.parkTimer); this.cb('playing'); this.scheduleAudioCheck(); });
    video.addEventListener('pause', () => { this.cb('paused'); this.maybePark(); });
    video.addEventListener('waiting', fire('waiting'));
    video.addEventListener('ended', () => {
      // The server's live session ended (provider dropped the connection): reconnect instead of freezing.
      if (this.opts?.live && this.hlsSession && this.liveRestarts()) { this.releaseHls(); this.toLiveHls(); return; }
      this.cb('ended');
    });
    video.addEventListener('timeupdate', fire('time'));
    video.addEventListener('loadedmetadata', () => {
      // Direct movie whose video track can't be decoded (e.g. HEVC in MKV): metadata loads but there's no picture.
      if (this.isDirectVod() && video.videoWidth === 0 && video.videoHeight === 0) this.toVodTranscode('full', this.v.currentTime || this.opts!.startAt);
    });
    video.addEventListener('error', () => {
      if (!this.v.getAttribute('src')) return;
      if (this.isDirectVod()) { this.toVodTranscode('full', this.opts!.startAt); return; }
      if (this.isDirectLiveHls()) { this.toLiveHls(); return; }
      if (isIOS) api.clientLog(`media error ${video.error?.code ?? '?'} ${video.error?.message ?? ''} (${this.opts?.id}, ${this.hlsSession ? 'server hls' : 'direct'})`);
      this.cb('error', video.error?.message || 'Playback error');
    });
  }

  on(cb: (e: PlayerEvent, d?: string) => void) { this.cb = cb; }

  /**
   * iPhone/iPad playing a channel straight from the provider's HLS. Safari refuses HEVC in MPEG-TS segments
   * (Apple only takes HEVC in fMP4), which is how the provider sends its 4K channels: fall back to the server,
   * which repackages them into fMP4 HLS without re-encoding.
   */
  private isDirectLiveHls() { return !!this.opts?.live && this.nativeHls && !!this.opts.hlsUrl && !this.hlsSession; }

  private toLiveHls() {
    this.cb('waiting');
    this.startLiveHls();
  }

  private restarts: number[] = [];
  /** At most 3 reconnects a minute: a channel that keeps dying should surface an error, not loop. */
  private liveRestarts() {
    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < 60_000);
    if (this.restarts.length >= 3) return false;
    this.restarts.push(now);
    return true;
  }

  private startLiveHls() {
    const gen = ++this.gen;
    const v = this.v;
    v.pause();
    if (v.getAttribute('src') != null) { v.removeAttribute('src'); v.load(); } // release the provider connection first
    this.startHls(gen, 0);
    this.armWatchdog(gen, 20_000);
  }

  private watchdog: ReturnType<typeof setTimeout> | undefined;
  /**
   * A channel can fail without any error: nothing ever plays, or (iPhone, HEVC in the provider's HLS) sound
   * with a black picture. After `ms`, treat that as a failure so the usual retry / next source kicks in.
   * Sound with no picture is fine for radio stations, so that case only switches to the server's version.
   */
  private armWatchdog(gen: number, ms: number) {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      const v = this.v;
      if (gen !== this.gen || !this.opts?.live || v.paused) return;
      const noPicture = v.readyState >= 2 && v.videoWidth === 0;
      if (v.readyState >= 2 && !noPicture) return; // playing fine
      if (this.isDirectLiveHls()) { api.clientLog(`watchdog: ${noPicture ? 'no picture' : 'nothing played'} (${this.opts.id}), trying the server`); this.toLiveHls(); return; }
      if (noPicture) return; // radio
      api.clientLog(`watchdog: nothing played after ${ms / 1000}s (${this.opts.id})`);
      this.cb('error', 'stalled');
    }, ms);
  }

  /** Playing a movie file as-is, with a conversion to fall back on if this browser can't decode it. */
  private isDirectVod() { return !!this.opts && !this.opts.live && this.txOffset === null && !!(this.nativeHls ? this.opts.hlsUrl : this.opts.transcodeUrl); }

  async load(urls: string[], o: LoadOpts) {
    this.stop();
    this.opts = o;
    this.txOffset = null; this.parked = null;
    const gen = ++this.gen;
    if (o.live) this.armWatchdog(gen, 12_000);
    const hls = urls.find((u) => u.endsWith('.m3u8'));
    const ts = urls.find((u) => u.endsWith('.ts'));
    const v = this.v;
    if (o.live && ts && this.mse && !this.nativeHls) {
      // Channels we already know are HEVC go straight to the server's GPU transcode: no failed first attempt.
      // Data saver: always the server's (smaller) version.
      const useTx = !!o.transcodeUrl && (!!o.lowData || (!canHevc && (o.hevc || (!!o.id && hevcIds.has(o.id)))) || !!o.interlaced);
      if (await this.mpegts(useTx ? o.transcodeUrl! : ts, gen, useTx ? undefined : o)) return;
    }
    if (o.live && this.nativeHls && o.hlsUrl && (o.hevc || o.lowData)) {
      // iPhone, channel known to be HEVC (the provider's HLS won't play) or data saver: the server's version.
      this.startLiveHls();
      return;
    }
    if (!o.live && this.nativeHls && o.hlsUrl && (o.lowData || !/\.(mp4|m4v|mov)$/i.test(urls[0] ?? ''))) {
      // iPhone Safari can't open MKV/AVI at all: straight to the server's HLS version.
      this.startVodTranscode('full', o.startAt);
      return;
    }
    if (!o.live && o.lowData && o.transcodeUrl && this.mse && !this.nativeHls) { this.startVodTranscode('full', o.startAt); return; }
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
    this.startPlay();
  }

  /** Chrome plays AC3/E-AC3/DTS movies silently: if no audio got decoded after a few seconds, convert the audio. */
  private scheduleAudioCheck() {
    clearTimeout(this.audioCheck);
    if (!this.isDirectVod()) return;
    const v = this.v as HTMLVideoElement & { webkitAudioDecodedByteCount?: number; audioTracks?: { length: number } };
    if (v.webkitAudioDecodedByteCount === undefined) return; // not Chromium: can't tell
    // Resuming: 'playing' can fire at 0 before the seek lands. Check from the resume point (the next 'playing' reschedules),
    // otherwise we'd start a conversion at the wrong position and then a second one.
    if (v.seeking || (this.opts!.startAt > 5 && v.currentTime < this.opts!.startAt - 5)) return;
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
    if (this.nativeHls) { this.releaseHls(); this.startHls(gen, this.txOffset); return; }
    const url = `${this.opts!.transcodeUrl}&mode=${mode}&start=${this.txOffset}${this.opts!.alang ? `&alang=${encodeURIComponent(this.opts!.alang)}` : ''}`;
    this.mpegts(url, gen);
  }

  /** iPhone/iPad: ask the server for an HLS version (of a movie from `start`, or of a channel) and play it natively. */
  private async startHls(gen: number, start: number) {
    const base = this.opts!.hlsUrl!;
    try {
      const o = this.opts!;
      const prefs = o.live ? '' : `&alang=${encodeURIComponent(o.alang ?? '')}&slang=${encodeURIComponent(o.slang ?? 'off')}`;
      const r = await fetch(`${base}&start=${start}${prefs}`, { method: 'POST' });
      const j = await r.json().catch(() => ({})) as { url?: string; error?: string; audio?: MediaTracks['audio']; subs?: MediaTracks['subs']; defSub?: number; offset?: number; stop?: string };
      const url = j.url ? new URL(j.url, base).href : null;
      const stopUrl = j.stop ? new URL(j.stop, base).href : null;
      if (gen !== this.gen) { if (stopUrl) this.deleteHls(stopUrl); return; } // stopped/seeked meanwhile: don't hold the connection
      if (!r.ok || !url) { this.cb('error', j.error ?? `Conversion failed (HTTP ${r.status})`); return; }
      this.hlsSession = url;
      this.hlsStop = stopUrl;
      this.mtracks = j.audio ? { audio: j.audio, subs: j.subs ?? [], defSub: j.defSub ?? -1 } : null;
      this.langsSettled = Date.now() + 4000;
      // The stream starts at a keyframe before what was asked for (the server says where): count from there and
      // jump to the exact second. What's before it stays in the stream, so going back a little is instant.
      const v = this.v;
      if (typeof j.offset === 'number' && this.txOffset !== null && j.offset <= start) {
        this.txOffset = j.offset;
        const rel = start - j.offset;
        if (rel > 0.5) {
          this.landing = start;
          const go = () => { if (gen === this.gen) v.currentTime = rel; };
          v.addEventListener('loadedmetadata', go, { once: true });
          v.addEventListener('seeked', () => { this.landing = null; }, { once: true });
        }
      }
      v.src = url;
      this.startPlay();
    } catch {
      if (gen === this.gen) this.cb('error', `Could not reach the server for the converted ${this.opts?.live ? 'channel' : 'movie'}`);
    }
  }

  /** Tracks as Safari exposes them (audioTracks / textTracks), matched to the server's list by language and order. */
  private nativeAudio(): any[] { return Array.from(((this.v as any).audioTracks ?? []) as ArrayLike<any>); }
  private nativeSubs(): TextTrack[] { return Array.from(this.v.textTracks ?? []).filter((t) => t.kind === 'subtitles' || t.kind === 'captions' || (t.kind as string) === 'forced'); }

  tracks(): MediaTracks | null {
    const m = this.mtracks;
    if (!m || !this.hlsSession) return null;
    const audioSel = Math.max(0, this.nativeAudio().findIndex((t) => t.enabled));
    const subSel = this.nativeSubs().findIndex((t) => t.mode === 'showing');
    return { audio: m.audio, subs: m.subs, audioSel, subSel };
  }
  setAudio(i: number) {
    const list = this.nativeAudio();
    if (!list[i]) return;
    list.forEach((t, k) => { t.enabled = k === i; });
    if (this.mtracks?.audio[i]?.lang) this.langCb('audio', this.mtracks.audio[i].lang!);
  }
  setSub(i: number) {
    this.nativeSubs().forEach((t, k) => { t.mode = k === i ? 'showing' : 'disabled'; });
    this.langCb('sub', i >= 0 ? (this.mtracks?.subs[i]?.lang ?? 'off') : 'off');
  }
  onLangs(cb: (kind: 'audio' | 'sub', lang: string) => void) { this.langCb = cb; }

  /** The user switched language in iOS's own menu: remember it (next movie, and after a seek restarts the stream). */
  private trackChanged(kind: 'audio' | 'sub') {
    if (!this.hlsSession || !this.mtracks || Date.now() < this.langsSettled) return;
    if (kind === 'audio') {
      const t = this.nativeAudio().find((x) => x.enabled);
      if (t?.language) { this.langCb('audio', t.language); if (this.opts) this.opts.alang = t.language; }
    } else {
      const t = this.nativeSubs().find((x) => x.mode === 'showing');
      const lang = t ? (t.language || 'off') : 'off';
      this.langCb('sub', lang); if (this.opts) this.opts.slang = lang;
    }
  }

  /** The session's own stop URL, as the server gave it. */
  private hlsStop: string | null = null;
  private deleteHls(stopUrl: string) { fetch(stopUrl, { method: 'DELETE', keepalive: true }).catch(() => {}); }
  /** Tell the server to stop the HLS conversion (frees the provider connection right away). */
  private releaseHls() { if (this.hlsStop) this.deleteHls(this.hlsStop); this.hlsSession = null; this.hlsStop = null; this.mtracks = null; }

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

  /** play(), and if Safari refuses (no tap to start it), show it as paused so one tap starts it, not a black 0:00. */
  private startPlay() {
    this.v.play().catch((e: DOMException) => {
      if (e?.name !== 'NotAllowedError') return;
      if (isIOS) api.clientLog(`play() refused: ${e.message} (${this.opts?.id})`);
      this.cb('paused');
    });
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
      for (let i = 0; i < b.length; i++) if (rel >= b.start(i) && rel <= b.end(i) - 1) { this.cancelPendingSeek(); this.v.currentTime = rel; return; }
      // Restarting the conversion costs a new provider connection: wait until the seeking stops.
      this.pendingSeek = t;
      this.cb('waiting');
      clearTimeout(this.seekTimer);
      this.seekTimer = setTimeout(() => {
        const at = this.pendingSeek;
        this.pendingSeek = null;
        if (at !== null) this.startVodTranscode(this.txMode, at);
      }, 350);
      return;
    }
    this.v.currentTime = t;
  }
  private cancelPendingSeek() { clearTimeout(this.seekTimer); this.pendingSeek = null; }

  stop() {
    this.gen++;
    this.landing = null;
    clearTimeout(this.watchdog);
    this.cancelPendingSeek();
    clearTimeout(this.parkTimer); clearTimeout(this.audioCheck);
    this.releaseHls();
    this.engine?.destroy();
    this.engine = null;
    this.v.pause();
    if (this.v.getAttribute('src') != null) { this.v.removeAttribute('src'); this.v.load(); } // aborts the HTTP connection
  }
  /** Position being jumped to while a converted stream opens (so the clock doesn't flick back to the keyframe). */
  private landing: number | null = null;
  position() {
    if (this.pendingSeek !== null) return this.pendingSeek;
    if (this.landing !== null) return this.landing;
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
