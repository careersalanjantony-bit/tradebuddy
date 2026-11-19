import { createVerify, generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { notify } from '../../src/notify/chrome';
import { categoryOf } from '../../src/notify/categories';
import { startServer, type RunningServer } from '../src/engine';
import { clientIp } from '../src/http/server';
import { DeviceStore, PAIRING_TTL_MS } from '../src/push/devices';
import { classify, FcmClient, type PushMessage, type SendResult } from '../src/push/fcm';
import { AccessTokenSource, CredentialError, parseServiceAccount, signJwt, type ServiceAccount } from '../src/push/google';
import { backoffMs, buildPayload, inQuietHours, MAX_ATTEMPTS, PushService, serverPushAlert } from '../src/push/outbox';
import { openStore, type Store } from '../src/storage/sqlite';
import { API_TOKEN, getJson, logCapture, tempDir, testConfig } from './helpers';

/** Milestone 4 — Firebase push: sign-in, sending, phones, the outbox and the HTTP API. No real Firebase. */

let sa: ServiceAccount;
let publicKey: string;
const TOKEN = `fcm-token-${'x'.repeat(140)}:APA91b`;
const T0 = Date.parse('2026-11-19T05:00:00Z'); // 10:30 IST

beforeAll(() => {
  const kp = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  publicKey = kp.publicKey;
  sa = parseServiceAccount({ type: 'service_account', project_id: 'tradebuddy-test', client_email: 'push@tradebuddy-test.iam.gserviceaccount.com', private_key: kp.privateKey, token_uri: 'https://oauth2.googleapis.com/token' });
});

describe('Google sign-in for FCM HTTP v1', () => {
  it('checks the key file without ever repeating the private key', () => {
    expect(() => parseServiceAccount({ type: 'authorized_user' })).toThrow(CredentialError);
    expect(() => parseServiceAccount({ type: 'service_account', project_id: 'p', client_email: 'e', private_key: 'secret-but-not-pem' })).toThrow(/not a PEM/);
    try {
      parseServiceAccount({ type: 'service_account', project_id: 'p', client_email: 'e', private_key: sa.privateKey, token_uri: 'https://evil.example/token' });
    } catch (err) {
      expect(String(err)).not.toContain('PRIVATE KEY');
    }
  });

  it('signs an RS256 JWT for the firebase.messaging scope, valid one hour', () => {
    const jwt = signJwt(sa, T0);
    const [h, b, s] = jwt.split('.');
    const v = createVerify('RSA-SHA256');
    v.update(`${h}.${b}`);
    expect(v.verify(publicKey, Buffer.from(s!, 'base64url'))).toBe(true);
    expect(JSON.parse(Buffer.from(b!, 'base64url').toString())).toEqual({ iss: sa.clientEmail, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: sa.tokenUri, iat: T0 / 1000, exp: T0 / 1000 + 3600 });
  });

  it('caches the access token and fetches a new one shortly before it expires', async () => {
    let t = T0;
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ access_token: `at-${fetchFn.mock.calls.length}`, expires_in: 3600 }), { status: 200 }));
    const src = new AccessTokenSource(sa, fetchFn, () => t);
    expect(await src.get()).toBe('at-1');
    t += 50 * 60_000;
    expect(await src.get()).toBe('at-1');
    t += 9 * 60_000; // 59 minutes: inside the last 2 minutes
    expect(await src.get()).toBe('at-2');
    src.invalidate();
    expect(await src.get()).toBe('at-3');
  });
});

