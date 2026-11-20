import { Worker } from 'node:worker_threads';
import type { DatabaseSync } from 'node:sqlite';
import { syncedAt, type SyncPart } from './db.ts';
import { config } from './config.ts';
import type { Provider } from './xtream.ts';

type What = SyncPart;
let running: Promise<void> | null = null;
let runningWhat: What[] = [];

/** Runs a sync of these parts; if one is already running, waits for it and then syncs what it didn't cover. */
export function runSync(provider: Provider, what: What[], onLog = console.log): Promise<void> {
  if (running) {
    const rest = what.filter((w) => !runningWhat.includes(w));
    return rest.length ? running.catch(() => {}).then(() => runSync(provider, rest, onLog)) : running;
  }
  runningWhat = what;
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
  }).finally(() => { running = null; runningWhat = []; });
  return running;
}

export const isSyncing = () => running !== null;

/** Syncs on start if stale, then on a schedule. */
export function scheduleSync(db: DatabaseSync, provider: Provider, onDone: () => void) {
  const due = (part: SyncPart, hours: number) => Date.now() - syncedAt(db, part) > hours * 3600_000;
  const tick = async () => {
    const what: What[] = [];
    if (due('catalog', config.catalogRefreshHours)) what.push('catalog');
    else if (due('live', 0.5)) what.push('live'); // event channels are renamed through the day
    if (due('epg', config.epgRefreshHours)) what.push('epg');
    if (!what.length) return;
    try { await runSync(provider, what); onDone(); } catch (e) { console.error('[sync] failed:', (e as Error).message); }
  };
  tick();
  setInterval(tick, 5 * 60_000).unref();
}
