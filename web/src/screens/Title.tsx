import { useEffect, useMemo, useState } from 'preact/hooks';
import type { Item } from '@shared/protocol.ts';
import { api, favorites, toggleFavorite, type TitleCard, type TitleDetail, type VersionInfo } from '../api.ts';
import { back, railFocused } from '../router.ts';
import { play } from '../playback.ts';
import { useAsync, useKeys } from '../ui/hooks.ts';
import { VList } from '../ui/VList.tsx';
import { ProgBar } from '../ui/common.tsx';
import { fmtTime, img, isTizen } from '../env.ts';
import { Card, openTitle } from './Browse.tsx';

type Ep = Item & { plot?: string; duration?: number };
const LANG_NAME: Record<string, string> = { eng: 'English', en: 'English', ara: 'Arabic', ar: 'Arabic', fre: 'French', fra: 'French', ger: 'German', deu: 'German', spa: 'Spanish', ita: 'Italian', tur: 'Turkish', hin: 'Hindi', por: 'Portuguese', dut: 'Dutch', nld: 'Dutch', rus: 'Russian', pol: 'Polish', jpn: 'Japanese', kor: 'Korean', chi: 'Chinese', zho: 'Chinese', heb: 'Hebrew', per: 'Persian', fas: 'Persian' };
const langs = (s: string | null | undefined) => {
  if (!s) return '';
  const l = s.split(',').map((x) => LANG_NAME[x] ?? x.toUpperCase()).filter((v, i, a) => a.indexOf(v) === i);
  // Your languages first, then a short tail
  l.sort((a, b) => Number(b === 'English' || b === 'Arabic') - Number(a === 'English' || a === 'Arabic'));
  return l.length > 8 ? `${l.slice(0, 8).join(', ')} +${l.length - 8}` : l.join(', ');
};