describe('FCM HTTP v1 send', () => {
  it('posts one message with the token, the data, high priority, the channel and a tag', async () => {
    const fetchFn = vi.fn(async (_u: string, _i: RequestInit) => new Response(JSON.stringify({ name: 'projects/tradebuddy-test/messages/1' }), { status: 200 }));
    const c = new FcmClient(sa, { get: async () => 'access', invalidate: () => undefined }, fetchFn);
    const r = await c.send({ token: TOKEN, title: 'T', body: 'B', data: { alertId: 'alert:x' }, channelId: 'trade-alerts-cash', ttlSeconds: 1800, tag: 'tb-alert:x' });
    expect(r).toEqual({ ok: true, messageId: 'projects/tradebuddy-test/messages/1' });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('https://fcm.googleapis.com/v1/projects/tradebuddy-test/messages:send');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer access');
    expect(JSON.parse(String(init.body)).message).toMatchObject({ token: TOKEN, data: { alertId: 'alert:x' }, android: { priority: 'HIGH', ttl: '1800s', notification: { channel_id: 'trade-alerts-cash', tag: 'tb-alert:x' } } });
  });

  it('sorts the answers: invalid token, try again later, or give up', () => {
    const inv = vi.fn();
    expect(classify(404, { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] }, null, inv).ok).toBe(false);
    expect((classify(404, { details: [{ errorCode: 'UNREGISTERED' }] }, null, inv) as { kind: string }).kind).toBe('invalid-token');
    expect((classify(400, { status: 'INVALID_ARGUMENT', message: 'The registration token is not a valid FCM registration token' }, null, inv) as { kind: string }).kind).toBe('invalid-token');
    expect((classify(403, { details: [{ errorCode: 'SENDER_ID_MISMATCH' }] }, null, inv) as { kind: string }).kind).toBe('invalid-token');
    expect(classify(429, { details: [{ errorCode: 'QUOTA_EXCEEDED' }] }, '120', inv)).toMatchObject({ kind: 'retry', retryAfterMs: 120_000 });
    expect((classify(503, { status: 'UNAVAILABLE' }, null, inv) as { kind: string }).kind).toBe('retry');
    expect((classify(401, { status: 'UNAUTHENTICATED' }, null, inv) as { kind: string }).kind).toBe('retry');
    expect(inv).toHaveBeenCalledTimes(1);
    expect((classify(400, { status: 'INVALID_ARGUMENT', message: 'Invalid JSON payload' }, null, inv) as { kind: string }).kind).toBe('bad-message');
  });
});

