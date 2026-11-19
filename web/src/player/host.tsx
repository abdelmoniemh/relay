import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import { isTizen, isMobile, clock, fmtTime } from '../env.ts';
import { Html5Player } from './html5.ts';
import { AvPlayer } from './avplay.ts';
import type { Player } from './types.ts';
import {
  attachPlayer, current, mode, status, position, duration, errorMsg, play, stop, togglePause, seekBy, seekTo, zap, setMode, volume,
  sources, nextSource, sourceEvent, nextUp, nextEpisode, playNextEpisode, cancelNextUp, toast,
} from '../playback.ts';
import { useKeys, nowNext, epgVersion } from '../ui/hooks.ts';
import { Logo, clean } from '../ui/common.tsx';
import { api, myDeviceId, toggleFavorite, favorites } from '../api.ts';
import { devices, send } from '../ws.ts';
import { route, go } from '../router.ts';

/** Element the Live screen offers as the preview area. */
export const previewBox = signal<HTMLElement | null>(null);

/** Hardware player only when Samsung's webapis actually loaded. */
const hw = isTizen && !!window.webapis?.avplay;

// ---- full screen / picture-in-picture / AirPlay ----
// iPhone Safari can't put the page in full screen, only the <video> itself (Apple's player, native controls).
// Everywhere else (desktop, iPad, Android) the whole page goes full screen so our own controls stay.
type WkVideo = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void; webkitExitFullscreen?: () => void; webkitDisplayingFullscreen?: boolean;
  webkitSupportsPresentationMode?: (m: string) => boolean; webkitSetPresentationMode?: (m: string) => void; webkitPresentationMode?: string;
  webkitShowPlaybackTargetPicker?: () => void;
};
const doc = document as Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void; webkitFullscreenEnabled?: boolean };
let videoEl: WkVideo | null = null;
const pageFs = !isTizen && !!(document.fullscreenEnabled || doc.webkitFullscreenEnabled);
export const canFullscreen = !hw && (pageFs || (typeof HTMLVideoElement !== 'undefined' && 'webkitEnterFullscreen' in HTMLVideoElement.prototype));
export const canPip = !hw && !!(document.pictureInPictureEnabled
  || (typeof HTMLVideoElement !== 'undefined' && 'webkitSupportsPresentationMode' in HTMLVideoElement.prototype));
export const isFull = signal(false);
export const airplay = signal(false); // an AirPlay receiver is around

export function toggleFullscreen() {
  try {
    if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
    if (doc.webkitFullscreenElement) { doc.webkitExitFullscreen?.(); return; }
    if (pageFs) {
      const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
      const r = el.requestFullscreen ? el.requestFullscreen({ navigationUI: 'hide' }) : (el.webkitRequestFullscreen?.(), undefined);
      // Phones: go landscape with it (Android Chrome; ignored where unsupported).
      if (isMobile) Promise.resolve(r).then(() => (screen.orientation as any)?.lock?.('landscape')).catch(() => {});
      r?.catch?.(() => {});
      return;
    }
    const v = videoEl;
    if (!v?.webkitEnterFullscreen) return;
    if (v.readyState < 1) { toast.value = 'Wait for the video to start'; setTimeout(() => { toast.value = null; }, 2000); return; }
    v.webkitEnterFullscreen();
  } catch {}
}

