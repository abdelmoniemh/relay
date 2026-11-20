import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import type { ProviderCreds } from './xtream.ts';

/** Accepts an Xtream-style M3U link (get.php?username=..&password=..) or explicit XTREAM_* env vars. */
export function parseProvider(env = process.env): ProviderCreds {
  if (env.XTREAM_URL && env.XTREAM_USER && env.XTREAM_PASS) {
    return { base: env.XTREAM_URL.replace(/\/+$/, ''), user: env.XTREAM_USER, pass: env.XTREAM_PASS };
  }
  const m3u = env.M3U_URL;
  if (!m3u) throw new Error('Set M3U_URL (or XTREAM_URL/XTREAM_USER/XTREAM_PASS) in server/.env');
  const u = new URL(m3u);
  const user = u.searchParams.get('username');
  const pass = u.searchParams.get('password');
  if (!user || !pass) throw new Error('M3U_URL has no username/password; plain M3U playlists are not supported yet');
  return { base: u.origin, user, pass };
}

const dataDir = resolve(process.env.DATA_DIR ?? './data');
mkdirSync(dataDir, { recursive: true });

export const config = {
  port: Number(process.env.PORT ?? 8787),
  dataDir,
  dbPath: resolve(dataDir, 'relay.db'),
  webDir: resolve(import.meta.dirname, '../../web/dist'),
  epgUrl: process.env.EPG_URL || null,
  catalogRefreshHours: 12,
  epgRefreshHours: 6,
};