describe('phones, pairing and the outbox', () => {
  let store: Store;
  let cleanup: () => void;
  let dir: string;
  let t = T0;
  const now = () => t;
  const open = () => {
    const x = tempDir();
    dir = x.dir;
    cleanup = x.cleanup;
    store = openStore(dir);
  };
  afterEach(() => {
    store.close();
    cleanup();
    t = T0;
  });

  it('a pairing code works once, within 10 minutes; the credential is kept only as a hash', () => {
    open();
    const ds = new DeviceStore(store.db, now);
    const { code } = ds.issuePairingCode();
    expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    expect(ds.pair('WRONG-CODE1', { name: 'x', platform: 'android', appVersion: null })).toBeNull();
    const p = ds.pair(code.toLowerCase().replace('-', ' '), { name: 'Pixel', platform: 'android', appVersion: '1.20.0' })!;
    expect(p.credential).toMatch(/^tbd\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    expect(ds.pair(code, { name: 'again', platform: 'android', appVersion: null })).toBeNull(); // used
    const secret = p.credential.split('.')[2]!;
    expect(JSON.stringify(store.db.prepare('SELECT * FROM devices').all())).not.toContain(secret);
    expect(ds.authenticate(p.credential)?.name).toBe('Pixel');
    expect(ds.authenticate(p.credential.slice(0, -1) + (p.credential.endsWith('A') ? 'B' : 'A'))).toBeNull();
    const late = ds.issuePairingCode();
    t += PAIRING_TTL_MS + 1;
    expect(ds.pair(late.code, { name: 'late', platform: 'android', appVersion: null })).toBeNull(); // expired
    ds.revoke(p.device.id);
    expect(ds.authenticate(p.credential)).toBeNull();
  });

  it('queues an alert once per phone, only for the kinds it wants and outside its quiet hours', () => {
    open();
    const ds = new DeviceStore(store.db, now);
    const push = new PushService(store.db, ds, null, now);
    const a = ds.pair(ds.issuePairingCode().code, { name: 'A', platform: 'android', appVersion: null })!.device;
    const b = ds.pair(ds.issuePairingCode().code, { name: 'B', platform: 'android', appVersion: null })!.device;
    ds.setFcmToken(a.id, TOKEN);
    ds.setFcmToken(b.id, `${TOKEN}b`);
    ds.setPreferences(b.id, { categories: ['falling'] });
    const rise = { id: 'alert:rise-NSE_EQ|X-2026-11-19', title: '📈 X likely to keep rising', message: 'm', at: t };
    expect(push.enqueue(rise)).toBe(1); // A only: B asked for "falling" only
    expect(push.enqueue(rise)).toBe(0); // the same alert again: never twice
    ds.setPreferences(a.id, { quietHours: { enabled: true, start: '10:00', end: '11:00' } });
    expect(push.enqueue({ ...rise, id: 'alert:rise-NSE_EQ|Y-2026-11-19' })).toBe(0); // 10:30 IST: quiet
    expect(push.enqueue({ id: 'alert:short-NSE_EQ|Z-2026-11-19', title: '▼ SELL first Z', message: 'm', at: t })).toBe(1); // B
    expect(inQuietHours({ enabled: true, start: '22:00', end: '07:00' }, Date.parse('2026-11-19T20:00:00Z'))).toBe(true); // 01:30 IST
  });

  it('retries temporary failures with growing pauses, then sends; survives a restart', async () => {
    open();
    let ds = new DeviceStore(store.db, now);
    const dev = ds.pair(ds.issuePairingCode().code, { name: 'A', platform: 'android', appVersion: null })!.device;
    ds.setFcmToken(dev.id, TOKEN);
    const answers: SendResult[] = [
      { ok: false, kind: 'retry', error: 'HTTP 503 UNAVAILABLE' },
      { ok: false, kind: 'retry', error: 'network: timeout' },
      { ok: true, messageId: 'm1' },
    ];
    const sent: PushMessage[] = [];
    const fcm = { send: vi.fn(async (m: PushMessage) => (sent.push(m), answers.shift()!)) };
    let push = new PushService(store.db, ds, fcm, now);
    push.enqueue({ id: 'alert:bo-K-1.00-ok', title: '✅ Confirmed breakout: K', message: 'm', at: t, detail: { symbol: 'K', side: 'buy', source: 'Breakout', entry: 1, stop: 0.9, targets: [1.2], qty: 5, risk: 1, score: 70, reasons: ['r'] } });
    expect((await push.processDue()).retried).toBe(1);
    expect((await push.processDue()).retried).toBe(0); // not due yet
    t += backoffMs(1);
    expect((await push.processDue()).retried).toBe(1);
    // the server restarts: everything is in SQLite
    store.close();
    store = openStore(dir);
    ds = new DeviceStore(store.db, now);
    push = new PushService(store.db, ds, fcm, now);
    t += backoffMs(2);
    expect((await push.processDue()).sent).toBe(1);
    expect(push.rowsFor('alert:bo-K-1.00-ok')).toEqual([{ device_id: dev.id, status: 'sent', attempts: 3, last_error: null }]);
    expect(sent[2]!.data).toMatchObject({ alertId: 'alert:bo-K-1.00-ok', category: 'breakout', source: 'tradebuddy-server' });
    expect(JSON.parse(sent[2]!.data.detail!)).toMatchObject({ symbol: 'K', entry: 1 });
    expect(ds.get(dev.id)?.lastPushAt).toBe(t);
    expect([backoffMs(1), backoffMs(2), backoffMs(3), backoffMs(20)]).toEqual([5_000, 10_000, 20_000, 30 * 60_000]);
  });

  it('an invalid token stops pushes to that phone until it sends a new one; repeated failures give up', async () => {
    open();
    const ds = new DeviceStore(store.db, now);
    const dev = ds.pair(ds.issuePairingCode().code, { name: 'A', platform: 'android', appVersion: null })!.device;
    ds.setFcmToken(dev.id, TOKEN);
    const fcm = { send: vi.fn(async (): Promise<SendResult> => ({ ok: false, kind: 'invalid-token', error: 'HTTP 404 UNREGISTERED' })) };
    const push = new PushService(store.db, ds, fcm, now);
    push.enqueue({ id: 'alert:short-A-1', title: 't', message: 'm', at: t });
    expect((await push.processDue()).failed).toBe(1);
    expect(ds.get(dev.id)).toMatchObject({ fcmToken: null, tokenState: 'invalid' });
    expect(push.enqueue({ id: 'alert:short-A-2', title: 't', message: 'm', at: t })).toBe(0);
    ds.setFcmToken(dev.id, `${TOKEN}new`);
    expect(push.enqueue({ id: 'alert:short-A-3', title: 't', message: 'm', at: t })).toBe(1);
    // always busy → given up after the last try (a server message: it may wait up to a day)
    expect(push.enqueue({ id: 'test-giveup', title: 't', message: 'm', at: t })).toBe(1);
    fcm.send.mockImplementation(async () => ({ ok: false, kind: 'retry', error: 'HTTP 503' }));
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await push.processDue();
      t += 31 * 60_000;
    }
    expect(push.rowsFor('test-giveup')[0]).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS });
    // the market alert ran out of its 30 minutes while retrying: dropped, never sent late
    expect(push.rowsFor('alert:short-A-3')[0]).toMatchObject({ status: 'skipped', last_error: expect.stringMatching(/expired/) });
    expect(push.healthy).toBe(false); // failing: the phone is told so (it alerts by itself again)
  });

  it('review fix: after the server was down for hours, old market alerts are not pushed late', async () => {
    open();
    const ds = new DeviceStore(store.db, now);
    const dev = ds.pair(ds.issuePairingCode().code, { name: 'A', platform: 'android', appVersion: null })!.device;
    ds.setFcmToken(dev.id, TOKEN);
    const fcm = { send: vi.fn(async (): Promise<SendResult> => ({ ok: true, messageId: 'm' })) };
    let push = new PushService(store.db, ds, fcm, now);
    push.enqueue({ id: 'alert:bo-OLD-1', title: 'Breakout: OLD', message: 'm', at: t });
    push.enqueue({ id: 'test-old-server-message', title: 'server note', message: 'm', at: t });
    // down for 3 hours, then restarted
    store.close();
    store = openStore(dir);
    t += 3 * 3_600_000;
    push = new PushService(store.db, new DeviceStore(store.db, now), fcm, now);
    expect(await push.processDue()).toMatchObject({ sent: 1, skipped: 1 });
    expect(push.rowsFor('alert:bo-OLD-1')[0]).toMatchObject({ status: 'skipped', last_error: expect.stringMatching(/expired/) });
    expect(push.rowsFor('test-old-server-message')[0]!.status).toBe('sent'); // a day to live
    expect(fcm.send).toHaveBeenCalledTimes(1);
    expect(push.healthy).toBe(true);
  });

  it('review fix: a bare 404 from Google (e.g. a wrong project id) does not wipe the phones’ tokens', () => {
    const inv = vi.fn();
    expect(classify(404, { status: 'NOT_FOUND', message: 'Requested entity was not found.' }, null, inv)).toMatchObject({ kind: 'retry' });
    expect(classify(404, { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] }, null, inv)).toMatchObject({ kind: 'invalid-token' });
  });

  it('review fix: the server does not push the phone-only messages; its own token problem goes under its own id', () => {
    expect(serverPushAlert('login-reminder', 'Log in to Upstox', 'm')).toBeNull();
    expect(serverPushAlert('session-expired', 'Session ended', 'm')).toBeNull();
    expect(serverPushAlert('scan-summary', 'Evening scan', 'm')).toBeNull();
    expect(serverPushAlert('analytics-invalid', 'Upstox Analytics Token rejected', 'm')).toMatchObject({ id: 'server-analytics-invalid', title: 'TradeBuddy server: Upstox Analytics Token rejected' });
    expect(serverPushAlert('alert:bo-X-1', 't', 'm')).toEqual({ id: 'alert:bo-X-1', title: 't', message: 'm' });
    expect(categoryOf('server-analytics-invalid')).toBe('system');
  });

  it('payloads stay small and every alert kind maps to a category', () => {
    const p = buildPayload({ id: 'alert:intraday-K-2026-11-19', title: 'x', message: 'y', at: 1, detail: { symbol: 'K', side: 'buy', source: 's', entry: 1, stop: 0.9, targets: [1.2], qty: 1, risk: 1, score: 1, reasons: Array.from({ length: 30 }, () => 'r'.repeat(300)) } }, 'intraday');
    expect(JSON.stringify(p.data).length).toBeLessThan(3500);
    expect(Object.values(p.data).every((v) => typeof v === 'string')).toBe(true);
    expect(['alert:rise-K-d', 'alert:short-K-d', 'alert:bo-K-1-ok', 'alert:day-long-K:1', 'alert:intraday-K-d', 'alert:early-K-setup-d', 'alert:preopen-final-d', 'alert:pick-K:1', 'alert:al_1:5', 'alert:wallet-F1', 'alert:bot-open-1', 'login-reminder'].map(categoryOf)).toEqual([
      'rising', 'falling', 'breakout', 'daytrade', 'intraday', 'early', 'early', 'picks', 'price', 'practice', 'autotrader', 'system',
    ]);
  });
});

