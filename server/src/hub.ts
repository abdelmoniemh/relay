// Coordinates the provider's single allowed connection across devices.
// Invariant: a device is only told to start (`granted`) after the previous holder confirmed it stopped
// (or timed out / is offline), so the provider never sees two simultaneous streams from us.
import { parseTitleId } from '../../shared/domain.ts';
import type { ClientMsg, DeviceInfo, Item, Lease, ServerMsg } from '../../shared/protocol.ts';

export interface HubDeps {
  listDevices(): Omit<DeviceInfo, 'online'>[];
  saveProgress(item: Item, position: number, duration: number): void;
  resumePosition(item: Item): number; // 0 if none
  urls(item: Item): string[];
  /** Refuse items that aren't in the catalog (adult content is never stored, so never playable). */
  allowed?(item: Item): boolean;
  txMode?(item: Item): 'full' | 'audio' | undefined;
  uhd?(item: Item): boolean;
  /** Source is interlaced: browsers should take the server's deinterlacing conversion. */
  interlaced?(item: Item): boolean;
  /** A film title (t123) sent to a device: the version that suits it (TV builds from before titles were sent play only items). */
  versionFor?(tid: number, deviceId: string): Promise<Item | null>;
  /** The lease now belongs to `deviceId` (or nobody): free server-side streams held for anyone else. */
  leaseMoved?(deviceId: string | null): void | Promise<void>;
  now?: () => number;
  stopTimeoutMs?: number;
  log?: (m: string) => void;
}

type Send = (m: ServerMsg) => void;

export class Hub {
  private clients = new Map<string, Set<Send>>();
  private lease: Lease | null = null;
  private stopWaiters = new Map<string, () => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private deps: HubDeps;

  constructor(deps: HubDeps) { this.deps = deps; }

  private now() { return this.deps.now?.() ?? Date.now(); }
  private online(id: string) { return (this.clients.get(id)?.size ?? 0) > 0; }

  getLease() { return this.lease; }
  streamActive() { return !!this.lease && this.online(this.lease.deviceId); }

  connect(deviceId: string, send: Send) {
    let set = this.clients.get(deviceId);
    if (!set) this.clients.set(deviceId, (set = new Set()));
    set.add(send);
    send({ t: 'hello', deviceId });
    this.broadcastState();
    return () => {
      set!.delete(send);
      if (!set!.size) {
        this.clients.delete(deviceId);
        this.stopWaiters.get(deviceId)?.(); // an offline device can't be streaming
      }
      this.broadcastState();
    };
  }

  broadcast(m: ServerMsg) { for (const sends of this.clients.values()) for (const send of sends) send(m); }
  /** Ask a device to start playing something (like "send to"); false if it's offline. */
  sendPlay(target: string, item: Item, from: string, eventId?: string | null): boolean {
    if (!this.online(target)) return false;
    this.sendTo(target, { t: 'play', item, from, ...(eventId ? { eventId } : {}) });
    return true;
  }

  private sendTo(deviceId: string, m: ServerMsg) {
    for (const s of this.clients.get(deviceId) ?? []) s(m);
  }

  state(): ServerMsg {
    const devices = this.deps.listDevices().map((d) => ({ ...d, online: this.online(d.id) }));
    return { t: 'state', devices, lease: this.lease };
  }

  broadcastState() {
    const s = this.state();
    for (const sends of this.clients.values()) for (const send of sends) send(s);
  }

  /** Serialize lease changes so concurrent requests can't interleave stop/grant. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {});
    return p;
  }

  private persist(lease: Lease) {
    if (lease.item.kind === 'live' || lease.duration > 0) this.deps.saveProgress(lease.item, lease.position, lease.duration);
  }

  /** Ask the current holder to stop and wait for its ack (or timeout / disconnect). */
  private async revoke(to: string) {
    const holder = this.lease;
    if (!holder || holder.deviceId === to || !this.online(holder.deviceId)) return;
    const ack = new Promise<void>((resolve) => {
      const timer = setTimeout(() => { this.deps.log?.(`stop ack timeout from ${holder.deviceId}`); done(); }, this.deps.stopTimeoutMs ?? 2500);
      const done = () => { clearTimeout(timer); this.stopWaiters.delete(holder.deviceId); resolve(); };
      this.stopWaiters.set(holder.deviceId, done);
    });
    this.sendTo(holder.deviceId, { t: 'stop', reason: 'handoff', to });
    await ack;
  }

