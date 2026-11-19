// Text normalization for messy IPTV names: regions, duplicate-channel families, and sports match parsing.

/** "UK| SPORT ᴴᴰ" -> "UK"; "4K| ..." -> "4K"; no prefix -> null */
export function regionOf(categoryName: string): string | null {
  const m = /^\s*([A-Z0-9]{2,5})\s*[|:]/.exec(categoryName.normalize('NFKC').toUpperCase());
  return m ? m[1] : null;
}

const QUALITY = /\b(UHD|FHD|HD|SD|LQ|HQ|4K|8K|RAW|HEVC|H\.?265|H\.?264|\d{2,3}\s*FPS|\d{3,4}\s*P|STABLE|BACKUP|BK|ALT|VIP|GOLD|PLUS\+?|MULTI|AUDIO|DOLBY|NEW|TEST|EXCLUSIVE)\b/g;

/** Channel identity without region prefix and quality tags: "UK: SKY SPORTS MAIN EVENT ᴴᴰ ◉" -> "SKY SPORTS MAIN EVENT" */
export function channelKey(name: string): string {
  let s = name.normalize('NFKC').toUpperCase();
  s = s.replace(/(\p{L})⚽(\p{L})/gu, '$1O$2'); // "SP⚽RTS"
  s = s.replace(/^\s*([A-Z0-9]{2,5})\s*[|:]\s*/, '');      // region prefix
  s = s.replace(/^\s*([A-Z0-9]{2,5})\s*[|:]\s*/, '');      // occasionally doubled ("VIP: UK: ...")
  s = s.replace(/[()[\]{}]/g, ' ');
  s = s.replace(QUALITY, ' ');
  s = s.replace(/[^\p{L}\p{N}+&' ]+/gu, ' ');
  return s.split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w))                      // drop stray "&", "+"
    .map((w) => (w.length > 3 && w.endsWith('S') ? w.slice(0, -1) : w)) // EVENT/EVENTS, SPORT/SPORTS
    .join(' ');
}

// ---------------- sports ----------------

export type Sport =
  | 'football' | 'basketball' | 'american-football' | 'hockey' | 'baseball' | 'tennis' | 'darts' | 'cricket'
  | 'rugby' | 'fighting' | 'motorsport' | 'golf' | 'snooker' | 'other';

const SPORT_WORDS: [Sport, RegExp][] = [
  ['other', /\b(HANDBALL|STARLIGUE|EHF|VOLLEYBALL|VOLLEY|FUTSAL|WATER POLO|NETBALL|PADEL|BADMINTON|TABLE TENNIS|CYCLING|SKIING|ATHLETICS|SWIMMING)\b/i],
  ['basketball', /\b(NBA|WNBA|NCAAB|NCAAM|NCAAW|BASKETBALL|EUROLEAGUE|EUROCUP|BASKET|HOOPS|FLOHOOPS)\b/i],
  ['american-football', /\b(NFL|NCAAF|COLLEGE FOOTBALL|SUPER BOWL|CFL)\b/i],
  ['hockey', /\b(NHL|HOCKEY|FLOHOCKEY|AHL|KHL|WHL|OHL|BCHL|USHL)\b/i],
  ['baseball', /\b(MLB|MILB|BASEBALL)\b/i],
  ['tennis', /\b(ATP|WTA|TENNIS|WIMBLEDON|ROLAND|US OPEN|DAVIS CUP|BJK)\b/i],
  ['darts', /\b(DARTS|PDC|BDO)\b/i],
  ['cricket', /\b(CRICKET|WBBL|BBL|IPL|T20|ODI|TEST MATCH|ASHES|PSL|CPL)\b/i],
  ['rugby', /\b(RUGBY|SUPER LEAGUE|PREMIERSHIP RUGBY|URC|SIX NATIONS|NATIONS CHAMPIONSHIP|NATIONS CUP ROUND|WORLD RUGBY|NRL|TOP 14|AUTUMN NATIONS)\b/i],
  ['fighting', /\b(UFC|BOXING|MMA|PFL|BELLATOR|WWE|AEW|FIGHT NIGHT|MATCHROOM|DAZN BOXING|WRESTLING|FLOWRESTLING|GRAPPLING)\b/i],
  ['motorsport', /\b(F1|FORMULA ?1|GRAND PRIX|MOTOGP|NASCAR|INDYCAR|WRC|RALLY|SUPERCROSS|MXGP|SUPERBIKE)\b/i],
  ['golf', /\b(GOLF|PGA|LPGA|DP WORLD|LIV|RYDER CUP|THE MASTERS)\b/i],
  ['snooker', /\b(SNOOKER|POOL)\b/i],
  ['football', /\b(FOOTBALL|SOCCER|FUTBOL|FUTEBOL|LEAGUE|LIGA|LALIGA|LIGUE|SERIE A|BUNDESLIGA|EREDIVISIE|PREMIERSHIP|EPL|EFL|FA CUP|CARABAO|UEFA|UCL|UEL|UECL|CHAMPIONS|NATIONS|WORLD CUP|EURO 20\d\d|AFCON|COPA|MLS|SPL|SPFL|SAUDI PRO|ROSHN|CONCACAF|CONMEBOL|CUP)\b|⚽/i],
];

