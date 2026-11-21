// The provider's own detail pages: a movie's info, a series' seasons and episodes. Cached, since they rarely change.
import type { DatabaseSync } from 'node:sqlite';
import type { Item, MovieInfo } from '../../shared/protocol.ts';
import { itemId } from '../../shared/domain.ts';
import type { Provider } from './xtream.ts';
import type { Catalog } from './catalog.ts';

const FRESH_MS = 6 * 3600_000;

export class ProviderDetails {
  private provider: Provider;
  private catalog: Catalog;
  private movies = new Map<number, { at: number; v: MovieInfo }>();
  private series: { get: ReturnType<DatabaseSync['prepare']>; put: ReturnType<DatabaseSync['prepare']> };

  constructor(db: DatabaseSync, provider: Provider, catalog: Catalog) {
    this.provider = provider; this.catalog = catalog;
    this.series = { get: db.prepare('SELECT json, fetched FROM series_cache WHERE sid = ?'), put: db.prepare('INSERT OR REPLACE INTO series_cache (sid, json, fetched) VALUES (?, ?, ?)') };
  }

  async movie(sid: number, timeoutMs = 15_000): Promise<MovieInfo> {
    const hit = this.movies.get(sid);
    if (hit && Date.now() - hit.at < FRESH_MS) return hit.v;
    const i = (await this.provider.json<any>('get_vod_info', { vod_id: String(sid) }, timeoutMs))?.info ?? {};
    const v: MovieInfo = {
      plot: i.plot || i.description || null, genre: i.genre || null, year: i.releasedate?.slice(0, 4) || i.year || null,
      duration: Number(i.duration_secs) || null, backdrop: i.backdrop_path?.[0] || null, cast: i.cast || i.actors || null,
      director: i.director || null, rating: Number(i.rating_5based) || (Number(i.rating) ? Number(i.rating) / 2 : null), // out of 5, like every rating trailer: i.youtube_trailer || null,
    };
    if (this.movies.size > 2000) this.movies.clear();
    this.movies.set(sid, { at: Date.now(), v });
    return v;
  }

  /** Series → seasons → episodes, as JSON (stored as such). */
  async seriesJson(sid: number): Promise<string> {
    const hit = this.series.get.get(sid) as { json: string; fetched: number } | undefined;
    if (hit && Date.now() - hit.fetched < FRESH_MS) return hit.json;
    const r = await this.provider.json<any>('get_series_info', { series_id: String(sid) }, 20_000);
    const parent = this.catalog.get(itemId('series', sid));
    const info = r?.info ?? {};
    const seasons = Object.entries<any[]>(r?.episodes ?? {})
      .map(([s, eps]) => ({
        season: Number(s),
        episodes: eps.map((e): Item & { plot?: string; duration?: number } => ({
          // "NF - The Roshans (2025) (IN) - S01E02 - Little we have" -> "Little we have"
          id: itemId('episode', e.id), kind: 'episode',
          name: String(e.title ?? '').replace(/^.*?\bS\d{1,2}\s?E\d{1,3}\b\s*[-:]?\s*/i, '').trim() || e.info?.name || `Episode ${e.episode_num}`,
          icon: e.info?.movie_image || null, ext: e.container_extension || 'mp4', seriesId: itemId('series', sid),
          season: Number(s), episode: Number(e.episode_num), plot: e.info?.plot || undefined,
          duration: Number(e.info?.duration_secs) || undefined,
        })).sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0)),
      }))
      .sort((a, b) => a.season - b.season);
    const json = JSON.stringify({
      id: itemId('series', sid), name: info.name || parent?.name || '', cover: info.cover || parent?.icon || null,
      backdrop: info.backdrop_path?.[0] || null, plot: info.plot || null, genre: info.genre || null,
      year: info.releaseDate?.slice(0, 4) || info.release_date?.slice(0, 4) || null, rating: Number(info.rating_5based) || parent?.rating || null,
      seasons,
    });
    this.series.put.run(sid, json, Date.now());
    return json;
  }
}