describe('the push API on the running server', () => {
  let server: RunningServer;
  const sent: PushMessage[] = [];
  const outside: string[] = [];
  const logs = logCapture();
  let tmp: ReturnType<typeof tempDir>;
  const fcm = { projectId: 'tradebuddy-test', send: vi.fn(async (m: PushMessage): Promise<SendResult> => (sent.push(m), { ok: true, messageId: `m${sent.length}` })) };
  const call = async (method: string, path: string, body?: unknown, auth: string | null = API_TOKEN) => {
    const res = await fetch(`http://127.0.0.1:${server.port}${path}`, { method, headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
    return { status: res.status, body: (await res.json()) as any };
  };

  afterEach(async () => {
    await server?.close('test end');
    vi.unstubAllGlobals();
    tmp?.cleanup();
  });

  it('pairs a phone with a one-time code, registers its token, pushes a server alert to it, and revokes it', async () => {
    tmp = tempDir();
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (u: string | URL, i?: RequestInit) => (String(u).startsWith('http://127.0.0.1') ? realFetch(u, i) : (outside.push(String(u)), Promise.reject(new TypeError('offline'))))));
    server = await startServer(testConfig(tmp.dir), { write: logs.write, fcm, startTasks: false });

    // admin only: a pairing code
    expect((await call('POST', '/v1/devices/pairing-code', undefined, null)).status).toBe(401);
    const { body: pc } = await call('POST', '/v1/devices/pairing-code');
    // the app pairs with the code (no other credential)
    expect((await call('POST', '/v1/devices/pair', { code: 'ABCDE-23456', name: 'Phone' }, null)).status).toBe(401);
    const paired = await call('POST', '/v1/devices/pair', { code: pc.code, name: 'Nik’s phone', appVersion: '1.20.0' }, null);
    expect(paired.status).toBe(201);
    const cred = paired.body.credential as string;
    // the credential works only on the phone's own endpoints — never as the admin token
    expect((await call('GET', '/v1/devices', undefined, cred)).status).toBe(401);
    expect((await call('GET', '/v1/device', undefined, cred)).body.device).toMatchObject({ name: 'Nik’s phone', tokenState: 'none' });
    expect((await call('PUT', '/v1/device/fcm-token', { token: 'short' }, cred)).status).toBe(400);
    expect((await call('PUT', '/v1/device/fcm-token', { token: TOKEN }, cred)).status).toBe(200);
    expect((await call('PUT', '/v1/device/preferences', { categories: ['falling', 'nonsense'] }, cred)).status).toBe(400);
    expect((await call('PUT', '/v1/device/preferences', { categories: ['falling', 'system'], channelId: 'trade-alerts-coins' }, cred)).status).toBe(200);

    // the server's own alert (the app's notify) → outbox → push
    await notify('alert:short-NSE_EQ|INE155A01022-2026-11-19', { title: '▼ SELL first TMPV at ₹252.55 · score 72', message: 'Buy back if it rises to ₹255.00', detail: { symbol: 'TMPV', side: 'sell', source: 'Falling now', entry: 252.55, stop: 255, targets: [250.1], qty: 40, risk: 98, score: 72, reasons: ['below VWAP'] } });
    await notify('alert:rise-NSE_EQ|X-2026-11-19', { title: '📈 X likely to keep rising', message: 'm' }); // not wanted (falling + system only)
    await vi.waitFor(() => expect(server.push.stats().pending).toBe(1));
    await server.push.processDue();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ token: TOKEN, channelId: 'trade-alerts-coins', data: { alertId: 'alert:short-NSE_EQ|INE155A01022-2026-11-19', category: 'falling' } });
    expect(JSON.parse(sent[0]!.data.detail!)).toMatchObject({ symbol: 'TMPV', stop: 255 });
    // the same alert again → nothing new (history + outbox both refuse repeats)
    await notify('alert:short-NSE_EQ|INE155A01022-2026-11-19', { title: '▼ SELL first TMPV', message: 'again' });
    await server.push.processDue();
    expect(sent).toHaveLength(1);

    // a test push (then not another for 30 seconds), and the admin view hides the token and the credential
    expect((await call('POST', '/v1/device/test-push', undefined, cred)).status).toBe(202);
    expect((await call('POST', '/v1/device/test-push', undefined, cred)).status).toBe(429);
    await server.push.processDue();
    expect(sent[1]!.title).toContain('test notification');
    const list = await call('GET', '/v1/devices');
    expect(JSON.stringify(list.body)).not.toContain(TOKEN);
    expect(JSON.stringify(list.body)).not.toContain(cred.split('.')[2]!);
    expect(list.body.devices[0]).toMatchObject({ tokenHint: `…${TOKEN.slice(-6)}`, push: { sent: 2 } });
    expect((await call('GET', '/v1/push')).body).toMatchObject({ configured: true, projectId: 'tradebuddy-test', outbox: { sent: 2 } });
    // review fix: the phone learns whether the server covers it (this test server makes no signals: jobs off, no Upstox token)
    expect((await call('GET', '/v1/device', undefined, cred)).body.server).toMatchObject({ signals: false, push: true, tokenActive: true });
    // review fix: phone-only messages are not pushed; the server's own token problem is, under its own id
    await notify('login-reminder', { title: 'Log in to Upstox', message: 'm' });
    await notify('scan-summary', { title: 'Evening scan: no setups today', message: 'm' });
    await notify('analytics-invalid', { title: 'Upstox Analytics Token rejected', message: 'Paste a new one.' });
    await vi.waitFor(() => expect(server.push.stats().pending).toBe(1));
    expect(server.push.rowsFor('login-reminder')).toEqual([]);
    expect(server.push.rowsFor('scan-summary')).toEqual([]);
    expect(server.push.rowsFor('server-analytics-invalid')).toHaveLength(1);
    await server.push.processDue();
    expect(sent.at(-1)!.title).toBe('TradeBuddy server: Upstox Analytics Token rejected');

    // restart: the phone stays paired
    const d = tmp.dir;
    await server.close('restart');
    server = await startServer(testConfig(d), { write: logs.write, fcm, startTasks: false });
    expect((await call('GET', '/v1/device', undefined, cred)).body.device.tokenState).toBe('active');

    // logout from the phone: the credential stops working
    expect((await call('DELETE', '/v1/device', undefined, cred)).body).toEqual({ revoked: true });
    expect((await call('GET', '/v1/device', undefined, cred)).status).toBe(401);
    // no secret in the logs; never an Upstox order or GTT call
    expect(logs.text()).not.toContain(cred.split('.')[2]!);
    expect(logs.text()).not.toContain(TOKEN);
    expect(outside.filter((u) => /\/order|\/gtt/i.test(u))).toEqual([]);
  });

  it('turns away guessed pairing codes (5 per address per 15 minutes) and bad requests', async () => {
    tmp = tempDir();
    server = await startServer(testConfig(tmp.dir), { write: () => undefined, fcm, startTasks: false });
    for (let i = 0; i < 5; i++) expect((await call('POST', '/v1/devices/pair', { code: `AAAAA-BBBB${i + 2}`, name: 'x' }, null)).status).toBe(401);
    const { body: pc } = await call('POST', '/v1/devices/pairing-code');
    expect((await call('POST', '/v1/devices/pair', { code: pc.code, name: 'x' }, null)).status).toBe(429); // even the right code now
    expect((await call('POST', '/v1/devices/pairing-code', 'not json')).status).toBe(400);
    expect((await call('POST', '/v1/devices/pairing-code', { pad: 'x'.repeat(20_000) })).status).toBe(413);
  });

  it('behind Caddy, wrong codes from one address do not lock out another (X-Forwarded-For, trusted from this machine only)', async () => {
    expect(clientIp('127.0.0.1', '203.0.113.7')).toBe('203.0.113.7');
    expect(clientIp('::1', 'spoofed-by-client, 198.51.100.9')).toBe('198.51.100.9'); // the entry Caddy added last
    expect(clientIp('203.0.113.7', '10.0.0.1')).toBe('203.0.113.7'); // not from this machine: header ignored
    expect(clientIp('127.0.0.1', 'not an ip')).toBe('127.0.0.1');
    tmp = tempDir();
    server = await startServer(testConfig(tmp.dir), { write: () => undefined, fcm, startTasks: false });
    const pair = (code: string, from: string) =>
      fetch(`http://127.0.0.1:${server.port}/v1/devices/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': from }, body: JSON.stringify({ code, name: 'x' }) });
    for (let i = 0; i < 5; i++) expect((await pair(`AAAAA-BBBB${i + 2}`, '203.0.113.7')).status).toBe(401);
    const { body: pc } = await call('POST', '/v1/devices/pairing-code');
    expect((await pair(pc.code, '203.0.113.7')).status).toBe(429);
    expect((await pair(pc.code, '198.51.100.9')).status).toBe(201);
  });

  it('push off without a Firebase key: pairing still works, test pushes say so', async () => {
    tmp = tempDir();
    server = await startServer(testConfig(tmp.dir), { write: () => undefined, startTasks: false });
    const { body: pc } = await call('POST', '/v1/devices/pairing-code');
    const cred = (await call('POST', '/v1/devices/pair', { code: pc.code, name: 'x' }, null)).body.credential as string;
    expect((await call('POST', '/v1/device/test-push', undefined, cred)).status).toBe(503);
    expect((await getJson(server.port, '/v1/push')).body).toMatchObject({ configured: false });
  });
});
