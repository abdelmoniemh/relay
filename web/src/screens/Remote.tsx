import { useEffect, useState } from 'preact/hooks';
import type { Item, RemoteCmd, SportEvent } from '@shared/protocol.ts';
import { api } from '../api.ts';
import { useAsync } from '../ui/hooks.ts';
import { myDeviceId } from '../api.ts';
import { devices, lease, send } from '../ws.ts';
import { current, takeover } from '../playback.ts';
import { Search } from './Search.tsx';
import { Logo, ProgBar, clean } from '../ui/common.tsx';
import { fmtTime, img } from '../env.ts';

let lastTarget: string | null = null;

/** Phone remote for the TV (or any other device): d-pad, transport, channel, volume, and "play this there". */
export function Remote() {
  const others = devices.value.filter((d) => d.id !== myDeviceId.value);
  const l = lease.value;
  const [target, setTarget] = useState<string | null>(lastTarget);
  const [tab, setTab] = useState<'pad' | 'sports' | 'browse'>('pad');
  const events = useAsync(() => (tab === 'sports' ? api.events({ sport: 'football' }) : Promise.resolve([] as SportEvent[])), [tab]);
  const [pad, setPad] = useState(false);
  useEffect(() => {
    // default: the device that's playing, else the TV, else first online
    if (target && others.some((d) => d.id === target)) return;
    const pick = (l && l.deviceId !== myDeviceId.value ? l.deviceId : null) ?? others.find((d) => d.online && d.kind === 'tv')?.id ?? others.find((d) => d.online)?.id ?? null;
    setTarget(pick);
  }, [others.map((d) => d.id + d.online).join(), l?.deviceId]);
  useEffect(() => { lastTarget = target; }, [target]);

  const t = others.find((d) => d.id === target);
  const cmd = (c: RemoteCmd, arg?: number | string) => {
    if (!target) return;
    navigator.vibrate?.(10);
    send({ t: 'remote', target, cmd: c, arg });
  };
  const sendItem = (it: Item) => target && send({ t: 'sendTo', target, item: it });
  const playingThere = l && l.deviceId === target ? l : null;

  return (
    <div class="remote">
      <div class="targets">
        {others.length === 0 && <div class="muted">No other devices paired yet.</div>}
        {others.map((d) => (
          <button key={d.id} class={`${d.id === target ? 'sel' : ''} ${d.online ? '' : 'off'}`} onClick={() => setTarget(d.id)}>
            {d.kind === 'tv' ? '📺' : d.kind === 'phone' ? '📱' : '🖥'} {d.name}
          </button>
        ))}
      </div>
      {playingThere ? (
        <div class="np panel">
          {playingThere.item.kind === 'live' ? <Logo src={playingThere.item.icon} name={playingThere.item.name} size={48} /> : <img class="thumb small" src={img(playingThere.item.icon, 92)} alt="" />}
          <div class="meta">
            <div class="name">{clean(playingThere.item.name)}</div>
            {playingThere.duration > 0 && <><ProgBar p={playingThere.position} d={playingThere.duration} /><div class="muted small">{fmtTime(playingThere.position)} / {fmtTime(playingThere.duration)}{playingThere.paused ? ' · paused' : ''}</div></>}
          </div>
          {!current.value && <button onClick={() => takeover()}>Play here</button>}
        </div>
      ) : t ? <div class="np panel muted">{t.online ? `Nothing playing on ${t.name}` : `${t.name} is offline — open Relay on it`}</div> : null}
      {current.value && target && <button class="wide" onClick={() => send({ t: 'sendTo', target })}>Move what I'm watching to {t?.name}</button>}

      <div class="seg">
        <button class={tab === 'pad' ? 'sel' : ''} onClick={() => setTab('pad')}>Remote</button>
        <button class={tab === 'sports' ? 'sel' : ''} onClick={() => setTab('sports')}>⚽ Football</button>
        <button class={tab === 'browse' ? 'sel' : ''} onClick={() => setTab('browse')}>Find & play</button>
      </div>

      {tab === 'pad' ? (
        <div class={`pad ${t?.online ? '' : 'disabled'}`}>
          <div class="dpad">
            <button class="u" onClick={() => cmd('up')}>▲</button>
            <button class="l" onClick={() => cmd('left')}>◀</button>
            <button class="ok" onClick={() => cmd('ok')}>OK</button>
            <button class="r" onClick={() => cmd('right')}>▶</button>
            <button class="d" onClick={() => cmd('down')}>▼</button>
          </div>
          <div class="grid3">
            <button onClick={() => cmd('back')}>↩ Back</button>
            <button onClick={() => cmd('playpause')}>⏯</button>
            <button onClick={() => cmd('stop')}>⏹ Stop</button>
            <button onClick={() => cmd('seek', -30)}>⟲ 30</button>
            <button onClick={() => cmd('seek', -10)}>⟲ 10</button>
            <button onClick={() => cmd('seek', 10)}>10 ⟳</button>
            <button onClick={() => cmd('chup')}>CH ▲</button>
            <button onClick={() => cmd('mute')}>🔇</button>
            <button onClick={() => cmd('volup')}>VOL ＋</button>
            <button onClick={() => cmd('chdown')}>CH ▼</button>
            <button onClick={() => setPad(!pad)}>123</button>
            <button onClick={() => cmd('voldown')}>VOL －</button>
          </div>
          {pad && <div class="grid3 digits">{[1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map((n) => <button key={n} onClick={() => cmd('digit', n)}>{n}</button>)}</div>}
        </div>
      ) : tab === 'sports' ? (
        <div class="rlist">
          {events.loading && <div class="spinner inline" />}
          {(events.data ?? []).filter((e) => !e.offline).slice(0, 40).map((e) => {
            const best = e.sources.find((x) => !x.dead);
            return (
              <button key={e.id} class="revent" disabled={!t?.online || !best} onClick={() => best && target && send({ t: 'sendTo', target, item: best.item, eventId: e.id })}>
                <span class="when">{e.status === 'live' ? <span class="live-pill">LIVE</span> : e.start ? new Date(e.start * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</span>
                <span class="meta"><b>{e.home} v {e.away}</b><span class="muted small">{e.competition} · {e.sourceCount} sources{best?.verified ? ` · ${best.label}` : ''}</span></span>
              </button>
            );
          })}
        </div>
      ) : (
        <Search onPick={async (it) => {
          if (it.id.startsWith('t')) {
            // A movie title: send its best version. (Series: pick the episode on the TV.)
            const d = await api.title(Number(it.id.slice(1))).catch(() => null);
            const v = d?.versions[0];
            if (d?.kind === 'movie' && v) sendItem({ ...v.item, duration: (d.runtime ?? 0) * 60 || null });
            return;
          }
          if (it.kind === 'series') return;
          sendItem(it);
        }} autoFocus={false} />
      )}
    </div>
  );
}
