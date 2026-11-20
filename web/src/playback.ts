// Playback orchestration: asks the server for the lease, plays when granted, gives the stream up instantly
// when another device takes over, and reports position so any device can resume.
import { signal, effect } from '@preact/signals';
import type { Item, RankedSource, ServerMsg } from '@shared/protocol.ts';
import { send, onServer, devices, lease } from './ws.ts';
import { api, myDeviceId, server, token } from './api.ts';
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
/** Equivalent streams for what's playing (same match / copies of the same channel), best first. */
export const sources = signal<RankedSource[]>([]);
export const sourceEvent = signal<string | null>(null); // event id when playing a sports event
/** Series being watched: episodes in order, so the next one can start automatically. */
export const episodeQueue = signal<Item[]>([]);
export const nextUp = signal<{ item: Item; at: number } | null>(null); // countdown to the next episode
let nextTimer: ReturnType<typeof setTimeout> | undefined;

export function nextEpisode(): Item | null {
  const cur = current.value, q = episodeQueue.value;
  if (!cur || cur.kind !== 'episode') return null;
  const i = q.findIndex((e) => e.id === cur.id);
  return i >= 0 && i + 1 < q.length ? q[i + 1] : null;
}
export function playNextEpisode() {
  clearTimeout(nextTimer);
  const n = nextUp.value?.item ?? nextEpisode();
  nextUp.value = null;
  if (n) play(n, { mode: 'full', episodes: episodeQueue.value, startAt: 0 });
}
export function cancelNextUp() { clearTimeout(nextTimer); nextUp.value = null; }
function scheduleNextEpisode() {
  const n = nextEpisode();
  if (!n) return false;
  nextUp.value = { item: n, at: Date.now() + 10_000 };
  clearTimeout(nextTimer);
  nextTimer = setTimeout(playNextEpisode, 10_000);
  return true;
}
/** Preferred audio language (null = the file's default) and subtitles ('off' or a language), per device. */
const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string | null) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };
export const audioLang = signal<string | null>(lsGet('relay.alang'));
export const subLang = signal<string>(lsGet('relay.slang') ?? 'off');
export function setAudioLang(l: string | null) { audioLang.value = l; lsSet('relay.alang', l); }
export function setSubLang(l: string) { subLang.value = l; lsSet('relay.slang', l); }

/**
 * Data saver: 'auto' = on when Relay is reached through Tailscale (away from home), 'on' / 'off' always.
 * Only streams that pass through the server can be made smaller, so with it on everything does.
 */
export type DataSaver = 'auto' | 'on' | 'off';
export const dataSaver = signal<DataSaver>(((v) => (v === 'on' || v === 'off' ? v : 'auto'))(lsGet('relay.datasaver')));
export function setDataSaver(v: DataSaver) { dataSaver.value = v; lsSet('relay.datasaver', v); }
/** Reached through Tailscale (100.64.0.0/10 or a *.ts.net name), i.e. probably not on the home network. */
export const isAway = () => typeof location !== 'undefined' && (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(location.hostname) || location.hostname.endsWith('.ts.net'));
export const lowDataNow = () => !isTizen && (dataSaver.value === 'on' || (dataSaver.value === 'auto' && isAway()));

/** Sports: chase the live edge (lowest delay) instead of playing the provider's backlog smoothly. */
export const lowLatencySports = signal<boolean>((() => { try { return localStorage.getItem('relay.lowLatency') !== '0'; } catch { return true; } })());
export function setLowLatency(v: boolean) { lowLatencySports.value = v; try { localStorage.setItem('relay.lowLatency', v ? '1' : '0'); } catch {} }

let player: Player | null = null;
let pending: { item: Item; mode: Mode } | null = null;
let suspended: { item: Item; position: number } | null = null;
let retried = false;
let lastUrls: string[] = [];
let lastStart = 0;
let lastHevc = false;
let lastTx: 'full' | 'audio' | undefined;
let lastInterlaced = false;

