import { useEffect, useRef, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import type { Item, Programme } from '@shared/protocol.ts';
import { pushKeys, type Key } from '../keys.ts';
import { api } from '../api.ts';

/** Register a key handler that always sees the latest closure. */
export function useKeys(h: (k: Key) => boolean | void, layer = 1, enabled = true) {
  const r = useRef(h);
  r.current = h;
  useEffect(() => (enabled ? pushKeys((k) => r.current(k), layer) : undefined), [enabled, layer]);
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | undefined; error: Error | undefined; loading: boolean } {
  const [s, set] = useState<{ data?: T; error?: Error; loading: boolean }>({ loading: true });
  useEffect(() => {
    let live = true;
    set((p) => ({ data: p.data, loading: true }));
    fn().then((data) => live && set({ data, loading: false }), (error) => live && set({ error, loading: false }));
    return () => { live = false; };
  }, deps);
  return s as any;
}

export function useDebounced<T>(v: T, ms: number) {
  const [d, set] = useState(v);
  useEffect(() => { const t = setTimeout(() => set(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

const PAGE = 120;
/** Sparse paged list: only fetches the pages the virtual list actually shows. */
export function usePaged(key: string, fetchPage: ((offset: number, limit: number) => Promise<{ items: Item[]; total: number }>) | null) {
  const pages = useRef(new Map<number, Item[]>());
  const inflight = useRef(new Set<number>());
  const [total, setTotal] = useState<number | null>(null);
  const [, bump] = useState(0);
  const keyRef = useRef(key);

  const load = (p: number) => {
    if (!fetchPage || pages.current.has(p) || inflight.current.has(p)) return;
    inflight.current.add(p);
    const k = keyRef.current;
    fetchPage(p * PAGE, PAGE).then((r) => {
      if (k !== keyRef.current) return;
      pages.current.set(p, r.items);
      setTotal(r.total);
      bump((n) => n + 1);
    }).finally(() => inflight.current.delete(p));
  };

  useEffect(() => {
    keyRef.current = key;
    pages.current = new Map(); inflight.current = new Set();
    setTotal(null);
    load(0);
  }, [key]);

  return {
    total: total ?? 0,
    ready: total !== null,
    get: (i: number) => pages.current.get(Math.floor(i / PAGE))?.[i % PAGE],
    ensure: (start: number, end: number) => { for (let p = Math.floor(start / PAGE); p <= Math.floor(Math.max(start, end - 1) / PAGE); p++) load(p); },
  };
}

// ---- EPG now/next, batched across all visible rows ----
export const epgVersion = signal(0);
const epg = new Map<string, { list: Programme[]; exp: number }>();
let want = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;

export function nowNext(ch: string | null | undefined): Programme[] | undefined {
  if (!ch) return undefined;
  const now = Date.now() / 1000;
  const e = epg.get(ch);
  if (!e || e.exp < now) {
    want.add(ch);
    if (!timer) timer = setTimeout(flush, 60);
  }
  return e?.list.filter((p) => p.stop > now);
}

function flush() {
  timer = null;
  const chs = [...want]; want = new Set();
  for (let i = 0; i < chs.length; i += 200) {
    const batch = chs.slice(i, i + 200);
    const now = Date.now() / 1000;
    batch.forEach((c) => epg.set(c, { list: epg.get(c)?.list ?? [], exp: now + 60 })); // avoid refetch storms
    api.nowNext(batch).then((r) => {
      for (const [ch, list] of Object.entries(r)) epg.set(ch, { list, exp: list[0]?.stop ?? now + 1800 });
      epgVersion.value++;
    }).catch(() => {});
  }
}
