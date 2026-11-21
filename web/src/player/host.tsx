import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import { isTizen, isMobile, clock, fmtTime } from '../env.ts';
import { Html5Player } from './html5.ts';
import { AvPlayer } from './avplay.ts';
import type { Player } from './types.ts';
import {
  attachPlayer, current, mode, status, position, duration, errorMsg, play, stop, togglePause, seekBy, seekTo, zap, setMode, volume,
  sources, nextSource, sourceEvent, nextUp, nextEpisode, playNextEpisode, cancelNextUp,
  isLiveNow, skipAt, skipIntro, thumbAt, mediaTracks, selectAudio, selectSub, startOver, canCatchup,
  showToast,
  continueOn,
} from '../playback.ts';
import { Sheet } from '../ui/kit.tsx';
import { ProgrammesSheet } from '../features/programmes.tsx';
import { useKeys, nowNext, epgVersion } from '../ui/hooks.ts';
import { Logo } from '../ui/common.tsx';
import { displayName } from '@shared/domain.ts';
import { api, myDeviceId, toggleFavorite, favorites } from '../api.ts';
import { devices } from '../ws.ts';
import { route, go, compact } from '../router.ts';
import { Icon } from '../ui/Icon.tsx';
import { previewBox, numbered } from './placement.ts';
import { t } from '../i18n.ts';


const hw = isTizen && !!window.webapis?.avplay;

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
    if (v.readyState < 1) { showToast(t('Wait for the video to start'), 2000); return; }
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
      const small = compact.value; // the phone layout (router.ts)
      const w = Math.min(480, W * (small ? 0.55 : 0.45)), h = (w * 9) / 16;
      const gap = small ? 12 : 24;
      // Keep clear of the bottom tab bar on phones.
      const rail = document.querySelector('.tabbar')?.getBoundingClientRect();
      const bottom = rail && rail.top > H / 2 ? H - rail.top + gap : gap;
      setRect({ x: W - w - gap, y: H - h - bottom, w, h });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [m, onLive, previewBox.value, compact.value]);

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
            onClick={() => (m === 'mini' ? setMode('full') : !isLiveNow(current.value) && togglePause())}
            onDblClick={() => m === 'full' && toggleFullscreen()} />}
      {m === 'mini' && rect && !hw && !onLive && (
        <div class="mini-ctl" style={{ left: rect.x, top: rect.y - 40, width: rect.w }}>
          <span class="name">{current.value && displayName(current.value.name)}</span>
          <button aria-label={t('Full screen')} onClick={() => setMode('full')}><Icon n="expand" /></button>
          <button aria-label={t('Stop')} onClick={() => stop()}><Icon n="close" /></button>
        </div>
      )}
      {m === 'full' && <Overlay />}
      {m === 'full' && <SkipButton />}
    </>
  );
}

