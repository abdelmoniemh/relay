import { useMemo, useState } from 'preact/hooks';
import type { Item, Progress, SportEvent } from '@shared/protocol.ts';
import { api, favorites, type TitleDetail } from '../api.ts';
import { current, play, playEvent } from '../playback.ts';
import { go, push, navFocused, compact } from '../router.ts';
import { connected } from '../ws.ts';
import { useAsync, useKeys, epgVersion } from '../ui/hooks.ts';
import { clean } from '../ui/common.tsx';
import { Billboard, ChannelTile, IconBtn, PosterTile, Row, SkeletonRow, LivePill, QualityChip, type Action } from '../ui/kit.tsx';
import { Icon, type IconName } from '../ui/Icon.tsx';
import { Card } from './Browse.tsx';
import { fmtTime } from '../env.ts';
import { t } from '../i18n.ts';

interface Tile { key: string; render: (f: boolean) => any; act: () => void }
interface HRow { title: string; tiles: Tile[]; wide?: boolean; more?: () => void }

const kickoff = (e: SportEvent) => e.start ? new Date(e.start * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

/** Open a VOD item on its title page (falls back to the raw provider detail). */
function openVod(it: Item) {
  if (it.id.startsWith('t')) { push({ name: 'title', tid: Number(it.id.slice(1)) }); return; }
  api.titleOf(it.kind === 'episode' && it.seriesId ? it.seriesId : it.id).then((r) => push({ name: 'title', tid: r.tid }))
    .catch(() => push(it.kind === 'series' || it.kind === 'episode' ? { name: 'show', item: it } : { name: 'movie', item: it }));
}

export function Home() {
  const cont = useAsync(() => api.continueWatching(), [current.value?.id]);
  const recent = useAsync(() => api.recent(), [current.value?.id]);
  const wl = useAsync(() => api.watchlist().catch(() => null), []);
  const events = useAsync(() => api.events({ sport: 'football' }).catch(() => [] as SportEvent[]), []);
  epgVersion.value;

  // Billboard: what you were last watching (a film or show), else the top of your watchlist.
  const vodCont = (cont.data ?? []).filter((p) => p.item.kind !== 'live');
  const lead = vodCont[0];
  const leadTid = useAsync(async (): Promise<{ d: TitleDetail; p?: Progress } | null> => {
    if (lead) {
      const r = await api.titleOf(lead.item.kind === 'episode' && lead.item.seriesId ? lead.item.seriesId : lead.item.id).catch(() => null);
      if (r) return { d: await api.title(r.tid), p: lead };
    }
    const w = wl.data?.items?.[0];
    if (w) return { d: await api.title(w.tid) };
    return null;
  }, [lead?.item.id, wl.data?.items?.[0]?.tid]);
  const bb = leadTid.data;

  const bbActions: Action[] = !bb ? [] : [
    bb.p
      ? { label: bb.p.item.kind === 'episode' ? t('Resume S{s} E{e}', { s: bb.p.item.season ?? '', e: bb.p.item.episode ?? '' }) : t('Resume'), icon: 'play', primary: true,
          act: () => play(bb.p!.item, { startAt: bb.p!.position }) }
      : { label: t('Play'), icon: 'play', primary: true, act: () => {
          const v = bb.d.versions[0];
          if (bb.d.kind === 'movie' && v) play({ ...v.item, duration: (bb.d.runtime ?? 0) * 60 || null }, { startAt: 0 });
          else push({ name: 'title', tid: bb.d.tid });
        } },
    { label: t('More info'), icon: 'info', act: () => push({ name: 'title', tid: bb.d.tid }) },
  ];

  const rows = useMemo(() => {
    const out: HRow[] = [];
    if (vodCont.length) out.push({ title: t('Continue watching'), tiles: vodCont.map((p) => ({
      key: p.item.id, act: () => play(p.item, { startAt: p.position }),
      render: (f) => {
        const show = p.item.kind === 'episode' ? favorites.value.get(p.item.seriesId ?? '') : null;
        return <PosterTile src={show?.icon ?? p.item.icon} focused={f} progress={p.duration ? p.position / p.duration : 0}
          title={show ? clean(show.name) : clean(p.item.name)}
          sub={p.item.kind === 'episode' ? `S${p.item.season} E${p.item.episode} · ${t('{t} left', { t: fmtTime(Math.max(0, p.duration - p.position)) })}` : t('{t} left', { t: fmtTime(Math.max(0, p.duration - p.position)) })} />;
      },
    })) });
    const favLive = [...favorites.value.values()].filter((i) => i.kind === 'live');
    const chan = (it: Item): Tile => ({ key: it.id, act: () => play(it, { mode: 'full' }), render: (f) => <ChannelTile it={it} focused={f} playing={current.value?.id === it.id} /> });
    if (favLive.length) out.push({ title: t('Your channels'), wide: true, tiles: favLive.map(chan), more: () => go({ name: 'live' }) });
    const soon = (events.data ?? []).filter((e) => !e.offline && (e.status === 'live' || (e.start && e.start * 1000 - Date.now() < 12 * 3600e3))).slice(0, 20);
    if (soon.length) out.push({ title: t("Tonight's football"), wide: true, more: () => go({ name: 'sports' }), tiles: soon.map((e) => {
      const best = e.sources.find((s) => !s.dead);
      return {
        key: e.id, act: () => playEvent(e.id),
        render: (f: boolean) => (
          <div class={`tile landscape event ${f ? 'focus' : ''}`} role="button" tabIndex={-1}>
            <div class="art">
              <div class="ev-when">{e.status === 'live' ? <LivePill /> : <span class="tnum">{kickoff(e)}</span>}</div>
              <div class="ev-teams"><b>{e.home}</b><b>{e.away}</b></div>
              {best && <QualityChip label={best.label} verified={best.verified} />}
            </div>
            <div class="cap">{e.competition ?? t('Football')}</div>
          </div>
        ),
      };
    }) });
    const favVod = [...favorites.value.values()].filter((i) => i.kind === 'movie' || i.kind === 'series');
    if (favVod.length) out.push({ title: t('My list'), tiles: favVod.map((it) => ({
      key: it.id, act: () => openVod(it), render: (f: boolean) => <PosterTile src={it.icon} title={clean(it.name)} focused={f} />,
    })) });
    const wlItems = wl.data?.items ?? [];
    if (wlItems.length) out.push({ title: t('From your Letterboxd watchlist'), more: () => push({ name: 'grid', kind: 'movie', filters: { wl: '1', sort: 'watchlist' }, title: t('Your Letterboxd watchlist') }),
      tiles: wlItems.slice(0, 30).map((c) => ({ key: `wl${c.tid}`, act: () => push({ name: 'title', tid: c.tid }), render: (f: boolean) => <Card c={c} focused={f} /> })) });
    if (recent.data?.length) out.push({ title: t('Recently watched channels'), wide: true, tiles: recent.data.map(chan) });
    return out;
  }, [cont.data, recent.data, wl.data, events.data, favorites.value, epgVersion.value, current.value?.id]);

  // focus: row -1 = billboard buttons
  const hasBB = !!bb;
  const [r, setR] = useState(-1);
  const [c, setC] = useState<number[]>([]);
  const minR = hasBB ? -1 : 0;
  const ri = Math.max(minR, Math.min(r, rows.length - 1));
  const len = (i: number) => (i < 0 ? bbActions.length : rows[i]?.tiles.length ?? 1);
  const col = (i: number) => Math.min(c[i + 1] ?? 0, len(i) - 1);
  const setCol = (i: number, v: number) => { const n = [...c]; n[i + 1] = v; setC(n); };

  useKeys((k) => {
    if (navFocused.value) return false;
    if (k === 'up') { if (ri <= minR) return false; setR(ri - 1); return true; }
    if (k === 'down') { setR(Math.min(rows.length - 1, ri + 1)); return true; }
    if (k === 'left') { if (col(ri) > 0) setCol(ri, col(ri) - 1); return true; }
    if (k === 'right') { setCol(ri, Math.min(len(ri) - 1, col(ri) + 1)); return true; }
    if (k === 'ok') { if (ri < 0) bbActions[col(ri)]?.act(); else rows[ri]?.tiles[col(ri)]?.act(); return true; }
    return false;
  });

  const kb = !navFocused.value && !compact.value;
  const loading = cont.loading && !cont.data;
  const empty = !loading && !rows.length && !bb;
  const meta = bb ? [bb.d.year, bb.d.genres.slice(0, 3).join(' · '), bb.d.rating ? `★ ${(bb.d.rating * 2).toFixed(1)}` : null].filter(Boolean).join('  ·  ') : '';

  return (
    <div class="home page">
      {compact.value && (
        <header class="phone-head">
          <span class="wordmark">Relay</span>
          {!connected.value && <span class="offline-pill">{t('Reconnecting…')}</span>}
          <IconBtn n="remote" label={t('Remote')} onClick={() => push({ name: 'remote' })} />
          <IconBtn n="settings" label={t('Settings')} onClick={() => push({ name: 'settings' })} />
        </header>
      )}
      {bb ? (
        <Billboard backdrop={bb.d.backdrop} poster={bb.d.poster} title={bb.d.name} meta={meta} plot={bb.d.plot}
          eyebrow={bb.p ? (bb.p.item.kind === 'episode' ? `S${bb.p.item.season} E${bb.p.item.episode} · ${clean(bb.p.item.name)}` : t('Continue watching')) : t('From your watchlist')}
          actions={bbActions} focus={kb && ri === -1 ? col(-1) : -1} />
      ) : loading ? <div class="billboard skel" /> : null}
      <div class="rows">
        {loading && <><SkeletonRow /><SkeletonRow wide /></>}
        {empty && <EmptyHome />}
        {rows.map((row, n) => (
          <Row key={row.title} title={row.title} wide={row.wide} onMore={row.more} focus={kb && n === ri ? col(n) : -1}>
            {row.tiles.map((tile, i) => (
              <div key={tile.key} class="cell" onClick={() => { setR(n); setCol(n, i); tile.act(); }}>
                {tile.render(kb && n === ri && i === col(n))}
              </div>
            ))}
          </Row>
        ))}
      </div>
    </div>
  );
}

function EmptyHome() {
  const start: { k: 'live' | 'sports' | 'movies'; icon: IconName; label: string; sub: string }[] = [
    { k: 'live', icon: 'live', label: t('Live TV'), sub: t('Channels and what’s on now') },
    { k: 'sports', icon: 'sports', label: t('Sports'), sub: t('Matches in the next 36 hours') },
    { k: 'movies', icon: 'film', label: t('Movies & TV'), sub: t('Films and series') },
  ];
  return (
    <div class="empty-home">
      <h2>{t('Start watching')}</h2>
      <p class="muted">{t('What you watch and favourite shows up here, on every device.')}</p>
      <div class="start-tiles">
        {start.map((s) => <button key={s.k} class="start-tile" onClick={() => go({ name: s.k })}><Icon n={s.icon} /><b>{s.label}</b><span>{s.sub}</span></button>)}
      </div>
    </div>
  );
}
