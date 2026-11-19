import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, type BrowseRow, type TitleCard } from '../api.ts';
import { push, railFocused } from '../router.ts';
import { useAsync, useKeys, usePaged } from '../ui/hooks.ts';
import { VList } from '../ui/VList.tsx';
import { img, isMobile } from '../env.ts';

const rem = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
export const openTitle = (tid: number) => push({ name: 'title', tid });

export function Card({ c, focused, onClick, size = 'md' }: { c: TitleCard; focused: boolean; onClick?: () => void; size?: 'md' | 'lg' }) {
  return (
    <div class={`tcard ${size} ${focused ? 'focus' : ''}`} onClick={onClick}>
      <div class="pwrap">
        {c.poster ? <img class="poster" src={img(c.poster, size === 'lg' ? 342 : 185)} loading="lazy" decoding="async" alt="" onError={(e) => ((e.currentTarget as HTMLImageElement).style.opacity = '0')} />
          : <div class="poster ph">{c.name.slice(0, 1)}</div>}
        {c.uhd && <span class="b4k">4K</span>}
        {c.progress && c.progress.duration > 0 && <div class="bar card-bar"><i style={{ width: `${Math.min(100, (c.progress.position / c.progress.duration) * 100)}%` }} /></div>}
      </div>
      <div class="cap">{c.name}</div>
      <div class="sub">{[c.progress?.label, c.year, c.rating ? `★ ${(c.rating * 2).toFixed(1)}` : null].filter(Boolean).join(' · ')}</div>
    </div>
  );
}

/** Netflix-style home for movies or series. */
export function Browse({ kind }: { kind: 'movie' | 'series' }) {
  const rows = useAsync(() => api.browse(kind), [kind]);
  const top = useMemo(() => [
    { label: kind === 'movie' ? 'All movies' : 'All series', act: () => push({ name: 'grid', kind, filters: {}, title: kind === 'movie' ? 'All movies' : 'All series' }) },
    { label: '4K', act: () => push({ name: 'grid', kind, filters: { uhd: '1' }, title: 'In 4K' }) },
    { label: 'Arabic', act: () => push({ name: 'grid', kind, filters: { lang: 'ar', sort: 'added' }, title: 'Arabic' }) },
    { label: 'Provider categories', act: () => push({ name: 'categories', kind }) },
  ], [kind]);
  const list: BrowseRow[] = rows.data ?? [];
  const [r, setR] = useState(-1); // -1 = top bar
  const [cols, setCols] = useState<Record<string, number>>({});
  const [tb, setTb] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<(HTMLElement | null)[]>([]);
  const ri = Math.min(r, list.length - 1);
  const row = ri >= 0 ? list[ri] : null;
  const cards = (rw: BrowseRow) => rw.items.length + (rw.more ? 1 : 0);
  const ci = row ? Math.min(cols[row.id] ?? 0, cards(row) - 1) : 0;
  useEffect(() => { if (rows.data && r === -1 && !isMobile) setR(0); }, [rows.data]);

  const activate = (rw: BrowseRow, i: number) => {
    if (i < rw.items.length) openTitle(rw.items[i].tid);
    else if (rw.more) push({ name: 'grid', kind, filters: rw.more, title: rw.title });
  };

  useKeys((k) => {
    if (railFocused.value) return false;
    if (ri < 0) {
      if (k === 'left') { if (tb === 0) return false; setTb(tb - 1); return true; }
      if (k === 'right') { setTb(Math.min(top.length - 1, tb + 1)); return true; }
      if (k === 'down') { if (list.length) setR(0); return true; }
      if (k === 'ok') { top[tb].act(); return true; }
      return false;
    }
    if (!row) return false;
    if (k === 'up') { setR(ri - 1); return true; }
    if (k === 'down') { setR(Math.min(list.length - 1, ri + 1)); return true; }
    if (k === 'left') { if (ci === 0) return false; setCols({ ...cols, [row.id]: ci - 1 }); return true; }
    if (k === 'right') { setCols({ ...cols, [row.id]: Math.min(cards(row) - 1, ci + 1) }); return true; }
    if (k === 'ok') { activate(row, ci); return true; }
    return false;
  });

  // keep the focused row/card in view
  useLayoutEffect(() => {
    const el = rowRefs.current[ri];
    if (el && scroller.current) {
      const top = el.offsetTop - scroller.current.clientHeight * 0.18;
      scroller.current.scrollTop = Math.max(0, top);
      const strip = el.querySelector('.hscroll') as HTMLElement | null;
      const card = strip?.children[ci] as HTMLElement | undefined;
      if (strip && card) {
        if (card.offsetLeft < strip.scrollLeft + 8) strip.scrollLeft = card.offsetLeft - 8;
        else if (card.offsetLeft + card.offsetWidth > strip.scrollLeft + strip.clientWidth - 8) strip.scrollLeft = card.offsetLeft + card.offsetWidth - strip.clientWidth + 8;
      }
    } else if (ri < 0 && scroller.current) scroller.current.scrollTop = 0;
  }, [ri, ci]);

  return (
    <div class="browse" ref={scroller}>
      <div class="browse-head">
        <h1>{kind === 'movie' ? 'Movies' : 'Series'}</h1>
        <div class="tb">
          {top.map((b, i) => <button key={b.label} class={ri < 0 && i === tb && !railFocused.value ? 'focus' : ''} onClick={b.act}>{b.label}</button>)}
        </div>
      </div>
      {rows.loading && !rows.data && <div class="spinner inline" />}
      {rows.error && <div class="empty">{rows.error.message}</div>}
      {list.map((rw, n) => {
        const near = Math.abs(n - Math.max(0, ri)) <= 3; // render nearby rows only: keeps the TV fast
        return (
          <section key={rw.id} class="brow" ref={(el) => { rowRefs.current[n] = el; }}>
            <h3>{rw.title}</h3>
            {near ? (
              <div class="hscroll">
                {rw.items.map((c, i) => <Card key={c.tid} c={c} focused={!railFocused.value && n === ri && i === ci} onClick={() => { setR(n); setCols({ ...cols, [rw.id]: i }); openTitle(c.tid); }} />)}
                {rw.more && (
                  <div class={`tcard more ${!railFocused.value && n === ri && ci === rw.items.length ? 'focus' : ''}`} onClick={() => activate(rw, rw.items.length)}>
                    <div class="pwrap"><div class="poster ph">See all ›</div></div>
                  </div>
                )}
              </div>
            ) : <div class="hscroll placeholder" />}
          </section>
        );
      })}
    </div>
  );
}