export function showToast(msg: string, ms = 3500) {
  toast.value = msg;
  setTimeout(() => { if (toast.value === msg) toast.value = null; }, ms);
}

const deviceName = (id?: string) => devices.value.find((d) => d.id === id)?.name ?? 'another device';

export function attachPlayer(p: Player) {
  player = p;
  p.onLangs?.((kind, lang) => (kind === 'audio' ? setAudioLang(lang) : setSubLang(lang)));
  p.on((e, detail) => {
    if (e === 'time') {
      position.value = p.position(); duration.value = p.duration();
      if ((status.value === 'loading' || status.value === 'buffering') && !p.paused()) { status.value = 'playing'; errorMsg.value = null; }
      return;
    }
    if (e === 'playing') {
      status.value = 'playing'; errorMsg.value = null; retried = false;
      // Passive verification: tell the server what this stream really is (resolution/fps/codec), once it has settled.
      const item = current.value;
      if (item && isLiveNow(item)) setTimeout(() => {
        const i = current.value === item ? p.info?.() : null;
        if (i && i.height) api.observed({ id: item.id, ...i }).catch(() => {});
      }, 5000);
    }
    else if (e === 'paused') { if (status.value !== 'idle') { status.value = 'paused'; beat(); } }
    else if (e === 'waiting') { if (status.value === 'playing') status.value = 'buffering'; }
    else if (e === 'ended') {
      if (current.value?.kind === 'episode' && scheduleNextEpisode()) { beat(); return; }
      if (!isLiveNow(current.value)) stop();
    }
    else if (e === 'error') {
      // Most common cause: provider hasn't released our previous connection yet (1-connection limit). Retry once.
      if (!retried && current.value) {
        retried = true; status.value = 'loading';
        const item = current.value;
        setTimeout(() => { if (current.value === item) p.load(lastUrls, loadOpts(item, p.position() || lastStart)).catch(() => {}); }, 1200);
        return;
      }
      // Still failing: fail over to the next working copy of the same channel / match.
      if (isLiveNow(current.value) && nextSource(1, true)) return;
      status.value = 'error'; errorMsg.value = friendlyError(detail);
      if (detail) api.clientLog(`error shown: ${detail} (${current.value?.id})`);
    }
  });
}

/** Live right now (not a programme from a channel's archive). */
export const isLiveNow = (item: Item | null | undefined) => item?.kind === 'live' && !item.catchup;

/** What the player says (HTTP codes, engine error names) → a sentence for people. Server messages are already readable. */
export function friendlyError(raw?: string | null): string {
  const s = String(raw ?? '');
  const live = isLiveNow(current.value);
  if (!s) return 'Playback failed. Try again.';
  if (/Could not reach the server|Failed to fetch|NetworkError when|Load failed/i.test(s)) return "Can't reach the Relay server. Check this device is on the same network (or Tailscale) and try again.";
  if (/stalled/.test(s)) return live ? 'This channel isn\'t sending anything right now. Try another source or channel.' : 'The stream stopped. Try again.';
  if (/(Conversion|Transcode) failed.*(HTTP 5|ffmpeg exited|no output)/i.test(s) || /HTTP 50[23]/.test(s)) return live ? 'The provider didn\'t send this channel. It may be offline or busy: try another source.' : 'The provider didn\'t send this title. It may be busy: try again in a moment.';
  if (/HTTP 401|HTTP 403|unauthor/i.test(s)) return 'This device is no longer paired. Pair it again in Settings.';
  if (/archive|catch-up|not found|can't decode|isn't|no longer/i.test(s)) return s; // already a sentence
  if (/NetworkError|IOException|HttpStatusCodeInvalid|manifestLoadError|fragLoadError|levelLoadError|MEDIA_ERR_NETWORK/i.test(s)) return live ? 'Lost the connection to this channel. Try again or pick another source.' : 'Lost the connection to the stream. Try again.';
  if (/MediaError|MEDIA_ERR_DECODE|MEDIA_ERR_SRC_NOT_SUPPORTED|bufferAppendError|FormatUnsupported|CodecUnsupported/i.test(s)) return 'This device can\'t play this stream\'s format. Try another source.';
  return 'Playback failed. Try again.';
}

