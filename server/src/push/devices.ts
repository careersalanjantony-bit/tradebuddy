import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_CLOUD_CATEGORIES, isCategory, type AlertCategory } from '../../../src/notify/categories';

/**
 * Milestone 4 — the phones allowed to receive pushes (one owner; a few phones at most).
 *
 * Pairing: the owner asks the server (admin token, on the server itself) for a one-time code, valid
 * 10 minutes, and types it in the app. The app gets its own device credential back, once:
 * `tbd.<device id>.<secret>`. The server keeps only a SHA-256 of the secret, so a copy of the database
 * cannot be used to log in, and each phone can be revoked on its own. The admin token, the Upstox
 * token and the Firebase key never go to the phone.
 */

export const PAIRING_TTL_MS = 10 * 60_000;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const CREDENTIAL_RE = /^tbd\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/;

export interface QuietHours {
  enabled: boolean;
  start: string;
  end: string;
}

export interface Device {
  id: string;
  name: string;
  platform: string;
  appVersion: string | null;
  fcmToken: string | null;
  tokenState: 'none' | 'active' | 'invalid';
  tokenAt: number | null;
  categories: AlertCategory[];
  quietHours: QuietHours | null;
  channelId: string | null;
  createdAt: number;
  lastSeenAt: number | null;
  lastPushAt: number | null;
  revokedAt: number | null;
}

/** What the API may show about a phone: never its FCM token or credential. */
export type PublicDevice = Omit<Device, 'fcmToken'> & { tokenHint: string | null };

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
export const normalizeCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');
export const isFcmToken = (t: unknown): t is string => typeof t === 'string' && t.length >= 32 && t.length <= 4096 && /^[A-Za-z0-9_:.\-]+$/.test(t);
export const isTime = (t: unknown): t is string => typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
export const isChannelId = (c: unknown): c is string => typeof c === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(c);

type Row = {
  id: string;
  name: string;
  platform: string;
  app_version: string | null;
  fcm_token: string | null;
  fcm_token_at: number | null;
  token_state: string;
  categories: string;
  quiet_json: string | null;
  channel_id: string | null;
  created_at: number;
  last_seen_at: number | null;
  last_push_at: number | null;
  revoked_at: number | null;
};

function toDevice(r: Row): Device {
  let categories: AlertCategory[] = [];
  try {
    categories = (JSON.parse(r.categories) as unknown[]).filter(isCategory);
  } catch {
    categories = [...DEFAULT_CLOUD_CATEGORIES];
  }
  let quiet: QuietHours | null = null;
  try {
    quiet = r.quiet_json ? (JSON.parse(r.quiet_json) as QuietHours) : null;
  } catch {
    quiet = null;
  }
  return {
    id: r.id,
    name: r.name,
    platform: r.platform,
    appVersion: r.app_version,
    fcmToken: r.fcm_token,
    tokenState: (r.token_state as Device['tokenState']) ?? 'none',
    tokenAt: r.fcm_token_at,
    categories,
    quietHours: quiet,
    channelId: r.channel_id,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    lastPushAt: r.last_push_at,
    revokedAt: r.revoked_at,
  };
}

export function publicDevice(d: Device): PublicDevice {
  const { fcmToken, ...rest } = d;
  return { ...rest, tokenHint: fcmToken ? `…${fcmToken.slice(-6)}` : null };
}

