// Playback orchestration: asks the server for the lease, plays when granted, gives the stream up instantly
// when another device takes over, and reports position so any device can resume.
import { signal } from '@preact/signals';
import type { Item, ServerMsg } from '@shared/protocol.ts';
import { send, onServer, devices, lease } from './ws.ts';
import { api, myDeviceId } from './api.ts';
import { dispatchKey, type Key } from './keys.ts';
import type { Player } from './player/types.ts';
import { isTizen } from './env.ts';

export type Mode = 'off' | 'mini' | 'full';
export type Status = 'idle' | 'requesting' | 'loading' | 'playing' | 'paused' | 'buffering' | 'error';

export const current = signal<Item | null>(null);
export const mode = signal<Mode>('off');
export const status = signal<Status>('idle');
export const position = signal(0);
export const duration = signal(0);
export const errorMsg = signal<string | null>(null);
export const toast = signal<string | null>(null);

let player: Player | null = null;
let pending: { item: Item; mode: Mode } | null = null;
let suspended: { item: Item; position: number } | null = null;
let retried = false;
let lastUrls: string[] = [];
let lastStart = 0;

export function showToast(msg: string, ms = 3500) {
  toast.value = msg;
  setTimeout(() => { if (toast.value === msg) toast.value = null; }, ms);
}

const deviceName = (id?: string) => devices.value.find((d) => d.id === id)?.name ?? 'another device';

export function attachPlayer(p: Player) {
  player = p;
  p.on((e, detail) => {
    if (e === 'time') {
      position.value = p.position(); duration.value = p.duration();
      if ((status.value === 'loading' || status.value === 'buffering') && !p.paused()) { status.value = 'playing'; errorMsg.value = null; }
      return;
    }
    if (e === 'playing') { status.value = 'playing'; errorMsg.value = null; retried = false; }
    else if (e === 'paused') { if (status.value !== 'idle') { status.value = 'paused'; beat(); } }
    else if (e === 'waiting') { if (status.value === 'playing') status.value = 'buffering'; }
    else if (e === 'ended') { if (current.value?.kind !== 'live') stop(); }
    else if (e === 'error') {
      // Most common cause: provider hasn't released our previous connection yet (1-connection limit). Retry once.
      if (!retried && current.value) {
        retried = true; status.value = 'loading';
        const item = current.value;
        setTimeout(() => { if (current.value === item) p.load(lastUrls, { startAt: p.position() || lastStart, live: item.kind === 'live', uhd: /4K|UHD|2160/i.test(item.name) }).catch(() => {}); }, 1200);
        return;
      }
      status.value = 'error'; errorMsg.value = detail ?? 'Playback failed';
    }
  });
}

function beat() {
  if (!player || !current.value || status.value === 'requesting') return;
  send({ t: 'heartbeat', position: player.position(), duration: player.duration(), paused: player.paused() });
}
setInterval(() => { if (status.value === 'playing' || status.value === 'buffering') beat(); }, 5000);

/** Start playing `item` on this device. Other devices are stopped by the server before we're granted. */
export function play(item: Item, opts: { startAt?: number; mode?: Mode } = {}) {
  if (current.value && player) {
    // Same device switching items: report final position, then free the connection before the next one opens.
    beat();
    player.stop();
  }
  suspended = null;
  pending = { item, mode: opts.mode ?? 'full' };
  current.value = item;
  mode.value = pending.mode;
  status.value = 'requesting';
  errorMsg.value = null;
  position.value = opts.startAt ?? 0;
  duration.value = 0;
  send({ t: 'play', item, startAt: opts.startAt });
}

/** Continue whatever is playing on another device, here. */
export function takeover(m: Mode = 'full') {
  const l = lease.value;
  if (!l) return;
  pending = { item: l.item, mode: m };
  current.value = l.item; mode.value = m; status.value = 'requesting';
  position.value = l.position; duration.value = l.duration;
  send({ t: 'takeover' });
}

export function stop() {
  if (!current.value) return;
  const pos = player?.position() ?? 0, dur = player?.duration() ?? 0;
  player?.stop();
  send({ t: 'stopped', position: pos, duration: dur });
  reset();
}

function reset() {
  current.value = null; mode.value = 'off'; status.value = 'idle'; pending = null; errorMsg.value = null;
}