function loadOpts(item: Item, startAt: number, hevc = lastHevc) {
  const cu = item.kind === 'live' ? item.catchup : null;
  const low = lowDataNow();
  const q = new URLSearchParams({ token: token.value ?? '', ...(item.ext ? { ext: item.ext } : {}), ...(cu ? { cs: String(cu.start), ce: String(cu.stop) } : {}), ...(low ? { q: 'low' } : {}) });
  const src = sources.value.find((s) => s.item.id === item.id);
  return {
    // 4K by measurement, not just by name (the TV needs SET_MODE_4K for a 4K stream)
    startAt, live: isLiveNow(item), uhd: /4K|UHD|2160/i.test(item.name) || (src?.height ?? 0) >= 2000, id: item.id,
    transcodeUrl: `${server.value}/api/transcode/${item.id}.ts?${q}`, hlsUrl: `${server.value}/api/hls/${item.id}?${q}`, hevc: hevc || !!src?.hevc,
    lowLatency: isLiveNow(item) && !!sourceEvent.value && lowLatencySports.value,
    duration: cu ? cu.stop - cu.start : item.duration ?? undefined,
    // Catch-up in a browser: always the server's conversion (raw MPEG-TS, and it seeks by restarting)
    tx: cu ? ((hevc || src?.hevc) ? 'full' as const : 'audio' as const) : lastTx,
    catchupUrl: cu ? `${server.value}/api/catchup/${item.id}.ts?${q}` : undefined,
    interlaced: item.kind === 'live' && (lastInterlaced || !!src?.interlaced),
    alang: audioLang.value, slang: subLang.value, lowData: low,
  };
}

/** Switch to the next/previous copy of what's playing. `auto` skips sources known to be dead. */
export function nextSource(dir: 1 | -1, auto = false): boolean {
  const list = sources.value, cur = current.value;
  if (!cur || list.length < 2) return false;
  const i = list.findIndex((s) => s.item.id === cur.id);
  for (let k = 1; k < list.length; k++) {
    const j = (i + dir * k + list.length * k) % list.length;
    const cand = list[j];
    if (auto && (cand.dead || failed.has(cand.item.id))) continue;
    if (auto) { failed.add(cur.id); showToast(`Source failed — switched to source ${j + 1}/${list.length}`); }
    else showToast(`Source ${j + 1}/${list.length} · ${cand.label}`, 2500);
    play(cand.item, { mode: mode.value === 'off' ? 'full' : mode.value, keepSources: true });
    return true;
  }
  return false;
}
const failed = new Set<string>();

/** For a channel played on its own, look up its other copies so ◀ ▶ can switch between them. */
async function loadFamily(item: Item) {
  try {
    const fam = await api.family(item.id);
    if (current.value?.id === item.id && !sourceEvent.value) sources.value = fam;
  } catch {}
}

function beat() {
  if (!player || !current.value || status.value === 'requesting') return;
  send({ t: 'heartbeat', position: player.position(), duration: player.duration(), paused: player.paused() });
}
setInterval(() => { if (status.value === 'playing' || status.value === 'buffering') beat(); }, 5000);

/** Start playing `item` on this device. Other devices are stopped by the server before we're granted. */
export function play(item: Item, opts: { startAt?: number; mode?: Mode; sources?: RankedSource[]; eventId?: string | null; keepSources?: boolean; episodes?: Item[] } = {}) {
  cancelNextUp();
  if (opts.episodes) episodeQueue.value = opts.episodes;
  else if (item.kind !== 'episode') episodeQueue.value = [];
  if (!opts.keepSources) {
    sources.value = opts.sources ?? [];
    sourceEvent.value = opts.eventId ?? null;
    failed.clear();
    if (!opts.sources && isLiveNow(item)) loadFamily(item);
  }
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
  sources.value = []; sourceEvent.value = null; episodeQueue.value = []; cancelNextUp();
}

