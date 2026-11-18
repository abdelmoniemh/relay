import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import { isTizen, isMobile, clock, fmtTime } from '../env.ts';
import { Html5Player } from './html5.ts';
import { AvPlayer } from './avplay.ts';
import type { Player } from './types.ts';
import {
  attachPlayer, current, mode, status, position, duration, errorMsg, play, stop, togglePause, seekBy, seekTo, zap, setMode, volume,
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

export function PlayerHost() {
  const vid = useRef<HTMLVideoElement>(null);
  const obj = useRef<HTMLObjectElement>(null);
  const player = useRef<Player | null>(null);
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const m = mode.value;
  const onLive = route().name === 'live';

  useEffect(() => {
    const p = hw ? new AvPlayer() : new Html5Player(vid.current!);
    player.current = p;
    attachPlayer(p);
  }, []);

  // Where should the video be? full screen, the Live preview box, or a corner mini player.
  useLayoutEffect(() => {
    const place = () => {
      if (m === 'full' || m === 'off') { setRect(null); return; }
      const box = onLive ? previewBox.value : null;
      if (box) { const r = box.getBoundingClientRect(); setRect({ x: r.left, y: r.top, w: r.width, h: r.height }); return; }
      const w = Math.min(480, window.innerWidth * 0.45);
      setRect({ x: window.innerWidth - w - 24, y: window.innerHeight - (w * 9) / 16 - 24, w, h: (w * 9) / 16 });
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
            onDblClick={() => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.()} />}
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
      case 'left': case 'rw': seekBy(k === 'rw' ? -60 : -10); return true;
      case 'right': case 'ff': seekBy(k === 'ff' ? 60 : 10); return true;
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

  return (
    <div class={`overlay ${visible || st !== 'playing' ? 'show' : ''}`} onMouseMove={poke} onClick={(e) => { if (e.target === e.currentTarget) { poke(); if (!live) togglePause(); } }}>
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
        <div class="ctl">
          {live ? <>
            <button onClick={() => zap('prev')}>▲ CH</button><button onClick={() => zap('next')}>▼ CH</button>
          </> : <>
            <button onClick={() => seekBy(-10)}>⟲ 10</button>
            <button class="big" onClick={togglePause}>{st === 'paused' ? '▶' : '❚❚'}</button>
            <button onClick={() => seekBy(10)}>10 ⟳</button>
          </>}
          <button onClick={() => toggleFavorite(it)}>{favorites.value.has(it.id) ? '★' : '☆'}</button>
          {others.length > 0 && <button onClick={() => setSendMenu(true)}>Send to… <span class="key blue" /></button>}
          {!isMobile && !isTizen && <button onClick={() => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()}>⤢ Full screen</button>}
        </div>
      </div>
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
