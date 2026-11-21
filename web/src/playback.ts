// Playback orchestration: asks the server for the lease, plays when granted, gives the stream up instantly
// when another device takes over, and reports position so any device can resume.
import { signal, effect } from '@preact/signals';
import type { Item, RankedSource, ServerMsg } from '@shared/protocol.ts';
import { send, onServer, lease, deviceName } from './ws.ts';
import { api, myDeviceId, server, token, type Extras } from './api.ts';
import { dispatchKey, type Key } from './keys.ts';
import type { Player, PlayError } from './player/types.ts';
import { isTizen } from './env.ts';
import { t } from './i18n.ts';
import { displayName, parseTitleId, versionItem } from '@shared/domain.ts';
import { persisted } from './storage.ts';
import { loadReminders } from './notify.ts';

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

/** Markers and thumbnails of what's playing (movies/episodes, once the server has prepared them). */
export const extras = signal<Extras | null>(null);
let creditsShown: string | null = null;

export function skipAt(t: number): { kind: 'intro' | 'recap'; to: number } | null {
  const m = extras.value?.markers;
  if (m?.intro && t >= m.intro[0] && t < m.intro[1] - 1) return { kind: 'intro', to: m.intro[1] };
  if (m?.recap && t >= m.recap[0] && t < m.recap[1] - 1) return { kind: 'recap', to: m.recap[1] };
  return null;
}
export function skipIntro() { const s = skipAt(position.value); if (s) seekTo(s.to); }

/** The seek-bar preview for time `t`: a tile of the sprite (CSS background), or null. */
export function thumbAt(t: number): { url: string; x: number; y: number; w: number; h: number } | null {
  const x = extras.value?.thumbs, it = current.value;
  if (!x || !it) return null;
  const i = Math.max(0, Math.min(x.cols * x.rows - 1, Math.floor(t / x.interval)));
  return { url: `${server.value}/api/thumbs/${it.id}.jpg?token=${encodeURIComponent(token.value ?? '')}`, x: (i % x.cols) * x.w, y: Math.floor(i / x.cols) * x.h, w: x.w, h: x.h };
}

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
export const audioLang = persisted<string | null>('alang', (v) => v);
export const subLang = persisted<string>('slang', (v) => v ?? 'off');
export function setAudioLang(l: string | null) { audioLang.value = l; }
export function setSubLang(l: string) { subLang.value = l; }

/**
 * Data saver: 'auto' = on when Relay is reached through Tailscale (away from home), 'on' / 'off' always.
 * Only streams that pass through the server can be made smaller, so with it on everything does.
 */
export type DataSaver = 'auto' | 'on' | 'off';
export const dataSaver = persisted<DataSaver>('datasaver', (v) => (v === 'on' || v === 'off' ? v : 'auto'));
export function setDataSaver(v: DataSaver) { dataSaver.value = v; }
/** Reached through Tailscale (100.64.0.0/10 or a *.ts.net name), i.e. probably not on the home network. */
export const isAway = () => typeof location !== 'undefined' && (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(location.hostname) || location.hostname.endsWith('.ts.net'));
export const lowDataNow = () => !isTizen && (dataSaver.value === 'on' || (dataSaver.value === 'auto' && isAway()));

/** Sports: chase the live edge (lowest delay) instead of playing the provider's backlog smoothly. */
export const lowLatencySports = persisted<boolean>('lowLatency', (v) => v !== '0', (v) => (v ? '1' : '0'));
export function setLowLatency(v: boolean) { lowLatencySports.value = v; }

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