export function TitleScreen({ tid }: { tid: number }) {
  const [tick, setTick] = useState(0);
  const d = useAsync(() => api.title(tid), [tid, tick]);
  const t = d.data;
  // Re-fetch once shortly after opening: the server checks the files' real quality in the background.
  useEffect(() => { if (t?.kind === 'movie') { const x = setTimeout(() => setTick((n) => n + 1), 9000); return () => clearTimeout(x); } }, [t?.tid]);
  const [verIdx, setVerIdx] = useState(0);
  const ver: VersionInfo | undefined = t?.versions[verIdx] ?? t?.versions[0];
  const [panel, setPanel] = useState<'none' | 'versions' | 'trailer'>('none');
  const [pi, setPi] = useState(0);

  // ---- movie progress (any version) ----
  const vIds = useMemo(() => (t?.versions ?? []).map((v) => v.item.id), [t]);
  const prog = useAsync(() => (vIds.length && t?.kind === 'movie' ? api.progress(vIds) : Promise.resolve({} as Record<string, [number, number]>)), [vIds.join()]);
  const resumeAt = useMemo(() => {
    let best = 0, dur = 0;
    for (const [p, du] of Object.values(prog.data ?? {})) if (p > best && du > 0 && p < du * 0.95) { best = p; dur = du; }
    return best > 30 ? { p: best, d: dur } : null;
  }, [prog.data]);

  // ---- series: seasons of the chosen version ----
  const sid = t?.kind === 'series' ? ver?.item.id : null;
  const ser = useAsync(() => (sid ? api.series(sid) : Promise.resolve(null)), [sid]);
  const seasons = ser.data?.seasons ?? [];
  const allEps: Ep[] = useMemo(() => seasons.flatMap((s) => s.episodes), [seasons]);
  const epProg = useAsync(() => (allEps.length ? api.progress(allEps.map((e) => e.id)) : Promise.resolve({} as Record<string, [number, number]>)), [allEps.map((e) => e.id).join()]);
  const [si, setSi] = useState(0);
  const [ei, setEi] = useState(0);
  // Where to resume: last episode with progress (or the one after it if finished)
  const resumeEp = useMemo(() => {
    let idx = -1;
    allEps.forEach((e, i) => { if (epProg.data?.[e.id]) idx = i; });
    if (idx < 0) return { ep: allEps[0], at: 0 };
    const [p, du] = epProg.data![allEps[idx].id];
    if (du > 0 && p > du * 0.95) return { ep: allEps[idx + 1] ?? allEps[idx], at: 0 };
    return { ep: allEps[idx], at: p };
  }, [allEps, epProg.data]);
  useEffect(() => {
    const e = resumeEp.ep;
    if (!e) return;
    const s = seasons.findIndex((x) => x.episodes.some((y) => y.id === e.id));
    if (s >= 0) { setSi(s); setEi(seasons[s].episodes.findIndex((y) => y.id === e.id)); }
  }, [resumeEp.ep?.id]);
  const eps = seasons[si]?.episodes ?? [];

  const playMovie = (v: VersionInfo | undefined, from: number) => {
    if (!v || !t) return;
    play({ ...v.item, duration: (t.runtime ?? 0) * 60 || resumeAt?.d || null }, { startAt: from });
  };
  const playEp = (e: Ep | undefined, at?: number) => {
    if (!e) return;
    const pr = epProg.data?.[e.id];
    const start = at ?? (pr && pr[0] < pr[1] * 0.95 ? pr[0] : 0);
    play({ ...e, duration: e.duration ?? (pr?.[1] || null) }, { startAt: start, episodes: allEps });
  };
  const isFav = t ? favorites.value.has(`t${t.tid}`) : false;
  const fav = () => t && toggleFavorite({ id: `t${t.tid}`, kind: t.kind, name: t.name, icon: t.poster });

  const buttons = !t ? [] : [
    ...(t.kind === 'movie'
      ? resumeAt ? [{ label: `▶ Resume ${fmtTime(resumeAt.p)}`, act: () => playMovie(ver, resumeAt.p) }, { label: '⟲ Start over', act: () => playMovie(ver, 0) }]
        : [{ label: '▶ Play', act: () => playMovie(ver, 0) }]
      : resumeEp.ep ? [{ label: resumeEp.at > 30 ? `▶ Resume S${resumeEp.ep.season} E${resumeEp.ep.episode}` : `▶ Play S${resumeEp.ep.season} E${resumeEp.ep.episode}`, act: () => playEp(resumeEp.ep, resumeEp.at) }] : []),
    ...(t.versions.length > 1 ? [{ label: `Versions (${t.versions.length})`, act: () => { setPi(verIdx); setPanel('versions'); } }] : []),
    ...(t.trailer ? [{ label: '▷ Trailer', act: () => setPanel('trailer') }] : []),
    { label: isFav ? '✓ My list' : '+ My list', act: fav },
  ];
  const rows: { title: string; items: TitleCard[] }[] = !t ? [] : [
    ...(t.collection.length ? [{ title: 'Collection', items: t.collection }] : []),
    ...(t.similar.length ? [{ title: 'More like this', items: t.similar }] : []),
  ];

  // ---- focus ----
  type Zone = 'buttons' | 'seasons' | 'eps' | 'rows';
  const [zone, setZone] = useState<Zone>('buttons');
  const [bi, setBi] = useState(0);
  const [ri, setRi] = useState(0);
  const [rc, setRc] = useState(0);
  const order: Zone[] = ['buttons', ...(t?.kind === 'series' && seasons.length ? (['seasons', 'eps'] as Zone[]) : []), ...(rows.length ? (['rows'] as Zone[]) : [])];
  const move = (dir: 1 | -1) => { const i = order.indexOf(zone) + dir; if (i >= 0 && i < order.length) setZone(order[i]); };

  useKeys((k) => {
    if (panel === 'trailer') { if (k === 'back' || k === 'ok') setPanel('none'); return true; }
    if (panel === 'versions') {
      if (k === 'up') setPi(Math.max(0, pi - 1));
      else if (k === 'down') setPi(Math.min((t?.versions.length ?? 1) - 1, pi + 1));
      else if (k === 'ok') { setVerIdx(pi); setPanel('none'); if (t?.kind === 'movie') playMovie(t.versions[pi], resumeAt?.p ?? 0); }
      else if (k === 'back') setPanel('none');
      return true;
    }
    return false;
  }, 2);

  useKeys((k) => {
    if (railFocused.value) return false;
    if (k === 'back') { back(); return true; }
    if (k === 'red') { fav(); return true; }
    if (k === 'play' || k === 'playpause') { buttons[0]?.act(); return true; }
    switch (zone) {
      case 'buttons':
        if (k === 'left') { if (bi === 0) return false; setBi(bi - 1); return true; }
        if (k === 'right') { setBi(Math.min(buttons.length - 1, bi + 1)); return true; }
        if (k === 'ok') { buttons[bi]?.act(); return true; }
        if (k === 'down') { move(1); return true; }
        return false;
      case 'seasons':
        if (k === 'left') { if (si === 0) return false; setSi(si - 1); setEi(0); return true; }
        if (k === 'right') { setSi(Math.min(seasons.length - 1, si + 1)); setEi(0); return true; }
        if (k === 'up') { move(-1); return true; }
        if (k === 'down' || k === 'ok') { setZone('eps'); return true; }
        return false;
      case 'eps':
        if (k === 'up') { if (ei === 0) setZone('seasons'); else setEi(ei - 1); return true; }
        if (k === 'down') { if (ei >= eps.length - 1) move(1); else setEi(ei + 1); return true; }
        if (k === 'ok') { playEp(eps[ei]); return true; }
        return false;
      case 'rows': {
        const row = rows[ri];
        if (k === 'up') { if (ri === 0) move(-1); else { setRi(ri - 1); setRc(0); } return true; }
        if (k === 'down') { if (ri < rows.length - 1) { setRi(ri + 1); setRc(0); } return true; }
        if (k === 'left') { if (rc === 0) return false; setRc(rc - 1); return true; }
        if (k === 'right') { setRc(Math.min(row.items.length - 1, rc + 1)); return true; }
        if (k === 'ok') { openTitle(row.items[rc].tid); return true; }
        return false;
      }
    }
    return false;
  });

  useEffect(() => {
    const el = document.querySelector('.title-screen .focus') as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [zone, bi, si, ei, ri, rc]);

  if (d.loading && !t) return <div class="title-screen"><div class="spinner inline" /></div>;
  if (!t) return <div class="title-screen"><div class="empty">{d.error?.message ?? 'Not found'}</div></div>;
  const f = (z: Zone) => zone === z && !railFocused.value && panel === 'none';
  const meta = [t.year, t.runtime ? (t.kind === 'movie' ? `${Math.floor(t.runtime / 60)}h ${t.runtime % 60}m` : `${t.runtime} min episodes`) : null,
    t.rating ? `★ ${(t.rating * 2).toFixed(1)}${t.votes ? ` (${t.votes.toLocaleString()})` : ''}` : null, t.genres.slice(0, 3).join(', ') || null].filter(Boolean);

  return (
    <div class="title-screen">
      {t.backdrop && <img class="hero-bg" src={img(t.backdrop, 1280)} alt="" />}
      <div class="hero">
        {t.poster && <img class="poster hero-poster" src={img(t.poster, 342)} alt="" />}
        <div class="hero-txt">
          <button class="back-link" onClick={() => back()}>‹ Back</button>
          <h1>{t.name}</h1>
          <div class="facts">{meta.join(' · ')} {t.uhd && <span class="b4k inline">4K</span>} {t.top250 && <span class="badge imdb">IMDb Top 250 #{t.top250}</span>}
            {t.wl && !t.watched && <span class="badge lbwl">On your watchlist</span>}
            {t.watched && <span class="badge lbseen">Watched{typeof t.watched === 'number' ? ` · you rated ${'★'.repeat(Math.floor(t.watched))}${t.watched % 1 ? '½' : ''}` : ''}</span>}</div>
          {ver && <div class="muted small vline">Version: {ver.label}{ver.probe?.alangs ? ` · Audio: ${langs(ver.probe.alangs)}` : ''}{ver.probe?.slangs ? ` · Subtitles: ${langs(ver.probe.slangs)}` : ''}</div>}
          {resumeAt && t.kind === 'movie' && <ProgBar p={resumeAt.p} d={resumeAt.d} />}
          <div class="btns">{buttons.map((b, i) => <button key={b.label} class={f('buttons') && i === bi ? 'focus' : ''} onClick={b.act}>{b.label}</button>)}</div>
          {t.plot && <p class="plot">{t.plot}</p>}
          {t.cast && <p class="muted small">Starring: {t.cast}</p>}
          {t.director && <p class="muted small">{t.kind === 'movie' ? 'Director' : 'Created by'}: {t.director}</p>}
        </div>
      </div>

      {t.kind === 'series' && (
        <div class="episodes">
          {ser.loading && <div class="spinner inline" />}
          <div class="tabs">
            {seasons.map((x, n) => (
              <button key={x.season} class={`${n === si ? 'sel' : ''} ${f('seasons') && n === si ? 'focus' : ''}`} onClick={() => { setSi(n); setEi(0); setZone('eps'); }}>
                {x.season === 0 ? 'Specials' : `Season ${x.season}`}
              </button>
            ))}
          </div>
          <VList class="eps" count={eps.length} rowH={isTizen ? 150 : 124} focus={f('eps') ? ei : -1} render={(n, foc) => {
            const e = eps[n];
            const pr = epProg.data?.[e.id];
            return (
              <div class={`row ep ${foc ? 'focus' : ''}`} onClick={() => { setEi(n); playEp(e); }}>
                {e.icon ? <img class="thumb" src={img(e.icon, 185)} loading="lazy" alt="" /> : <div class="thumb ph">{e.episode}</div>}
                <div class="meta">
                  <div class="name">{e.episode}. {e.name.replace(/^.* - S\d+E\d+$/, `Episode ${e.episode}`)}</div>
                  <div class="muted small">{e.duration ? fmtTime(e.duration) : ''}{pr && pr[0] > pr[1] * 0.95 ? ' · Watched' : ''}</div>
                  {e.plot && <div class="desc clamp">{e.plot}</div>}
                  {pr && <ProgBar p={pr[0]} d={pr[1]} />}
                </div>
              </div>
            );
          }} />
        </div>
      )}

      {rows.map((row, n) => (
        <section key={row.title} class="brow">
          <h3>{row.title}</h3>
          <div class="hscroll">{row.items.map((c, i) => <Card key={c.tid} c={c} focused={f('rows') && n === ri && i === rc} onClick={() => openTitle(c.tid)} />)}</div>
        </section>
      ))}

      {panel === 'versions' && (
        <div class="modal" onClick={() => setPanel('none')}>
          <div class="dialog versions" onClick={(e) => e.stopPropagation()}>
            <h3>Choose a version</h3>
            {t.versions.map((v, i) => (
              <button key={v.item.id} class={`${i === pi ? 'focus' : ''} ${i === verIdx ? 'sel' : ''}`} onClick={() => { setVerIdx(i); setPanel('none'); if (t.kind === 'movie') playMovie(v, resumeAt?.p ?? 0); }}>
                <b>{v.label}</b>
                <span class="muted small">{[v.probe?.alangs && `Audio: ${langs(v.probe.alangs)}`, v.probe?.slangs && `Subs: ${langs(v.probe.slangs)}`, v.probe ? '✓ checked' : 'not checked yet'].filter(Boolean).join(' · ')}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {panel === 'trailer' && t.trailer && (
        <div class="modal trailer" onClick={() => setPanel('none')}>
          <iframe src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(t.trailer)}?autoplay=1&rel=0`} allow="autoplay; encrypted-media; fullscreen" allowFullScreen />
        </div>
      )}
    </div>
  );
}
