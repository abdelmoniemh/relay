// The provider allows one connection at a time. Everything that opens one goes through here:
// foreground uses (a device streaming, the server's own conversions) always win; background work (quality
// probes, preparing titles) runs only while nothing else uses it, one job at a time, and is stopped first.

/** Something in the foreground that may hold the connection (asked, not told). */
export interface Holder { active(): boolean }

/** Background work: told when it may run, and stopped (connection closed) when it must not. */
export interface Worker {
  readonly busy: boolean;
  /** Close the connection; resolves when it's closed. */
  stop(): Promise<void>;
  /** The connection is free: start if there's work. */
  kick(): void;
}

/** The provider keeps counting a connection for a moment after it's closed. */
const RELEASE_MS = 400;

export class ProviderSlot {
  private holders: Holder[] = [];
  private workers: Worker[] = [];
  /** Foreground uses about to start (between clearing the slot and holding it): background work waits. */
  private claims = 0;

  hold(h: Holder) { this.holders.push(h); }
  work(w: Worker) { this.workers.push(w); }

  mayRun(w: Worker) { return !this.claims && !this.holders.some((h) => h.active()) && !this.workers.some((o) => o !== w && o.busy); }

  /** Keep background work out until the returned function is called (e.g. while a device is being granted). */
  claim(): () => void {
    this.claims++;
    let done = false;
    return () => { if (done) return; done = true; this.claims--; if (!this.claims) this.released(); };
  }

  /** A foreground use is starting: stop background work; resolves once its connection is closed (and let go). */
  async clear(): Promise<void> {
    const busy = this.workers.filter((w) => w.busy);
    if (!busy.length) return;
    await Promise.all(busy.map((w) => w.stop()));
    await new Promise((r) => setTimeout(r, RELEASE_MS));
  }

  /** A foreground use ended: background work may start. */
  released() { setTimeout(() => { for (const w of this.workers) if (this.mayRun(w)) w.kick(); }, 0); }
}