function Overlay() {
  const [visible, setVisible] = useState(true);
  const [digits, setDigits] = useState('');
  const [sendMenu, setSendMenu] = useState(false);
  const [sheet, setSheet] = useState<'tracks' | 'guide' | null>(null);
  const [hover, setHover] = useState<number | null>(null); // seek-bar preview time
  const hideT = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const digitT = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastTap = useRef(0);
  const it = current.value!;
  const live = isLiveNow(it); // a catch-up programme plays like a movie: seekable
  const skip = it && !live ? skipAt(position.value) : null;
  epgVersion.value;

  const poke = () => {
    setVisible(true);
    clearTimeout(hideT.current);
    hideT.current = setTimeout(() => setVisible(false), 4000);
  };
  useEffect(() => { poke(); return () => clearTimeout(hideT.current); }, [it?.id]);

  const others = devices.value.filter((d) => d.online && d.id !== myDeviceId.value);

  useKeys((k) => {
    if (sheet) return false; // the open sheet handles the remote
    if (nextUp.value) {
      if (k === 'ok' || k === 'play' || k === 'playpause') { playNextEpisode(); return true; }
      if (k === 'back') { cancelNextUp(); stop(); return true; }
      return true;
    }
    if (sendMenu) {
      if (k === 'back') { setSendMenu(false); return true; }
      if (k.startsWith('digit')) {
        const d = others[Number(k.slice(5)) - 1];
        if (d) { continueOn(d.id); setSendMenu(false); }
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
      case 'ok': if (!live && skip) { skipIntro(); return true; } if (!live && visible) togglePause(); return true;
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
        if (!n) return;
        // the list whose numbers were on screen (Favourites, Recent, a category): only it, or a number off its end
        // plays some other channel. No list shown: this channel's category.
        const list = numbered.value, cat = list ? list.cat : it.cat;
        const pick = list?.at(n - 1) ?? (cat ? (await api.items('live', cat, 'default', n - 1, 1)).items[0] : undefined);
        if (pick) play(pick, { mode: 'full' }); else showToast(t('No channel {n}', { n }), 2000);
      }, 1300);
      return true;
    }
    return true; // full-screen player swallows everything else
  }, 2);

  if (!it) return null;
  const tracks = !live ? mediaTracks() : null;
  const hasTracks = !!tracks && (tracks.audio.length > 1 || tracks.subs.length > 0);
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
      {st === 'error' && <div class="err" role="alert"><p>{errorMsg.value}</p><button class="btn primary" onClick={() => play(it, { mode: 'full' })}><Icon n="refresh" />{t('Try again')}</button></div>}
      {!live && (st === 'playing' || st === 'paused') && (
        <div class="center-ctl">
          <button class="cbtn" aria-label={t('Back 10 seconds')} onClick={() => { poke(); seekBy(-10); }}><Icon n="back10" /></button>
          <button class="cbtn big" aria-label={st === 'paused' ? t('Play') : t('Pause')} onClick={() => { poke(); togglePause(); }}><Icon n={st === 'paused' ? 'play' : 'pause'} /></button>
          <button class="cbtn" aria-label={t('Forward 10 seconds')} onClick={() => { poke(); seekBy(10); }}><Icon n="fwd10" /></button>
        </div>
      )}
      {digits && <div class="digits">{digits}</div>}
      <div class="top">
        <button class="ico tool" aria-label={t('Back')} onClick={() => (live ? setMode('mini') : stop())}><Icon n="back" /></button>
        {it.kind === 'live' && <Logo src={it.icon} name={it.name} size={56} />}
        <div class="t">
          <div class="name">{it.catchup?.title ?? displayName(it.name)}{favorites.value.has(it.id) && !it.catchup && <Icon n="star" filled class="fav-mark" />}</div>
          {it.kind === 'episode' && <div class="sub">S{it.season} · E{it.episode}</div>}
          {it.catchup && <div class="sub"><span class="badge-inline">{t('Catch-up')}</span> {displayName(it.name)} · <span class="tnum">{clock(it.catchup.start)}</span></div>}
        </div>
        <div class="clock tnum">{clock(now)}</div>
        {airplay.value && <button class="ico tool" title="AirPlay" aria-label="AirPlay" onClick={() => { poke(); showAirplay(); }}><Icon n="airplay" /></button>}
        {canPip && <button class="ico tool" title={t('Picture in picture')} aria-label={t('Picture in picture')} onClick={() => { poke(); togglePip(); }}><Icon n="pip" /></button>}
        {canFullscreen && <button class="ico tool" title={t('Full screen')} aria-label={t('Full screen')} onClick={() => { poke(); toggleFullscreen(); }}><Icon n={isFull.value ? 'shrink' : 'expand'} /></button>}
      </div>
      <div class="bottom">
        {live ? (
          p ? (
            <div class="epg">
              <div><span class="live-pill">{t('LIVE')}</span> <b>{p.title}</b> <span class="sub tnum">{clock(p.start)}–{clock(p.stop)}</span></div>
              <div class="bar"><i style={{ width: `${((now - p.start) / (p.stop - p.start)) * 100}%` }} /></div>
              {epg?.[1] && <div class="sub">{t('Next')}: {epg[1].title} · <span class="tnum">{clock(epg[1].start)}</span></div>}
            </div>
          ) : <div><span class="live-pill">{t('LIVE')}</span></div>
        ) : (
          <div class="seek tnum">
            <span>{fmtTime(position.value)}</span>
            <div class="seek-track">
              {hover != null && duration.value > 0 && (() => {
                const th = thumbAt(hover);
                return (
                  <div class="seek-preview" style={{ left: `${(hover / duration.value) * 100}%` }}>
                    {th && <div class="thumb" style={{ width: th.w, height: th.h, backgroundImage: `url("${th.url}")`, backgroundPosition: `-${th.x}px -${th.y}px` }} />}
                    <span>{fmtTime(hover)}</span>
                  </div>
                );
              })()}
              <input type="range" min={0} max={duration.value || 1} step={1} value={position.value}
                onInput={(e) => { const v = Number((e.target as HTMLInputElement).value); setHover(v); seekTo(v); }}
                onPointerMove={(e) => { if (!isMobile && duration.value) { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setHover(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * duration.value); } }}
                onPointerLeave={() => setHover(null)} onPointerUp={() => setTimeout(() => setHover(null), 600)} />
            </div>
            <span>{fmtTime(duration.value)}</span>
          </div>
        )}
        {live && sources.value.length > 1 && (() => {
          const i = sources.value.findIndex((x) => x.item.id === it.id);
          const src = sources.value[i];
          return (
            <div class="srcline">
              <button class="pill-btn" aria-label={t('Previous source')} onClick={() => nextSource(-1)}><Icon n="back" /></button>
              <span>{t('Source {i} of {n}', { i: i + 1, n: sources.value.length })}{src ? <> · <span class={`qchip ${src.verified && !src.dead ? 'ok' : 'unverified'}`}>{src.label.replace(' · unverified', '')}</span></> : null}</span>
              <button class="pill-btn" aria-label={t('Next source')} onClick={() => nextSource(1)}><Icon n="chevron" /></button>
              <span class="sub">{sourceEvent.value ? t('Same match on other channels') : t('Other copies of this channel')}</span>
            </div>
          );
        })()}
        <div class="ctl">
          {live && <>
            <button class="pill-btn" onClick={() => zap('prev')}><Icon n="up" />{t('Previous channel')}</button>
            <button class="pill-btn" onClick={() => zap('next')}><Icon n="down" />{t('Next channel')}</button>
          </>}
          {it.kind === 'episode' && nextEpisode() && <button class="pill-btn" onClick={playNextEpisode}><Icon n="next" />{t('Next episode')}</button>}
          {hasTracks && <button class="pill-btn" onClick={() => setSheet('tracks')}><Icon n="globe" />{t('Audio & subtitles')}</button>}
          {live && p && canCatchup(it, p) && <button class="pill-btn" onClick={() => startOver(it)}><Icon n="restart" />{t('Start over')}</button>}
          {it.kind === 'live' && it.epg && <button class="pill-btn" onClick={() => setSheet('guide')}><Icon n="info" />{t('Programmes')}</button>}
          {live && <button class="pill-btn" aria-pressed={favorites.value.has(it.id)} onClick={() => toggleFavorite(it)}><Icon n="star" filled={favorites.value.has(it.id)} />{favorites.value.has(it.id) ? t('Favourite') : t('Add to favourites')}</button>}
          {others.length > 0 && <button class="pill-btn" onClick={() => setSendMenu(true)}><Icon n="send" />{t('Send to…')}<span class="keydot blue" /></button>}
        </div>
      </div>
      {nextUp.value && <NextUp />}
      {sheet === 'guide' && <ProgrammesSheet channel={{ ...it, catchup: null }} onClose={() => setSheet(null)} />}
      {sheet === 'tracks' && tracks && (
        <Sheet title={t('Audio & subtitles')} onClose={() => setSheet(null)}>
          {tracks.audio.length > 1 && (
            <section class="set-group">
              <h2 class="list-head">{t('Audio')}</h2>
              <div class="list-group">
                {tracks.audio.map((a, i) => (
                  <button key={a.n} class="list-row tappable" aria-pressed={i === tracks.audioSel} onClick={() => { selectAudio(i); setSheet(null); }}>
                    <span class="lr-main"><b>{a.name}</b></span>{i === tracks.audioSel && <Icon n="check" class="lr-chev" />}
                  </button>
                ))}
              </div>
            </section>
          )}
          {tracks.subs.length > 0 && (
            <section class="set-group">
              <h2 class="list-head">{t('Subtitles')}</h2>
              <div class="list-group">
                <button class="list-row tappable" aria-pressed={tracks.subSel < 0} onClick={() => { selectSub(-1); setSheet(null); }}>
                  <span class="lr-main"><b>{t('Off')}</b></span>{tracks.subSel < 0 && <Icon n="check" class="lr-chev" />}
                </button>
                {tracks.subs.map((sb, i) => (
                  <button key={sb.n} class="list-row tappable" aria-pressed={i === tracks.subSel} onClick={() => { selectSub(i); setSheet(null); }}>
                    <span class="lr-main"><b>{sb.name}</b></span>{i === tracks.subSel && <Icon n="check" class="lr-chev" />}
                  </button>
                ))}
              </div>
            </section>
          )}
        </Sheet>
      )}
      {sendMenu && (
        <div class="dialog" onClick={(e) => e.stopPropagation()}>
          <h3>{t('Continue on…')}</h3>
          {others.map((d, i) => (
            <button key={d.id} class="list-row" onClick={() => { continueOn(d.id); setSendMenu(false); }}><span class="tnum">{i + 1}</span><span class="lr-main"><b>{d.name}</b></span></button>
          ))}
          <button class="btn secondary" onClick={() => setSendMenu(false)}>{t('Cancel')}</button>
        </div>
      )}
    </div>
  );
}

/** Stays visible while the controls are hidden (outside the fading overlay). */
function SkipButton() {
  const it = current.value;
  const skip = it && !isLiveNow(it) && (status.value === 'playing' || status.value === 'paused') ? skipAt(position.value) : null;
  if (!skip) return null;
  return <button class="btn primary skip-btn" onClick={() => skipIntro()}>{skip.kind === 'intro' ? t('Skip intro') : t('Skip recap')}</button>;
}

function NextUp() {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 250); return () => clearInterval(t); }, []);
  const n = nextUp.value;
  if (!n) return null;
  const secs = Math.max(0, Math.ceil((n.at - Date.now()) / 1000));
  return (
    <div class="nextup" onClick={(e) => e.stopPropagation()}>
      <div class="sub">{t('Next episode in {n}s', { n: secs })}</div>
      <div class="name">S{n.item.season} E{n.item.episode} · {n.item.name}</div>
      <div class="ctl"><button class="btn primary" onClick={playNextEpisode}><Icon n="play" />{t('Play now')}</button><button class="btn secondary" onClick={cancelNextUp}>{t('Cancel')}</button></div>
    </div>
  );
}
