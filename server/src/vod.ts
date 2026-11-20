// Movies & series: classify each provider copy (language, quality, source) and group copies into titles.

export type Lang = 'en' | 'ar' | 'ar-sub' | 'other';

export interface Version {
  lang: Lang;
  uhd: boolean;
  hdr: boolean;
  dv: boolean;
  dolby: boolean;
  src: string | null;   // NF, AMZ, TOP, PRMT... (where the copy comes from)
  top250: number | null; // IMDb Top 250 rank, from the provider's "EN-TOP - 250. Title" list
  name: string;          // clean display title (no prefix, year, country)
  year: number | null;
}

const EN_SOURCES = new Set(['A+', 'EN', 'NF', 'AMZ', 'PRMT', 'UNV', 'MAX', 'PCOK', 'SKY', 'NICK', 'TOP', 'EX', 'AF', 'HBO', 'ATV', 'DSNP', 'APPLE', 'UK', 'US']);
const AR_AUDIO = new Set(['AR', 'EG', 'SHAM', 'KH', 'MA', 'IRQ', 'TN', 'DZ', 'DUB', 'BDY', 'ISL', 'POD', 'SH', 'WIT', 'VIU', 'AJ', 'MSH', 'SA', 'LB', 'SY', 'KW', 'JO', 'PS', 'LY', 'YE', 'SD']);
const AR_SUBS = new Set(['SUBS', 'SUB', 'DE', 'TR', 'AS', 'DOC', 'KID', 'PTV', 'IN', 'KR', 'FR', 'ES', 'IT']);
const QUALITY = new Set(['4K', 'UHD', 'HDR', 'DV', 'DO', 'HEVC', '8K', 'FHD']);
const ARABIC_SCRIPT = /[؀-ۿ]/;

/** Splits "4K-NF - Okja (2017)" -> prefix tokens ["4K","NF"] + rest. Tolerates "NF -X", "NF + X". */
function splitPrefix(raw: string): { tokens: string[]; rest: string } {
  const m = /^\s*((?:A\+|[A-Z0-9]{2,6})(?:-[A-Z0-9]{2,6})*)\s*[-|:+]\s*/.exec(raw);
  if (!m) return { tokens: [], rest: raw.trim() };
  return { tokens: m[1].split('-'), rest: raw.slice(m[0].length).trim() };
}

export function cleanTitle(rest: string): { name: string; year: number | null; rank: number | null } {
  let s = rest.normalize('NFKC');
  let rank: number | null = null;
  const r = /^(\d{1,3})\.\s+/.exec(s);
  if (r) { rank = Number(r[1]); s = s.slice(r[0].length); }
  let year: number | null = null;
  const bare = /\b(19\d\d|20\d\d)\s*$/.exec(s);
  // "Blade Runner 2049" is a title, not a year: a bare trailing number only counts if it's a plausible year
  const y = /\((19\d\d|20\d\d)\)/.exec(s) ?? (bare && Number(bare[1]) <= new Date().getFullYear() + 1 ? bare : null);
  if (y) { year = Number(y[1]); s = s.replace(y[0], ' '); }
  s = s.replace(/\((?:[A-Z]{2}|[A-Z]{2}\/[A-Z]{2})\)/g, ' ')   // country codes "(GB)"
    .replace(/\(\s*\)/g, ' ').replace(/\s+-\s*$/, '').replace(/\s+/g, ' ').trim();
  return { name: s, year, rank };
}

/** Classify one provider copy from its name and category name. */
export function classify(rawName: string, categoryName = ''): Version {
  const { tokens, rest } = splitPrefix(rawName);
  const cat = categoryName.normalize('NFKC').toUpperCase();
  const { name, year, rank } = cleanTitle(rest);
  const q = new Set(tokens.filter((t) => QUALITY.has(t)));
  const lt = tokens.filter((t) => !QUALITY.has(t));
  let lang: Lang = 'other';
  let src: string | null = null;
  if (lt[0] === 'AR') {
    const sub = lt[1];
    if (!sub || AR_AUDIO.has(sub)) lang = 'ar';
    else if (AR_SUBS.has(sub)) lang = 'ar-sub';
    else lang = 'ar';
  } else if (lt.length === 0 && q.size && tokens.length) {
    // "4K-AR"-style handled above; bare "4K - Title"
    lang = ARABIC_SCRIPT.test(name) ? 'ar' : 'other';
  } else if (lt[0] && AR_AUDIO.has(lt[0]) && lt[0] !== 'AR') {
    lang = 'ar'; src = lt[0];
  } else if (lt[0] === 'IN' && lt[1] === 'EN') {
    lang = 'other'; // Indian dubs of English films (Hindi audio)
  } else if (lt[0] && EN_SOURCES.has(lt[0])) {
    lang = lt[0] === 'AF' && lt[1] !== 'EN' ? 'other' : 'en';
    if (lt[0] !== 'EN') src = lt[0];
    if (lt[0] === 'EN' && lt[1] === 'TOP') src = 'TOP';
  } else if (!tokens.length) {
    // No prefix: fall back to category language
    if (ARABIC_SCRIPT.test(categoryName)) lang = /مترجم/.test(categoryName) && !ARABIC_SCRIPT.test(name) ? 'ar-sub' : 'ar';
    else if (/\bENGLISH\b|\bNETFLIX\b|\bAMAZON\b|\bHBO\b|\bAPPLE\b|\bDISNEY\b/.test(cat)) lang = 'en';
  }
  // "4K-AR - <latin title>" in "foreign films UHD" categories are subtitled foreign films, not Arabic audio
  if (lang === 'ar' && !ARABIC_SCRIPT.test(name) && (/مترجم|أجنبي|اجنبي|أجنبيه|أسيوي|آسيوي|تركي|هندي/.test(categoryName))) lang = 'ar-sub';
  const uhd = q.has('4K') || q.has('UHD') || q.has('8K') || /⁴ᴷ|\b4K\b|3840|2160/.test(categoryName.normalize('NFKC').toUpperCase());
  const dv = q.has('DV') || /\bDV\b|DOLBY VISION/.test(cat);
  const hdr = dv || q.has('HDR') || /\bHDR\b/.test(cat);
  const dolby = q.has('DO') || /DOLBY ?AUDIO|ATMOS/.test(cat);
  return { lang, uhd, hdr, dv, dolby, src, top250: src === 'TOP' && rank ? rank : null, name, year };
}

/** Identity used to merge copies of the same title when the provider has no TMDB id. */
export function titleKey(kind: string, tmdb: number | null, name: string, year: number | null): string {
  if (tmdb) return `${kind}:t${tmdb}`;
  const n = name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return `${kind}:n${n}:${year ?? ''}`;
}

export const parseTmdb = (v: unknown): number | null => {
  const n = Number(String(v ?? '').trim());
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** Language groups of the movie/series catalogue as bits of titles.lmask. */
export const LANG_BITS: Record<Lang, number> = { en: 1, ar: 2, 'ar-sub': 4, other: 8 };
