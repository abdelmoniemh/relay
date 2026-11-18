import { useEffect, useMemo, useState } from 'preact/hooks';
import type { Item } from '@shared/protocol.ts';
import { api, favorites, toggleFavorite } from '../api.ts';
import { back, railFocused } from '../router.ts';
import { play } from '../playback.ts';
import { useAsync, useKeys } from '../ui/hooks.ts';
import { VList } from '../ui/VList.tsx';
import { ProgBar, clean } from '../ui/common.tsx';
import { fmtTime, img } from '../env.ts';

function useBackKey(extra?: (k: string) => boolean) {
  useKeys((k) => {
    if (k === 'back') { back(); railFocused.value = false; return true; }
    return extra?.(k) ?? false;
  });
}

export function MovieDetail({ item }: { item: Item }) {
  const info = useAsync(() => api.movie(item.id), [item.id]);
  const prog = useAsync(() => api.progress([item.id]), [item.id]);
  const [p, d] = prog.data?.[item.id] ?? [0, 0];
  const resumable = p > 30 && d > 0 && p < d * 0.95;
  const buttons = [
    ...(resumable ? [{ label: `▶ Resume ${fmtTime(p)}`, act: () => play(item, { startAt: p }) }] : []),
    { label: resumable ? '⟲ From start' : '▶ Play', act: () => play(item, { startAt: 0 }) },
    { label: favorites.value.has(item.id) ? '★ Favorited' : '☆ Favorite', act: () => toggleFavorite(item) },
  ];
  const [bi, setBi] = useState(0);
  useBackKey((k) => {
    if (railFocused.value) return false;
    if (k === 'left') { if (bi === 0) return false; setBi(bi - 1); return true; }
    if (k === 'right') { setBi(Math.min(buttons.length - 1, bi + 1)); return true; }
    if (k === 'ok') { buttons[bi]?.act(); return true; }
    if (k === 'play' || k === 'playpause') { buttons[0].act(); return true; }
    return false;
  });
  const i = info.data;
  return (
    <div class="detail">
      {i?.backdrop && <img class="backdrop" src={img(i.backdrop, 1280)} alt="" />}
      <div class="detail-body">
        <img class="poster big" src={img(item.icon, 342)} alt="" />
        <div class="txt">
          <button class="back-link" onClick={() => back()}>‹ Back</button>
          <h1>{clean(item.name)}</h1>
          <div class="facts muted">{[i?.year, i?.genre, i?.duration ? fmtTime(i.duration) : null, (i?.rating ?? item.rating) ? `★ ${(i?.rating ?? item.rating)!.toFixed(1)}` : null].filter(Boolean).join(' · ')}</div>
          {resumable && <ProgBar p={p} d={d} />}
          <div class="btns">{buttons.map((b, n) => <button key={b.label} class={n === bi && !railFocused.value ? 'focus' : ''} onClick={b.act}>{b.label}</button>)}</div>
          {i?.plot && <p class="plot">{i.plot}</p>}
          {i?.cast && <p class="muted small">Cast: {i.cast}</p>}
          {i?.director && <p class="muted small">Director: {i.director}</p>}
        </div>
      </div>
    </div>
  );
}

