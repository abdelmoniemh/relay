import { useEffect, useRef, useState } from 'preact/hooks';
import type { Item } from '@shared/protocol.ts';
import { api, type TitleCard } from '../api.ts';
import { play } from '../playback.ts';
import { push, railFocused } from '../router.ts';
import { useAsync, useDebounced, useKeys, nowNext, epgVersion } from '../ui/hooks.ts';
import { VList } from '../ui/VList.tsx';
import { Logo, NowLine, Star, clean } from '../ui/common.tsx';
import { img, isTizen } from '../env.ts';

const KLABEL: Record<string, string> = { live: 'LIVE', movie: 'MOVIE', series: 'SERIES' };
let lastQ = '';

export function openItem(it: Item) {
  if (it.id.startsWith('t')) { push({ name: 'title', tid: Number(it.id.slice(1)) }); return; }
  if (it.kind === 'live') play(it, { mode: 'full' });
  else if (it.kind === 'movie') push({ name: 'movie', item: it });
  else if (it.kind === 'series') push({ name: 'show', item: it });
  else play(it);
}

export function Search({ onPick, autoFocus = true }: { onPick?: (it: Item) => void; autoFocus?: boolean }) {
  const [q, setQ] = useState(lastQ);
  const dq = useDebounced(q.trim(), 220);
  const [kind, setKind] = useState<'' | 'live' | 'movie' | 'series'>('');
  // Live channels come from the catalog; movies & series as titles (one result per film/show, not per copy).
  const res = useAsync(async () => {
    if (dq.length < 2) return [] as Item[];
    const asItem = (t: TitleCard): Item => ({ id: `t${t.tid}`, kind: t.kind, name: t.year ? `${t.name} (${t.year})` : t.name, icon: t.poster, rating: t.rating });
    if (kind === 'live') return api.search(dq, 'live');
    if (kind) return (await api.titleSearch(dq, kind)).map(asItem);
    const [live, titles] = await Promise.all([api.search(dq, 'live'), api.titleSearch(dq)]);
    return [...titles.slice(0, 30).map(asItem), ...live.slice(0, 30)];
  }, [dq, kind]);
  const items = res.data ?? [];
  const [fi, setFi] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  epgVersion.value;
  useEffect(() => { lastQ = q; }, [q]);
  useEffect(() => { if (autoFocus && !isTizen) input.current?.focus(); }, []);
  const pick = onPick ?? openItem;

  useKeys((k) => {
    if (railFocused.value) return false;
    if (fi < 0) {
      if (k === 'down' && items.length) { input.current?.blur(); setFi(0); return true; }
      if (k === 'ok') { input.current?.focus(); return true; }
      return false;
    }
    if (k === 'up') { if (fi === 0) { setFi(-1); input.current?.focus(); } else setFi(fi - 1); return true; }
    if (k === 'down') { setFi(Math.min(items.length - 1, fi + 1)); return true; }
    if (k === 'ok') { pick(items[fi]); return true; }
    if (k === 'left') return false;
    return false;
  });

  return (
    <div class="search">
      <div class="search-bar">
        <input ref={input} class={fi < 0 && !railFocused.value ? 'focus' : ''} type="search" placeholder="Search channels, movies, series…" value={q}
          onInput={(e) => { setQ((e.target as HTMLInputElement).value); setFi(-1); }} enterKeyHint="search" />
        <div class="chips">
          {(['', 'live', 'movie', 'series'] as const).map((k) => <button key={k} class={kind === k ? 'sel' : ''} onClick={() => setKind(k)}>{k ? KLABEL[k] : 'ALL'}</button>)}
        </div>
      </div>
      {dq.length >= 2 && !res.loading && !items.length && <div class="empty">No results for “{dq}”</div>}
      <VList count={items.length} rowH={84} focus={fi} render={(i, f) => {
        const it = items[i];
        return (
          <div class={`row result ${f ? 'focus' : ''}`} onClick={() => pick(it)}>
            {it.kind === 'live' ? <Logo src={it.icon} name={it.name} size={56} /> : <img class="thumb small" src={img(it.icon, 92)} loading="lazy" alt="" />}
            <div class="meta">
              <div class="name">{clean(it.name)} <Star id={it.id} /></div>
              {it.kind === 'live' ? <NowLine list={nowNext(it.epg)} /> : <div class="muted small">{it.rating ? `★ ${(it.rating * 2).toFixed(1)}` : ''}</div>}
            </div>
            <span class={`badge k-${it.kind}`}>{KLABEL[it.kind]}</span>
          </div>
        );
      }} />
    </div>
  );
}
