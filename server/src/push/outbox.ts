import type { DatabaseSync } from 'node:sqlite';
import type { AlertDetail } from '../../../src/alerts/history';
import { categoryOf, type AlertCategory } from '../../../src/notify/categories';
import { createLogger } from '../../../src/lib/log';
import type { Device, DeviceStore, QuietHours } from './devices';
import type { FcmClient, PushMessage } from './fcm';

/**
 * Milestone 4 — the push outbox. Every new alert the server makes (the app's own notify(), which
 * already keeps each alert id once per 24 hours) is written here, one row per phone that wants that
 * kind of alert, and the scanning goes on at once. A separate task sends the rows:
 *  - sent → done; one row per (alert id, phone) ever, so the same alert is never pushed twice;
 *  - temporary failure (Google busy, rate limit, network) → again after 5 s, 10 s, 20 s … up to 30 min,
 *    at most 8 tries;
 *  - the phone's token is no longer valid → the phone gets no more pushes until it sends a new token;
 *  - a message Google refuses → given up (recorded).
 * Everything is in SQLite, so a restart continues where it stopped.
 */

export interface PushAlert {
  id: string;
  title: string;
  message: string;
  at: number;
  detail?: AlertDetail;
}

interface Payload {
  title: string;
  body: string;
  data: Record<string, string>;
  ttlSeconds: number;
  tag: string;
}

export const MAX_ATTEMPTS = 8;
const BASE_DELAY_MS = 5_000;
const MAX_DELAY_MS = 30 * 60_000;
const log = createLogger('push');

/** The delay before try number `attempt + 1` (attempt counts from 1). */
export function backoffMs(attempt: number, retryAfterMs?: number): number {
  const exp = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
  return Math.max(exp, Math.min(MAX_DELAY_MS, retryAfterMs ?? 0));
}

/** "HH:MM"–"HH:MM" in IST, also across midnight. */
export function inQuietHours(q: QuietHours | null, now: number): boolean {
  if (!q?.enabled) return false;
  const d = new Date(now + 5.5 * 3_600_000);
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const a = toMin(q.start);
  const b = toMin(q.end);
  return a <= b ? m >= a && m < b : m >= a || m < b;
}

/** The data the app reads when the notification is tapped (FCM data: strings, about 4 KB at most). */
export function buildPayload(a: PushAlert, category: AlertCategory): Payload {
  const data: Record<string, string> = { alertId: a.id, title: a.title.slice(0, 200), message: a.message.slice(0, 1000), at: String(a.at), category, source: 'tradebuddy-server' };
  if (a.detail) {
    let detail = { ...a.detail, reasons: a.detail.reasons.slice(0, 6).map((r) => r.slice(0, 160)) };
    let text = JSON.stringify(detail);
    if (text.length > 1800) {
      detail = { ...detail, reasons: detail.reasons.slice(0, 2) };
      text = JSON.stringify(detail);
    }
    if (text.length <= 1800) data.detail = text;
  }
  const market = category !== 'system' && category !== 'price';
  return { title: a.title, body: a.message, data, ttlSeconds: market ? 30 * 60 : 24 * 3600, tag: `tb-${a.id}`.slice(0, 100) };
}

export interface ProcessResult {
  sent: number;
  retried: number;
  failed: number;
  skipped: number;
}

/**
 * Review fix — what the SERVER may push. Its alerts come from the app's own code, which also makes a
 * few messages that only make sense on the phone: "Log in to Upstox" (the server needs no daily login),
 * "session expired" and the evening scan summary (the phone makes its own — a push would be a second
 * copy). Those are not pushed. "Analytics Token rejected" is about the SERVER's token here, so it is
 * pushed under its own id and says so. Everything else unchanged. Pure.
 */
export function serverPushAlert(id: string, title: string, message: string): { id: string; title: string; message: string } | null {
  if (id === 'login-reminder' || id === 'session-expired' || id === 'scan-summary') return null;
  if (id === 'analytics-invalid') return { id: 'server-analytics-invalid', title: `TradeBuddy server: ${title}`, message: `${message} (Fix it on the server: UPSTOX_ANALYTICS_TOKEN in /etc/tradebuddy/server.env.)` };
  return { id, title, message };
}

export class PushService {
  lastError: string | null = null;
  lastErrorAt: number | null = null;
  lastSentAt: number | null = null;

  /** Review fix: pushes are working — set up, and no failure since the last successful send. */
  get healthy(): boolean {
    return this.fcm !== null && (this.lastErrorAt === null || (this.lastSentAt !== null && this.lastSentAt > this.lastErrorAt));
  }

  constructor(
    private readonly db: DatabaseSync,
    private readonly devices: DeviceStore,
    private readonly fcm: Pick<FcmClient, 'send'> | null,
    private readonly now: () => number = Date.now,
  ) {}

  get configured(): boolean {
    return this.fcm !== null;
  }

  /**
   * Queues an alert for every phone that wants its kind (and is not in its quiet hours). `force` =
   * a test push to one phone. Returns how many rows were added (0 for an alert already queued).
   */
  enqueue(a: PushAlert, opts: { deviceId?: string; force?: boolean } = {}): number {
    const category = categoryOf(a.id);
    const t = this.now();
    let added = 0;
    const targets = opts.deviceId ? [this.devices.get(opts.deviceId)].filter((d): d is Device => !!d && d.revokedAt === null) : this.devices.reachable();
    for (const d of targets) {
      if (!opts.force && (!d.categories.includes(category) || inQuietHours(d.quietHours, t))) continue;
      const p = buildPayload(a, category);
      const r = this.db.prepare("INSERT OR IGNORE INTO push_outbox (alert_id, device_id, payload, status, next_at, created_at) VALUES (?, ?, ?, 'pending', ?, ?)").run(a.id, d.id, JSON.stringify({ ...p, channelId: d.channelId }), t, t);
      added += Number(r.changes);
    }
    return added;
  }

