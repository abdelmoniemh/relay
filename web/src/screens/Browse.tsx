import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, type BrowseRow, type TitleCard } from '../api.ts';
import { push, go, back, navFocused, compact } from '../router.ts';
import { play } from '../playback.ts';
import { useAsync, useKeys, usePaged } from '../ui/hooks.ts';
import { VList } from '../ui/VList.tsx';
import { Billboard, PosterTile, Row, Segmented, SkeletonRow, IconBtn, type Action } from '../ui/kit.tsx';
import { Icon } from '../ui/Icon.tsx';
import { isMobile, isTizen } from '../env.ts';
import { t } from '../i18n.ts';
import { versionItem } from '../catalogue.ts';

const rem = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
export const openTitle = (tid: number) => push({ name: 'title', tid });

export function Card({ c, focused, onClick }: { c: TitleCard; focused: boolean; onClick?: () => void; size?: 'md' | 'lg' }) {
  const sub = [c.progress?.label, c.year, c.rating ? `★ ${(c.rating * 2).toFixed(1)}` : null].filter(Boolean).join(' · ');
  return (
    <PosterTile src={c.poster} title={c.name} sub={sub} focused={focused} onClick={onClick}
      progress={c.progress && c.progress.duration > 0 ? c.progress.position / c.progress.duration : undefined}
      badges={<>
        {c.uhd && <span class="badge-4k">4K</span>}
        {c.fresh && c.wl && <span class="badge-new">{t('NEW')}</span>}
        {c.wl && !c.watched && <span class="badge-wl" title={t('On your Letterboxd watchlist')} />}
        {c.watched ? <span class="badge-seen"><Icon n="check" />{typeof c.watched === 'number' ? ` ${'★'.repeat(Math.floor(c.watched))}${c.watched % 1 ? '½' : ''}` : ''}</span> : null}
      </>} />
  );
}