export const togglePause = () => { if (!player || !current.value) return; player.paused() ? player.play() : player.pause(); };
export const seekBy = (d: number) => { if (player && current.value?.kind !== 'live') { player.seek(player.position() + d); position.value = player.position() + d; } };
export const seekTo = (t: number) => { if (player && current.value?.kind !== 'live') { player.seek(t); position.value = t; } };
export const volume = (d: number | 'mute') => player?.setVolume(d);
export const setMode = (m: Mode) => { if (current.value) mode.value = m; };

/** Channel up/down within the channel's category (server knows the order). */
export async function zap(dir: 'next' | 'prev') {
  const c = current.value;
  if (!c || c.kind !== 'live') return;
  try { play(await api.neighbor(c.id, dir), { mode: mode.value === 'off' ? 'full' : mode.value }); } catch {}
}

export function preconnect(url: string) {
  try {
    const o = new URL(url).origin;
    if (document.querySelector(`link[rel=preconnect][href="${o}"]`)) return;
    const l = document.createElement('link'); l.rel = 'preconnect'; l.href = o; document.head.appendChild(l);
  } catch {}
}

onServer((m: ServerMsg) => {
  switch (m.t) {
    case 'granted': {
      if (!player) return;
      const item = m.item;
      if (pending && pending.item.id !== item.id) return; // a newer request is in flight
      current.value = item;
      if (pending) mode.value = pending.mode;
      pending = null;
      status.value = 'loading';
      lastUrls = m.urls; lastStart = m.startAt; retried = false;
      position.value = m.startAt;
      if (m.urls[0]) preconnect(m.urls[0]);
      player.load(m.urls, { startAt: m.startAt, live: item.kind === 'live', uhd: /4K|UHD|2160/i.test(item.name) }).catch(() => {});
      return;
    }
    case 'stop': {
      if (!current.value && !pending) { send({ t: 'stopped', position: 0, duration: 0 }); return; }
      const pos = player?.position() ?? 0, dur = player?.duration() ?? 0;
      player?.stop(); // free the provider connection *before* acking
      send({ t: 'stopped', position: pos, duration: dur });
      reset();
      if (m.reason === 'handoff' && m.to && m.to !== myDeviceId.value) showToast(`Now playing on ${deviceName(m.to)}`);
      return;
    }
    case 'play':
      play(m.item, { startAt: m.startAt, mode: 'full' });
      showToast(`Sent from ${deviceName(m.from)}`);
      return;
    case 'remote': {
      const map: Partial<Record<string, Key>> = { playpause: 'playpause', chup: 'chup', chdown: 'chdown', home: 'back' };
      if (m.cmd === 'seek') { seekBy(Number(m.arg) || 0); return; }
      if (m.cmd === 'volup') { volume(+0.1); return; }
      if (m.cmd === 'voldown') { volume(-0.1); return; }
      if (m.cmd === 'mute') { volume('mute'); return; }
      if (m.cmd === 'digit') { dispatchKey(`digit${Number(m.arg)}`); return; }
      dispatchKey((map[m.cmd] ?? m.cmd) as Key);
      return;
    }
    case 'error':
      showToast(m.message);
      return;
  }
});

// Leaving the app (TV home button, phone lock, tab hidden): release the stream but keep the lease so any
// device can "Continue here"; resume on return.
document.addEventListener('visibilitychange', () => {
  const hidden = document.visibilityState === 'hidden';
  if (hidden && current.value && player && (status.value === 'playing' || status.value === 'paused' || status.value === 'buffering')) {
    if (!isTizen && current.value.kind !== 'live' && document.pictureInPictureElement) return; // PiP keeps playing
    const pos = player.position();
    send({ t: 'heartbeat', position: pos, duration: player.duration(), paused: true });
    player.stop();
    suspended = { item: current.value, position: pos };
    status.value = 'paused';
  } else if (!hidden && suspended) {
    const s = suspended; suspended = null;
    if (lease.value?.deviceId === myDeviceId.value) play(s.item, { startAt: s.position, mode: mode.value === 'off' ? 'full' : mode.value });
    else reset();
  }
});
window.addEventListener('pagehide', () => { if (current.value) stop(); });