export function sportOf(...texts: (string | null | undefined)[]): Sport {
  const t = texts.filter(Boolean).join(' ').normalize('NFKC');
  for (const [s, re] of SPORT_WORDS) if (re.test(t)) return s;
  return 'other';
}

/** Football team / player name identity: "Sheff Utd" == "Sheffield United", "Man City" == "Manchester City". */
export function teamKey(name: string): string {
  let s = name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  s = s.replace(/&/g, ' and ').replace(/[.'’`]/g, '').replace(/[^a-z0-9 ]+/g, ' ');
  s = ` ${s} `
    .replace(/ utd /g, ' united ').replace(/ man /g, ' manchester ').replace(/ sheff /g, ' sheffield ')
    .replace(/ wolves /g, ' wolverhampton ').replace(/ spurs /g, ' tottenham ').replace(/ nottm /g, ' nottingham ')
    .replace(/ (fc|afc|cf|sc|ac|ssc|as|cd|ud|rc|sl|fk|sk|bk|if|club|de|the|hotspur|wanderers|albion|town|city of) /g, ' ')
    .replace(/ (w|women|womens|ladies|fem|femenino|feminine) /g, ' women ');
  return s.replace(/\s+/g, ' ').trim();
}

export interface When { year?: number; month?: number; day?: number; hour: number; minute: number; tz?: string }

export interface ParsedMatch {
  home: string;
  away: string;
  competition: string | null;
  live: boolean;      // explicitly marked live
  replay: boolean;    // explicitly a replay/highlights/classic
  time: string | null; // "19:45" if embedded in the text (event channel names)
  when: When | null;   // date/time embedded in the text, in the source's local time zone
}

const VS = /\s+(?:vs?\.?|versus|-v-)\s+/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Pulls a date/time out of an event title, returning the text without it. */
function extractWhen(s: string): { when: When | null; rest: string } {
  const to24 = (h: number, ap?: string) => (ap?.toLowerCase() === 'pm' && h < 12 ? h + 12 : ap?.toLowerCase() === 'am' && h === 12 ? 0 : h);
  let m = /\(?\b(20\d\d)-(\d\d)-(\d\d)[ T](\d\d):(\d\d)(?::\d\d)?\)?/.exec(s); // (2026-11-20 20:00:00)
  if (m) return { when: { year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5] }, rest: s.replace(m[0], ' ') };
  m = /\b(UK|ET|EST|EDT|PT|CET|GMT)?\s*(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})[:.](\d\d)\s*(am|pm)?/i.exec(s); // UK Sat 14 Nov 3:00pm
  if (m) {
    const tz = { UK: 'Europe/London', GMT: 'Europe/London', ET: 'America/New_York', EST: 'America/New_York', EDT: 'America/New_York', PT: 'America/Los_Angeles', CET: 'Europe/Paris' }[(m[1] ?? '').toUpperCase()];
    return { when: { day: +m[2], month: MONTHS.indexOf(m[3].toLowerCase()) + 1, hour: to24(+m[4], m[6]), minute: +m[5], ...(tz ? { tz } : {}) }, rest: s.slice(0, m.index) };
  }
  m = /@?\s*\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{1,2})[:.](\d\d)\s*(am|pm)?/i.exec(s); // @ Nov 18 9:30 PM
  if (m) return { when: { month: MONTHS.indexOf(m[1].toLowerCase()) + 1, day: +m[2], hour: to24(+m[3], m[5]), minute: +m[4] }, rest: s.replace(m[0], ' ') };
  m = /\b(\d{1,2})\/(\d{1,2})\s+(\d{1,2})[:.](\d\d)\b/.exec(s); // 24/10 12:30 (day/month)
  if (m && +m[2] <= 12) return { when: { day: +m[1], month: +m[2], hour: +m[3], minute: +m[4] }, rest: s.replace(m[0], ' ') };
  m = /\b([01]?\d|2[0-3])[:.]([0-5]\d)\s*(am|pm)?(?![\d/])/i.exec(s); // 19:45 pm / 15.00
  if (m) return { when: { hour: to24(+m[1], m[3]), minute: +m[2] }, rest: s.replace(m[0], ' ') };
  return { when: null, rest: s };
}