/** Movies & TV: Movies | Series toggle, filter chips, billboard, then rows (Netflix-style). */
export function Browse({ kind }: { kind: 'movie' | 'series' }) {
  const rows = useAsync(() => api.browse(kind), [kind]);
  const list: BrowseRow[] = rows.data ?? [];
  const leadCard = list[0]?.items[0];
  const lead = useAsync(() => (leadCard ? api.title(leadCard.tid).catch(() => null) : Promise.resolve(null)), [leadCard?.tid]);
  const bb = lead.data;
  const all = kind === 'movie' ? t('All movies') : t('All series');
  const chips = useMemo(() => [
    { label: all, act: () => push({ name: 'grid', kind, filters: {}, title: all }) },
    { label: '4K', act: () => push({ name: 'grid', kind, filters: { uhd: '1' }, title: t('In 4K') }) },
    { label: t('Arabic'), act: () => push({ name: 'grid', kind, filters: { lang: 'ar', sort: 'added' }, title: t('Arabic') }) },
    { label: t('Watchlist'), act: () => push({ name: 'grid', kind, filters: { wl: '1', sort: 'watchlist' }, title: t('Your Letterboxd watchlist') }) },
    { label: t('Categories'), act: () => push({ name: 'categories', kind }) },
  ], [kind, all]);
  const head = [
    { label: t('Movies'), act: () => kind !== 'movie' && go({ name: 'movies' }) },
    { label: t('Series'), act: () => kind !== 'series' && go({ name: 'series' }) },
    ...chips,
  ];
  const bbActions: Action[] = !bb ? [] : [
    { label: t('Play'), icon: 'play', primary: true, act: () => {
      const v = versionItem(bb);
      if (v) play(v, { startAt: 0 });
      else openTitle(bb.tid);
    } },
    { label: t('More info'), icon: 'info', act: () => openTitle(bb.tid) },
  ];

  // focus rows: -2 = toggle + chips, -1 = billboard buttons, 0.. = rows
  const [r, setR] = useState(-1);
  const [cols, setCols] = useState<Record<string, number>>({});
  const minR = -2;
  const ri = Math.max(minR, Math.min(r, list.length - 1));
  const rowLen = (i: number) => (i === -2 ? head.length : i === -1 ? bbActions.length : list[i].items.length + (list[i].more ? 1 : 0));
  const keyOf = (i: number) => (i < 0 ? String(i) : list[i].id);
  const ci = Math.min(cols[keyOf(ri)] ?? (ri === -2 ? (kind === 'movie' ? 0 : 1) : 0), Math.max(0, rowLen(ri) - 1));
  useEffect(() => { if (r === -1 && rows.data && !bbActions.length && !compact.value) setR(0); }, [rows.data, bb]);

  const activate = (rw: BrowseRow, i: number) => {
    if (i < rw.items.length) openTitle(rw.items[i].tid);
    else if (rw.more) push({ name: 'grid', kind, filters: rw.more, title: t(rw.title) });
  };

  useKeys((k) => {
    if (navFocused.value) return false;
    if (k === 'up') { let n = ri - 1; if (n === -1 && !bbActions.length) n = -2; if (n < minR) return false; setR(n); return true; }
    if (k === 'down') { let n = ri + 1; if (n === -1 && !bbActions.length) n = 0; setR(Math.min(list.length - 1, n)); return true; }
    if (k === 'left') { if (ci > 0) setCols({ ...cols, [keyOf(ri)]: ci - 1 }); return true; }
    if (k === 'right') { setCols({ ...cols, [keyOf(ri)]: Math.min(rowLen(ri) - 1, ci + 1) }); return true; }
    if (k === 'ok') { if (ri === -2) head[ci]?.act(); else if (ri === -1) bbActions[ci]?.act(); else activate(list[ri], ci); return true; }
    return false;
  });

  const kb = !navFocused.value && !compact.value;
  const meta = bb ? [bb.year, bb.genres.slice(0, 3).join(' · '), bb.rating ? `★ ${(bb.rating * 2).toFixed(1)}` : null, bb.uhd ? '4K' : null].filter(Boolean).join('  ·  ') : '';
  return (
    <div class="browse page">
      <div class="browse-head">
        <Segmented value={kind} options={[{ v: 'movie', label: t('Movies') }, { v: 'series', label: t('Series') }]}
          onChange={(v) => go({ name: v === 'movie' ? 'movies' : 'series' })} focus={kb && ri === -2 && ci < 2 ? ci : -1} />
        <div class="chips">
          {chips.map((b, i) => <button key={b.label} class={`chip ${kb && ri === -2 && ci === i + 2 ? 'focus' : ''}`} onClick={b.act}>{b.label}</button>)}
        </div>
      </div>
      {bb ? <Billboard backdrop={bb.backdrop} poster={bb.poster} title={bb.name} meta={meta} plot={bb.plot} eyebrow={list[0] ? t(list[0].title) : undefined}
        actions={bbActions} focus={kb && ri === -1 ? ci : -1} /> : rows.loading ? <div class="billboard skel" /> : null}
      <div class="rows">
        {rows.loading && !rows.data && <><SkeletonRow /><SkeletonRow /></>}
        {rows.error && <div class="empty">{rows.error.message}</div>}
        {list.map((rw, n) => {
          const near = !isTizen || Math.abs(n - Math.max(0, ri)) <= 3; // TV only: render rows near the D-pad focus (mouse/touch scrolling never moves it)
          return near ? (
            <Row key={rw.id} title={t(rw.title)} focus={kb && n === ri ? ci : -1} onMore={rw.more ? () => activate(rw, rw.items.length) : undefined}>
              {rw.items.map((c, i) => <Card key={c.tid} c={c} focused={kb && n === ri && i === ci} onClick={() => { setR(n); setCols({ ...cols, [rw.id]: i }); openTitle(c.tid); }} />)}
              {rw.more && (
                <div class={`tile poster more ${kb && n === ri && ci === rw.items.length ? 'focus' : ''}`} onClick={() => activate(rw, rw.items.length)} role="button">
                  <div class="art"><span class="ph"><Icon n="chevron" />{t('See all')}</span></div>
                </div>
              )}
            </Row>
          ) : <SkeletonRow key={rw.id} />;
        })}
      </div>
    </div>
  );
}

