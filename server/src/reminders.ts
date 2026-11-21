// Reminders for guide programmes and sports events: a minute before the start every open Relay app shows it,
// installed iPhone/desktop apps get a notification (Web Push), and optionally one device starts playing it.
//
// Push messages carry no payload (so no RFC 8291 encryption is needed): the service worker asks the server what
// is due, with the secret it got when subscribing.
import type { DatabaseSync } from 'node:sqlite';
import { createECDH, createPrivateKey, randomBytes, sign, createHash } from 'node:crypto';
import type { Item } from '../../shared/protocol.ts';
import { kvGet, kvSet } from './db.ts';

export interface Reminder {
  id: string;
  item: Item;            // the channel (or catch-up-able programme channel)
  title: string;         // programme / event title
  start: number;         // unix seconds
  stop: number | null;
  eventId: string | null;
  /** Device to start it on at the start time, or null (just remind). */
  autoplay: string | null;
  created: number;
  fired: number | null;
}

/** How long before the start reminders fire. */
export const LEAD_S = 60;

const b64u = (b: Buffer) => b.toString('base64url');

export class Reminders {
  private db: DatabaseSync;
  private vapid: { pub: string; jwk: Record<string, string> };
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS reminders (
        id TEXT PRIMARY KEY, json TEXT NOT NULL, start INTEGER NOT NULL, fired INTEGER
      );
      CREATE INDEX IF NOT EXISTS reminders_start ON reminders (start);
      CREATE TABLE IF NOT EXISTS push_subs (
        endpoint TEXT PRIMARY KEY, device TEXT, secret TEXT NOT NULL, created INTEGER NOT NULL, failures INTEGER NOT NULL DEFAULT 0
      );
    `);
    this.vapid = this.loadVapid();
  }

  list(): Reminder[] {
    const now = Date.now() / 1000;
    return (this.db.prepare('SELECT json, fired FROM reminders WHERE start > ? ORDER BY start').all(now - 6 * 3600) as { json: string; fired: number | null }[])
      .map((r) => ({ ...JSON.parse(r.json), fired: r.fired }));
  }
  add(r: Omit<Reminder, 'id' | 'created' | 'fired'>): Reminder {
    const id = createHash('sha1').update(`${r.item.id}|${r.start}|${r.eventId ?? ''}`).digest('hex').slice(0, 16);
    const full: Reminder = { ...r, id, created: Date.now(), fired: null };
    this.db.prepare('INSERT OR REPLACE INTO reminders (id, json, start, fired) VALUES (?, ?, ?, NULL)').run(id, JSON.stringify(full), Math.floor(r.start));
    return full;
  }
  remove(id: string) { this.db.prepare('DELETE FROM reminders WHERE id = ?').run(id); }

  /** Reminders whose time has come (and not fired yet); marks them fired. */
  takeDue(now = Date.now() / 1000): Reminder[] {
    const rows = this.db.prepare('SELECT json FROM reminders WHERE fired IS NULL AND start <= ? AND start > ?').all(now + LEAD_S, now - 30 * 60) as { json: string }[];
    const due = rows.map((r) => JSON.parse(r.json) as Reminder);
    for (const r of due) this.db.prepare('UPDATE reminders SET fired = ? WHERE id = ?').run(Math.floor(now), r.id);
    this.db.prepare('DELETE FROM reminders WHERE start < ?').run(now - 2 * 86400);
    return due;
  }
  /** What a service worker shows when woken by a push: reminders that fired in the last few minutes. */
  recentlyFired(now = Date.now() / 1000): Reminder[] {
    return (this.db.prepare('SELECT json FROM reminders WHERE fired IS NOT NULL AND fired > ?').all(now - 10 * 60) as { json: string }[]).map((r) => JSON.parse(r.json));
  }

  /** Check every 15s; `fire` delivers (WS, autoplay), then pushes go out. */
  start(fire: (r: Reminder) => void, log: (m: string) => void = () => {}) {
    const tick = () => {
      for (const r of this.takeDue()) {
        try { fire(r); } catch (e) { log(`reminder ${r.id}: ${(e as Error).message}`); }
        this.pushAll(log).catch(() => {});
      }
    };
    tick();
    this.timer = setInterval(tick, 15_000);
    this.timer.unref();
  }

  // ---- Web Push (VAPID, no payload) ----
  private loadVapid() {
    const saved = kvGet(this.db, 'vapid');
    if (saved) return JSON.parse(saved);
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const pub = ecdh.getPublicKey(); // 65 bytes, uncompressed
    const jwk = { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: b64u(ecdh.getPrivateKey()) };
    const v = { pub: b64u(pub), jwk };
    kvSet(this.db, 'vapid', JSON.stringify(v));
    return v;
  }
  /** Public key the browser subscribes with (applicationServerKey). */
  get publicKey() { return this.vapid.pub; }

  subscribe(endpoint: string, device: string | null): string {
    if (!/^https:\/\//.test(endpoint)) throw new Error('bad endpoint');
    const old = this.db.prepare('SELECT secret FROM push_subs WHERE endpoint = ?').get(endpoint) as { secret: string } | undefined;
    const secret = old?.secret ?? b64u(randomBytes(18));
    this.db.prepare('INSERT OR REPLACE INTO push_subs (endpoint, device, secret, created, failures) VALUES (?, ?, ?, ?, 0)').run(endpoint, device, secret, Date.now());
    return secret;
  }
  unsubscribe(endpoint: string) { this.db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(endpoint); }
  validSecret(secret: string) { return !!secret && !!this.db.prepare('SELECT 1 FROM push_subs WHERE secret = ?').get(secret); }

  /** VAPID JWT (ES256) for one push service. */
  vapidAuth(endpoint: string, now = Math.floor(Date.now() / 1000)): string {
    const aud = new URL(endpoint).origin;
    const head = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
    const body = b64u(Buffer.from(JSON.stringify({ aud, exp: now + 12 * 3600, sub: 'mailto:relay@localhost.localdomain' })));
    const key = createPrivateKey({ key: this.vapid.jwk as any, format: 'jwk' });
    const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' });
    return `vapid t=${head}.${body}.${b64u(sig)}, k=${this.vapid.pub}`;
  }

  async pushAll(log: (m: string) => void = () => {}) {
    const subs = this.db.prepare('SELECT endpoint, failures FROM push_subs').all() as { endpoint: string; failures: number }[];
    await Promise.all(subs.map(async (s) => {
      try {
        const r = await fetch(s.endpoint, { method: 'POST', headers: { TTL: '600', Urgency: 'high', Authorization: this.vapidAuth(s.endpoint), 'Content-Length': '0' }, signal: AbortSignal.timeout(10_000) });
        if (r.status === 404 || r.status === 410) { this.unsubscribe(s.endpoint); return; } // subscription gone
        if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
        this.db.prepare('UPDATE push_subs SET failures = 0 WHERE endpoint = ?').run(s.endpoint);
      } catch (e) {
        log(`push to ${new URL(s.endpoint).host}: ${(e as Error).message}`);
        if (s.failures >= 20) this.unsubscribe(s.endpoint);
        else this.db.prepare('UPDATE push_subs SET failures = failures + 1 WHERE endpoint = ?').run(s.endpoint);
      }
    }));
  }
}
