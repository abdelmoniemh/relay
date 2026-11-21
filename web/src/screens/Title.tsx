import { useEffect, useMemo, useState } from 'preact/hooks';
import { isFinished, MIN_RESUME_S, titleId } from '@shared/domain.ts';
import type { Item } from '@shared/protocol.ts';
import { api, favorites, toggleFavorite, type TitleCard, type VersionInfo } from '../api.ts';
import { back, navFocused, compact } from '../router.ts';
import { play } from '../playback.ts';
import { useAsync, useKeys } from '../ui/hooks.ts';
import { VList } from '../ui/VList.tsx';
import { ProgBar, stars, diaryStars } from '../ui/common.tsx';
import { Btn, IconBtn, Row, Sheet, type Action } from '../ui/kit.tsx';
import { Icon } from '../ui/Icon.tsx';
import { fmtTime, img, isTizen } from '../env.ts';
import { t as tr } from '../i18n.ts';
import { Card, openTitle } from './Browse.tsx';
import { versionItem } from '@shared/domain.ts';

type Ep = Item & { plot?: string; duration?: number };
const LANG_NAME: Record<string, string> = { eng: 'English', en: 'English', ara: 'Arabic', ar: 'Arabic', fre: 'French', fra: 'French', ger: 'German', deu: 'German', spa: 'Spanish', ita: 'Italian', tur: 'Turkish', hin: 'Hindi', por: 'Portuguese', dut: 'Dutch', nld: 'Dutch', rus: 'Russian', pol: 'Polish', jpn: 'Japanese', kor: 'Korean', chi: 'Chinese', zho: 'Chinese', heb: 'Hebrew', per: 'Persian', fas: 'Persian' };
const langs = (s: string | null | undefined) => {
  if (!s) return '';
  const l = s.split(',').map((x) => LANG_NAME[x] ?? x.toUpperCase()).filter((v, i, a) => a.indexOf(v) === i);
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

  const vIds = useMemo(() => (t?.versions ?? []).map((v) => v.item.id), [t]);
  const prog = useAsync(() => (vIds.length && t?.kind === 'movie' ? api.progress(vIds) : Promise.resolve({} as Record<string, [number, number]>)), [vIds.join()]);
  const resumeAt = useMemo(() => {
    let best = 0, dur = 0;
    for (const [p, du] of Object.values(prog.data ?? {})) if (p > best && du > 0 && !isFinished(p, du)) { best = p; dur = du; }
    return best > MIN_RESUME_S ? { p: best, d: dur } : null;
  }, [prog.data]);

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
    if (isFinished(p, du)) return { ep: allEps[idx + 1] ?? allEps[idx], at: 0 };
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
    const it = versionItem({ ...t, versions: [v] }, 0, resumeAt?.d);
    if (it) play(it, { startAt: from });
  };
  const playEp = (e: Ep | undefined, at?: number) => {
    if (!e) return;
    const pr = epProg.data?.[e.id];
    const start = at ?? (pr && !isFinished(pr[0], pr[1]) ? pr[0] : 0);
    play({ ...e, duration: e.duration ?? (pr?.[1] || null) }, { startAt: start, episodes: allEps });
  };
  const isFav = t ? favorites.value.has(titleId(t.tid)) : false;
  const fav = () => t && toggleFavorite({ id: titleId(t.tid), kind: t.kind, name: t.name, icon: t.poster });

  const buttons: Action[] = !t ? [] : [
    ...(t.kind === 'movie'
      ? resumeAt ? [{ label: tr('Resume {t}', { t: fmtTime(resumeAt.p) }), icon: 'play' as const, primary: true, act: () => playMovie(ver, resumeAt.p) },
          { label: tr('Start over'), icon: 'restart' as const, act: () => playMovie(ver, 0) }]
        : [{ label: tr('Play'), icon: 'play' as const, primary: true, act: () => playMovie(ver, 0) }]
      : resumeEp.ep ? [{ label: tr(resumeEp.at > MIN_RESUME_S ? 'Resume S{s} E{e}' : 'Play S{s} E{e}', { s: resumeEp.ep.season ?? '', e: resumeEp.ep.episode ?? '' }), icon: 'play' as const, primary: true, act: () => playEp(resumeEp.ep, resumeEp.at) }] : []),
    ...(t.trailer ? [{ label: tr('Trailer'), icon: 'trailer' as const, act: () => setPanel('trailer') }] : []),
    { label: isFav ? tr('In my list') : tr('My list'), icon: isFav ? 'check' as const : 'plus' as const, act: fav },
    ...(t.versions.length > 1 ? [{ label: tr('Versions ({n})', { n: t.versions.length }), icon: 'film' as const, act: () => { setPi(verIdx); setPanel('versions'); } }] : []),
  ];
  const rows: { title: string; items: TitleCard[] }[] = !t ? [] : [
    ...(t.collection.length ? [{ title: tr('Collection'), items: t.collection }] : []),
    ...(t.similar.length ? [{ title: tr('More like this'), items: t.similar }] : []),
  ];

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
    if (navFocused.value) return false;
    if (k === 'back') { back(); return true; }
    if (k === 'red') { fav(); return true; }
    if (k === 'play' || k === 'playpause') { buttons[0]?.act(); return true; }
    switch (zone) {
      case 'buttons':
        if (k === 'left') { setBi(Math.max(0, bi - 1)); return true; }
        if (k === 'right') { setBi(Math.min(buttons.length - 1, bi + 1)); return true; }
        if (k === 'ok') { buttons[bi]?.act(); return true; }
        if (k === 'down') { move(1); return true; }
        return false; // 'up' -> top bar
      case 'seasons':
        if (k === 'left') { if (si > 0) { setSi(si - 1); setEi(0); } return true; }
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
        if (k === 'left') { if (rc > 0) setRc(rc - 1); return true; }
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

  if (d.loading && !t) return <div class="title-screen page"><div class="billboard skel" /></div>;
  if (!t) return <div class="title-screen page"><div class="empty">{d.error?.message ?? tr('Not found')}</div></div>;
  const f = (z: Zone) => zone === z && !navFocused.value && panel === 'none' && !compact.value;
  const meta = [t.year, t.runtime ? (t.kind === 'movie' ? `${Math.floor(t.runtime / 60)}h ${t.runtime % 60}m` : tr('{n} min episodes', { n: t.runtime })) : null,
    stars(t.rating), t.genres.slice(0, 3).join(', ') || null].filter(Boolean);
  const audio = ver?.probe?.alangs ? langs(ver.probe.alangs) : '';
  const subs = ver?.probe?.slangs ? langs(ver.probe.slangs) : '';

  return (
    <div class="title-screen page">
      <section class={`billboard title-hero ${t.backdrop ? '' : 'no-art'}`}>
        {t.backdrop ? <img class="bb-art" src={img(t.backdrop, 1280)} alt="" /> : t.poster ? <img class="bb-art blur" src={img(t.poster, 342)} alt="" /> : null}
        <div class="bb-scrim" />
        <IconBtn n="back" label={tr('Back')} class="title-back" onClick={() => back()} />
        <div class="bb-body">
          {!t.backdrop && t.poster && <img class="title-poster" src={img(t.poster, 342)} alt="" />}
          <h1 class="bb-title">{t.name}</h1>
          <div class="bb-meta">
            {meta.join('  ·  ')}
            {t.uhd && <span class="badge-inline">4K</span>}
            {t.top250 && <span class="badge-inline imdb">IMDb Top 250 #{t.top250}</span>}
            {t.wl && !t.watched && <span class="badge-inline lb">{tr('On your watchlist')}</span>}
            {t.watched && <span class="badge-inline lb">{tr('Watched')}{typeof t.watched === 'number' ? ` · ${diaryStars(t.watched)}` : ''}</span>}
          </div>
          {resumeAt && t.kind === 'movie' && <ProgBar p={resumeAt.p} d={resumeAt.d} />}
          <div class="bb-actions">{buttons.map((b, i) => <Btn key={b.label} a={b} focused={f('buttons') && i === bi} />)}</div>
        </div>
      </section>

      <div class="title-body">
        <div class="title-about">
          {t.plot && <p class="plot">{t.plot}</p>}
          <dl class="facts">
            {t.cast && <><dt>{tr('Starring')}</dt><dd>{t.cast}</dd></>}
            {t.director && <><dt>{t.kind === 'movie' ? tr('Director') : tr('Created by')}</dt><dd>{t.director}</dd></>}
            {ver && <><dt>{tr('Version')}</dt><dd>{ver.label}</dd></>}
            {audio && <><dt>{tr('Audio')}</dt><dd>{audio}</dd></>}
            {subs && <><dt>{tr('Subtitles')}</dt><dd>{subs}</dd></>}
          </dl>
        </div>

        {t.kind === 'series' && (
          <section class="episodes">
            <div class="ep-head">
              <h2 class="row-title">{tr('Episodes')}</h2>
              <div class="chips seasons">
                {seasons.map((x, n) => (
                  <button key={x.season} class={`chip ${n === si ? 'on' : ''} ${f('seasons') && n === si ? 'focus' : ''}`} onClick={() => { setSi(n); setEi(0); setZone('eps'); }}>
                    {x.season === 0 ? tr('Specials') : tr('Season {n}', { n: x.season })}
                  </button>
                ))}
              </div>
            </div>
            {ser.loading && <div class="ep-skel" />}
            <VList class="eps" count={eps.length} rowH={isTizen ? 168 : compact.value ? 116 : 132} focus={f('eps') ? ei : -1} render={(n, foc) => {
              const e = eps[n];
              const pr = epProg.data?.[e.id];
              const done = pr && isFinished(pr[0], pr[1]);
              return (
                <div class={`ep ${foc ? 'focus' : ''}`} onClick={() => { setEi(n); playEp(e); }} role="button">
                  <div class="ep-thumb">
                    {e.icon ? <img src={img(e.icon, 185)} loading="lazy" alt="" /> : <span class="ph">{e.episode}</span>}
                    <span class="ep-play"><Icon n="play" /></span>
                    {pr && !done && <div class="tile-bar"><i style={{ width: `${Math.min(100, (pr[0] / pr[1]) * 100)}%` }} /></div>}
                  </div>
                  <div class="ep-txt">
                    <div class="ep-name"><span class="ep-num">{e.episode}</span>{e.name.replace(/^.* - S\d+E\d+$/, tr('Episode {n}', { n: e.episode ?? '' }))}</div>
                    <div class="ep-meta">{e.duration ? fmtTime(e.duration) : ''}{done ? ` · ${tr('Watched')}` : ''}</div>
                    {e.plot && <div class="ep-plot">{e.plot}</div>}
                  </div>
                </div>
              );
            }} />
          </section>
        )}

        {rows.map((row, n) => (
          <Row key={row.title} title={row.title} focus={f('rows') && n === ri ? rc : -1}>
            {row.items.map((c, i) => <Card key={c.tid} c={c} focused={f('rows') && n === ri && i === rc} onClick={() => openTitle(c.tid)} />)}
          </Row>
        ))}
      </div>

      {panel === 'versions' && (
        <Sheet title={tr('Choose a version')} onClose={() => setPanel('none')}>
          <div class="list-group">
            {t.versions.map((v, i) => (
              <button key={v.item.id} class={`list-row ${i === pi ? 'focus' : ''}`} onClick={() => { setVerIdx(i); setPanel('none'); if (t.kind === 'movie') playMovie(v, resumeAt?.p ?? 0); }}>
                <span class="lr-main"><b>{v.label}</b>
                  <span class="lr-sub">{[v.probe?.alangs && `${tr('Audio')}: ${langs(v.probe.alangs)}`, v.probe?.slangs && `${tr('Subtitles')}: ${langs(v.probe.slangs)}`, v.probe ? tr('Checked') : tr('Not checked yet')].filter(Boolean).join(' · ')}</span></span>
                {i === verIdx && <Icon n="check" class="lr-check" />}
              </button>
            ))}
          </div>
        </Sheet>
      )}
      {panel === 'trailer' && t.trailer && (
        <div class="sheet-backdrop trailer" onClick={() => setPanel('none')}>
          <iframe src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(t.trailer)}?autoplay=1&rel=0`} allow="autoplay; encrypted-media; fullscreen" allowFullScreen />
        </div>
      )}
    </div>
  );
}
