import { signal } from '@preact/signals';
import type { Item } from '@shared/protocol.ts';

export type Route =
  | { name: 'home' } | { name: 'live' } | { name: 'movies' } | { name: 'series' } | { name: 'search' }
  | { name: 'remote' } | { name: 'settings' }
  | { name: 'movie'; item: Item } | { name: 'show'; item: Item };

export const TOP: Route['name'][] = ['home', 'live', 'movies', 'series', 'search', 'remote', 'settings'];

export const stack = signal<Route[]>([{ name: 'home' }]);
export const route = () => stack.value[stack.value.length - 1];
export const railFocused = signal(false);

export function go(r: Route) { stack.value = [r]; }
export function push(r: Route) { stack.value = [...stack.value, r]; railFocused.value = false; }
export function back(): boolean {
  if (stack.value.length <= 1) return false;
  stack.value = stack.value.slice(0, -1);
  return true;
}
