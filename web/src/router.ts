import { signal } from '@preact/signals';
import type { Item } from '@shared/protocol.ts';
import { isTizen } from './env.ts';

export type Route =
  | { name: 'home' } | { name: 'sports' } | { name: 'live' } | { name: 'movies' } | { name: 'series' } | { name: 'search' }
  | { name: 'remote' } | { name: 'settings' }
  | { name: 'movie'; item: Item } | { name: 'show'; item: Item }
  | { name: 'title'; tid: number } | { name: 'grid'; kind: 'movie' | 'series'; filters: Record<string, string>; title?: string }
  | { name: 'categories'; kind: 'movie' | 'series' };

/** The same five sections on every device (DESIGN.md › Navigation). 'vod' = Movies & TV: opens whichever of
 *  Movies / Series was used last. Remote and Settings are utilities, not sections. */
export type Tab = 'home' | 'live' | 'sports' | 'vod' | 'search' | 'remote' | 'settings';
export const SECTIONS: Tab[] = ['home', 'live', 'sports', 'vod', 'search'];
export const UTILITIES: Tab[] = isTizen ? ['settings'] : ['remote', 'settings'];
export const lastVod = signal<'movies' | 'series'>('movies');
export const tabOf = (n: Route['name']): Tab =>
  n === 'movies' || n === 'series' || n === 'grid' || n === 'categories' || n === 'title' || n === 'movie' || n === 'show' ? 'vod'
    : n === 'home' || n === 'live' || n === 'sports' || n === 'search' || n === 'remote' || n === 'settings' ? n : 'home';

/** Compact (phone) layout: same breakpoints as the phone block in styles.css. */
const mq = typeof matchMedia === 'function' ? matchMedia('(max-width: 760px), (orientation: landscape) and (max-height: 500px) and (pointer: coarse)') : null;
export const compact = signal(!isTizen && !!mq?.matches);
const onMq = () => { compact.value = !isTizen && !!mq?.matches; };
if (mq?.addEventListener) mq.addEventListener('change', onMq); else (mq as any)?.addListener?.(onMq);

export const stack = signal<Route[]>([{ name: 'home' }]);
export const route = () => stack.value[stack.value.length - 1];
/** D-pad focus is on the navigation bar (TV / keyboard) rather than the screen. */
export const navFocused = signal(false);

export function go(r: Route) { stack.value = [r]; navFocused.value = false; }
export function push(r: Route) { stack.value = [...stack.value, r]; navFocused.value = false; }
export function back(): boolean {
  if (stack.value.length <= 1) return false;
  stack.value = stack.value.slice(0, -1);
  return true;
}

/** Desktop top bar turns solid once the screen under it scrolls. */
export const scrolled = signal(false);
if (typeof document !== 'undefined') {
  document.addEventListener('scroll', (e) => {
    const el = e.target as HTMLElement;
    if (el && el.closest && el.closest('.screen')) scrolled.value = el.scrollTop > 8;
  }, true);
}
