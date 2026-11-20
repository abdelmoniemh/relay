import { useEffect, useState } from 'preact/hooks';
import type { Item, RemoteCmd, SportEvent } from '@shared/protocol.ts';
import { api } from '../api.ts';
import { useAsync } from '../ui/hooks.ts';
import { back, stack } from '../router.ts';
import { myDeviceId } from '../api.ts';
import { devices, lease, send } from '../ws.ts';
import { current, takeover } from '../playback.ts';
import { Search } from './Search.tsx';
import { Logo, ProgBar } from '../ui/common.tsx';
import { displayName } from '@shared/domain.ts';
import { fmtTime, img } from '../env.ts';
import { Btn, IconBtn, LivePill, Segmented } from '../ui/kit.tsx';
import { Icon, type IconName, deviceIcon } from '../ui/Icon.tsx';
import { t } from '../i18n.ts';
import { versionItem } from '../catalogue.ts';
import { parseTitleId } from '@shared/domain.ts';

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
    if (target && others.some((d) => d.id === target)) return;
    const pick = (l && l.deviceId !== myDeviceId.value ? l.deviceId : null) ?? others.find((d) => d.online && d.kind === 'tv')?.id ?? others.find((d) => d.online)?.id ?? null;
    setTarget(pick);
  }, [others.map((d) => d.id + d.online).join(), l?.deviceId]);
  useEffect(() => { lastTarget = target; }, [target]);

  const t2 = others.find((d) => d.id === target);
  const cmd = (c: RemoteCmd, arg?: number | string) => {
    if (!target) return;
    navigator.vibrate?.(10);
    send({ t: 'remote', target, cmd: c, arg });
  };
  const sendItem = (it: Item) => target && send({ t: 'sendTo', target, item: it });
  const playingThere = l && l.deviceId === target ? l : null;

  const key = (n: IconName, c: RemoteCmd, label: string, arg?: number) => (
    <button class="rkey" aria-label={label} title={label} onClick={() => cmd(c, arg)}><Icon n={n} /></button>
  );

  return (
    <div class="remote page">
      <h1 class="screen-title">{stack.value.length > 1 && <IconBtn n="back" label={t('Back')} onClick={() => back()} />}{t('Remote')}</h1>
      {others.length === 0 ? <div class="empty">{t('No other devices paired yet. Pair one with the code in Settings.')}</div> : (
        <div class="targets" role="radiogroup" aria-label={t('Control which device')}>
          {others.map((d) => (
            <button key={d.id} role="radio" aria-checked={d.id === target} class={`target ${d.id === target ? 'sel' : ''} ${d.online ? '' : 'off'}`} onClick={() => setTarget(d.id)}>
              <Icon n={deviceIcon(d.kind)} /><span>{d.name}</span>{!d.online && <small>{t('Offline')}</small>}
            </button>
          ))}
        </div>
      )}
      {playingThere ? (
        <div class="np">
          <div class="np-art">{playingThere.item.kind === 'live' ? <Logo src={playingThere.item.icon} name={playingThere.item.name} size={48} /> : <img src={img(playingThere.item.icon, 92)} alt="" />}</div>
          <div class="np-txt">
            <b>{displayName(playingThere.item.name)}</b>
            {playingThere.duration > 0 ? <>
              <ProgBar p={playingThere.position} d={playingThere.duration} />
              <span class="tnum">{fmtTime(playingThere.position)} / {fmtTime(playingThere.duration)}{playingThere.paused ? ` · ${t('Paused')}` : ''}</span>
            </> : <span>{t('Live')}</span>}
          </div>
          {!current.value && <Btn a={{ label: t('Watch here'), primary: true, act: () => takeover() }} />}
        </div>
      ) : t2 ? <div class="np empty-np">{t2.online ? t('Nothing playing on {name}', { name: t2.name }) : t('{name} is offline. Open Relay on it.', { name: t2.name })}</div> : null}
      {current.value && target && <Btn a={{ label: t('Move what I’m watching to {name}', { name: t2?.name ?? '' }), icon: 'send', act: () => send({ t: 'sendTo', target }) }} />}

      <Segmented value={tab} onChange={setTab} options={[{ v: 'pad', label: t('Remote') }, { v: 'sports', label: t('Football') }, { v: 'browse', label: t('Find & play') }]} />

      {tab === 'pad' ? (
        <div class={`pad ${t2?.online ? '' : 'disabled'}`}>
          <div class="dpad">
            <button class="u" aria-label={t('Up')} onClick={() => cmd('up')}><Icon n="up" /></button>
            <button class="l" aria-label={t('Left')} onClick={() => cmd('left')}><Icon n="back" /></button>
            <button class="ok" onClick={() => cmd('ok')}>OK</button>
            <button class="r" aria-label={t('Right')} onClick={() => cmd('right')}><Icon n="chevron" /></button>
            <button class="d" aria-label={t('Down')} onClick={() => cmd('down')}><Icon n="down" /></button>
          </div>
          <div class="rgrid">
            <button class="rkey wide" onClick={() => cmd('back')}><Icon n="back" />{t('Back')}</button>
            {key(playingThere?.paused ? 'play' : 'pause', 'playpause', t('Play/pause'))}
            {key('stop', 'stop', t('Stop'))}
            {key('back10', 'seek', t('Back 10 seconds'), -10)}
            {key('rw', 'seek', t('Back 30 seconds'), -30)}
            {key('fwd10', 'seek', t('Forward 10 seconds'), 10)}
            <button class="rkey" onClick={() => cmd('chup')}>CH<Icon n="up" /></button>
            {key('mute', 'mute', t('Mute'))}
            {key('volup', 'volup', t('Volume up'))}
            <button class="rkey" onClick={() => cmd('chdown')}>CH<Icon n="down" /></button>
            <button class={`rkey ${pad ? 'sel' : ''}`} onClick={() => setPad(!pad)}>123</button>
            {key('voldown', 'voldown', t('Volume down'))}
          </div>
          {pad && <div class="rgrid digits">{[1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map((n) => <button key={n} class="rkey" onClick={() => cmd('digit', n)}>{n}</button>)}</div>}
        </div>
      ) : tab === 'sports' ? (
        <div class="list-group">
          {events.loading && <div class="list-skel" />}
          {(events.data ?? []).filter((e) => !e.offline).slice(0, 40).map((e) => {
            const best = e.sources.find((x) => !x.dead);
            return (
              <button key={e.id} class="list-row" disabled={!t2?.online || !best} onClick={() => best && target && send({ t: 'sendTo', target, item: best.item, eventId: e.id })}>
                <span class="ev-when">{e.status === 'live' ? <LivePill /> : <span class="tnum">{e.start ? new Date(e.start * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</span>}</span>
                <span class="lr-main"><b>{e.home} {t('v')} {e.away}</b><span class="lr-sub">{e.competition}</span></span>
                <Icon n="send" class="lr-chev" />
              </button>
            );
          })}
        </div>
      ) : (
        <Search onPick={async (it) => {
          const tid = parseTitleId(it.id);
          if (tid != null) {
            // A movie title: send its best version. (Series: pick the episode on the TV.)
            const d = await api.title(tid).catch(() => null);
            const v = d && versionItem(d);
            if (v) sendItem(v);
            return;
          }
          if (it.kind === 'series') return;
          sendItem(it);
        }} autoFocus={false} />
      )}
    </div>
  );
}
