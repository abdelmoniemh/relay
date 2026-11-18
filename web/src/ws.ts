import { signal } from '@preact/signals';
import type { ClientMsg, DeviceInfo, Lease, ServerMsg } from '@shared/protocol.ts';
import { server, token, myDeviceId } from './api.ts';

export const connected = signal(false);
export const devices = signal<DeviceInfo[]>([]);
export const lease = signal<Lease | null>(null);

type Handler = (m: ServerMsg) => void;
const handlers = new Set<Handler>();
export const onServer = (h: Handler) => { handlers.add(h); return () => handlers.delete(h); };

let ws: WebSocket | null = null;
let retry = 0;
let queue: string[] = [];

export function send(m: ClientMsg) {
  const s = JSON.stringify(m);
  if (ws?.readyState === WebSocket.OPEN) ws.send(s);
  else if (m.t !== 'heartbeat') queue.push(s);
}

export function connect() {
  if (!token.value || ws) return;
  const url = server.value.replace(/^http/, 'ws') + `/ws?token=${encodeURIComponent(token.value)}`;
  const sock = (ws = new WebSocket(url));
  sock.onopen = () => {
    connected.value = true; retry = 0;
    for (const s of queue) sock.send(s);
    queue = [];
  };
  sock.onmessage = (e) => {
    const m = JSON.parse(e.data) as ServerMsg;
    if (m.t === 'state') { devices.value = m.devices; lease.value = m.lease; }
    else if (m.t === 'hello') myDeviceId.value = m.deviceId;
    handlers.forEach((h) => h(m));
  };
  sock.onclose = (e) => {
    connected.value = false; ws = null;
    if (e.code === 4001) { token.value = null; return; }
    setTimeout(connect, Math.min(5000, 300 * 2 ** retry++));
  };
}

// Reconnect immediately when the device wakes up / app comes to foreground.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !ws) connect();
});
