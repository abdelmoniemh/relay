import { useMemo, useState } from 'preact/hooks';
import type { Item, Progress } from '@shared/protocol.ts';
import { api, favorites, myDeviceId } from '../api.ts';
import { lease, devices } from '../ws.ts';
import { current, play, takeover } from '../playback.ts';
import { go, push, railFocused } from '../router.ts';
import { useAsync, useKeys, nowNext, epgVersion } from '../ui/hooks.ts';
import { Logo, NowLine, Poster, ProgBar, clean } from '../ui/common.tsx';
import { img } from '../env.ts';
import { Card } from './Browse.tsx';

interface Card { key: string; render: (f: boolean) => any; act: () => void }

export function Home() {
  const cont = useAsync(() => api.continueWatching(), [current.value?.id]);
  const recent = useAsync(() => api.recent(), [current.value?.id]);
  const wl = useAsync(() => api.watchlist().catch(() => null), []);
  epgVersion.value;
  const l = lease.value;
  const elsewhere = l && l.deviceId !== myDeviceId.value && !current.value ? l : null;
  const devName = devices.value.find((d) => d.id === elsewhere?.deviceId)?.name ?? 'another device';

  const rows = useMemo(() => {
    const out: { title: string; cards: Card[]; wide?: boolean }[] = [];
    if (elsewhere) out.push({ title: `Playing on ${devName}`, wide: true, cards: [{
      key: 'takeover', act: () => takeover(),
      render: (f) => (
        <div class={`card handoff ${f ? 'focus' : ''}`}>
          {elsewhere.item.kind === 'live' ? <Logo src={elsewhere.item.icon} name={elsewhere.item.name} size={64} /> : <img class="thumb" src={img(elsewhere.item.icon, 154)} alt="" />}
          <div><div class="name">{clean(elsewhere.item.name)}</div><div class="cta">▶ Continue here</div>
            {elsewhere.duration > 0 && <ProgBar p={elsewhere.position} d={elsewhere.duration} />}</div>
        </div>
      ),
    }] });
    const c = (cont.data ?? []) as Progress[];
    if (c.length) out.push({ title: 'Continue watching', cards: c.map((p) => ({
      key: p.item.id, act: () => play(p.item, { startAt: p.position }),
      render: (f) => (
        <div class={`card ${f ? 'focus' : ''}`}>
          <Poster item={p.item.kind === 'episode' ? { ...p.item, icon: (favorites.value.get(p.item.seriesId ?? '')?.icon) ?? p.item.icon } : p.item} />
          <ProgBar p={p.position} d={p.duration} />
          <div class="cap">{clean(p.item.name)}</div>
        </div>
      ),
    })) });
    const wlItems = wl.data?.items ?? [];
    if (wlItems.length) out.push({ title: `From your Letterboxd watchlist · ${wl.data!.available} of ${wl.data!.total} available`, cards: wlItems.slice(0, 30).map((c) => ({
      key: `wl${c.tid}`, act: () => push({ name: 'title', tid: c.tid }),
      render: (f: boolean) => <div style={{ width: '100%' }}><Card c={c} focused={f} /></div>,
    })) });
    const favLive = [...favorites.value.values()].filter((i) => i.kind === 'live');
    const chanCard = (it: Item): Card => ({
      key: it.id, act: () => play(it, { mode: 'full' }),
      render: (f) => (
        <div class={`card chan ${f ? 'focus' : ''}`}>
          <Logo src={it.icon} name={it.name} size={72} />
          <div class="cap">{clean(it.name)}</div>
          <NowLine list={nowNext(it.epg)} />
        </div>
      ),
    });
    if (favLive.length) out.push({ title: 'Favorite channels', cards: favLive.map(chanCard) });
    if (recent.data?.length) out.push({ title: 'Recently watched channels', cards: recent.data.map(chanCard) });
    const favVod = [...favorites.value.values()].filter((i) => i.kind === 'movie' || i.kind === 'series');
    if (favVod.length) out.push({ title: 'My list', cards: favVod.map((it) => ({
      key: it.id, act: () => it.id.startsWith('t') ? push({ name: 'title', tid: Number(it.id.slice(1)) })
        : api.titleOf(it.id).then((r) => push({ name: 'title', tid: r.tid })).catch(() => push(it.kind === 'movie' ? { name: 'movie', item: it } : { name: 'show', item: it })),
      render: (f) => <div class={`card ${f ? 'focus' : ''}`}><Poster item={it} /><div class="cap">{clean(it.name)}</div></div>,
    })) });
    return out;
  }, [cont.data, recent.data, wl.data, favorites.value, elsewhere?.item.id, elsewhere?.position, devName, epgVersion.value]);

  const [r, setR] = useState(0);
  const [c, setC] = useState<number[]>([]);
  const col = (ri: number) => Math.min(c[ri] ?? 0, (rows[ri]?.cards.length ?? 1) - 1);
  const ri = Math.min(r, Math.max(0, rows.length - 1));

  useKeys((k) => {
    if (railFocused.value || !rows.length) return false;
    if (k === 'up') { setR(Math.max(0, ri - 1)); return true; }
    if (k === 'down') { setR(Math.min(rows.length - 1, ri + 1)); return true; }
    if (k === 'left') { if (col(ri) === 0) return false; const n = [...c]; n[ri] = col(ri) - 1; setC(n); return true; }
    if (k === 'right') { const n = [...c]; n[ri] = Math.min(rows[ri].cards.length - 1, col(ri) + 1); setC(n); return true; }
    if (k === 'ok') { rows[ri].cards[col(ri)]?.act(); return true; }
    if ((k === 'play' || k === 'green') && elsewhere) { takeover(); return true; }
    return false;
  });

  return (
    <div class="home">
      <h1 class="brand">Relay</h1>
      {!rows.length && !cont.loading && (
        <div class="empty welcome">
          <p>Nothing here yet. Start with <a onClick={() => go({ name: 'live' })}>Live TV</a>, <a onClick={() => go({ name: 'movies' })}>Movies</a> or <a onClick={() => go({ name: 'series' })}>Series</a>.</p>
          <p class="muted">Favorite things with the red button (F on a keyboard) and they'll show up here on every device.</p>
        </div>
      )}
      {rows.map((row, n) => (
        <section key={row.title} class={`hrow ${row.wide ? 'wide' : ''}`}>
          <h3>{row.title}</h3>
          <HScroll focus={!railFocused.value && n === ri ? col(n) : -1}>
            {row.cards.map((card, i) => (
              <div key={card.key} class="hcell" onClick={() => { setR(n); const x = [...c]; x[n] = i; setC(x); card.act(); }}>
                {card.render(!railFocused.value && n === ri && i === col(n))}
              </div>
            ))}
          </HScroll>
        </section>
      ))}
    </div>
  );
}

function HScroll({ focus, children }: { focus: number; children: any }) {
  return (
    <div class="hscroll" ref={(el) => {
      if (!el || focus < 0) return;
      const child = el.children[focus] as HTMLElement | undefined;
      if (!child) return;
      const l = child.offsetLeft, w = child.offsetWidth;
      if (l < el.scrollLeft) el.scrollLeft = l - 16;
      else if (l + w > el.scrollLeft + el.clientWidth) el.scrollLeft = l + w - el.clientWidth + 16;
      if (el.closest('.hrow')) (el.closest('.hrow') as HTMLElement).scrollIntoView({ block: 'nearest' });
    }}>{children}</div>
  );
}
