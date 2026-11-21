import { isCategory, type AlertCategory } from '../../../src/notify/categories';
import { publicDevice, isChannelId, isFcmToken, isTime, type Device, type DeviceStore, type QuietHours } from '../push/devices';
import type { PushService } from '../push/outbox';
import { FailureLimiter } from './auth';
import { BadRequest, type RequestContext, type Router } from './router';

/**
 * Milestone 4 — phone pairing and push registration.
 *
 *  Admin (TB_API_TOKEN — use it on the server itself, never in the app):
 *    POST   /v1/devices/pairing-code   a one-time code for pairing a phone (10 minutes)
 *    GET    /v1/devices                the paired phones (no tokens or credentials)
 *    DELETE /v1/devices/:id            revoke a phone
 *    POST   /v1/devices/:id/test-push  a harmless test notification to one phone
 *    GET    /v1/push                   is Firebase set up, outbox counts, last error
 *  The app, with a pairing code (no other credential; 5 wrong codes per address per 15 minutes):
 *    POST   /v1/devices/pair           → its own device credential, shown once
 *  The paired phone (Authorization: Bearer tbd.<id>.<secret>):
 *    GET    /v1/device                 its status
 *    PUT    /v1/device/fcm-token       register / refresh its FCM token
 *    PUT    /v1/device/preferences     which alerts, quiet hours, notification channel
 *    POST   /v1/device/test-push       a test notification to itself
 *    DELETE /v1/device                 unpair (logout)
 */

export interface DeviceRouteDeps {
  devices: DeviceStore;
  push: PushService;
  projectId: string | null;
  now: () => number;
  /**
   * Review fix: is the server making signals right now (its jobs on, an Upstox token it can use)? The
   * phone hides its own copy of a market alert only while the server says yes (see GET /v1/device).
   */
  signals?: () => Promise<boolean>;
}

/** A phone may ask for one test push per this many ms (review fix: no flood of test pushes). */
export const TEST_PUSH_EVERY_MS = 30_000;

const obj = (b: unknown): Record<string, unknown> => {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new BadRequest('Send a JSON object.');
  return b as Record<string, unknown>;
};
const clean = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);