/**
 * Parses fixtures out of EPG titles and event-channel names, e.g.
 * "Valencia vs Real Madrid - Spanish LaLiga 2026/2027 - Week 12", "EFL 26/27:Bristol City v Sheff Utd",
 * "Live Football 04 : Portugal vs Denmark 19:45 pm", "AU (STAN 96) | Arsenal v Manchester City  Premier League Matchweek 12 (2026-11-30 03:20:50)",
 * "flohoops: 2026 Hiram College vs Case Western Reserve - Men's (Hiram vs CWRU) (2026-11-18 19:00:00)",
 * "Denver Nuggets vs Boston Celtics @ Nov 18 9:30 PM :NBA  10".
 */
export function parseMatch(text: string): ParsedMatch | null {
  let s = text.normalize('NFKC').replace(/\t/g, ' ').trim();
  if (!VS.test(s)) return null;
  const live = /\b(live|en vivo|en directo)\b|مباشر/i.test(s);
  const thisYear = new Date().getFullYear();
  const { when, rest } = extractWhen(s);
  s = rest;
  const oldYear = [...s.matchAll(/\b(19|20)(\d\d)\b(?![\/-])/g)].some((m) => Number(m[0]) < thisYear - 1) || (when?.year != null && when.year < thisYear - 1);
  const replay = oldYear || /\b(replay|highlights?|classics?|rewind|review|preview|reloaded|best of|goals of|recap|extended|mini match|magazine|en diferido)\b/i.test(s);

  // Trailing ":NBA  10" style competition tags, leading service prefixes ("flohoops: 2026", "Flo (FLSP) 261: 2025", "AU (STAN 17) |")
  let competition: string | null = null;
  const tail = /\s:([A-Za-z][\w ]{1,20}?)\s+\d+\s*$/.exec(s);
  if (tail) { competition = tail[1].trim(); s = s.slice(0, tail.index); }
  s = s.replace(/^[A-Z]{2}\s*\([^)]*\)\s*\|\s*/, '')
    .replace(/^\s*flo(hoops|hockey|wrestling|live|football|volleyball|softball|baseball|rugby|racing|track|swimming|grappling|marching|bowling|cheer)?\s*(\([^)]*\))?\s*\d*\s*:\s*/i, (m) => { if (!competition) competition = m.replace(/[:\d()]/g, '').trim(); return ''; })
    .replace(/\b(live|en vivo|en directo)\b[:\s-]*/ig, ' ')
    .replace(/\((?:[^()]*\bvs?\b[^()]*|home|away|tbd[^)]*)\)/ig, ' ')   // "(Hiram vs CWRU)", "(Home)"
    .replace(/\([^)]*\)?/g, ' ')                                     // any other parenthetical, incl. unclosed "(Kick-off 11"
    .replace(/@\s*$/, ' ');

  let core = s;
  const segs = core.split(/\s+[-–|]\s+|\s{2,}|\s*\/\/\s*/).map((x) => x.trim()).filter(Boolean);
  if (segs.length > 1) {
    const idx = segs.findIndex((p) => VS.test(` ${p} `));
    if (idx < 0) return null;
    core = segs[idx];
    const others = segs.filter((_, i) => i !== idx && !/^(men'?s|women'?s|mens|womens)$/i.test(segs[i]) && !/^\d+$/.test(segs[i])).join(' - ');
    if (others) competition = competition ? `${competition} - ${others}` : others;
  }
  const colon = core.lastIndexOf(':');
  if (colon > 0 && VS.test(core.slice(colon))) {
    const pre = core.slice(0, colon).trim();
    core = core.slice(colon + 1);
    if (pre && !/^(live )?(football|soccer|event|ppv|match|game)?\s*\d*$/i.test(pre)) competition = competition ? `${pre} - ${competition}` : pre;
  }
  const parts = core.split(VS);
  if (parts.length !== 2) return null;
  const clean = (x: string) => x.replace(/^\s*(19|20)\d\d\s+/, '').replace(/\b(19|20)\d\d(\/\d{2,4})?\b/g, '')
    .replace(/[\s:–|-]+$|^[\s:–|-]+/g, '').replace(/\s+/g, ' ').trim();
  const home = clean(parts[0]), away = clean(parts[1]);
  if (!home || !away || home.length > 45 || away.length > 45 || /^\d+$/.test(home) || /^\d+$/.test(away)) return null;
  const time = when ? `${String(when.hour).padStart(2, '0')}:${String(when.minute).padStart(2, '0')}` : null;
  return { home, away, competition: competition ? clean(competition) || null : null, live, replay, time, when };
}