export class DeviceStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {}

  /** A new one-time pairing code (older unused codes stop working). Shown once; only its hash is kept. */
  issuePairingCode(): { code: string; expiresAt: number } {
    const t = this.now();
    const bytes = randomBytes(10);
    let raw = '';
    for (const b of bytes) raw += ALPHABET[b % ALPHABET.length];
    this.db.prepare('DELETE FROM pairing_codes WHERE used_at IS NULL').run();
    const expiresAt = t + PAIRING_TTL_MS;
    this.db.prepare('INSERT INTO pairing_codes (code_hash, created_at, expires_at) VALUES (?, ?, ?)').run(sha256(raw), t, expiresAt);
    return { code: `${raw.slice(0, 5)}-${raw.slice(5)}`, expiresAt };
  }

  /** Pairs a phone with a valid unused code. Null = wrong, used or expired code. */
  pair(code: string, info: { name: string; platform: string; appVersion: string | null }): { device: Device; credential: string } | null {
    const t = this.now();
    const hash = sha256(normalizeCode(code));
    const row = this.db.prepare('SELECT code_hash, expires_at, used_at FROM pairing_codes WHERE code_hash = ?').get(hash) as { code_hash: string; expires_at: number; used_at: number | null } | undefined;
    if (!row || row.used_at !== null || t > row.expires_at) return null;
    const id = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    this.db.exec('SAVEPOINT pair');
    try {
      const used = this.db.prepare('UPDATE pairing_codes SET used_at = ?, device_id = ? WHERE code_hash = ? AND used_at IS NULL').run(t, id, hash);
      if (Number(used.changes) !== 1) {
        this.db.exec('ROLLBACK TO pair');
        this.db.exec('RELEASE pair');
        return null;
      }
      this.db
        .prepare('INSERT INTO devices (id, name, platform, app_version, secret_hash, categories, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, info.name, info.platform, info.appVersion, sha256(secret), JSON.stringify(DEFAULT_CLOUD_CATEGORIES), t, t);
      this.db.exec('RELEASE pair');
    } catch (err) {
      this.db.exec('ROLLBACK TO pair');
      this.db.exec('RELEASE pair');
      throw err;
    }
    return { device: this.get(id)!, credential: `tbd.${id}.${secret}` };
  }

  /** The phone behind a device credential, if it is valid and not revoked. */
  authenticate(credential: string | undefined | null): Device | null {
    const m = CREDENTIAL_RE.exec(credential ?? '');
    if (!m) return null;
    const row = this.db.prepare('SELECT secret_hash, revoked_at FROM devices WHERE id = ?').get(m[1]!) as { secret_hash: string; revoked_at: number | null } | undefined;
    const given = Buffer.from(sha256(m[2]!), 'hex');
    const stored = Buffer.from(row?.secret_hash ?? sha256('no device'), 'hex');
    const same = timingSafeEqual(given, stored);
    if (!row || !same || row.revoked_at !== null) return null;
    const t = this.now();
    this.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)').run(t, m[1]!, t - 60_000);
    return this.get(m[1]!);
  }

  get(id: string): Device | null {
    const r = this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as Row | undefined;
    return r ? toDevice(r) : null;
  }

  list(): Device[] {
    return (this.db.prepare('SELECT * FROM devices ORDER BY created_at').all() as Row[]).map(toDevice);
  }

  /** Phones that can receive a push now. */
  reachable(): Device[] {
    return (this.db.prepare("SELECT * FROM devices WHERE revoked_at IS NULL AND fcm_token IS NOT NULL AND token_state = 'active'").all() as Row[]).map(toDevice);
  }

  setFcmToken(id: string, token: string): void {
    this.db.prepare("UPDATE devices SET fcm_token = ?, fcm_token_at = ?, token_state = 'active' WHERE id = ? AND revoked_at IS NULL").run(token, this.now(), id);
  }

  /** Google said this token is no longer valid: stop sending to it until the phone sends a new one. */
  markTokenInvalid(id: string, token: string): void {
    this.db.prepare("UPDATE devices SET fcm_token = NULL, token_state = 'invalid' WHERE id = ? AND fcm_token = ?").run(id, token);
  }

  setPreferences(id: string, p: { categories?: AlertCategory[]; quietHours?: QuietHours | null; channelId?: string | null }): void {
    const d = this.get(id);
    if (!d) return;
    this.db
      .prepare('UPDATE devices SET categories = ?, quiet_json = ?, channel_id = ? WHERE id = ?')
      .run(JSON.stringify(p.categories ?? d.categories), JSON.stringify(p.quietHours === undefined ? d.quietHours : p.quietHours), p.channelId === undefined ? d.channelId : p.channelId, id);
  }

  notePush(id: string, at: number): void {
    this.db.prepare('UPDATE devices SET last_push_at = ? WHERE id = ?').run(at, id);
  }

  /** Logout / lost phone: the credential stops working and its FCM token is forgotten. */
  revoke(id: string): boolean {
    return Number(this.db.prepare("UPDATE devices SET revoked_at = ?, fcm_token = NULL, token_state = 'none' WHERE id = ? AND revoked_at IS NULL").run(this.now(), id).changes) > 0;
  }
}
