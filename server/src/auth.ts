import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { DeviceKind } from '../../shared/protocol.ts';

export class Auth {
  private db: DatabaseSync;
  private code = '';
  private codeExpires = 0;
  private cache = new Map<string, string>(); // token -> deviceId

  constructor(db: DatabaseSync) { this.db = db; }

  pairingCode() {
    if (Date.now() > this.codeExpires) {
      this.code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      this.codeExpires = Date.now() + 15 * 60_000;
    }
    return this.code;
  }

  /** `trusted` = request from this machine: no code needed. */
  pair(code: string | undefined, name: string, kind: DeviceKind, trusted: boolean) {
    if (!trusted && (!code || code !== this.pairingCode())) return null;
    if (!trusted) this.codeExpires = 0; // single use
    const id = randomUUID().slice(0, 8);
    const token = randomBytes(24).toString('base64url');
    this.db.prepare('INSERT INTO devices (id, token, name, kind, created) VALUES (?, ?, ?, ?, ?)').run(id, token, name.slice(0, 40) || kind, kind, Date.now());
    return { deviceId: id, token };
  }

  verify(token: string | undefined): string | null {
    if (!token) return null;
    const hit = this.cache.get(token);
    if (hit) return hit;
    const r = this.db.prepare('SELECT id FROM devices WHERE token = ?').get(token) as { id: string } | undefined;
    if (r) { this.cache.set(token, r.id); this.db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(Date.now(), r.id); }
    return r?.id ?? null;
  }

  devices() {
    return this.db.prepare('SELECT id, name, kind FROM devices ORDER BY created').all() as { id: string; name: string; kind: DeviceKind }[];
  }

  rename(id: string, name: string) { this.db.prepare('UPDATE devices SET name = ? WHERE id = ?').run(name.slice(0, 40), id); }
  remove(id: string) {
    this.db.prepare('DELETE FROM devices WHERE id = ?').run(id);
    for (const [t, d] of this.cache) if (d === id) this.cache.delete(t);
  }
}