// ---------------- filterable grid ----------------

type Opt = { v: string; label: string };
const SORTS: Opt[] = [{ v: 'watchlist', label: 'Watchlist order' }, { v: 'popular', label: 'Popular' }, { v: 'added', label: 'Recently added' }, { v: 'rating', label: 'Top rated' }, { v: 'year', label: 'Newest' }, { v: 'name', label: 'A–Z' }];
const LANGS: Opt[] = [{ v: '', label: 'Any language' }, { v: 'en', label: 'English' }, { v: 'ar', label: 'Arabic' }];
const RATINGS: Opt[] = [{ v: '', label: 'Any rating' }, { v: '7', label: '★ 7+' }, { v: '8', label: '★ 8+' }];
const UHD: Opt[] = [{ v: '', label: 'Any quality' }, { v: '1', label: '4K only' }];
const WL: Opt[] = [{ v: '', label: 'All titles' }, { v: '1', label: 'My watchlist' }];
const year = new Date().getFullYear();
const DECADES: { v: string; label: string; from?: string; to?: string }[] = [
  { v: '', label: 'Any year' }, { v: 'new', label: `${year - 1}–${year}`, from: String(year - 1) }, { v: '2020', label: '2020s', from: '2020', to: '2029' },
  { v: '2010', label: '2010s', from: '2010', to: '2019' }, { v: '2000', label: '2000s', from: '2000', to: '2009' }, { v: 'old', label: 'Before 2000', to: '1999' },
];

