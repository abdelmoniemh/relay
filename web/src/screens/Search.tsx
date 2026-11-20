import { useEffect, useRef, useState } from 'preact/hooks';
import type { Item } from '@shared/protocol.ts';
import { api, favorites, type TitleCard } from '../api.ts';
import { navFocused } from '../router.ts';
import { useAsync, useDebounced, useKeys, nowNext, epgVersion } from '../ui/hooks.ts';
import { Logo, NowLine } from '../ui/common.tsx';
import { displayName } from '@shared/domain.ts';
import { Icon } from '../ui/Icon.tsx';
import { img, isTizen } from '../env.ts';
import { t } from '../i18n.ts';
import { compact } from '../router.ts';
import { openItem } from '../catalogue.ts';

const GROUPS: { kind: 'live' | 'movie' | 'series'; label: string }[] = [
  { kind: 'live', label: 'Channels' }, { kind: 'movie', label: 'Movies' }, { kind: 'series', label: 'Series' },
];
let lastQ = '';


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

  // Results grouped by type (Channels / Movies / Series); focus walks the flat order.
  const groups = GROUPS.map((g) => ({ ...g, items: items.filter((it) => it.kind === g.kind).slice(0, 60) })).filter((g) => g.items.length);
  const flat = groups.flatMap((g) => g.items);

  useKeys((k) => {
    if (navFocused.value) return false;
    if (fi < 0) {
      if (k === 'down' && flat.length) { input.current?.blur(); setFi(0); return true; }
      if (k === 'ok') { input.current?.focus(); return true; }
      return false;
    }
    if (k === 'up') { if (fi === 0) { setFi(-1); input.current?.focus(); } else setFi(fi - 1); return true; }
    if (k === 'down') { setFi(Math.min(flat.length - 1, fi + 1)); return true; }
    if (k === 'ok') { pick(flat[fi]); return true; }
    return k === 'left' || k === 'right';
  });
  useEffect(() => { (document.querySelector('.search .result.focus') as HTMLElement | null)?.scrollIntoView({ block: 'nearest' }); }, [fi]);

  const kb = !navFocused.value && !compact.value;
  let n = -1;
  return (
    <div class="search page">
      <div class="search-top">
        {!onPick && <h1 class="screen-title">{t('Search')}</h1>}
        <div class={`search-field big ${kb && fi < 0 ? 'focus' : ''}`}>
          <Icon n="search" />
          <input ref={input} id="search-input" type="search" placeholder={t('Channels, movies, series')} value={q}
            onInput={(e) => { setQ((e.target as HTMLInputElement).value); setFi(-1); }} enterKeyHint="search" />
          {q && <button class="clear" aria-label={t('Clear')} onClick={() => { setQ(''); input.current?.focus(); }}><Icon n="close" /></button>}
        </div>
        <div class="chips">
          {(['', 'live', 'movie', 'series'] as const).map((k) => (
            <button key={k} class={`chip ${kind === k ? 'on' : ''}`} onClick={() => setKind(k)}>
              {k === '' ? t('All') : t(GROUPS.find((g) => g.kind === k)!.label)}
            </button>
          ))}
        </div>
      </div>
      <div class="search-results">
        {dq.length < 2 && <div class="empty">{t('Type at least two letters.')}</div>}
        {dq.length >= 2 && res.loading && !items.length && <div class="list-skel" />}
        {dq.length >= 2 && !res.loading && !items.length && <div class="empty">{t('No results for “{q}”', { q: dq })}</div>}
        {groups.map((g) => (
          <section key={g.kind} class="result-group">
            <h2 class="list-head">{t(g.label)} <small>{g.items.length}</small></h2>
            <div class="list-group">
              {g.items.map((it) => {
                n++;
                const i = n;
                return (
                  <div key={it.id} class={`list-row result ${kb && i === fi ? 'focus' : ''}`} onClick={() => pick(it)} role="button">
                    {it.kind === 'live' ? <Logo src={it.icon} name={it.name} size={48} />
                      : it.icon ? <img class="thumb-poster" src={img(it.icon, 92)} loading="lazy" alt="" /> : <span class="thumb-poster ph">{it.name.slice(0, 1)}</span>}
                    <span class="lr-main">
                      <b>{displayName(it.name)}{favorites.value.has(it.id) && <Icon n="star" filled class="fav-mark" />}</b>
                      {it.kind === 'live' ? <NowLine list={nowNext(it.epg)} /> : <span class="lr-sub">{it.rating ? `★ ${(it.rating * 2).toFixed(1)}` : ''}</span>}
                    </span>
                    <Icon n="chevron" class="lr-chev" />
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
