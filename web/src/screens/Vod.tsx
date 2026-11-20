import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Category, Item } from '@shared/protocol.ts';
import { api, favorites, toggleFavorite, type Sort } from '../api.ts';
import { back, push, navFocused } from '../router.ts';
import { useAsync, useDebounced, useKeys, usePaged } from '../ui/hooks.ts';
import { VList } from '../ui/VList.tsx';
import { Poster, Star, clean } from '../ui/common.tsx';
import { isMobile } from '../env.ts';
import { IconBtn, PosterTile } from '../ui/kit.tsx';
import { t } from '../i18n.ts';

type VCat = Category & { sort?: Sort };
const memory: Record<string, { ci: number; fi: number }> = {};

export function Vod({ kind }: { kind: 'movie' | 'series' }) {
  const cats = useAsync(() => api.categories(kind), [kind]);
  const all: VCat[] = useMemo(() => [
    { id: '__added', name: t('Recently added'), count: 0, sort: 'added' },
    { id: '__fav', name: t('Favourites'), count: 0 },
    ...(cats.data ?? []),
  ], [cats.data]);
  const mem = memory[kind] ?? { ci: 0, fi: 0 };
  const [zone, setZone] = useState<'cats' | 'grid'>('grid');
  const [ci, setCi] = useState(mem.ci);
  const [fi, setFi] = useState(mem.fi);
  const cat = all[useDebounced(ci, 200)] ?? all[0];
  useEffect(() => { memory[kind] = { ci, fi }; }, [ci, fi, kind]);
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } setFi(0); }, [cat.id]);

  const favs = useMemo(() => [...favorites.value.values()].filter((i) => i.kind === kind), [favorites.value, kind]);
  const virtual = cat.id === '__fav' ? favs : null;
  const paged = usePaged(`${kind}:${cat.id}`, virtual ? null
    : (o, l) => api.items(kind, cat.id.startsWith('__') ? null : cat.id, cat.sort ?? 'default', o, l));
  const count = virtual ? virtual.length : paged.total;
  const get = (i: number) => (virtual ? virtual[i] : paged.get(i));

  // responsive columns
  const gridRef = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(6);
  useLayoutEffect(() => {
    const el = gridRef.current!;
    const ro = new ResizeObserver(() => setCols(Math.max(2, Math.floor(el.clientWidth / (isMobile ? 120 : 200)))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const colW = (gridRef.current?.clientWidth ?? 1200) / cols;
  const rowH = Math.round(colW * 1.5 + 64);

  const open = (it?: Item) => {
    if (!it) return;
    api.titleOf(it.id).then((r) => push({ name: 'title', tid: r.tid }))
      .catch(() => push(kind === 'movie' ? { name: 'movie', item: it } : { name: 'show', item: it }));
  };

  useKeys((k) => {
    if (navFocused.value) return false;
    if (zone === 'cats') {
      if (k === 'up') { if (ci === 0) return false; setCi((i) => Math.max(0, i - 1)); return true; }
      if (k === 'down') { setCi((i) => Math.min(all.length - 1, i + 1)); return true; }
      if (k === 'right' || k === 'ok') { setZone('grid'); return true; }
      return false;
    }
    if (k === 'back') { back(); return true; }
    if (k === 'left') { if (fi % cols === 0) setZone('cats'); else setFi(fi - 1); return true; }
    if (k === 'right') { setFi(Math.min(count - 1, fi + 1)); return true; }
    if (k === 'up') { if (fi < cols) return false; setFi(fi - cols); return true; }
    if (k === 'down') { setFi(Math.min(count - 1, fi + cols)); return true; }
    if (k === 'chdown') { setFi(Math.min(count - 1, fi + cols * 3)); return true; }
    if (k === 'chup') { setFi(Math.max(0, fi - cols * 3)); return true; }
    if (k === 'ok') { open(get(fi)); return true; }
    if (k === 'red') { const it = get(fi); if (it) toggleFavorite(it); return true; }
    return false;
  });

  return (
    <div class={`vod page z-${zone}`}>
      <div class={`col cats ${zone === 'cats' && !navFocused.value ? 'active' : ''}`}>
        <h1 class="screen-title"><IconBtn n="back" label={t('Back')} onClick={() => back()} />{t('Categories')}</h1>
        <VList count={all.length} rowH={52} focus={zone === 'cats' ? ci : -1} render={(i, f) => (
          <div class={`row cat ${f ? 'focus' : ''} ${i === ci ? 'sel' : ''}`} onClick={() => { setCi(i); setZone('grid'); }}>
            <span class="name">{all[i].name}</span><span class="count">{all[i].id === '__fav' ? favs.length || '' : all[i].count || ''}</span>
          </div>
        )} />
      </div>
      <div class={`col grid ${zone === 'grid' && !navFocused.value ? 'active' : ''}`} ref={gridRef}>
        <div class="col-head">
          <button class="cat-picker" onClick={() => setZone('cats')}><span>{cat.name}</span></button>
          <h2 class="col-title">{cat.name} <small>{count ? count.toLocaleString() : ''}</small></h2>
        </div>
        {count === 0 && (virtual || paged.ready) && <div class="empty">{t('Nothing here yet.')}</div>}
        <VList count={count} rowH={rowH} cols={cols} focus={zone === 'grid' ? fi : -1} onRange={(s, e) => paged.ensure(s, e)} render={(i, f) => {
          const it = get(i);
          if (!it) return <div class="tile poster skel" />;
          return <PosterTile src={it.icon} title={clean(it.name)} sub={it.rating ? `★ ${it.rating.toFixed(1)}` : undefined} focused={f}
            onClick={() => { setZone('grid'); setFi(i); open(it); }} />;
        }} />
      </div>
    </div>
  );
}
