import { persisted } from './storage.ts';
import { lang2 } from '@shared/domain.ts';
import { AR } from './i18n.ar.ts';

/** UI language. English strings are the keys; Arabic comes from i18n.ar.ts (missing keys fall back to English). */
export type Lang = 'en' | 'ar';
export const lang = persisted<Lang>('lang', (v) => (v === 'ar' ? 'ar' : 'en'));

export function applyLang() {
  const el = document.documentElement;
  el.lang = lang.value;
  el.dir = lang.value === 'ar' ? 'rtl' : 'ltr';
}

export function setLang(l: Lang) {
  lang.value = l;
  applyLang();
}

/** Translate: t('Playing on {name}', { name }) */
export function t(s: string, vars?: Record<string, string | number>): string {
  let out = lang.value === 'ar' ? AR[s] ?? s : s;
  if (vars) for (const k in vars) out = out.split(`{${k}}`).join(String(vars[k]));
  return out;
}

/** Plural helper: tn(n, '{n} source', '{n} sources'). Arabic uses its own forms when given. */
export function tn(n: number, one: string, many: string) {
  return t(n === 1 ? one : many, { n: n.toLocaleString() });
}

/** A language's name in the UI language ('ara' → "Arabic" / "العربية"); the code itself if the browser doesn't know it. */
export function languageName(code: string): string {
  const c = lang2(code) ?? code;
  try { return new Intl.DisplayNames([lang.value], { type: 'language' }).of(c) ?? c.toUpperCase(); } catch { return t(FALLBACK_NAMES[c] ?? c.toUpperCase()); }
}
// The TV's browser (Chromium 63–69) has no Intl.DisplayNames: the languages people actually pick, named here.
const FALLBACK_NAMES: Record<string, string> = {
  en: 'English', ar: 'Arabic', fr: 'French', de: 'German', es: 'Spanish', it: 'Italian', pt: 'Portuguese', tr: 'Turkish', hi: 'Hindi', ur: 'Urdu',
  ru: 'Russian', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', nl: 'Dutch', fa: 'Persian', he: 'Hebrew', el: 'Greek', pl: 'Polish', sv: 'Swedish',
};
