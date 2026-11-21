import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { SportEvent } from '@shared/protocol.ts';
import { api } from '../api.ts';
import { playEvent, play, current, sourceEvent } from '../playback.ts';
import { navFocused } from '../router.ts';
import { useKeys, useDebounced } from '../ui/hooks.ts';
import { VList } from '../ui/VList.tsx';
import { Logo } from '../ui/common.tsx';
import { displayName } from '@shared/domain.ts';
import { isMobile, startsAt } from '../env.ts';
import { Btn, IconBtn, LivePill, QualityChip } from '../ui/kit.tsx';
import { Icon } from '../ui/Icon.tsx';
import { t, tn } from '../i18n.ts';
import { RemindSheet } from '../features/programmes.tsx';
import { reminders, loadReminders, unremind } from '../notify.ts';

const LABEL: Record<string, string> = {
  football: 'Football', all: 'All sports', basketball: 'Basketball', 'american-football': 'American football', hockey: 'Hockey',
  baseball: 'Baseball', tennis: 'Tennis', darts: 'Darts', cricket: 'Cricket', rugby: 'Rugby', fighting: 'Fighting',
  motorsport: 'Motorsport', golf: 'Golf', snooker: 'Snooker', other: 'Other',
};
const sportName = (k: string) => t(LABEL[k] ?? k);

let lastSport = 'football';

const when = (e: SportEvent) => (e.status === 'live' ? null : e.start ? startsAt(e.start) : '—');