  /** Sends what is due (oldest first). Never throws. */
  async processDue(limit = 20): Promise<ProcessResult> {
    const out: ProcessResult = { sent: 0, retried: 0, failed: 0, skipped: 0 };
    if (!this.fcm) return out;
    const t = this.now();
    const rows = this.db.prepare("SELECT id, alert_id, device_id, payload, attempts, created_at FROM push_outbox WHERE status = 'pending' AND next_at <= ? ORDER BY next_at, id LIMIT ?").all(t, limit) as Array<{ id: number; alert_id: string; device_id: string; payload: string; attempts: number; created_at: number }>;
    for (const r of rows) {
      const d = this.devices.get(r.device_id);
      if (!d || d.revokedAt !== null || !d.fcmToken || d.tokenState !== 'active') {
        this.finish(r.id, 'skipped', d?.revokedAt ? 'phone revoked' : 'no valid FCM token');
        out.skipped++;
        continue;
      }
      const p = JSON.parse(r.payload) as Payload & { channelId?: string | null };
      // review fix: an alert older than its time-to-live (30 minutes for a market signal) is not sent
      // late — e.g. after the server was down for hours, or after long retries. It stays in the Alerts tab.
      if (t - r.created_at > p.ttlSeconds * 1000) {
        this.finish(r.id, 'skipped', `expired before it could be sent (older than ${Math.round(p.ttlSeconds / 60)} minutes)`, r.attempts);
        out.skipped++;
        continue;
      }
      const msg: PushMessage = { token: d.fcmToken, title: p.title, body: p.body, data: p.data, channelId: p.channelId ?? null, ttlSeconds: p.ttlSeconds, tag: p.tag };
      let res;
      try {
        res = await this.fcm.send(msg);
      } catch (err) {
        res = { ok: false as const, kind: 'retry' as const, error: err instanceof Error ? err.message : String(err) };
      }
      const attempts = r.attempts + 1;
      if (res.ok) {
        const at = this.now();
        this.db.prepare("UPDATE push_outbox SET status = 'sent', attempts = ?, sent_at = ?, message_id = ?, last_error = NULL WHERE id = ?").run(attempts, at, res.messageId, r.id);
        this.devices.notePush(d.id, at);
        this.lastSentAt = at;
        out.sent++;
      } else if (res.kind === 'invalid-token') {
        this.devices.markTokenInvalid(d.id, d.fcmToken);
        this.finish(r.id, 'failed', `token no longer valid (${res.error})`, attempts);
        log.warn(`Push to "${d.name}" stopped: its FCM token is no longer valid — the app sends a new one when it opens`);
        out.failed++;
      } else if (res.kind === 'retry' && attempts < MAX_ATTEMPTS) {
        this.db.prepare('UPDATE push_outbox SET attempts = ?, next_at = ?, last_error = ? WHERE id = ?').run(attempts, this.now() + backoffMs(attempts, res.retryAfterMs), res.error, r.id);
        this.lastError = res.error;
        this.lastErrorAt = this.now();
        out.retried++;
      } else {
        this.finish(r.id, 'failed', res.error, attempts);
        this.lastError = res.error;
        this.lastErrorAt = this.now();
        log.warn(`Push of ${r.alert_id} gave up after ${attempts} tries`, { error: res.error });
        out.failed++;
      }
    }
    return out;
  }

  private finish(id: number, status: 'failed' | 'skipped', error: string, attempts?: number): void {
    this.db.prepare(`UPDATE push_outbox SET status = ?, last_error = ?${attempts !== undefined ? ', attempts = ?' : ''} WHERE id = ?`).run(...([status, error, ...(attempts !== undefined ? [attempts] : []), id] as [string, string, ...number[]]));
  }

  /** Counts for the health check (overall or one phone). */
  stats(deviceId?: string): { pending: number; sent: number; failed: number; skipped: number } {
    const rows = (deviceId ? this.db.prepare('SELECT status, COUNT(*) AS n FROM push_outbox WHERE device_id = ? GROUP BY status').all(deviceId) : this.db.prepare('SELECT status, COUNT(*) AS n FROM push_outbox GROUP BY status').all()) as Array<{ status: string; n: number }>;
    const s = { pending: 0, sent: 0, failed: 0, skipped: 0 };
    for (const r of rows) if (r.status in s) s[r.status as keyof typeof s] = r.n;
    return s;
  }

  /** Rows of one alert (tests and the admin view). */
  rowsFor(alertId: string): Array<{ device_id: string; status: string; attempts: number; last_error: string | null }> {
    return this.db.prepare('SELECT device_id, status, attempts, last_error FROM push_outbox WHERE alert_id = ? ORDER BY id').all(alertId) as Array<{ device_id: string; status: string; attempts: number; last_error: string | null }>;
  }

  /** Forgets finished rows older than a week (pending ones stay). */
  prune(olderThanMs = 7 * 24 * 3_600_000): number {
    return Number(this.db.prepare("DELETE FROM push_outbox WHERE status != 'pending' AND created_at < ?").run(this.now() - olderThanMs).changes);
  }
}
