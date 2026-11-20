import { Worker } from 'node:worker_threads';
import type { DatabaseSync } from 'node:sqlite';
import { kvGet } from './db.ts';
import { config } from './config.ts';
import type { Provider } from './xtream.ts';

type What = 'catalog' | 'live' | 'epg';
let running: Promise<void> | null = null;

export function runSync(provider: Provider, what: What[], onLog = console.log): Promise<void> {
  if (running) return running;
  running = new Promise<void>((resolve, reject) => {
    const w = new Worker(new URL('./sync-worker.ts', import.meta.url), {
      workerData: { dbPath: config.dbPath, provider: provider.creds, epgUrl: config.epgUrl, what },
    });
    w.on('message', (m) => {
      if (m.log) onLog(`[sync] ${m.log}`);
      if (m.error) reject(new Error(m.error));
      if (m.done) resolve();
    });
    w.on('error', reject);
    w.on('exit', (code) => (code ? reject(new Error(`sync worker exit ${code}`)) : resolve()));
  }).finally(() => { running = null; });
  return running;
}

export const isSyncing = () => running !== null;

/** Syncs on start if stale, then on a schedule. */
export function scheduleSync(db: DatabaseSync, provider: Provider, onDone: () => void) {
  const due = (key: string, hours: number) => Date.now() - Number(kvGet(db, key) ?? 0) > hours * 3600_000;
  const tick = async () => {
    const what: What[] = [];
    if (due('catalog_synced', config.catalogRefreshHours)) what.push('catalog');
    else if (due('live_synced', 0.5)) what.push('live'); // event channels are renamed through the day
    if (due('epg_synced', config.epgRefreshHours)) what.push('epg');
    if (!what.length) return;
    try { await runSync(provider, what); onDone(); } catch (e) { console.error('[sync] failed:', (e as Error).message); }
  };
  tick();
  setInterval(tick, 5 * 60_000).unref();
}