export function addDeviceRoutes(r: Router, d: DeviceRouteDeps): void {
  const perAddress = new FailureLimiter(5, 15 * 60_000);
  const overall = new FailureLimiter(30, 60 * 60_000);
  const view = (dev: Device) => ({ ...publicDevice(dev), push: d.push.stats(dev.id) });
  const me = (ctx: RequestContext) => ctx.device as Device;
  const testPush = (dev: Device) =>
    d.push.enqueue({ id: `test-push-${dev.id.slice(0, 8)}-${d.now()}`, title: '🔔 TradeBuddy test notification', message: 'Your server can reach this phone. Nothing was bought or sold.', at: d.now() }, { deviceId: dev.id, force: true });

  // ---------- admin
  r.add('POST', '/v1/devices/pairing-code', () => {
    const c = d.devices.issuePairingCode();
    return { status: 201, body: { code: c.code, expiresAt: c.expiresAt, validMinutes: 10, next: 'In the app: Settings → Cloud alerts → enter the server address and this code. It works once.' } };
  });
  r.add('GET', '/v1/devices', () => ({ body: { devices: d.devices.list().map(view) } }));
  r.add('DELETE', '/v1/devices/:id', ({ params }) => {
    const revoked = d.devices.revoke(params.id!);
    return revoked ? { body: { revoked: true } } : { status: 404, body: { error: 'not_found', message: 'No such active phone.' } };
  });
  r.add('POST', '/v1/devices/:id/test-push', ({ params }) => {
    const dev = d.devices.get(params.id!);
    if (!dev || dev.revokedAt !== null) return { status: 404, body: { error: 'not_found', message: 'No such active phone.' } };
    if (dev.tokenState !== 'active') return { status: 409, body: { error: 'no_token', message: 'This phone has not sent a valid FCM token yet — open the app on it.' } };
    return { status: 202, body: { queued: testPush(dev) } };
  });
  r.add('GET', '/v1/push', () => ({ body: { configured: d.push.configured, projectId: d.projectId, lastSentAt: d.push.lastSentAt, lastError: d.push.lastError, outbox: d.push.stats() } }));

  // ---------- pairing (a one-time code is the only credential)
  r.add(
    'POST',
    '/v1/devices/pair',
    ({ body, ip }) => {
      const t = d.now();
      if (perAddress.blocked(ip, t) || overall.blocked('all', t)) return { status: 429, body: { error: 'too_many_attempts', message: 'Too many pairing attempts. Wait 15 minutes and ask the server for a new code.' }, headers: { 'Retry-After': '900' } };
      const b = obj(body);
      const code = typeof b.code === 'string' ? b.code : '';
      const name = typeof b.name === 'string' ? clean(b.name, 60) : '';
      const platform = b.platform === undefined ? 'android' : b.platform;
      const appVersion = typeof b.appVersion === 'string' ? clean(b.appVersion, 20) : null;
      if (code.replace(/[^A-Za-z0-9]/g, '').length !== 10) throw new BadRequest('The pairing code has 10 letters and digits (like ABCDE-23456).');
      if (!name) throw new BadRequest('Give the phone a name.');
      if (platform !== 'android') throw new BadRequest('Only Android phones can be paired.');
      const res = d.devices.pair(code, { name, platform, appVersion });
      if (!res) {
        perAddress.fail(ip, t);
        overall.fail('all', t);
        return { status: 401, body: { error: 'invalid_code', message: 'Wrong, used or expired code. Ask the server for a new one.' } };
      }
      return { status: 201, body: { deviceId: res.device.id, credential: res.credential, device: view(res.device), note: 'Keep the credential secret; it is shown only now.' } };
    },
    { auth: false },
  );

  // ---------- the paired phone
  // review fix: `server` tells the phone whether the cloud really covers its alerts right now (signals
  // made, pushes working, its token active); otherwise the phone shows its own notifications as before
  r.add(
    'GET',
    '/v1/device',
    async (ctx) => {
      const dev = me(ctx);
      const signals = d.signals ? await d.signals().catch(() => false) : false;
      return { body: { device: view(dev), pushConfigured: d.push.configured, server: { signals, push: d.push.healthy, tokenActive: dev.tokenState === 'active', at: d.now() } } };
    },
    { auth: 'device' },
  );

  r.add(
    'PUT',
    '/v1/device/fcm-token',
    (ctx) => {
      const token = obj(ctx.body).token;
      if (!isFcmToken(token)) throw new BadRequest('That is not an FCM registration token.');
      d.devices.setFcmToken(me(ctx).id, token);
      return { body: { ok: true, device: view(d.devices.get(me(ctx).id)!) } };
    },
    { auth: 'device' },
  );

  r.add(
    'PUT',
    '/v1/device/preferences',
    (ctx) => {
      const b = obj(ctx.body);
      const patch: { categories?: AlertCategory[]; quietHours?: QuietHours | null; channelId?: string | null } = {};
      if (b.categories !== undefined) {
        if (!Array.isArray(b.categories) || !b.categories.every(isCategory)) throw new BadRequest('categories must be a list of known alert kinds.');
        patch.categories = [...new Set(b.categories as AlertCategory[])];
      }
      if (b.quietHours !== undefined) {
        const q = b.quietHours as Record<string, unknown> | null;
        if (q !== null && (typeof q !== 'object' || typeof q.enabled !== 'boolean' || !isTime(q.start) || !isTime(q.end))) throw new BadRequest('quietHours needs enabled, start and end ("HH:MM").');
        patch.quietHours = q === null ? null : { enabled: q.enabled as boolean, start: q.start as string, end: q.end as string };
      }
      if (b.channelId !== undefined) {
        if (b.channelId !== null && !isChannelId(b.channelId)) throw new BadRequest('channelId is not a notification channel id.');
        patch.channelId = b.channelId as string | null;
      }
      d.devices.setPreferences(me(ctx).id, patch);
      return { body: { ok: true, device: view(d.devices.get(me(ctx).id)!) } };
    },
    { auth: 'device' },
  );

  const lastTest = new Map<string, number>();
  r.add(
    'POST',
    '/v1/device/test-push',
    (ctx) => {
      const dev = me(ctx);
      if (!d.push.configured) return { status: 503, body: { error: 'push_off', message: 'Firebase is not set up on the server yet.' } };
      if (dev.tokenState !== 'active') return { status: 409, body: { error: 'no_token', message: 'This phone has not registered for notifications yet.' } };
      const t = d.now();
      const prev = lastTest.get(dev.id);
      if (prev !== undefined && t - prev < TEST_PUSH_EVERY_MS) {
        const wait = Math.ceil((TEST_PUSH_EVERY_MS - (t - prev)) / 1000);
        return { status: 429, body: { error: 'too_soon', message: `One test push every ${TEST_PUSH_EVERY_MS / 1000} seconds — try again in ${wait} s.` }, headers: { 'Retry-After': String(wait) } };
      }
      lastTest.set(dev.id, t);
      return { status: 202, body: { queued: testPush(dev) } };
    },
    { auth: 'device' },
  );

  r.add(
    'DELETE',
    '/v1/device',
    (ctx) => {
      d.devices.revoke(me(ctx).id);
      return { body: { revoked: true } };
    },
    { auth: 'device' },
  );
}
