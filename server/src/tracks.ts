// Audio and subtitle tracks of a movie/episode file, and choosing between them.
import { execFile } from 'node:child_process';
import { lang2, sameLang } from '../../shared/domain.ts';

export interface AudioTrack { n: number; lang: string | null; title: string | null; codec: string; channels: number | null; def: boolean }
export interface SubTrack { n: number; lang: string | null; title: string | null; codec: string; forced: boolean; sdh: boolean; text: boolean }
export interface Chapter { start: number; end: number; title: string }
export interface Tracks { vcodec: string | null; audio: AudioTrack[]; subs: SubTrack[]; chapters?: Chapter[]; duration?: number | null }

/** Where to offer "skip intro" / "skip recap", and where the credits start (next episode shows from there). */
export interface Markers { intro?: [number, number]; recap?: [number, number]; credits?: number }

/** From chapter names: "Intro", "Opening", "Title Sequence", "OP"; "Recap", "Previously"; "Credits", "End Credits", "ED". */
export function markersFrom(chapters: Chapter[] | undefined, duration?: number | null): Markers {
  const m: Markers = {};
  for (const c of chapters ?? []) {
    const t = c.title.toLowerCase().trim();
    const len = c.end - c.start;
    if (!m.intro && len > 5 && len < 300 && /\b(intro|opening( credits| titles)?|title sequence|theme song|op)\b/.test(t)) m.intro = [c.start, c.end];
    else if (!m.recap && len > 5 && len < 300 && /\b(recap|previously)\b/.test(t)) m.recap = [c.start, c.end];
    else if (m.credits == null && /\b(credits|ending|outro|ed)\b/.test(t) && !/opening/.test(t) && (!duration || c.start > duration * 0.6)) m.credits = c.start;
  }
  return m;
}

/** Subtitle formats that convert to WebVTT. Picture subtitles (PGS, VobSub, DVB) can't be turned into text. */
const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text', 'microdvd', 'subviewer', 'subviewer1', 'sami', 'realtext', 'jacosub', 'mpl2', 'pjs', 'vplayer', 'stl']);

const lang = (l: unknown) => {
  const s = typeof l === 'string' ? l.trim().toLowerCase() : '';
  return s && s !== 'und' && s !== 'unk' ? s : null;
};

/** Parses `ffprobe -show_streams -of json` output (kept separate for tests). */
export function parseTracks(json: string): Tracks {
  const all = JSON.parse(json);
  const streams = (all.streams ?? []) as any[];
  const chapters: Chapter[] = ((all.chapters ?? []) as any[]).map((c) => ({ start: Number(c.start_time), end: Number(c.end_time), title: String(c.tags?.title ?? '') }))
    .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end));
  const duration = Number(all.format?.duration) || null;
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  let a = 0, s = 0;
  const audio: AudioTrack[] = [], subs: SubTrack[] = [];
  for (const st of streams) {
    const title = typeof st.tags?.title === 'string' ? st.tags.title.slice(0, 80) : null;
    if (st.codec_type === 'audio') {
      audio.push({ n: a++, lang: lang(st.tags?.language), title, codec: st.codec_name, channels: st.channels ?? null, def: !!st.disposition?.default });
    } else if (st.codec_type === 'subtitle') {
      const t = `${title ?? ''}`.toLowerCase();
      subs.push({ n: s++, lang: lang(st.tags?.language), title, codec: st.codec_name, forced: !!st.disposition?.forced || /forced/.test(t),
        sdh: !!st.disposition?.hearing_impaired || /\bsdh\b|\bcc\b|hearing/.test(t), text: TEXT_SUBS.has(st.codec_name) });
    }
  }
  return { vcodec: video?.codec_name ?? null, audio, subs, chapters, duration };
}

