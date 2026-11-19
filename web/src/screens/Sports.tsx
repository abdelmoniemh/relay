import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { SportEvent } from '@shared/protocol.ts';
import { api } from '../api.ts';
import { playEvent, play, current, sourceEvent } from '../playback.ts';
import { railFocused } from '../router.ts';
import { useKeys, useDebounced } from '../ui/hooks.ts';
import { VList } from '../ui/VList.tsx';
import { Logo, clean } from '../ui/common.tsx';
import { isMobile, isTizen } from '../env.ts';

const LABEL: Record<string, string> = {
  football: '⚽ Football', all: 'All sports', basketball: '🏀 Basketball', 'american-football': '🏈 American football', hockey: '🏒 Hockey',
  baseball: '⚾ Baseball', tennis: '🎾 Tennis', darts: '🎯 Darts', cricket: '🏏 Cricket', rugby: '🏉 Rugby', fighting: '🥊 Fighting',
  motorsport: '🏎 Motorsport', golf: '⛳ Golf', snooker: '🎱 Snooker', other: 'Other',
};

let lastSport = 'football';

const when = (e: SportEvent) => {
  if (e.status === 'live') return null;
  if (!e.start) return '—';
  const d = new Date(e.start * 1000), now = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return time;
  const tmr = new Date(now.getTime() + 86400000);
  if (d.toDateString() === tmr.toDateString()) return `Tmrw ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
};

export function Sports() {
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
    if (railFocused.value) return false;
    if (zone === 'sports') {
      if (k === 'up') { const i = Math.max(0, si - 1); setSi(i); setSport(sportsList[i].key); setEi(0); return true; }
      if (k === 'down') { const i = Math.min(sportsList.length - 1, si + 1); setSi(i); setSport(sportsList[i].key); setEi(0); return true; }
      if (k === 'right' || k === 'ok') { setZone('events'); return true; }
      return false;
    }
    if (zone === 'events') {
      if (k === 'up') { if (ei === 0) { input.current?.focus(); } else setEi(ei - 1); return true; }
      if (k === 'down') { input.current?.blur(); setEi(Math.min(events.length - 1, ei + 1)); return true; }
      if (k === 'left') { setZone('sports'); return true; }
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

  return (
    <div class={`sports z-${zone}`}>
      <div class={`col cats ${zone === 'sports' && !railFocused.value ? 'active' : ''}`}>
        <h2>Sports</h2>
        {sportsList.map((s, i) => (
          <div key={s.key} class={`row cat ${zone === 'sports' && i === si ? 'focus' : ''} ${s.key === sport ? 'sel' : ''}`}
            onClick={() => { setSi(i); setSport(s.key); setEi(0); setZone('events'); }}>
            <span class="name">{LABEL[s.key] ?? s.key}</span><span class="count">{s.count}</span>
          </div>
        ))}
      </div>
      <div class={`col events ${zone === 'events' && !railFocused.value ? 'active' : ''}`}>
        <div class="ev-head">
          <button class="phone-back" onClick={() => setZone('sports')}>‹</button>
          <input ref={input} type="search" placeholder={`Find a team or competition${isTizen ? '' : '…'}`} value={q}
            onInput={(e) => { setQ((e.target as HTMLInputElement).value); setEi(0); }} />
        </div>
        {err && <div class="empty">{err}</div>}
        {all && !events.length && <div class="empty">{dq ? `Nothing matching “${dq}”` : 'No events found for the next 36 hours.'}</div>}
        {!all && !err && <div class="spinner inline" />}
        <VList count={events.length} rowH={isMobile ? 78 : 84} focus={zone === 'events' ? ei : -1} render={(i, f) => {
          const e = events[i];
          const best = e.sources.find((s) => !s.dead);
          const t = when(e);
          return (
            <div class={`row event ${f ? 'focus' : ''} ${e.offline ? 'offline' : ''}`} onClick={() => { setEi(i); if (isMobile) setZone('detail'); else playEvent(e.id); }}
              onDblClick={() => playEvent(e.id)}>
              <div class="when">{t == null ? <span class="live-pill">LIVE</span> : t}</div>
              <div class="meta">
                <div class="name">{e.home} <span class="muted">v</span> {e.away}</div>
                <div class="muted small ellipsis">{e.competition ?? LABEL[e.sport]}</div>
              </div>
              <div class="q">
                {e.offline ? <span class="muted small">no signal yet</span>
                  : best ? <span class={`small ${best.verified ? 'ok' : 'muted'}`}>{best.label.replace(' · unverified', '')}{best.verified ? ' ✓' : ''}</span> : null}
                <div class="muted small">{e.sourceCount} source{e.sourceCount === 1 ? '' : 's'}</div>
              </div>
            </div>
          );
        }} />
      </div>
      <div class={`col detail-col ${zone === 'detail' ? 'active' : ''}`}>
        {focused ? (
          <>
            <div class="ev-title">
              <button class="phone-back" onClick={() => setZone('events')}>‹</button>
              <div>
                <h2>{focused.home} v {focused.away}</h2>
                <div class="muted small">{[focused.competition, focused.status === 'live' ? 'Live now' : when(focused)].filter(Boolean).join(' · ')}</div>
              </div>
            </div>
            <div class="ev-actions">
              <button class="primary" onClick={() => playEvent(focused.id)}>▶ Watch best source</button>
              <button onClick={requestChecks} disabled={!!watching}>{watching ? 'Checks pause while watching' : 'Check quality now'}</button>
            </div>
            <VList count={sources.length} rowH={60} focus={zone === 'detail' ? di : -1} render={(i, f) => {
              const s = sources[i];
              return (
                <div class={`row source ${f ? 'focus' : ''} ${s.dead ? 'offline' : ''}`} onClick={() => play(s.item, { sources, eventId: focused.id, mode: 'full' })}>
                  <span class="num">{i + 1}</span>
                  <Logo src={s.item.icon} name={s.item.name} size={36} />
                  <div class="meta"><div class="name">{clean(s.item.name)}</div></div>
                  <span class={`small ${s.verified ? (s.dead ? 'bad' : 'ok') : 'muted'}`}>{s.label}{s.verified && !s.dead ? ' ✓' : ''}</span>
                </div>
              );
            }} />
            <p class="muted small help">Quality is measured on the real stream while nothing is playing (✓ = verified). During playback use ◀ ▶ to switch sources.</p>
          </>
        ) : <div class="empty">Select an event</div>}
      </div>
    </div>
  );
}
