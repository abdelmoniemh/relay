// Per-device settings in localStorage. Storage can be unavailable (private browsing, TV quirks): then they last the session.
import { signal, effect, type Signal } from '@preact/signals';

export const storage = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string | null) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

/** A signal kept under `relay.<key>`: read once, saved on every change. */
export function persisted<T>(key: string, read: (raw: string | null) => T, write: (v: T) => string | null = (v) => (v == null ? null : String(v))): Signal<T> {
  const k = `relay.${key}`;
  const s = signal<T>(read(storage.get(k)));
  effect(() => storage.set(k, write(s.value)));
  return s;
}
