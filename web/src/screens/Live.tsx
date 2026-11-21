import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Category, Item } from '@shared/protocol.ts';
import { api, favorites, toggleFavorite } from '../api.ts';
import { current, mode, play, setMode, status, errorMsg } from '../playback.ts';
import { navFocused } from '../router.ts';
import { useAsync, useDebounced, useKeys, usePaged, nowNext, epgVersion } from '../ui/hooks.ts';
import { VList } from '../ui/VList.tsx';
import { Logo, NowLine } from '../ui/common.tsx';
import { displayName } from '@shared/domain.ts';
import { clock, isMobile } from '../env.ts';
import { Icon } from '../ui/Icon.tsx';
import { t } from '../i18n.ts';
import { previewBox, numbered } from '../player/placement.ts';
import { ProgrammesSheet } from '../features/programmes.tsx';

const FAV: Category = { id: '__fav', name: 'Favourites', count: 0 };
const RECENT: Category = { id: '__recent', name: 'Recently watched', count: 0 };
const catName = (c: Category) => (c.id.startsWith('__') ? t(c.name) : c.name);
let lastCat = 0; // remember position across visits
let lastChan = 0;

export function Live() {
  const cats = useAsync(() => api.categories('live'), []);
  const recent = useAsync(() => api.recent(), []);
  const allCats = useMemo(() => [FAV, RECENT, ...(cats.data ?? [])], [cats.data]);
  const [zone, setZone] = useState<'cats' | 'chans'>('chans');
  const [ci, setCi] = useState(lastCat);
  const [fi, setFi] = useState(lastChan);
  const [guideFor, setGuideFor] = useState<Item | null>(null);
  const cat = allCats[useDebounced(ci, 180)] ?? FAV;
  epgVersion.value; // subscribe: re-render when EPG arrives

  const favList = useMemo(() => [...favorites.value.values()].filter((i) => i.kind === 'live'), [favorites.value]);
  const virtual = cat.id === '__fav' ? favList : cat.id === '__recent' ? recent.data ?? [] : null;
  const paged = usePaged(`live:${cat.id}`, virtual ? null : (o, l) => api.items('live', cat.id, 'default', o, l));
  const count = virtual ? virtual.length : paged.total;
  const get = (i: number): Item | undefined => (virtual ? virtual[i] : paged.get(i));
  useEffect(() => { numbered.value = { at: get, cat: virtual ? undefined : cat.id }; return () => { numbered.value = null; }; });

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
    if (navFocused.value || guideFor) return false;
    if (zone === 'cats') {
      if (k === 'up') { if (ci === 0) return false; setCi((i) => Math.max(0, i - 1)); return true; }
      if (k === 'down') { setCi((i) => Math.min(allCats.length - 1, i + 1)); return true; }
      if (k === 'right' || k === 'ok') { setZone('chans'); return true; }
      return k === 'left';
    }
    const page = 10;
    if (k === 'up') { if (fi === 0) return false; setFi((i) => Math.max(0, i - 1)); return true; }
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
    <div class={`live page z-${zone}`}>
      <div class={`col cats ${zone === 'cats' && !navFocused.value ? 'active' : ''}`}>
        <h1 class="screen-title">{t('Live TV')}</h1>
        <VList count={allCats.length} rowH={52} focus={zone === 'cats' ? ci : -1} render={(i, f) => {
          const c = allCats[i];
          return (
            <div class={`row cat ${f ? 'focus' : ''} ${i === ci ? 'sel' : ''}`} onClick={() => { setCi(i); setZone('chans'); }}>
              {c.id === '__fav' && <Icon n="star" filled class="cat-ic" />}
              <span class="name">{catName(c)}</span>
              <span class="count">{c.id === '__fav' ? favList.length || '' : c.id === '__recent' ? '' : c.count}</span>
            </div>
          );
        }} />
      </div>
      <div class={`col chans ${zone === 'chans' && !navFocused.value ? 'active' : ''}`}>
        <div class="col-head">
          <button class="cat-picker" onClick={() => setZone('cats')} aria-label={t('Choose a category')}>
            <span>{catName(cat)}</span><Icon n="down" />
          </button>
          <h2 class="col-title">{catName(cat)} <small>{count || ''}</small></h2>
        </div>
        {count === 0 && (virtual || paged.ready) && <div class="empty">{cat.id === '__fav' ? t('No favourites yet. Tap the star on a channel, or press the red button.') : t('Nothing here.')}</div>}
        <VList count={count} rowH={isMobile ? 72 : 76} focus={zone === 'chans' ? fi : -1} onRange={(s, e) => paged.ensure(s, e)} render={(i, f) => {
          const it = get(i);
          if (!it) return <div class="row chan skel" />;
          const playing = live?.id === it.id;
          const fav = favorites.value.has(it.id);
          return (
            <div class={`row chan ${f ? 'focus' : ''} ${playing ? 'playing' : ''}`}
              onClick={() => { setZone('chans'); setFi(i); activate(it); }}
              onDblClick={() => { play(it, { mode: 'full' }); }}>
              <span class="num">{playing ? <Icon n="play" /> : i + 1}</span>
              <Logo src={it.icon} name={it.name} />
              <div class="meta">
                <div class="name">{displayName(it.name)}{it.archive ? <span class="badge-inline">{t('Catch-up')}</span> : null}</div>
                <NowLine list={nowNext(it.epg)} />
              </div>
              <button class={`fav-btn ${fav ? 'on' : ''}`} aria-label={fav ? t('Remove from favourites') : t('Add to favourites')} aria-pressed={fav}
                onClick={(e) => { e.stopPropagation(); toggleFavorite(it); }}><Icon n="star" filled={fav} /></button>
            </div>
          );
        }} />
      </div>
      <div class="col side">
        <div class="preview" ref={(el) => { previewBox.value = el; }}>
          {!live && <div class="hint">{isMobile ? t('Tap a channel to watch') : t('Select a channel to preview it. Select again for full screen.')}</div>}
          {live && mode.value === 'mini' && (status.value === 'requesting' || status.value === 'loading' || status.value === 'buffering') && <div class="spinner" />}
          {live && mode.value === 'mini' && status.value === 'error' && <div class="perr">{errorMsg.value}</div>}
        </div>
        {focused && (
          <div class="info">
            <div class="title"><Logo src={focused.icon} name={focused.name} size={56} /> <span>{displayName(focused.name)}</span></div>
            {epgNow?.length ? epgNow.slice(0, 2).map((p, n) => (
              <div class="prog" key={p.start}>
                <div class="when">{n === 0 ? t('Now') : t('Next')} · <span class="tnum">{clock(p.start)}–{clock(p.stop)}</span></div>
                <div class="pt">{p.title}</div>
                {n === 0 && p.desc && <div class="desc">{p.desc}</div>}
              </div>
            )) : <div class="desc">{t('No programme guide for this channel')}</div>}
            {focused.epg && <button class="pill-btn" onClick={() => setGuideFor(focused)}><Icon n="info" />{focused.archive ? t('Programmes & catch-up') : t('Programmes')}</button>}
            <div class="keys"><span class="keydot red" />{favorites.value.has(focused.id) ? t('Remove from favourites') : t('Add to favourites')}</div>
          </div>
        )}
      </div>
      {guideFor && <ProgrammesSheet channel={guideFor} onClose={() => setGuideFor(null)} />}
    </div>
  );
}
