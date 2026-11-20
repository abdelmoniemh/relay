// Domain rules both the server and the clients follow. One definition each, so they can't drift apart.
import type { Kind } from './protocol.ts';

// ---- ids ----
// Catalog items: l123 (live), m123 (movie), s123 (series), e123 (episode).
// A film/show title that groups provider copies: t123 (clients only use it to open the title page).
const PREFIX: Record<Kind, string> = { live: 'l', movie: 'm', series: 's', episode: 'e' };
const KIND_OF: Record<string, Kind> = { l: 'live', m: 'movie', s: 'series', e: 'episode' };

export const itemId = (kind: Kind, sid: number | string) => PREFIX[kind] + sid;
/** `kind` is undefined for ids that aren't catalog items (e.g. title ids). */
export const parseId = (id: string): { kind: Kind | undefined; sid: number } => ({ kind: KIND_OF[id[0]], sid: Number(id.slice(1)) });
export const titleId = (tid: number) => `t${tid}`;
export const parseTitleId = (id: string): number | null => (/^t\d+$/.test(id) ? Number(id.slice(1)) : null);
/** Movies and episodes: things with a file (tracks, chapters, thumbnails). */
export const isVodId = (id: string) => /^[me]\d+$/.test(id);

// ---- names ----
/** Provider names carry a region / source tag ("UK: BBC One", "NF - Moonlight"): what people should see. */
export const displayName = (s: string) => s.replace(/^([A-Z0-9]{2,4}|4K)\s*[|:]\s*/, '').replace(/^[A-Z]{2,3} - /, '');

// ---- watching ----
/** Watched past this share of the runtime counts as finished. */
export const FINISHED = 0.95;
/** Stopped before this many seconds in counts as not started (no "resume"). */
export const MIN_RESUME_S = 30;
export const isFinished = (position: number, duration: number) => duration > 0 && position >= duration * FINISHED;
export const isResumable = (position: number, duration: number) => duration > 0 && position > MIN_RESUME_S && position < duration * FINISHED;

// ---- languages ----
// Players and files report ISO 639-1 'en', 639-2 'eng' / 'fre', or 'en-GB'.
const ALIASES: string[][] = [
  ['en', 'eng'], ['ar', 'ara'], ['fr', 'fre', 'fra'], ['de', 'ger', 'deu'], ['es', 'spa'], ['it', 'ita'], ['pt', 'por'], ['tr', 'tur'],
  ['hi', 'hin'], ['ur', 'urd'], ['ru', 'rus'], ['ja', 'jpn'], ['ko', 'kor'], ['zh', 'chi', 'zho'], ['nl', 'dut', 'nld'], ['fa', 'per', 'fas'],
  ['he', 'heb'], ['el', 'gre', 'ell'], ['pl', 'pol'], ['sv', 'swe'], ['no', 'nor', 'nob'], ['da', 'dan'], ['fi', 'fin'], ['ta', 'tam'], ['te', 'tel'],
];
/** Any language code in its 2-letter form when known ('fre' → 'fr'). */
export function lang2(code: string | null | undefined): string | null {
  const c = (code ?? '').toLowerCase().split(/[-_]/)[0];
  if (!c || c === 'und' || c === 'unk') return null;
  return ALIASES.find((a) => a.includes(c))?.[0] ?? c;
}
export const sameLang = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && lang2(a) === lang2(b);
/** Languages offered as playback preferences (others still play). */
export const PREFERRED_LANGS = ['en', 'ar', 'fr', 'es', 'de', 'it', 'pt', 'tr', 'hi', 'ur', 'ru', 'ja', 'ko', 'zh'];