/** Play a sports event: best working source, with every other source one key press away. */
export async function playEvent(eventId: string, opts: { mode?: Mode; sourceId?: string } = {}) {
  const ev = await api.event(eventId);
  const list = ev.sources;
  const pick = (opts.sourceId && list.find((s) => s.item.id === opts.sourceId)) || list.find((s) => !s.dead) || list[0];
  if (!pick) { showToast('No sources for this event right now'); return; }
  play(pick.item, { mode: opts.mode ?? 'full', sources: list, eventId });
}

export const togglePause = () => { if (!player || !current.value) return; player.paused() ? player.play() : player.pause(); };
export const seekBy = (d: number) => { if (player && current.value && !isLiveNow(current.value)) { player.seek(player.position() + d); position.value = player.position() + d; } };
export const seekTo = (t: number) => { if (player && current.value && !isLiveNow(current.value)) { player.seek(t); position.value = t; } };

/** Watch a past programme of a catch-up channel from its start (or `at` seconds in). */
export function playCatchup(channel: Item, prog: { start: number; stop: number; title?: string }, opts: { at?: number; mode?: Mode } = {}) {
  const item: Item = { ...channel, catchup: { start: prog.start, stop: prog.stop, title: prog.title } };
  play(item, { mode: opts.mode ?? 'full', startAt: opts.at ?? 0 });
}
/** Is `prog` in this channel's archive (finished or on air, within its catch-up days)? */
export function canCatchup(channel: Item, prog: { start: number; stop: number }, now = Date.now() / 1000) {
  return channel.kind === 'live' && !!channel.archive && prog.start < now && prog.start > now - channel.archive * 86400;
}
/** "Start over": the programme on air now, from its beginning. */
export async function startOver(channel: Item = current.value!) {
  if (!channel?.epg || !channel.archive) return false;
  try {
    const now = Date.now() / 1000;
    const p = (await api.nowNext([channel.epg]))[channel.epg]?.find((x) => x.start <= now && x.stop > now);
    if (!p || !canCatchup(channel, p)) return false;
    playCatchup({ ...channel, catchup: null }, p, { mode: mode.value === 'off' ? 'full' : mode.value });
    return true;
  } catch { return false; }
}
export const volume = (d: number | 'mute') => player?.setVolume(d);
export const setMode = (m: Mode) => { if (current.value) mode.value = m; };

/** Neighbouring channels of the one playing, fetched as soon as it starts: channel up/down needs no round trip. */
const neighbours = new Map<string, Promise<Item>>();
function prefetchNeighbours(c: Item) {
  for (const dir of ['next', 'prev'] as const) {
    const k = `${c.id}:${dir}`;
    if (!neighbours.has(k)) neighbours.set(k, api.neighbor(c.id, dir).catch((e) => { neighbours.delete(k); throw e; }));
  }
  while (neighbours.size > 40) neighbours.delete(neighbours.keys().next().value!);
}
effect(() => { const c = current.value; if (c && isLiveNow(c)) prefetchNeighbours(c); });