/** Wall-clock time in an IANA zone -> unix seconds. Missing date parts default to "nearest to now". */
export function zonedToUnix(w: When, tz: string, now = Date.now() / 1000): number {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const at = (unix: number) => Object.fromEntries(fmt.formatToParts(new Date(unix * 1000)).map((p) => [p.type, Number(p.value)])) as Record<string, number>;
  const local = at(now);
  const offsetOf = (unix: number) => { const p = at(unix); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) / 1000 - Math.floor(unix / 60) * 60; };
  const y = w.year ?? local.year, mo = w.month ?? local.month, d = w.day ?? local.day;
  let guess = Date.UTC(y, mo - 1, d, w.hour, w.minute) / 1000;
  guess -= offsetOf(guess);
  if (w.day == null && guess < now - 12 * 3600) guess += 86400; // time only, long past: it's tomorrow's
  if (w.year == null && w.month != null && guess < now - 180 * 86400) guess = zonedToUnix({ ...w, year: y + 1 }, tz, now);
  return guess;
}

export const EURO_FOOTBALL = /\b(UEFA|CHAMPIONS LEAGUE|EUROPA|CONFERENCE LEAGUE|NATIONS LEAGUE|PREMIER LEAGUE|EPL|EFL|CHAMPIONSHIP|LEAGUE (ONE|TWO)|FA CUP|CARABAO|LALIGA|LA LIGA|SERIE A|BUNDESLIGA|LIGUE 1|EREDIVISIE|PRIMEIRA|SPFL|SCOTTISH|WSL|AFCON|AFRICA CUP)\b/i;
/** European football never kicks off at 03:00 UK time: those EPG airings are replays. */
export function implausibleKickoff(competition: string | null, title: string, start: number): boolean {
  if (!EURO_FOOTBALL.test(`${competition ?? ''} ${title}`)) return false;
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hourCycle: 'h23' }).format(new Date(start * 1000)));
  return h < 11 || h >= 22;
}

/** Order-independent identity for a fixture. */
export function matchKey(m: { home: string; away: string }): string {
  return [teamKey(m.home), teamKey(m.away)].sort().join(' | ');
}

// ---------------- adult content (never stored) ----------------
const ADULT_CATEGORY = /\b(FOR ADULTS?|ADULTS? ONLY|XXX|PORN\w*|EROTIC\w*|NSFW|18\s*\+|\+\s*18)\b/i;
const ADULT_CHANNEL = /\b(BRAZZERS|HUSTLER|PRIVATE ?TV|PLAYBOY ?TV|PLAYBOY|REDLIGHT|RED ?LIGHT ?HD|VIVID|DORCEL|PENTHOUSE|EROX|EROXXX|EXXXOTICA|SPICE ?TV|XXX|PORN\w*|VENUS ?TV|PASSION ?XXX|BLUE ?HUSTLER|BABES ?TV|BANG ?U|PINK ?O|O-LA-LA|OLALA|FRENCH ?LOVER|MEIDEN ?VAN|DUSK|SEXTREME|SEXY ?HOT|BEATE ?UHSE|DARING|PURE ?BABES|XY ?MIX|SUPERONE|EROTIC\w*)\b/i;

/** "Adult Swim" is cartoons, not adult content. */
const notAdult = (s: string) => s.replace(/ADULT[\s-]*SWIM/gi, '');

export function isAdultCategory(name: string): boolean {
  return ADULT_CATEGORY.test(notAdult(name.normalize('NFKC')));
}

/** Live channels only: movie titles like "xXx" or "Hustlers" are fine; movies rely on the provider flag + category. */
export function isAdultChannel(name: string): boolean {
  return ADULT_CHANNEL.test(notAdult(name.normalize('NFKC')));
}
