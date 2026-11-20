import { signal } from '@preact/signals';
import type { ClientMsg, DeviceInfo, Lease, ServerMsg } from '@shared/protocol.ts';
import { server, token, myDeviceId, setCredentials } from './api.ts';
import { t } from './i18n.ts';

export const connected = signal(false);
export const devices = signal<DeviceInfo[]>([]);
export const lease = signal<Lease | null>(null);
/** A device's name for people ("another device" if it's gone). */
export const deviceName = (id?: string | null) => devices.value.find((d) => d.id === id)?.name ?? t('another device');

type Handler = (m: ServerMsg) => void;
const handlers = new Set<Handler>();
export const onServer = (h: Handler) => { handlers.add(h); return () => handlers.delete(h); };

let ws: WebSocket | null = null;
let retry = 0;
/** Sent while offline: delivered on reconnect if still recent (a "play" from a minute ago isn't what anyone wants now). */
let queue: { s: string; at: number }[] = [];
const STALE_MS = 10_000;

export function send(m: ClientMsg) {
  const s = JSON.stringify(m);
  if (ws?.readyState === WebSocket.OPEN) ws.send(s);
  else if (m.t !== 'heartbeat') queue.push({ s, at: Date.now() });
}

export function connect() {
  if (!token.value || ws) return;
  const url = server.value.replace(/^http/, 'ws') + `/ws?token=${encodeURIComponent(token.value)}`;
  const sock = (ws = new WebSocket(url));
  sock.onopen = () => {
    connected.value = true; retry = 0;
    for (const q of queue) if (Date.now() - q.at < STALE_MS) sock.send(q.s);
    queue = [];
  };
  sock.onmessage = (e) => {
    let m: ServerMsg;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.t === 'state') { devices.value = m.devices; lease.value = m.lease; }
    else if (m.t === 'hello') myDeviceId.value = m.deviceId;
    handlers.forEach((h) => h(m));
  };
  sock.onclose = (e) => {
    connected.value = false; ws = null;
    if (e.code === 4001) { setCredentials(null, null); return; } // unpaired on the server: forget the token for good
    setTimeout(connect, Math.min(5000, 300 * 2 ** retry++));
  };
}

// Reconnect immediately when the device wakes up / app comes to foreground.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !ws) connect();
});