/** Channel up/down within the channel's category (server knows the order). */
export async function zap(dir: 'next' | 'prev') {
  const c = current.value;
  if (!c || c.kind !== 'live') return;
  const k = `${c.id}:${dir}`;
  try { play(await (neighbours.get(k) ?? api.neighbor(c.id, dir)), { mode: mode.value === 'off' ? 'full' : mode.value }); }
  catch { neighbours.delete(k); }
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
      lastUrls = m.urls; lastStart = m.startAt; lastHevc = !!m.hevc; lastTx = m.tx; lastInterlaced = !!m.interlaced; retried = false;
      position.value = m.startAt;
      if (m.urls[0]) preconnect(m.urls[0]);
      player.load(m.urls, loadOpts(item, m.startAt, !!m.hevc)).catch(() => {});
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
      if (m.eventId) playEvent(m.eventId, { sourceId: m.item.id }).catch(() => play(m.item, { mode: 'full' }));
      else play(m.item, { startAt: m.startAt, mode: 'full' });
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
    case 'reminder': {
      const r = m.reminder;
      const here = r.autoplay === myDeviceId.value;
      showToast(`${here ? 'Starting' : 'Starting now'}: ${r.title} · ${r.item.name.replace(/^([A-Z0-9]{2,4}|4K)\s*[|:]\s*/, '')}`, 8000);
      return;
    }
  }
});

// Leaving the app (TV home button, phone lock, tab hidden): release the stream but keep the lease so any
// device can "Continue here"; resume on return.
document.addEventListener('visibilitychange', () => {
  const hidden = document.visibilityState === 'hidden';
  if (hidden && current.value && player && (status.value === 'playing' || status.value === 'paused' || status.value === 'buffering')) {
    if (!isTizen && !isLiveNow(current.value) && document.pictureInPictureElement) return; // PiP keeps playing
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

// ---- Lock screen / Control Center / headphone buttons (Media Session) ----
// Without this iOS shows nothing on the lock screen and the AirPods/headphone buttons do nothing.
const ms = typeof navigator !== 'undefined' && 'mediaSession' in navigator && !isTizen ? navigator.mediaSession : null;
if (ms) {
  const tidy = (s: string) => s.replace(/^([A-Z0-9]{2,4}|4K)\s*[|:]\s*/, '').replace(/^[A-Z]{2,3} - /, '');
  const on = (a: MediaSessionAction, h: MediaSessionActionHandler | null) => { try { ms.setActionHandler(a, h); } catch {} };
  let shownId: string | null = null;
  effect(() => {
    const it = current.value;
    if (!it) { if (shownId) { ms.metadata = null; ms.playbackState = 'none'; shownId = null; } return; }
    if (it.id === shownId) return;
    shownId = it.id;
    const live = isLiveNow(it);
    ms.metadata = new MediaMetadata({
      title: it.catchup?.title ? `${it.catchup.title}` : tidy(it.name),
      artist: it.catchup ? `${tidy(it.name)} · catch-up` : live ? 'Live TV' : it.kind === 'episode' && it.season ? `S${it.season} · E${it.episode}` : 'Relay',
      album: 'Relay',
      artwork: it.icon ? [{ src: it.icon, sizes: '512x512' }] : [],
    });
    // Live: no seeking; next/previous track = channel up/down (or the next source of a match).
    on('seekbackward', live ? null : (d) => seekBy(-(d.seekOffset || 10)));
    on('seekforward', live ? null : (d) => seekBy(d.seekOffset || 30));
    on('seekto', live ? null : (d) => { if (d.seekTime != null) seekTo(d.seekTime); });
    on('nexttrack', live ? () => (sourceEvent.value ? nextSource(1) : zap('next')) : it.kind === 'episode' ? () => playNextEpisode() : null);
    on('previoustrack', live ? () => (sourceEvent.value ? nextSource(-1) : zap('prev')) : null);
  });
  effect(() => {
    const s = status.value;
    if (current.value) ms.playbackState = s === 'paused' ? 'paused' : 'playing';
  });
  // Keep the lock screen's progress bar right (movies/episodes only).
  effect(() => {
    const d = duration.value, p = position.value;
    if (!current.value || isLiveNow(current.value) || !d || !('setPositionState' in ms)) return;
    try { ms.setPositionState({ duration: d, position: Math.min(Math.max(0, p), d), playbackRate: 1 }); } catch {}
  });
  on('play', () => { if (player?.paused()) togglePause(); });
  on('pause', () => { if (player && !player.paused()) togglePause(); });
  on('stop', () => stop());
}
