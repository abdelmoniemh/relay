// Lock screen / Control Center / headphone buttons (Media Session): without it iOS shows nothing on the lock screen
// and the AirPods/headphone buttons do nothing.
import { effect } from '@preact/signals';
import { displayName } from '@shared/domain.ts';
import { isTizen } from './env.ts';
import { current, status, position, duration, seekBy, seekTo, nextSource, zap, sourceEvent, playNextEpisode, togglePause, stop, isLiveNow, resume } from './playback.ts';

const ms = typeof navigator !== 'undefined' && 'mediaSession' in navigator && !isTizen ? navigator.mediaSession : null;
if (ms) {
  const on = (a: MediaSessionAction, h: MediaSessionActionHandler | null) => { try { ms.setActionHandler(a, h); } catch {} };
  let shownId: string | null = null;
  effect(() => {
    const it = current.value;
    if (!it) { if (shownId) { ms.metadata = null; ms.playbackState = 'none'; shownId = null; } return; }
    const key = `${it.id}@${it.catchup?.start ?? ''}`; // start over / catch-up keep the channel's id
    if (key === shownId) return;
    shownId = key;
    const live = isLiveNow(it);
    ms.metadata = new MediaMetadata({
      title: it.catchup?.title ? `${it.catchup.title}` : displayName(it.name),
      artist: it.catchup ? `${displayName(it.name)} · catch-up` : live ? 'Live TV' : it.kind === 'episode' && it.season ? `S${it.season} · E${it.episode}` : 'Relay',
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
    if (current.value) ms.playbackState = s === 'paused' || s === 'error' ? 'paused' : s === 'idle' ? 'none' : 'playing';
  });
  // Keep the lock screen's progress bar right (movies/episodes only).
  effect(() => {
    const d = duration.value, p = position.value;
    if (!current.value || isLiveNow(current.value) || !d || !('setPositionState' in ms)) return;
    try { ms.setPositionState({ duration: d, position: Math.min(Math.max(0, p), d), playbackRate: 1 }); } catch {}
  });
  on('play', () => resume());
  on('pause', () => { if (status.value === 'playing' || status.value === 'buffering') togglePause(); });
  on('stop', () => stop());
}