export function SeriesDetail({ item }: { item: Item }) {
  const s = useAsync(() => api.series(item.id), [item.id]);
  const seasons = s.data?.seasons ?? [];
  const [si, setSi] = useState(0);
  const [ei, setEi] = useState(0);
  const [zone, setZone] = useState<'seasons' | 'eps'>('eps');
  const eps = seasons[si]?.episodes ?? [];
  const allIds = useMemo(() => seasons.flatMap((x) => x.episodes.map((e) => e.id)), [seasons]);
  const prog = useAsync(() => (allIds.length ? api.progress(allIds) : Promise.resolve({} as Record<string, [number, number]>)), [allIds.join()]);

  // Jump to the season/episode you were last watching.
  useEffect(() => {
    if (!prog.data || !seasons.length) return;
    let best: { s: number; e: number; t: number } | null = null;
    seasons.forEach((x, sIdx) => x.episodes.forEach((e, eIdx) => {
      const pr = prog.data![e.id];
      if (pr && (!best || eIdx + sIdx * 1000 > best.t)) best = { s: sIdx, e: pr[0] > pr[1] * 0.95 ? Math.min(eIdx + 1, x.episodes.length - 1) : eIdx, t: eIdx + sIdx * 1000 };
    }));
    if (best) { setSi((best as any).s); setEi((best as any).e); }
  }, [prog.data, seasons.length]);

  const playEp = (e: Item) => { const pr = prog.data?.[e.id]; play(e, pr && pr[0] < pr[1] * 0.95 ? { startAt: pr[0] } : {}); };

  useBackKey((k) => {
    if (railFocused.value) return false;
    if (zone === 'seasons') {
      if (k === 'left') { if (si === 0) return false; setSi(si - 1); setEi(0); return true; }
      if (k === 'right') { setSi(Math.min(seasons.length - 1, si + 1)); setEi(0); return true; }
      if (k === 'down' || k === 'ok') { setZone('eps'); return true; }
      if (k === 'red') { toggleFavorite(item); return true; }
      return false;
    }
    if (k === 'up') { if (ei === 0) setZone('seasons'); else setEi(ei - 1); return true; }
    if (k === 'down') { setEi(Math.min(eps.length - 1, ei + 1)); return true; }
    if (k === 'ok' || k === 'play' || k === 'playpause') { if (eps[ei]) playEp(eps[ei]); return true; }
    if (k === 'red') { toggleFavorite(item); return true; }
    return false;
  });

  const d = s.data;
  return (
    <div class="detail series">
      {d?.backdrop && <img class="backdrop" src={img(d.backdrop, 1280)} alt="" />}
      <div class="detail-head">
        <img class="poster" src={img(d?.cover ?? item.icon, 185)} alt="" />
        <div class="txt">
          <button class="back-link" onClick={() => back()}>‹ Back</button>
          <h1>{clean(d?.name || item.name)} {favorites.value.has(item.id) && <span class="star">★</span>}</h1>
          <div class="facts muted">{[d?.year, d?.genre, d?.rating ? `★ ${d.rating.toFixed(1)}` : null].filter(Boolean).join(' · ')}</div>
          {d?.plot && <p class="plot clamp">{d.plot}</p>}
        </div>
      </div>
      {s.loading && !d && <div class="spinner inline" />}
      {s.error && <div class="empty">Couldn't load episodes: {s.error.message}</div>}
      <div class={`tabs ${zone === 'seasons' ? 'active' : ''}`}>
        {seasons.map((x, n) => (
          <button key={x.season} class={`${n === si ? 'sel' : ''} ${zone === 'seasons' && n === si ? 'focus' : ''}`} onClick={() => { setSi(n); setEi(0); setZone('eps'); }}>
            {x.season === 0 ? 'Specials' : `Season ${x.season}`}
          </button>
        ))}
        <button onClick={() => toggleFavorite(item)}>{favorites.value.has(item.id) ? '★' : '☆'}</button>
      </div>
      <VList class="eps" count={eps.length} rowH={124} focus={zone === 'eps' ? ei : -1} render={(n, f) => {
        const e = eps[n];
        const pr = prog.data?.[e.id];
        return (
          <div class={`row ep ${f ? 'focus' : ''}`} onClick={() => { setEi(n); playEp(e); }}>
            {e.icon ? <img class="thumb" src={img(e.icon, 185)} loading="lazy" alt="" /> : <div class="thumb ph">{e.episode}</div>}
            <div class="meta">
              <div class="name">{e.episode}. {clean(e.name).replace(/^.* - S\d+E\d+$/, `Episode ${e.episode}`)}</div>
              <div class="muted small">{e.duration ? fmtTime(e.duration) : ''}{pr && pr[0] > pr[1] * 0.95 ? ' · Watched' : ''}</div>
              {e.plot && <div class="desc clamp">{e.plot}</div>}
              {pr && <ProgBar p={pr[0]} d={pr[1]} />}
            </div>
          </div>
        );
      }} />
    </div>
  );
}
