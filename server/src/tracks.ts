// Audio and subtitle tracks of a movie/episode file, and choosing between them.
import { execFile } from 'node:child_process';

export interface AudioTrack { n: number; lang: string | null; title: string | null; codec: string; channels: number | null; def: boolean }
export interface SubTrack { n: number; lang: string | null; title: string | null; codec: string; forced: boolean; sdh: boolean; text: boolean }
export interface Tracks { vcodec: string | null; audio: AudioTrack[]; subs: SubTrack[] }

/** Subtitle formats that convert to WebVTT. Picture subtitles (PGS, VobSub, DVB) can't be turned into text. */
const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text', 'microdvd', 'subviewer', 'subviewer1', 'sami', 'realtext', 'jacosub', 'mpl2', 'pjs', 'vplayer', 'stl']);

const lang = (l: unknown) => {
  const s = typeof l === 'string' ? l.trim().toLowerCase() : '';
  return s && s !== 'und' && s !== 'unk' ? s : null;
};

/** Parses `ffprobe -show_streams -of json` output (kept separate for tests). */
export function parseTracks(json: string): Tracks {
  const streams = (JSON.parse(json).streams ?? []) as any[];
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
  return { vcodec: video?.codec_name ?? null, audio, subs };
}

/** Reads the track list (only the start of the file is needed: through the VOD proxy this is usually from memory). */
export function probeTracks(url: string, timeoutMs = 12_000): Promise<Tracks> {
  return new Promise((resolve, reject) => {
    execFile('ffprobe', ['-v', 'error', '-user_agent', 'Relay/1.0 (like VLC/3.0.20)', '-probesize', '2M', '-analyzeduration', '0',
      '-show_entries', 'stream=index,codec_type,codec_name,channels:stream_tags=language,title:stream_disposition=default,forced,hearing_impaired,attached_pic',
      '-of', 'json', url], { timeout: timeoutMs, maxBuffer: 4 << 20 }, (err, out) => {
      if (err) return reject(err);
      try { resolve(parseTracks(out)); } catch (e) { reject(e); }
    });
  });
}

// ---- choosing ----

/** ISO 639-1/-2 codes for one language, e.g. 'ar' -> ['ar', 'ara']. */
const ALIASES: Record<string, string[]> = {
  en: ['en', 'eng'], ar: ['ar', 'ara'], fr: ['fr', 'fre', 'fra'], de: ['de', 'ger', 'deu'], es: ['es', 'spa'], it: ['it', 'ita'],
  pt: ['pt', 'por'], tr: ['tr', 'tur'], hi: ['hi', 'hin'], ur: ['ur', 'urd'], ru: ['ru', 'rus'], ja: ['ja', 'jpn'], ko: ['ko', 'kor'],
  zh: ['zh', 'chi', 'zho'], nl: ['nl', 'dut', 'nld'], fa: ['fa', 'per', 'fas'], he: ['he', 'heb'], el: ['el', 'gre', 'ell'],
  pl: ['pl', 'pol'], sv: ['sv', 'swe'], no: ['no', 'nor', 'nob'], da: ['da', 'dan'], fi: ['fi', 'fin'], ta: ['ta', 'tam'], te: ['te', 'tel'],
};
/** Normalises any language code to its 2-letter form when known. */
export function lang2(code: string | null | undefined): string | null {
  const c = (code ?? '').toLowerCase().split(/[-_]/)[0];
  if (!c) return null;
  for (const [k, v] of Object.entries(ALIASES)) if (v.includes(c)) return k;
  return c;
}
const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && lang2(a) === lang2(b);

/** Audio to start with: the preferred language, else the file's default, else the first. */
export function pickAudio(t: Tracks, pref: string | null): number {
  if (!t.audio.length) return -1;
  const byLang = pref ? t.audio.find((a) => same(a.lang, pref)) : undefined;
  return (byLang ?? t.audio.find((a) => a.def) ?? t.audio[0]).n;
}

/**
 * Subtitle shown at start, or -1. `pref` = language wanted, or 'off'. Forced subtitles (signs/foreign dialogue)
 * in the audio's language are shown even when subtitles are off.
 */
export function pickSub(t: Tracks, pref: string | null, audioLang: string | null): number {
  const text = t.subs.filter((s) => s.text);
  if (pref && pref !== 'off') {
    const m = text.filter((s) => same(s.lang, pref));
    const best = m.find((s) => !s.forced && !s.sdh) ?? m.find((s) => !s.forced) ?? m[0];
    if (best) return best.n;
  }
  const forced = text.find((s) => s.forced && (same(s.lang, audioLang) || !s.lang));
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
