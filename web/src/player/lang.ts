// Language codes as players report them (ISO 639-1 'en', 639-2 'eng'/'fre', or 'en-GB'), compared loosely.
const ALIASES: string[][] = [
  ['en', 'eng'], ['ar', 'ara'], ['fr', 'fre', 'fra'], ['de', 'ger', 'deu'], ['es', 'spa'], ['it', 'ita'], ['pt', 'por'], ['tr', 'tur'],
  ['hi', 'hin'], ['ur', 'urd'], ['ru', 'rus'], ['ja', 'jpn'], ['ko', 'kor'], ['zh', 'chi', 'zho'], ['nl', 'dut', 'nld'], ['fa', 'per', 'fas'],
  ['he', 'heb'], ['el', 'gre', 'ell'], ['pl', 'pol'], ['sv', 'swe'], ['no', 'nor', 'nob'], ['da', 'dan'], ['fi', 'fin'], ['ta', 'tam'], ['te', 'tel'],
];
export function lang2(code: string | null | undefined): string | null {
  const c = (code ?? '').toLowerCase().split(/[-_]/)[0];
  if (!c) return null;
  return ALIASES.find((a) => a.includes(c))?.[0] ?? c;
}
export const sameLang = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && lang2(a) === lang2(b);