export function Grid({ kind, filters, title }: { kind: 'movie' | 'series'; filters: Record<string, string>; title?: string }) {
  const genres = useAsync(() => api.genres(kind), [kind]);
  const [f, setF] = useState<Record<string, string>>({ sort: filters.sort ?? (filters.top250 ? '' : 'popular'), ...filters });
  const decade = DECADES.find((d) => d.from === f.year_from && d.to === f.year_to)?.v ?? (f.year_from ? 'new' : '');
  const chips: { label: string; opts: Opt[]; value: string; set: (v: string) => void }[] = [
    { label: 'Watchlist', opts: WL, value: f.wl ?? '', set: (v) => setF({ ...f, wl: v, sort: v ? 'watchlist' : f.sort === 'watchlist' ? 'popular' : f.sort }) },
    { label: 'Sort', opts: f.wl ? SORTS : SORTS.slice(1), value: f.sort ?? '', set: (v) => setF({ ...f, sort: v }) },
    { label: 'Genre', opts: [{ v: '', label: 'All genres' }, ...(genres.data ?? []).map((g) => ({ v: g.name, label: g.name }))], value: f.genre ?? '', set: (v) => setF({ ...f, genre: v }) },
    { label: 'Language', opts: LANGS, value: f.lang ?? '', set: (v) => setF({ ...f, lang: v }) },
    { label: 'Quality', opts: UHD, value: f.uhd ?? '', set: (v) => setF({ ...f, uhd: v }) },
    { label: 'Rating', opts: RATINGS, value: f.min_rating ?? '', set: (v) => setF({ ...f, min_rating: v }) },
    { label: 'Year', opts: DECADES, value: decade, set: (v) => { const d = DECADES.find((x) => x.v === v)!; setF({ ...f, year_from: d.from ?? '', year_to: d.to ?? '' }); } },
  ];
  const clean = Object.fromEntries(Object.entries(f).filter(([, v]) => v));
  const key = `${kind}:${JSON.stringify(clean)}`;
  const paged = usePaged(key, (o, l) => api.titles(kind, clean, o, l) as any);
  const [zone, setZone] = useState<'chips' | 'grid'>('grid');
  const [chi, setChi] = useState(0);
  const [fi, setFi] = useState(0);
  useEffect(() => setFi(0), [key]);
  const gridRef = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(6);
  useLayoutEffect(() => {
    const el = gridRef.current!;
    const ro = new ResizeObserver(() => setCols(Math.max(2, Math.floor(el.clientWidth / (isMobile ? 118 : 11.5 * rem())))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const colW = (gridRef.current?.clientWidth ?? 1200) / cols;
  const rowH = Math.round(colW * 1.5 + 3.4 * rem());
  const get = (i: number) => paged.get(i) as unknown as TitleCard | undefined;
  const cycle = (c: (typeof chips)[number], dir = 1) => {
    const i = c.opts.findIndex((o) => o.v === c.value);
    c.set(c.opts[(i + dir + c.opts.length) % c.opts.length].v);
  };

  useKeys((k) => {
    if (navFocused.value) return false;
    if (k === 'back') return false;
    if (zone === 'chips') {
      if (k === 'left') { setChi(Math.max(0, chi - 1)); return true; }
      if (k === 'right') { setChi(Math.min(chips.length - 1, chi + 1)); return true; }
      if (k === 'ok') { cycle(chips[chi]); return true; }
      if (k === 'down') { setZone('grid'); return true; }
      if (k === 'up') return false;
      return true;
    }
    if (k === 'up') { if (fi < cols) setZone('chips'); else setFi(fi - cols); return true; }
    if (k === 'down') { setFi(Math.min(paged.total - 1, fi + cols)); return true; }
    if (k === 'left') { if (fi % cols !== 0) setFi(fi - 1); return true; }
    if (k === 'right') { setFi(Math.min(paged.total - 1, fi + 1)); return true; }
    if (k === 'chdown') { setFi(Math.min(paged.total - 1, fi + cols * 3)); return true; }
    if (k === 'chup') { setFi(Math.max(0, fi - cols * 3)); return true; }
    if (k === 'ok') { const c = get(fi); if (c) openTitle(c.tid); return true; }
    return false;
  });

  const kb = !navFocused.value && !compact.value;
  return (
    <div class="grid-screen page">
      <div class="grid-head">
        <h1 class="screen-title"><IconBtn n="back" label={t('Back')} onClick={() => back()} />{title ?? (kind === 'movie' ? t('Movies') : t('Series'))} <small>{paged.ready ? paged.total.toLocaleString() : ''}</small></h1>
        <div class="chips">
          {chips.map((c, i) => {
            const cur = c.opts.find((o) => o.v === c.value) ?? c.opts[0];
            const cls = `chip ${kb && zone === 'chips' && i === chi ? 'focus' : ''} ${c.value ? 'on' : ''}`;
            return isTizen ? (
              <button key={c.label} class={cls} onClick={() => cycle(c)}>{t(cur.label)}</button>
            ) : (
              <label key={c.label} class={`${cls} select`}>
                <span>{t(cur.label)}</span><Icon n="down" />
                <select id={`grid-${c.label}`} aria-label={t(c.label)} value={c.value} onChange={(e) => c.set((e.target as HTMLSelectElement).value)}>
                  {c.opts.map((o) => <option key={o.v} value={o.v}>{t(o.label)}</option>)}
                </select>
              </label>
            );
          })}
        </div>
      </div>
      <div class="grid-body" ref={gridRef}>
        {paged.ready && paged.total === 0 && <div class="empty">{t('Nothing matches these filters.')}</div>}
        <VList count={paged.total} rowH={rowH} cols={cols} focus={kb && zone === 'grid' ? fi : -1} onRange={(s, e) => paged.ensure(s, e)} render={(i, foc) => {
          const c = get(i);
          return c ? <Card c={c} focused={foc} onClick={() => { setFi(i); openTitle(c.tid); }} /> : <div class="tile poster skel" />;
        }} />
      </div>
    </div>
  );
}
