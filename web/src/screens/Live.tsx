import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Category, Item } from '@shared/protocol.ts';
import { api, favorites, toggleFavorite } from '../api.ts';
import { current, mode, play, setMode, status, errorMsg } from '../playback.ts';
import { railFocused } from '../router.ts';
import { useAsync, useDebounced, useKeys, usePaged, nowNext, epgVersion } from '../ui/hooks.ts';
import { VList } from '../ui/VList.tsx';
import { Logo, NowLine, Star, clean } from '../ui/common.tsx';
import { clock, isMobile } from '../env.ts';
import { previewBox } from '../player/host.tsx';

const FAV: Category = { id: '__fav', name: '★ Favorites', count: 0 };
const RECENT: Category = { id: '__recent', name: '◷ Recent', count: 0 };
let lastCat = 0; // remember position across visits
let lastChan = 0;

export function Live() {
  const cats = useAsync(() => api.categories('live'), []);
  const recent = useAsync(() => api.recent(), []);
  const allCats = useMemo(() => [FAV, RECENT, ...(cats.data ?? [])], [cats.data]);
  const [zone, setZone] = useState<'cats' | 'chans'>('chans');
  const [ci, setCi] = useState(lastCat);
  const [fi, setFi] = useState(lastChan);
  const cat = allCats[useDebounced(ci, 180)] ?? FAV;
  epgVersion.value; // subscribe: re-render when EPG arrives

  const favList = useMemo(() => [...favorites.value.values()].filter((i) => i.kind === 'live'), [favorites.value]);
  const virtual = cat.id === '__fav' ? favList : cat.id === '__recent' ? recent.data ?? [] : null;
  const paged = usePaged(`live:${cat.id}`, virtual ? null : (o, l) => api.items('live', cat.id, 'default', o, l));
  const count = virtual ? virtual.length : paged.total;
  const get = (i: number): Item | undefined => (virtual ? virtual[i] : paged.get(i));

  // first visit: if no favorites, start on the first real category
  useEffect(() => { if (cats.data && lastCat === 0 && favList.length === 0) { setCi(2); } }, [cats.data]);
  const firstCat = useRef(true);
  useEffect(() => { if (firstCat.current) { firstCat.current = false; return; } setFi(0); }, [cat.id]);
  useEffect(() => { lastCat = ci; lastChan = fi; }, [ci, fi]);

  const focused = get(fi);
  const activate = (it: Item | undefined) => {
    if (!it) return;
    if (current.value?.id === it.id && mode.value !== 'off') setMode('full');
    else play(it, { mode: isMobile ? 'full' : 'mini' });
  };

  useKeys((k) => {
    if (railFocused.value) return false;
    if (zone === 'cats') {
      if (k === 'up') { setCi((i) => Math.max(0, i - 1)); return true; }
      if (k === 'down') { setCi((i) => Math.min(allCats.length - 1, i + 1)); return true; }
      if (k === 'right' || k === 'ok') { setZone('chans'); return true; }
      return false; // left -> rail
    }
    const page = 10;
    if (k === 'up') { setFi((i) => Math.max(0, i - 1)); return true; }
    if (k === 'down') { setFi((i) => Math.min(count - 1, i + 1)); return true; }
    if (k === 'chup') { setFi((i) => Math.max(0, i - page)); return true; }
    if (k === 'chdown') { setFi((i) => Math.min(count - 1, i + page)); return true; }
    if (k === 'left') { setZone('cats'); return true; }
    if (k === 'ok') { activate(focused); return true; }
    if (k === 'red' && focused) { toggleFavorite(focused); return true; }
    return false;
  });

  const epgNow = focused ? nowNext(focused.epg) : undefined;
  const live = current.value?.kind === 'live' ? current.value : null;

  return (
    <div class={`live z-${zone}`}>
      <div class={`col cats ${zone === 'cats' && !railFocused.value ? 'active' : ''}`}>
        <h2>Live TV</h2>
        <VList count={allCats.length} rowH={52} focus={zone === 'cats' ? ci : -1} render={(i, f) => {
          const c = allCats[i];
          return (
            <div class={`row cat ${f ? 'focus' : ''} ${i === ci ? 'sel' : ''}`} onClick={() => { setCi(i); setZone('chans'); }}>
              <span class="name">{c.name}</span>
              <span class="count">{c.id === '__fav' ? favList.length || '' : c.id === '__recent' ? '' : c.count}</span>
            </div>
          );
        }} />
      </div>
      <div class={`col chans ${zone === 'chans' && !railFocused.value ? 'active' : ''}`}>
        <h2><button class="phone-back" onClick={() => setZone('cats')}>‹</button>{cat.name} <small>{count || ''}</small></h2>
        {count === 0 && (virtual || paged.ready) && <div class="empty">{cat.id === '__fav' ? 'No favorites yet — press the red button (or F) on a channel.' : 'Nothing here.'}</div>}
        <VList count={count} rowH={76} focus={zone === 'chans' ? fi : -1} onRange={(s, e) => paged.ensure(s, e)} render={(i, f) => {
          const it = get(i);
          if (!it) return <div class="row chan skel" />;
          const playing = live?.id === it.id;
          return (
            <div class={`row chan ${f ? 'focus' : ''} ${playing ? 'playing' : ''}`}
              onClick={() => { setZone('chans'); setFi(i); activate(it); }}
              onDblClick={() => { play(it, { mode: 'full' }); }}>
              <span class="num">{i + 1}</span>
              <Logo src={it.icon} name={it.name} />
              <div class="meta">
                <div class="name">{clean(it.name)} <Star id={it.id} />{it.archive ? <span class="badge">CATCH-UP</span> : null}</div>
                <NowLine list={nowNext(it.epg)} />
              </div>
            </div>
          );
        }} />
      </div>
      <div class="col side">
        <div class="preview" ref={(el) => { previewBox.value = el; }}>
          {!live && <div class="hint">{isMobile ? 'Tap a channel to watch' : 'OK to preview · OK again for full screen'}</div>}
          {live && mode.value === 'mini' && (status.value === 'requesting' || status.value === 'loading' || status.value === 'buffering') && <div class="spinner" />}
          {live && mode.value === 'mini' && status.value === 'error' && <div class="perr">{errorMsg.value}</div>}
        </div>
        {focused && (
          <div class="info panel">
            <div class="title"><Logo src={focused.icon} name={focused.name} size={56} /> <span>{clean(focused.name)}</span></div>
            {epgNow?.length ? epgNow.slice(0, 2).map((p, n) => (
              <div class="prog" key={p.start}>
                <div class="when">{n === 0 ? 'Now' : 'Next'} · {clock(p.start)}–{clock(p.stop)}</div>
                <div class="pt">{p.title}</div>
                {n === 0 && p.desc && <div class="desc">{p.desc}</div>}
              </div>
            )) : <div class="desc muted">No programme guide for this channel</div>}
            <div class="keys muted"><b class="red">●</b> Favorite</div>
          </div>
        )}
      </div>
    </div>
  );
}
