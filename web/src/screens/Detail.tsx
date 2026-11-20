import { useEffect, useMemo, useState } from 'preact/hooks';
import type { Item } from '@shared/protocol.ts';
import { api, favorites, toggleFavorite } from '../api.ts';
import { back, navFocused } from '../router.ts';
import { play } from '../playback.ts';
import { useAsync, useKeys } from '../ui/hooks.ts';
import { VList } from '../ui/VList.tsx';
import { ProgBar } from '../ui/common.tsx';
import { displayName, isFinished, isResumable } from '@shared/domain.ts';
import { fmtTime, img } from '../env.ts';
import { Btn, IconBtn, type Action } from '../ui/kit.tsx';
import { t } from '../i18n.ts';

function useBackKey(extra?: (k: string) => boolean) {
  useKeys((k) => {
    if (k === 'back') { back(); navFocused.value = false; return true; }
    return extra?.(k) ?? false;
  });
}

export function MovieDetail({ item }: { item: Item }) {
  const info = useAsync(() => api.movie(item.id), [item.id]);
  const prog = useAsync(() => api.progress([item.id]), [item.id]);
  const [p, d] = prog.data?.[item.id] ?? [0, 0];
  const resumable = isResumable(p, d);
  const withDur = { ...item, duration: info.data?.duration ?? item.duration ?? (d || null) };
  const buttons: Action[] = [
    ...(resumable ? [{ label: t('Resume {t}', { t: fmtTime(p) }), icon: 'play' as const, primary: true, act: () => play(withDur, { startAt: p }) }] : []),
    { label: resumable ? t('Start over') : t('Play'), icon: resumable ? 'restart' as const : 'play' as const, primary: !resumable, act: () => play(withDur, { startAt: 0 }) },
    { label: favorites.value.has(item.id) ? t('In my list') : t('My list'), icon: favorites.value.has(item.id) ? 'check' as const : 'plus' as const, act: () => toggleFavorite(item) },
  ];
  const [bi, setBi] = useState(0);
  useBackKey((k) => {
    if (navFocused.value) return false;
    if (k === 'left') { setBi(Math.max(0, bi - 1)); return true; }
    if (k === 'right') { setBi(Math.min(buttons.length - 1, bi + 1)); return true; }
    if (k === 'ok') { buttons[bi]?.act(); return true; }
    if (k === 'play' || k === 'playpause') { buttons[0].act(); return true; }
    return false;
  });
  const i = info.data;
  return (
    <div class="detail page">
      {i?.backdrop && <img class="backdrop" src={img(i.backdrop, 1280)} alt="" />}
      <div class="detail-body">
        <img class="poster big" src={img(item.icon, 342)} alt="" />
        <div class="txt">
          <IconBtn n="back" label={t('Back')} onClick={() => back()} />
          <h1>{displayName(item.name)}</h1>
          <div class="facts muted">{[i?.year, i?.genre, i?.duration ? fmtTime(i.duration) : null, (i?.rating ?? item.rating) ? `★ ${(i?.rating ?? item.rating)!.toFixed(1)}` : null].filter(Boolean).join(' · ')}</div>
          {resumable && <ProgBar p={p} d={d} />}
          <div class="bb-actions">{buttons.map((b, n) => <Btn key={b.label} a={b} focused={n === bi && !navFocused.value} />)}</div>
          {i?.plot && <p class="plot">{i.plot}</p>}
          {i?.cast && <p class="muted small">{t('Starring')}: {i.cast}</p>}
          {i?.director && <p class="muted small">{t('Director')}: {i.director}</p>}
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
      if (pr && (!best || eIdx + sIdx * 1000 > best.t)) best = { s: sIdx, e: isFinished(pr[0], pr[1]) ? Math.min(eIdx + 1, x.episodes.length - 1) : eIdx, t: eIdx + sIdx * 1000 };
    }));
    if (best) { setSi((best as any).s); setEi((best as any).e); }
  }, [prog.data, seasons.length]);

  const playEp = (e: Item & { duration?: number }) => { const pr = prog.data?.[e.id]; play({ ...e, duration: e.duration ?? (pr?.[1] || null) }, pr && !isFinished(pr[0], pr[1]) ? { startAt: pr[0] } : {}); };

  useBackKey((k) => {
    if (navFocused.value) return false;
    if (zone === 'seasons') {
      if (k === 'left') { if (si > 0) { setSi(si - 1); setEi(0); } return true; }
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
    <div class="detail series page">
      {d?.backdrop && <img class="backdrop" src={img(d.backdrop, 1280)} alt="" />}
      <div class="detail-head">
        <img class="poster" src={img(d?.cover ?? item.icon, 185)} alt="" />
        <div class="txt">
          <IconBtn n="back" label={t('Back')} onClick={() => back()} />
          <h1>{displayName(d?.name || item.name)}</h1>
          <div class="facts muted">{[d?.year, d?.genre, d?.rating ? `★ ${d.rating.toFixed(1)}` : null].filter(Boolean).join(' · ')}</div>
          {d?.plot && <p class="plot clamp">{d.plot}</p>}
        </div>
      </div>
      {s.loading && !d && <div class="spinner inline" />}
      {s.error && <div class="empty">{t("Couldn't load episodes: {e}", { e: s.error.message })}</div>}
      <div class="chips seasons">
        {seasons.map((x, n) => (
          <button key={x.season} class={`chip ${n === si ? 'on' : ''} ${zone === 'seasons' && n === si ? 'focus' : ''}`} onClick={() => { setSi(n); setEi(0); setZone('eps'); }}>
            {x.season === 0 ? t('Specials') : t('Season {n}', { n: x.season })}
          </button>
        ))}
        <button class="chip" onClick={() => toggleFavorite(item)}>{favorites.value.has(item.id) ? t('In my list') : t('My list')}</button>
      </div>
      <VList class="eps" count={eps.length} rowH={124} focus={zone === 'eps' ? ei : -1} render={(n, f) => {
        const e = eps[n];
        const pr = prog.data?.[e.id];
        return (
          <div class={`row ep ${f ? 'focus' : ''}`} onClick={() => { setEi(n); playEp(e); }}>
            {e.icon ? <img class="thumb" src={img(e.icon, 185)} loading="lazy" alt="" /> : <div class="thumb ph">{e.episode}</div>}
            <div class="meta">
              <div class="name">{e.episode}. {displayName(e.name).replace(/^.* - S\d+E\d+$/, `Episode ${e.episode}`)}</div>
              <div class="muted small">{e.duration ? fmtTime(e.duration) : ''}{pr && isFinished(pr[0], pr[1]) ? ` · ${t('Watched')}` : ''}</div>
              {e.plot && <div class="desc clamp">{e.plot}</div>}
              {pr && <ProgBar p={pr[0]} d={pr[1]} />}
            </div>
          </div>
        );
      }} />
    </div>
  );
}