export function attachPlayer(p: Player) {
  player = p;
  if (earlyGrant) { const g = earlyGrant; earlyGrant = null; queueMicrotask(() => onGranted(g, p)); }
  p.onLangs?.((kind, lang) => (kind === 'audio' ? setAudioLang(lang) : setSubLang(lang)));
  p.on((e, detail, raw) => {
    if (e === 'time') {
      position.value = p.position(); duration.value = p.duration();
      // Credits started (chapter marker): offer the next episode now rather than at the very end.
      const cr = extras.value?.markers.credits, cur = current.value;
      if (cr && cur?.kind === 'episode' && creditsShown !== cur.id && position.value >= cr && !nextUp.value) { creditsShown = cur.id; scheduleNextEpisode(); }
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
        setTimeout(() => { if (current.value === item) p.load(lastUrls, loadOpts(item, p.position() || lastStart)).catch(loadFailed); }, 1200);
        return;
      }
      if (isLiveNow(current.value) && nextSource(1, true)) return;
      status.value = 'error'; errorMsg.value = friendlyError(detail as PlayError | undefined, raw);
      api.clientLog(`error shown: ${detail}${raw ? ` (${raw})` : ''} (${current.value?.id})`);
    }
  });
}

/** Live right now (not a programme from a channel's archive). */
export const isLiveNow = (item: Item | null | undefined) => item?.kind === 'live' && !item.catchup;

/** A failure, in words. 'server': the server already explained it (e.g. outside the archive). */
export function friendlyError(why?: PlayError, raw?: string): string {
  const live = isLiveNow(current.value);
  switch (why) {
    case 'unreachable': return t("Can't reach the Relay server. Check this device is on the same network (or Tailscale) and try again.");
    case 'stalled': return live ? t('This channel isn\'t sending anything right now. Try another source or channel.') : t('The stream stopped. Try again.');
    case 'conversion': return live ? t('The provider didn\'t send this channel. It may be offline or busy: try another source.') : t('The provider didn\'t send this title. It may be busy: try again in a moment.');
    case 'unpaired': return t('This device is no longer paired. Pair it again in Settings.');
    case 'network': return live ? t('Lost the connection to this channel. Try again or pick another source.') : t('Lost the connection to the stream. Try again.');
    case 'format': return t('This device can\'t play this stream\'s format. Try another source.');
    case 'server': return raw || t('Playback failed. Try again.');
    default: return t('Playback failed. Try again.');
  }
}