// ---------------- filterable grid ----------------

type Opt = { v: string; label: string };
const SORTS: Opt[] = [{ v: 'popular', label: 'Popular' }, { v: 'added', label: 'Recently added' }, { v: 'rating', label: 'Top rated' }, { v: 'year', label: 'Newest' }, { v: 'name', label: 'A–Z' }];
const LANGS: Opt[] = [{ v: '', label: 'Any language' }, { v: 'en', label: 'English' }, { v: 'ar', label: 'Arabic' }];
const RATINGS: Opt[] = [{ v: '', label: 'Any rating' }, { v: '7', label: '★ 7+' }, { v: '8', label: '★ 8+' }];
const UHD: Opt[] = [{ v: '', label: 'Any quality' }, { v: '1', label: '4K only' }];
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
    { label: 'Sort', opts: SORTS, value: f.sort ?? '', set: (v) => setF({ ...f, sort: v }) },
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
    if (railFocused.value) return false;
    if (k === 'back') return false;
    if (zone === 'chips') {
      if (k === 'left') { if (chi === 0) return false; setChi(chi - 1); return true; }
      if (k === 'right') { setChi(Math.min(chips.length - 1, chi + 1)); return true; }
      if (k === 'ok') { cycle(chips[chi]); return true; }
      if (k === 'down') { setZone('grid'); return true; }
      return true;
    }
    if (k === 'up') { if (fi < cols) setZone('chips'); else setFi(fi - cols); return true; }
    if (k === 'down') { setFi(Math.min(paged.total - 1, fi + cols)); return true; }
    if (k === 'left') { if (fi % cols === 0) return false; setFi(fi - 1); return true; }
    if (k === 'right') { setFi(Math.min(paged.total - 1, fi + 1)); return true; }
    if (k === 'chdown') { setFi(Math.min(paged.total - 1, fi + cols * 3)); return true; }
    if (k === 'chup') { setFi(Math.max(0, fi - cols * 3)); return true; }
    if (k === 'ok') { const c = get(fi); if (c) openTitle(c.tid); return true; }
    return false;
  });

  return (
    <div class="grid-screen">
      <div class="grid-head">
        <h2>{title ?? (kind === 'movie' ? 'Movies' : 'Series')} <small>{paged.ready ? paged.total.toLocaleString() : ''}</small></h2>
        <div class="chips">
          {chips.map((c, i) => (
            <button key={c.label} class={`chip ${zone === 'chips' && i === chi && !railFocused.value ? 'focus' : ''} ${c.value ? 'on' : ''}`}
              onClick={() => cycle(c)} onContextMenu={(e) => { e.preventDefault(); cycle(c, -1); }}>
              {c.opts.find((o) => o.v === c.value)?.label ?? c.opts[0].label}
            </button>
          ))}
        </div>
      </div>
      <div class="grid-body" ref={gridRef}>
        {paged.ready && paged.total === 0 && <div class="empty">Nothing matches these filters.</div>}
        <VList count={paged.total} rowH={rowH} cols={cols} focus={zone === 'grid' ? fi : -1} onRange={(s, e) => paged.ensure(s, e)} render={(i, foc) => {
          const c = get(i);
          return c ? <Card c={c} focused={foc && !railFocused.value} onClick={() => { setFi(i); openTitle(c.tid); }} /> : <div class="tcard skel" />;
        }} />
      </div>
    </div>
  );
}
