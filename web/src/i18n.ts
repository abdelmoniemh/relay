import { signal } from '@preact/signals';
import { AR } from './i18n.ar.ts';

/** UI language. English strings are the keys; Arabic comes from i18n.ar.ts (missing keys fall back to English). */
export type Lang = 'en' | 'ar';
const KEY = 'relay.lang';
const saved = (() => { try { return localStorage.getItem(KEY); } catch { return null; } })();
export const lang = signal<Lang>(saved === 'ar' ? 'ar' : 'en');

export function applyLang() {
  const el = document.documentElement;
  el.lang = lang.value;
  el.dir = lang.value === 'ar' ? 'rtl' : 'ltr';
}

export function setLang(l: Lang) {
  lang.value = l;
  try { localStorage.setItem(KEY, l); } catch {}
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