  play(deviceId: string, item: Item, startAt?: number) {
    if (this.deps.allowed && !this.deps.allowed(item)) {
      this.sendTo(deviceId, { t: 'error', message: 'Not available' });
      return Promise.resolve();
    }
    return this.exclusive(async () => {
      const prev = this.lease;
      await this.revoke(deviceId);
      await this.deps.leaseMoved?.(deviceId);
      if (prev) this.persist(this.lease ?? prev);
      const handedOver = this.lease ?? prev;
      let start = 0;
      if (item.kind === 'live' && item.catchup) start = Math.max(0, startAt ?? 0); // archive programme: where asked
      else if (item.kind !== 'live') {
        if (startAt != null) start = startAt;
        else if (handedOver && handedOver.item.id === item.id) start = handedOver.position;
        else start = this.deps.resumePosition(item);
      }
      this.lease = { deviceId, item, position: start, duration: handedOver?.item.id === item.id ? handedOver.duration : 0, paused: false, since: this.now() };
      if (item.kind === 'live') this.deps.saveProgress(item, 0, 0);
      this.deps.log?.(`lease -> ${deviceId}: ${item.name} @${Math.round(start)}s`);
      const tx = this.deps.txMode?.(item);
      this.sendTo(deviceId, { t: 'granted', item, startAt: start, urls: this.deps.urls(item), ...(tx ? { tx } : {}), ...(this.deps.interlaced?.(item) ? { interlaced: true } : {}), ...(this.deps.uhd?.(item) ? { uhd: true } : {}) });
      this.broadcastState();
    });
  }

  async handle(deviceId: string, msg: ClientMsg) {
    switch (msg.t) {
      case 'play':
        return this.play(deviceId, msg.item, msg.startAt);
      case 'takeover':
        if (this.lease) return this.play(deviceId, this.lease.item);
        return;
      case 'heartbeat': {
        const l = this.lease;
        if (!l || l.deviceId !== deviceId) {
          // Playing without the lease (missed a stop?) — enforce the single connection.
          this.sendTo(deviceId, { t: 'stop', reason: 'handoff', to: l?.deviceId });
          return;
        }
        l.position = msg.position; l.duration = msg.duration; l.paused = msg.paused;
        this.persist(l);
        this.broadcastState();
        return;
      }
      case 'stopped': {
        const l = this.lease;
        if (l && l.deviceId === deviceId) {
          if (msg.duration > 0 || l.item.kind === 'live') { l.position = msg.position; l.duration = msg.duration; }
          this.persist(l);
          const waiter = this.stopWaiters.get(deviceId);
          if (waiter) waiter(); // handoff in progress: play() will replace the lease
          else {
            this.lease = null;
            this.broadcastState();
            // freeing the server's own uses of the connection is a lease change like any other: serialized with play()
            await this.exclusive(async () => { await this.deps.leaseMoved?.(null); });
          }
        } else {
          this.stopWaiters.get(deviceId)?.();
        }
        return;
      }
      case 'sendTo': {
        const item = msg.item ?? this.lease?.item;
        if (!item) return;
        if (!this.online(msg.target)) {
          this.sendTo(deviceId, { t: 'error', message: 'That device is offline' });
          return;
        }
        const tid = parseTitleId(item.id);
        const deliver = (it: Item) => this.sendTo(msg.target, { t: 'play', item: it, startAt: msg.startAt, from: deviceId, ...(msg.eventId ? { eventId: msg.eventId } : {}), ...(tid != null ? { titleId: item.id } : {}) });
        if (tid == null || !this.deps.versionFor) { deliver(item); return; }
        this.deps.versionFor(tid, msg.target).then((v) => (v ? deliver(v) : this.sendTo(deviceId, { t: 'error', message: 'Not available' })), () => this.sendTo(deviceId, { t: 'error', message: 'Not available' }));
        return;
      }
      case 'remote':
        if (msg.cmd === 'stop' && this.lease?.deviceId === msg.target) {
          this.sendTo(msg.target, { t: 'stop', reason: 'remote' });
          return;
        }
        this.sendTo(msg.target, { t: 'remote', cmd: msg.cmd, arg: msg.arg, from: deviceId });
        return;
    }
  }
}
