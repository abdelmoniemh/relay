// What we know about a title's media, in one place: measured by the prober (live) or the movie probe, read from the
// file's track list, or learned when a browser failed to play it. Decides "can browsers play this as it is?".
import type { DatabaseSync } from 'node:sqlite';
import { parseId } from '../../shared/domain.ts';
import type { SourceInfo, TxMode } from './media.ts';
import { probeToSource, type Prober } from './prober.ts';
import type { TrackStore, Tracks } from './tracks.ts';
import { kvGet, kvSet } from './db.ts';

/** Audio browsers (Chrome) can't decode: those films need their audio converted. */
const BROWSER_UNPLAYABLE_AUDIO = new Set(['ac3', 'eac3', 'dts', 'truehd']);
const LEARNED_KEY = 'hevc_ids';

export class MediaFacts {
  private db: DatabaseSync;
  private prober: Prober;
  private tracks: TrackStore;
  private learned: Map<string, TxMode>;
  private vod: ReturnType<DatabaseSync['prepare']>;
  private name: ReturnType<DatabaseSync['prepare']>;

  constructor(db: DatabaseSync, prober: Prober, tracks: TrackStore) {
    this.db = db; this.prober = prober; this.tracks = tracks;
    const saved = JSON.parse(kvGet(db, LEARNED_KEY) ?? '[]');
    // older format: a plain id list (all HEVC)
    this.learned = new Map(Array.isArray(saved) ? saved.map((x: any): [string, TxMode] => (Array.isArray(x) ? [x[0], x[1]] : [x, 'full'])) : []);
    this.vod = db.prepare('SELECT * FROM vod_probes WHERE id = ? AND ok = 1');
    this.name = db.prepare('SELECT name FROM items WHERE kind = ? AND sid = ?');
  }

  /** What the conversion should know about the source (deinterlacing, HDR tone mapping, 10-bit, audio layout). */
  source(id: string): SourceInfo | null {
    const { kind, sid } = parseId(id);
    if (kind === 'live') return probeToSource(this.prober.results([sid]).get(sid));
    const r = this.vod.get(id) as any;
    const t = this.tracks.get(id);
    if (!r) return t?.vcodec ? { vcodec: t.vcodec } : null;
    // the movie probe names HDR by format (hdr10 / dv / hlg); conversions care about the transfer (pq / hlg)
    const hdr = r.hdr === 'hdr10' || r.hdr === 'dv' ? 'pq' : r.hdr === 'hlg' ? 'hlg' : null;
    return { vcodec: t?.vcodec ?? r.vcodec, width: r.width, height: r.height, hdr, bitDepth: hdr ? 10 : null, interlaced: false, acodec: r.acodec, channels: r.channels };
  }

  /** The video codec if known, else a guess from the name / extension (ffmpeg corrects a wrong guess at once). */
  videoCodec(id: string, ext?: string | null): string | null {
    const known = this.source(id)?.vcodec;
    if (known) return known;
    const { kind, sid } = parseId(id);
    if (kind === 'live') return 'hevc'; // channels reach the server's HLS when they didn't play directly: almost always HEVC
    if (ext === 'avi' || ext === 'flv') return null; // old Xvid/DivX era: needs converting
    const name = (this.name.get(kind!, sid) as { name: string } | undefined)?.name ?? '';
    return /\b(x265|h\.?265|hevc|hdr|dv|2160p?|4k|uhd)\b/i.test(name) ? 'hevc' : 'h264';
  }

  /** Can't a browser (without an HEVC decoder) play it as it is? 'full' = the video, 'audio' = only the audio. */
  browserNeeds(id: string): TxMode | undefined {
    const s = this.source(id);
    if (s?.vcodec === 'hevc') return 'full';
    // Measured plain 8-bit H.264 plays in every browser: a learned "video" here was something else going wrong.
    const plainH264 = s?.vcodec === 'h264' && (s.bitDepth ?? 8) <= 8;
    const learned = this.learned.get(id);
    if (learned && !(learned === 'full' && plainH264)) return learned;
    const audio = this.tracks.get(id)?.audio[0]?.codec ?? s?.acodec;
    return audio && BROWSER_UNPLAYABLE_AUDIO.has(audio) ? 'audio' : undefined;
  }

  /** A movie's file was read (tracks): keep its quality facts for the title page and conversions. */
  recordProbe(id: string, t: Tracks) {
    const a = t.audio[0];
    const langs = (l: (string | null)[]) => [...new Set(l.filter(Boolean))].join(',');
    this.db.prepare(`INSERT OR REPLACE INTO vod_probes (id, at, ok, width, height, hdr, vcodec, acodec, channels, alangs, slangs, err) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
      .run(id, Math.floor(Date.now() / 1000), t.video?.width ?? null, t.video?.height ?? null, t.video?.hdr ?? 'sdr', t.vcodec, a?.codec ?? null, a?.channels ?? null,
        langs(t.audio.map((x) => x.lang)), langs(t.subs.map((x) => x.lang)));
  }

  /** A browser couldn't play it directly (or the server saw HEVC): every device skips that failed try from now on. */
  learn(id: string, mode: TxMode) {
    const cur = this.learned.get(id);
    if (cur === mode || (cur === 'full' && mode === 'audio')) return;
    this.learned.set(id, mode);
    kvSet(this.db, LEARNED_KEY, JSON.stringify([...this.learned].slice(-5000)));
  }
}