function loadOpts(item: Item, startAt: number, hevc = lastHevc) {
  const cu = item.kind === 'live' ? item.catchup : null;
  const low = lowDataNow();
  const src = sources.value.find((s) => s.item.id === item.id);
  return {
    // 4K by measurement, not just by name (the TV needs SET_MODE_4K for a 4K stream)
    startAt, live: isLiveNow(item), uhd: /4K|UHD|2160/i.test(item.name) || (src?.height ?? 0) >= 2000, id: item.id,
    stream: { base: server.value, id: item.id, query: { token: token.value ?? '', ext: item.ext, cs: cu?.start, ce: cu?.stop, q: low ? 'low' as const : undefined } },
    catchup: !!cu, hevc: hevc || !!src?.hevc,
    lowLatency: isLiveNow(item) && !!sourceEvent.value && lowLatencySports.value,
    duration: cu ? cu.stop - cu.start : item.duration ?? undefined,
    // Catch-up in a browser: always the server's conversion (raw MPEG-TS, and it seeks by restarting)
    tx: cu ? ((hevc || src?.hevc) ? 'full' as const : 'audio' as const) : lastTx,
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

/** The player couldn't even start (an engine chunk failed to load, the TV player threw): say so, don't spin. */
function loadFailed(e: unknown) {
  if (!current.value) return;
  status.value = 'error'; errorMsg.value = friendlyError('other');
  api.clientLog(`load failed: ${(e as Error)?.message ?? e} (${current.value.id})`);
}

/** Lock screen / headphones play: also brings back a stream released while the app was in the background. */
export function resume() {
  if (suspended) { const s = suspended; suspended = null; play(s.item, { startAt: s.position, mode: mode.value === 'off' ? 'full' : mode.value }); return; }
  if (player?.paused()) togglePause();
}

function reset() {
  current.value = null; mode.value = 'off'; status.value = 'idle'; pending = null; errorMsg.value = null; earlyGrant = null; suspended = null;
  sources.value = []; sourceEvent.value = null; episodeQueue.value = []; cancelNextUp();
}

/** A film by its title: the version that suits this device, from where it was left. */
export async function playTitle(tid: number) {
  try {
    const v = versionItem(await api.title(tid));
    if (v) play(v, { mode: 'full' });
  } catch { showToast(t('Couldn\'t open that title')); }
}

/** Play a sports event: best working source, with every other source one key press away. */
export async function playEvent(eventId: string, opts: { mode?: Mode; sourceId?: string } = {}) {
  const ev = await api.event(eventId);
  const list = ev.sources;
  const pick = (opts.sourceId && list.find((s) => s.item.id === opts.sourceId)) || list.find((s) => !s.dead) || list[0];
  if (!pick) { showToast('No sources for this event right now'); return; }
  play(pick.item, { mode: opts.mode ?? 'full', sources: list, eventId });
}

/** Audio / subtitle tracks of what's playing (iPhone movies via the server; null when the player can't tell). */
export const mediaTracks = () => player?.tracks?.() ?? null;
export const selectAudio = (i: number) => player?.setAudio?.(i);
export const selectSub = (i: number) => player?.setSub?.(i);

export const togglePause = () => { if (!player || !current.value) return; player.paused() ? player.play() : player.pause(); };
export const seekBy = (d: number) => { if (player && current.value && !isLiveNow(current.value)) { const to = player.position() + d; player.seek(to); position.value = to; } };
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

/** The server says go: this device has the stream. */
function onGranted(m: Extract<ServerMsg, { t: 'granted' }>, player: Player) {
  const item = m.item;
  // stopped meanwhile (play, then stop before the server answered): hand the stream straight back
  if (!pending) { send({ t: 'stopped', position: 0, duration: 0 }); return; }
  if (pending.item.id !== item.id) return; // a newer request is in flight
  current.value = item;
  if (pending) mode.value = pending.mode;
  pending = null;
  status.value = 'loading';
  lastUrls = m.urls; lastStart = m.startAt; lastHevc = m.tx === 'full'; lastTx = m.tx; lastInterlaced = !!m.interlaced; retried = false;
  extras.value = null; creditsShown = null;
  if (item.kind === 'movie' || item.kind === 'episode') {
    api.extras(item.id).then((x) => { if (current.value?.id === item.id) extras.value = x; }).catch(() => {});
    const next = item.kind === 'episode' ? nextEpisode() : null;
    if (next) api.prefetch([{ id: next.id, ext: next.ext }]).catch(() => {}); // its markers/thumbnails while idle
  }
  position.value = m.startAt;
  if (m.urls[0]) preconnect(m.urls[0]);
  player.load(m.urls, loadOpts(item, m.startAt, m.tx === 'full')).catch(loadFailed);
}
let earlyGrant: Extract<ServerMsg, { t: 'granted' }> | null = null;

onServer((m: ServerMsg) => {
  switch (m.t) {
    case 'granted':
      // granted before the player exists (first play right after start-up): play it when it attaches
      if (!player) earlyGrant = m; else onGranted(m, player);
      return;
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
      // Sent from another device: choose what suits *this* one (versions and sources are ranked per device).
      if (m.eventId) playEvent(m.eventId).catch(() => play(m.item, { mode: 'full' }));
      else if (parseTitleId(m.item.id) != null) playTitle(parseTitleId(m.item.id)!);
      else play(m.item, { startAt: m.startAt, mode: 'full' });
      showToast(t('Sent from {name}', { name: deviceName(m.from) }));
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
      showToast(`${t('Starting now')}: ${r.title} · ${displayName(r.item.name)}`, 8000);
      loadReminders(); // it fired: lists stop showing "Reminder set"
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