/** Reads the track list (only the start of the file is needed: through the VOD proxy this is usually from memory). */
export function probeTracks(url: string, timeoutMs = 12_000): Promise<Tracks> {
  return new Promise((resolve, reject) => {
    execFile('ffprobe', ['-v', 'error', '-user_agent', 'Relay/1.0 (like VLC/3.0.20)', '-probesize', '2M', '-analyzeduration', '0',
      '-show_chapters', '-show_entries', 'format=duration:stream=index,codec_type,codec_name,channels:stream_tags=language,title:stream_disposition=default,forced,hearing_impaired,attached_pic',
      '-of', 'json', url], { timeout: timeoutMs, maxBuffer: 4 << 20 }, (err, out) => {
      if (err) return reject(err);
      try { resolve(parseTracks(out)); } catch (e) { reject(e); }
    });
  });
}

/**
 * Track lists per title, read once (through the VOD proxy that's usually the cached header) and kept in the db.
 * Shared by playback (which languages to offer) and the background prefetcher (markers, thumbnails).
 */
export class TrackStore {
  private cache: Map<string, Tracks>;
  private save: (entries: [string, Tracks][]) => void;
  constructor(initial: Record<string, Tracks>, save: (entries: [string, Tracks][]) => void) {
    this.cache = new Map(Object.entries(initial));
    this.save = save;
  }
  /** Known, and read with chapters/duration (older entries were not). */
  get(id: string): Tracks | undefined { const t = this.cache.get(id); return t && t.chapters ? t : undefined; }
  async probe(id: string, url: string): Promise<Tracks> {
    const t = await probeTracks(url);
    this.cache.set(id, t);
    this.save([...this.cache].slice(-3000));
    return t;
  }
}

// ---- choosing ----


/** Audio to start with: the preferred language, else the file's default, else the first. */
export function pickAudio(t: Tracks, pref: string | null): number {
  if (!t.audio.length) return -1;
  const byLang = pref ? t.audio.find((a) => sameLang(a.lang, pref)) : undefined;
  return (byLang ?? t.audio.find((a) => a.def) ?? t.audio[0]).n;
}

/**
 * Subtitle shown at start, or -1. `pref` = language wanted, or 'off'. Forced subtitles (signs/foreign dialogue)
 * in the audio's language are shown even when subtitles are off.
 */
export function pickSub(t: Tracks, pref: string | null, audioLang: string | null): number {
  const text = t.subs.filter((s) => s.text);
  if (pref && pref !== 'off') {
    const m = text.filter((s) => sameLang(s.lang, pref));
    const best = m.find((s) => !s.forced && !s.sdh) ?? m.find((s) => !s.forced) ?? m[0];
    if (best) return best.n;
  }
  const forced = text.find((s) => s.forced && (sameLang(s.lang, audioLang) || !s.lang));
  return forced ? forced.n : -1;
}

/** Name shown in the player's audio/subtitle menu. */
export function trackName(t: { lang: string | null; title: string | null }, extra = ''): string {
  let name = '';
  try { name = t.lang ? new Intl.DisplayNames(['en'], { type: 'language' }).of(lang2(t.lang)!) ?? '' : ''; } catch {}
  if (!name) name = t.title || 'Unknown';
  else if (t.title && !t.title.toLowerCase().includes(name.toLowerCase())) name += ` (${t.title})`;
  return (name + extra).replace(/"/g, "'");
}

/**
 * The keyframe a seek to `at` really lands on. With the video copied, ffmpeg can only start on a keyframe,
 * up to several seconds before `at`; the player has to know where, or the clock and subtitles are off by that much.
 * Reads one packet header at the position (no decoding).
 */
export function keyframeAt(url: string, at: number, timeoutMs = 8000): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile('ffprobe', ['-v', 'error', '-user_agent', 'Relay/1.0 (like VLC/3.0.20)', '-read_intervals', `${at}%+#1`, '-select_streams', 'v:0',
      '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', url], { timeout: timeoutMs }, (err, out) => {
      if (err) return reject(err);
      const line = out.split('\n').find((l) => /K/.test(l.split(',')[1] ?? '')) ?? out.split('\n')[0];
      const t = Number(line?.split(',')[0]);
      Number.isFinite(t) && t >= 0 && t <= at + 1 ? resolve(t) : reject(new Error(`no keyframe near ${at}s`));
    });
  });
}