export function togglePip() {
  const v = videoEl;
  if (!v) return;
  try {
    if (document.pictureInPictureElement) { document.exitPictureInPicture().catch(() => {}); return; }
    if (v.requestPictureInPicture && document.pictureInPictureEnabled) { v.requestPictureInPicture().catch(() => {}); return; }
    if (v.webkitSupportsPresentationMode?.('picture-in-picture')) {
      v.webkitSetPresentationMode!(v.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
    }
  } catch {}
}

export const showAirplay = () => { try { videoEl?.webkitShowPlaybackTargetPicker?.(); } catch {} };

const syncFull = () => { isFull.value = !!(document.fullscreenElement || doc.webkitFullscreenElement || videoEl?.webkitDisplayingFullscreen); };
if (!isTizen) {
  document.addEventListener('fullscreenchange', syncFull);
  document.addEventListener('webkitfullscreenchange', syncFull);
}

/** iPhone: native full screen, PiP and AirPlay hooks on our <video>. */
function wireVideo(v: WkVideo) {
  videoEl = v;
  v.setAttribute('x-webkit-airplay', 'allow');
  v.setAttribute('autopictureinpicture', ''); // Safari: keep watching in PiP when leaving the Home Screen app
  v.addEventListener('webkitbeginfullscreen', syncFull);
  v.addEventListener('webkitendfullscreen', () => {
    syncFull();
    // Leaving Apple's player can pause the stream; a live channel should just keep going.
    setTimeout(() => { if (v.paused && current.value?.kind === 'live') v.play().catch(() => {}); }, 300);
  });
  if ('WebKitPlaybackTargetAvailabilityEvent' in window) {
    v.addEventListener('webkitplaybacktargetavailabilitychanged', (e: any) => { airplay.value = e.availability === 'available'; });
  }
}

export function PlayerHost() {
  const vid = useRef<HTMLVideoElement>(null);
  const obj = useRef<HTMLObjectElement>(null);
  const player = useRef<Player | null>(null);
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const m = mode.value;
  const onLive = route().name === 'live';

  useEffect(() => {
    const p = hw ? new AvPlayer() : new Html5Player(vid.current!);
    if (!hw) wireVideo(vid.current!);
    player.current = p;
    attachPlayer(p);
  }, []);

  // Where should the video be? full screen, the Live preview box, or a corner mini player.
  useLayoutEffect(() => {
    const place = () => {
      if (m === 'full' || m === 'off') { setRect(null); return; }
      const box = onLive ? previewBox.value : null;
      const b = box?.getBoundingClientRect();
      // (on phones the Live preview box is hidden: fall back to the corner player instead of a 0×0 video)
      if (b && b.width > 0 && b.height > 0) { setRect({ x: b.left, y: b.top, w: b.width, h: b.height }); return; }
      const W = window.innerWidth, H = window.innerHeight;
      const small = W < 760 || H < 500;
      const w = Math.min(480, W * (small ? 0.55 : 0.45)), h = (w * 9) / 16;
      const gap = small ? 12 : 24;
      // Keep clear of the bottom tab bar on phones.
      const rail = document.querySelector('.rail')?.getBoundingClientRect();
      const bottom = rail && rail.top > H / 2 ? H - rail.top + gap : gap;
      setRect({ x: W - w - gap, y: H - h - bottom, w, h });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [m, onLive, previewBox.value]);

  // On the TV the corner mini player can't punch through the UI, and an off-screen stream wastes the one connection.
  useEffect(() => { if (hw && m === 'mini' && !onLive) stop(); }, [m, onLive]);

  useEffect(() => {
    const p = player.current;
    if (!p?.setRect) return;
    const s = 1920 / window.innerWidth;
    const r = rect ?? { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
    p.setRect({ x: Math.round(r.x * s), y: Math.round(r.y * s), w: Math.round(r.w * s), h: Math.round(r.h * s) });
  }, [rect]);

  useEffect(() => { document.documentElement.classList.toggle('playing-full', m === 'full'); document.documentElement.classList.toggle('playing', m !== 'off'); }, [m]);

  const style = m === 'off' ? { display: 'none' }
    : rect ? { left: rect.x, top: rect.y, width: rect.w, height: rect.h } : { left: 0, top: 0, width: '100%', height: '100%' };

  return (
    <>
      {hw
        ? <object ref={obj} id="av-player" type="application/avplayer" class={`video ${m}`} style={style} />
        : <video ref={vid} class={`video ${m}`} style={style} playsInline autoplay
            onClick={() => (m === 'mini' ? setMode('full') : current.value?.kind !== 'live' && togglePause())}
            onDblClick={() => m === 'full' && toggleFullscreen()} />}
      {m === 'mini' && rect && !hw && !onLive && (
        <div class="mini-ctl" style={{ left: rect.x, top: rect.y - 40, width: rect.w }}>
          <span class="name">{current.value && clean(current.value.name)}</span>
          <button onClick={() => setMode('full')}>⤢</button>
          <button onClick={() => stop()}>✕</button>
        </div>
      )}
      {m === 'full' && <Overlay />}
    </>
  );
}

function Overlay() {
  const [visible, setVisible] = useState(true);
  const [digits, setDigits] = useState('');
  const [sendMenu, setSendMenu] = useState(false);
  const hideT = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const digitT = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastTap = useRef(0);
  const it = current.value!;
  const live = it?.kind === 'live';
  epgVersion.value;

  const poke = () => {
    setVisible(true);
    clearTimeout(hideT.current);
    hideT.current = setTimeout(() => setVisible(false), 4000);
  };
  useEffect(() => { poke(); return () => clearTimeout(hideT.current); }, [it?.id]);

  const others = devices.value.filter((d) => d.online && d.id !== myDeviceId.value);

  useKeys((k) => {
    if (nextUp.value) {
      if (k === 'ok' || k === 'play' || k === 'playpause') { playNextEpisode(); return true; }
      if (k === 'back') { cancelNextUp(); stop(); return true; }
      return true;
    }
    if (sendMenu) {
      if (k === 'back') { setSendMenu(false); return true; }
      if (k.startsWith('digit')) {
        const d = others[Number(k.slice(5)) - 1];
        if (d) { send({ t: 'sendTo', target: d.id }); setSendMenu(false); }
        return true;
      }
      return true;
    }
    poke();
    switch (k) {
      case 'back':
        if (live) { setMode('mini'); if (route().name !== 'live') go({ name: 'live' }); } else stop();
        return true;
      case 'stop': stop(); return true;
      case 'ok': if (!live && visible) togglePause(); return true;
      case 'playpause': case 'play': case 'pause': if (!live) togglePause(); return true;
      case 'left': case 'rw': if (live) nextSource(-1); else seekBy(k === 'rw' ? -60 : -10); return true;
      case 'right': case 'ff': if (live) nextSource(1); else seekBy(k === 'ff' ? 60 : 10); return true;
      case 'up': case 'chup': if (live) zap('prev'); return true;
      case 'down': case 'chdown': if (live) zap('next'); return true;
      case 'red': toggleFavorite(it); return true;
      case 'blue': setSendMenu(true); return true;
      case 'volup': volume(0.1); return true;
      case 'voldown': volume(-0.1); return true;
      case 'mute': volume('mute'); return true;
    }
    if (k.startsWith('digit') && live) {
      const d = digits + k.slice(5);
      setDigits(d);
      clearTimeout(digitT.current);
      digitT.current = setTimeout(async () => {
        setDigits('');
        const n = Number(d);
        if (!n || !it.cat) return;
        const r = await api.items('live', it.cat, 'default', n - 1, 1);
        if (r.items[0]) play(r.items[0], { mode: 'full' });
      }, 1300);
      return true;
    }
    return true; // full-screen player swallows everything else
  }, 2);

  if (!it) return null;
  const epg = live ? nowNext(it.epg) : undefined;
  const p = epg?.[0];
  const now = Date.now() / 1000;
  const st = status.value;
  const shown = visible || st !== 'playing';

  // Mouse: click toggles pause, double-click goes full screen. Touch: tap shows/hides the controls
  // (never pauses by accident), double-tap goes full screen. Hidden controls aren't tappable (CSS).
  const onTap = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, input, .dialog, .nextup')) return;
    if (!isMobile) { poke(); if (!live && e.target === e.currentTarget) togglePause(); return; }
    const t = Date.now();
    if (t - lastTap.current < 320) { lastTap.current = 0; toggleFullscreen(); return; }
    lastTap.current = t;
    if (shown && st === 'playing') { clearTimeout(hideT.current); setVisible(false); } else poke();
  };

  return (
    <div class={`overlay ${shown ? 'show' : ''}`} onMouseMove={isMobile ? undefined : poke} onClick={onTap}
      onDblClick={isMobile ? undefined : (e) => { if (!(e.target as HTMLElement).closest('button, input, .dialog, .nextup')) toggleFullscreen(); }}>
      {(st === 'requesting' || st === 'loading' || st === 'buffering') && <div class="spinner" />}
      {st === 'error' && <div class="err">{errorMsg.value}<br /><button onClick={() => play(it, { mode: 'full' })}>Retry</button></div>}
      {digits && <div class="digits">{digits}</div>}
      <div class="top">
        <button class="ico" onClick={() => (live ? setMode('mini') : stop())}>‹</button>
        {live && <Logo src={it.icon} name={it.name} size={56} />}
        <div class="t">
          <div class="name">{clean(it.name)} {favorites.value.has(it.id) && <span class="star">★</span>}</div>
          {it.kind === 'episode' && <div class="muted">S{it.season} · E{it.episode}</div>}
        </div>
        <div class="clock">{clock(now)}</div>
        {airplay.value && <button class="ico tool" title="AirPlay" aria-label="AirPlay" onClick={() => { poke(); showAirplay(); }}>
          <svg viewBox="0 0 24 24"><path d="M5 17H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-1M12 15l5 6H7z" /></svg></button>}
        {canPip && <button class="ico tool" title="Picture in picture" aria-label="Picture in picture" onClick={() => { poke(); togglePip(); }}>
          <svg viewBox="0 0 24 24"><path d="M3 5h18v14H3zM12 12h7v5h-7z" /></svg></button>}
        {canFullscreen && <button class="ico tool" title="Full screen" aria-label="Full screen" onClick={() => { poke(); toggleFullscreen(); }}>
          <svg viewBox="0 0 24 24"><path d={isFull.value ? 'M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6' : 'M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6'} /></svg></button>}
      </div>
      <div class="bottom">
        {live ? (
          p ? (
            <div class="epg">
              <div><b>{p.title}</b> <span class="muted">{clock(p.start)}–{clock(p.stop)}</span></div>
              <div class="bar"><i style={{ width: `${((now - p.start) / (p.stop - p.start)) * 100}%` }} /></div>
              {epg?.[1] && <div class="muted">Next: {epg[1].title} · {clock(epg[1].start)}</div>}
            </div>
          ) : <div class="muted">Live</div>
        ) : (
          <div class="seek">
            <span>{fmtTime(position.value)}</span>
            <input type="range" min={0} max={duration.value || 1} step={1} value={position.value} onInput={(e) => seekTo(Number((e.target as HTMLInputElement).value))} />
            <span>{fmtTime(duration.value)}</span>
          </div>
        )}
        {live && sources.value.length > 1 && (() => {
          const i = sources.value.findIndex((x) => x.item.id === it.id);
          const src = sources.value[i];
          return (
            <div class="srcline">
              <button onClick={() => nextSource(-1)}>◀</button>
              <span>Source <b>{i + 1}</b>/{sources.value.length}{src ? <> · <span class={src.verified ? 'ok' : 'muted'}>{src.label}{src.verified && !src.dead ? ' ✓' : ''}</span></> : null}</span>
              <button onClick={() => nextSource(1)}>▶</button>
              <span class="muted small">{sourceEvent.value ? 'same match on other channels' : 'other copies of this channel'}</span>
            </div>
          );
        })()}
        <div class="ctl">
          {live ? <>
            <button onClick={() => zap('prev')}>▲ CH</button><button onClick={() => zap('next')}>▼ CH</button>
          </> : <>
            <button onClick={() => seekBy(-10)}>⟲ 10</button>
            <button class="big" onClick={togglePause}>{st === 'paused' ? '▶' : '❚❚'}</button>
            <button onClick={() => seekBy(10)}>10 ⟳</button>
          </>}
          {it.kind === 'episode' && nextEpisode() && <button onClick={playNextEpisode}>Next episode ⏭</button>}
          {live && <button onClick={() => toggleFavorite(it)}>{favorites.value.has(it.id) ? '★' : '☆'}</button>}
          {others.length > 0 && <button onClick={() => setSendMenu(true)}>Send to… <span class="key blue" /></button>}
        </div>
      </div>
      {nextUp.value && <NextUp />}
      {sendMenu && (
        <div class="dialog" onClick={(e) => e.stopPropagation()}>
          <h3>Continue on…</h3>
          {others.map((d, i) => (
            <button key={d.id} onClick={() => { send({ t: 'sendTo', target: d.id }); setSendMenu(false); }}>{i + 1}. {d.name}</button>
          ))}
          <button class="muted" onClick={() => setSendMenu(false)}>Cancel</button>
        </div>
      )}
    </div>
  );
}

function NextUp() {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 250); return () => clearInterval(t); }, []);
  const n = nextUp.value;
  if (!n) return null;
  const secs = Math.max(0, Math.ceil((n.at - Date.now()) / 1000));
  return (
    <div class="nextup" onClick={(e) => e.stopPropagation()}>
      <div class="muted small">Next episode in {secs}s</div>
      <div class="name">S{n.item.season} E{n.item.episode} · {n.item.name}</div>
      <div class="ctl"><button class="big" onClick={playNextEpisode}>▶ Play now</button><button onClick={cancelNextUp}>Cancel</button></div>
    </div>
  );
}
