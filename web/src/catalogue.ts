// What happens when someone picks something in the catalogue: one place for every screen.
import type { Item } from '@shared/protocol.ts';
import { parseTitleId } from '@shared/domain.ts';
import { api, type TitleDetail } from './api.ts';
import { push } from './router.ts';
import { play } from './playback.ts';

/** Channels play; films and shows open their title page (or the provider's own page if there's no title yet). */
export function openItem(it: Item) {
  const tid = parseTitleId(it.id);
  if (tid != null) { push({ name: 'title', tid }); return; }
  if (it.kind === 'live') { play(it, { mode: 'full' }); return; }
  api.titleOf(it.kind === 'episode' && it.seriesId ? it.seriesId : it.id).then((r) => push({ name: 'title', tid: r.tid }))
    .catch(() => push(it.kind === 'series' || it.kind === 'episode' ? { name: 'show', item: it } : { name: 'movie', item: it }));
}

/** A film's version to play, carrying the title's runtime (the provider's file rarely says). */
export function versionItem(t: Pick<TitleDetail, 'kind' | 'runtime' | 'versions'>, i = 0, knownDuration?: number | null): Item | null {
  const v = t.versions[i];
  return t.kind === 'movie' && v ? { ...v.item, duration: (t.runtime ?? 0) * 60 || knownDuration || null } : null;
}