export function Sports() {
  const [remindFor, setRemindFor] = useState<SportEvent | null>(null);
  useEffect(() => { loadReminders(); }, []);
  const [all, setAll] = useState<SportEvent[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sport, setSport] = useState(lastSport);
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 200);
  const [zone, setZone] = useState<'sports' | 'events' | 'detail'>('events');
  const [si, setSi] = useState(0);
  const [ei, setEi] = useState(0);
  const [di, setDi] = useState(0);
  const [detail, setDetail] = useState<SportEvent | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const load = () => api.events().then((e) => { setAll(e); setErr(null); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, []);
  useEffect(() => { lastSport = sport; }, [sport]);

  const sportsList = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of all ?? []) counts.set(e.sport, (counts.get(e.sport) ?? 0) + 1);
    const order: string[] = ['football', 'all', ...[...counts.keys()].filter((k) => k !== 'football' && k !== 'other').sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0)), 'other'];
    return order.filter((k) => k === 'all' || counts.has(k)).map((k) => ({ key: k, count: k === 'all' ? all?.length ?? 0 : counts.get(k) ?? 0 }));
  }, [all]);
  useEffect(() => { const i = sportsList.findIndex((s) => s.key === sport); if (i >= 0) setSi(i); }, [sportsList]);

  const events = useMemo(() => {
    let l = (all ?? []).filter((e) => sport === 'all' || e.sport === sport);
    if (dq) { const t = dq.toLowerCase(); l = l.filter((e) => `${e.title} ${e.competition ?? ''}`.toLowerCase().includes(t)); }
    return l;
  }, [all, sport, dq]);
  const focused = events[Math.min(ei, events.length - 1)];

  // Detail: load full source list for the focused event, and get its sources checked while nobody's watching.
  const focusedId = focused?.id;
  useEffect(() => {
    if (!focusedId) { setDetail(null); return; }
    let live = true, n = 0;
    const get = () => api.event(focusedId).then((e) => { if (live) setDetail(e); }).catch(() => {});
    get();
    const iv = setInterval(() => { if (++n < 40) get(); }, 4000);
    return () => { live = false; clearInterval(iv); };
  }, [focusedId]);
  const requestChecks = () => { if (detail) api.probe(detail.sources.slice(0, 20).map((s) => s.item.id)).catch(() => {}); };
  useEffect(() => { if (zone === 'detail') requestChecks(); }, [zone, detail?.id]);

  const sources = detail && detail.id === focusedId ? detail.sources : focused?.sources ?? [];

  useKeys((k) => {
    if (navFocused.value || remindFor) return false;
    if (zone === 'sports') {
      if (k === 'left') { const i = Math.max(0, si - 1); setSi(i); setSport(sportsList[i].key); setEi(0); return true; }
      if (k === 'right') { const i = Math.min(sportsList.length - 1, si + 1); setSi(i); setSport(sportsList[i].key); setEi(0); return true; }
      if (k === 'down' || k === 'ok') { setZone('events'); return true; }
      return false; // up -> top bar
    }
    if (zone === 'events') {
      if (k === 'up') { if (ei === 0) setZone('sports'); else setEi(ei - 1); return true; }
      if (k === 'down') { input.current?.blur(); setEi(Math.min(events.length - 1, ei + 1)); return true; }
      if (k === 'left') return true;
      if (k === 'right') { if (focused) { setZone('detail'); setDi(0); } return true; }
      if (k === 'ok' || k === 'play' || k === 'playpause') { if (focused) playEvent(focused.id); return true; }
      return false;
    }
    if (k === 'up') { setDi(Math.max(0, di - 1)); return true; }
    if (k === 'down') { setDi(Math.min(sources.length - 1, di + 1)); return true; }
    if (k === 'left' || k === 'back') { setZone('events'); return true; }
    if (k === 'ok') { const s = sources[di]; if (s && focused) play(s.item, { sources, eventId: focused.id, mode: 'full' }); return true; }
    return false;
  });

  const watching = current.value && sourceEvent.value;
  const kb = !navFocused.value;

  return (
    <div class={`sports page z-${zone}`}>
      <div class={`col events ${zone === 'events' && kb ? 'active' : ''}`}>
        <div class="sports-head">
          <h1 class="screen-title">{t('Sports')}</h1>
          <div class="search-field">
            <Icon n="search" />
            <input ref={input} id="sports-search" type="search" placeholder={t('Find a team or competition')} value={q}
              onInput={(e) => { setQ((e.target as HTMLInputElement).value); setEi(0); }} />
          </div>
          <div class="chips">
            {sportsList.map((x, i) => (
              <button key={x.key} class={`chip ${x.key === sport ? 'on' : ''} ${kb && zone === 'sports' && i === si ? 'focus' : ''}`}
                onClick={() => { setSi(i); setSport(x.key); setEi(0); }}>
                {sportName(x.key)} <small>{x.count}</small>
              </button>
            ))}
          </div>
        </div>
        {err && <div class="empty">{err}</div>}
        {all && !events.length && <div class="empty">{dq ? t('Nothing matching “{q}”', { q: dq }) : t('No events in the next 36 hours.')}</div>}
        {!all && !err && <div class="list-skel" />}
        <VList count={events.length} rowH={isMobile ? 76 : 84} focus={kb && zone === 'events' ? ei : -1} render={(i, f) => {
          const e = events[i];
          const best = e.sources.find((s) => !s.dead);
          const w = when(e);
          return (
            <div class={`row event ${f ? 'focus' : ''} ${e.offline ? 'offline' : ''} ${e.id === focused?.id && zone === 'detail' ? 'sel' : ''}`}
              onClick={() => { setEi(i); if (isMobile) setZone('detail'); else playEvent(e.id); }}
              onDblClick={() => playEvent(e.id)}>
              <div class="when">{w == null ? <LivePill /> : <span class="tnum">{w}</span>}</div>
              <div class="meta">
                <div class="name">{e.home} <span class="vs">{t('v')}</span> {e.away}</div>
                <div class="sub ellipsis">{e.competition ?? sportName(e.sport)}</div>
              </div>
              <div class="q">
                {e.offline ? <span class="sub">{t('No signal yet')}</span> : best ? <QualityChip label={best.label} verified={best.verified} /> : null}
                <div class="sub">{tn(e.sourceCount, '{n} source', '{n} sources')}</div>
              </div>
            </div>
          );
        }} />
      </div>
      <div class={`col detail-col ${zone === 'detail' ? 'active' : ''}`}>
        {focused ? (
          <>
            <div class="ev-title">
              <IconBtn n="back" label={t('Back')} class="phone-only" onClick={() => setZone('events')} />
              <div>
                <h2>{focused.home} {t('v')} {focused.away}</h2>
                <div class="sub">{[focused.competition, focused.status === 'live' ? t('Live now') : when(focused)].filter(Boolean).join(' · ')}</div>
              </div>
            </div>
            <div class="ev-actions">
              <Btn a={{ label: t('Watch best source'), icon: 'play', primary: true, act: () => playEvent(focused.id) }} />
              <Btn a={{ label: watching ? t('Checks pause while watching') : t('Check quality now'), icon: 'refresh', act: () => { if (!watching) requestChecks(); } }} />
              {focused.status !== 'live' && focused.start && sources.length > 0 && (() => {
                const r = reminders.value.find((x) => x.eventId === focused.id);
                return r ? <Btn a={{ label: t('Reminder set'), icon: 'check', act: () => unremind(r.id) }} />
                  : <Btn a={{ label: t('Remind me'), icon: 'plus', act: () => setRemindFor(focused) }} />;
              })()}
            </div>
            <h3 class="list-head">{t('Sources')}</h3>
            <VList count={sources.length} rowH={60} focus={kb && zone === 'detail' ? di : -1} render={(i, f) => {
              const s = sources[i];
              return (
                <div class={`row source ${f ? 'focus' : ''} ${s.dead ? 'offline' : ''}`} onClick={() => play(s.item, { sources, eventId: focused.id, mode: 'full' })}>
                  <span class="num tnum">{i + 1}</span>
                  <Logo src={s.item.icon} name={s.item.name} size={36} />
                  <div class="meta"><div class="name">{displayName(s.item.name)}</div></div>
                  <QualityChip label={s.label} verified={s.verified} dead={s.dead} />
                </div>
              );
            }} />
            <p class="help">{t('Quality is measured on the real stream while nothing is playing. During playback, use left and right to switch sources.')}</p>
          </>
        ) : <div class="empty">{t('Select an event')}</div>}
      </div>
      {remindFor && (() => {
        const src = remindFor.sources.find((x) => !x.dead) ?? remindFor.sources[0];
        return src ? <RemindSheet channel={src.item} prog={{ start: remindFor.start!, stop: remindFor.stop, title: `${remindFor.home} ${t('v')} ${remindFor.away}` }}
          eventId={remindFor.id} onClose={() => setRemindFor(null)} /> : null;
      })()}
    </div>
  );
}
