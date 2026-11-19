import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppFetchInit } from '../src/platform/http';
import { installChromeMock } from './chromeMock';

/**
 * Milestone 4 — the phone's side of cloud alerts: pairing, push token, received and tapped pushes, no
 * duplicates with the phone's own alerts, unpairing, and stand-alone mode unchanged. The Firebase plugin
 * and the network are stand-ins (a small fake server answering like the real one).
 */

const h = vi.hoisted(() => ({
  native: true,
  firebase: true,
  perm: 'prompt',
  permAnswer: 'granted',
  token: `fcm-token-${'y'.repeat(140)}:APA91b`,
  listeners: {} as Record<string, (x: unknown) => void>,
  plugin: [] as string[],
  requests: [] as Array<{ url: string; method: string; auth: string | null; body: any }>,
  serverDown: false,
}));

const SERVER = 'https://tb.example.com';
const CODE = 'ABCDE-23456';
const CRED = `tbd.0d6c3b5e-1111-4222-8333-944455556666.${'s'.repeat(43)}`;

/** Answers like server/src/http/deviceRoutes.ts. */
function fakeServer(url: string, method: string, auth: string | null, body: any): Response {
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
  const path = url.slice(SERVER.length);
  if (method === 'POST' && path === '/v1/devices/pair') {
    if (String(body?.code).replace(/[^A-Za-z0-9]/g, '').toUpperCase() !== CODE.replace('-', '')) return json(401, { error: 'invalid_code', message: 'Wrong, used or expired code. Ask the server for a new one.' });
    return json(201, { deviceId: '0d6c3b5e-1111-4222-8333-944455556666', credential: CRED });
  }
  if (auth !== `Bearer ${CRED}`) return json(401, { error: 'unauthorized', message: 'Unknown device.' });
  if (method === 'PUT' && path === '/v1/device/fcm-token') return json(200, { ok: true });
  if (method === 'PUT' && path === '/v1/device/preferences') return json(200, { ok: true });
  if (method === 'POST' && path === '/v1/device/test-push') return json(202, { queued: 1 });
  if (method === 'DELETE' && path === '/v1/device') return json(200, { revoked: true });
  if (method === 'GET' && path === '/v1/device') return json(200, { device: { tokenState: 'active', lastPushAt: null, push: { sent: 0, failed: 0, pending: 0 } }, pushConfigured: true });
  return json(404, { error: 'not_found' });
}

vi.mock('../src/platform/http', () => ({
  isNative: () => h.native,
  appFetch: async (url: string, init: AppFetchInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : null;
    const auth = init.headers?.Authorization ?? null;
    h.requests.push({ url: String(url), method: init.method ?? 'GET', auth, body });
    if (h.serverDown) throw new Error('Unable to resolve host');
    return fakeServer(String(url), init.method ?? 'GET', auth, body);
  },
}));

vi.mock('@capacitor/push-notifications', () => ({
  PushNotifications: {
    checkPermissions: async () => ({ receive: h.perm }),
    requestPermissions: async () => {
      h.plugin.push('requestPermissions');
      h.perm = h.permAnswer;
      return { receive: h.perm };
    },
    addListener: async (ev: string, fn: (x: unknown) => void) => {
      h.listeners[ev] = fn;
      return { remove: async () => undefined };
    },
    register: async () => {
      h.plugin.push('register');
      setTimeout(() => h.listeners.registration?.({ value: h.token }), 0);
    },
    unregister: async () => void h.plugin.push('unregister'),
    removeAllListeners: async () => {
      h.listeners = {};
    },
  },
}));

vi.mock('@capacitor/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@capacitor/core')>();
  return {
    ...actual,
    registerPlugin: (name: string, impl?: unknown) => (name === 'PushSetup' ? { status: async () => ({ configured: h.firebase }) } : actual.registerPlugin(name, impl as never)),
  };
});

const { coveredByCloud } = await import('../src/notify/cloudMode');
const push = await import('../src/platform/push');
const { notify } = await import('../src/notify/chrome');
const { getAlertHistory, recordAlert } = await import('../src/alerts/history');
const { getLocal, getSecrets, setLocal } = await import('../src/storage/local');
const { takePendingNotificationClick } = await import('../src/platform/chromeShim');

let chrome: ReturnType<typeof installChromeMock>;

beforeEach(async () => {
  chrome = installChromeMock();
  Object.assign(chrome.runtime, { getManifest: () => ({ version: '1.20.0' }) });
  Object.assign(h, { native: true, firebase: true, perm: 'prompt', permAnswer: 'granted', listeners: {}, plugin: [], requests: [], serverDown: false });
  await chrome.storage.local.set({ alertHistory: { items: [], clearedAt: null, seen: {}, dismissed: {} } });
  takePendingNotificationClick();
  push.__resetCloudPush();
});

const tokenSent = () => vi.waitFor(async () => expect((await getLocal('cloud'))?.tokenSentAt).toBeTypeOf('number'));
async function paired() {
  await push.pairWithServer(SERVER, CODE.toLowerCase(), 'Test phone', '1.20.0');
  await tokenSent();
}
const RISE = 'alert:rise-TATASTEEL-2026-11-19';
const PRICE = 'alert:rule-7f3a:1763530000000';

describe('which alerts the server pushes', () => {
  const state = { serverUrl: SERVER, deviceId: 'd', name: 'p', pairedAt: 1, categories: ['rising', 'breakout', 'system'] as const, tokenSentAt: 2, lastError: null };
  it('covers only chosen market signals, and only once the server has the push token', () => {
    const s = { ...state, categories: [...state.categories] };
    expect(coveredByCloud(s, RISE)).toBe(true);
    expect(coveredByCloud(s, 'alert:bo-INFY-2026-11-19')).toBe(true);
    expect(coveredByCloud(s, 'alert:short-INFY-2026-11-19')).toBe(false); // not chosen
    expect(coveredByCloud(s, PRICE)).toBe(false); // price alerts: phone's own data
    expect(coveredByCloud(s, 'alert:wallet-sold-1')).toBe(false); // practice money
    expect(coveredByCloud(s, 'login-reminder')).toBe(false); // system: always from the phone too
    expect(coveredByCloud({ ...s, tokenSentAt: null }, RISE)).toBe(false); // no token yet → phone alerts itself
    expect(coveredByCloud(null, RISE)).toBe(false); // stand-alone
  });

  it('accepts only an https server address (http only for a test server on this computer)', () => {
    expect(push.normalizeServerUrl(' https://tb.example.com/ ')).toBe('https://tb.example.com');
    expect(push.normalizeServerUrl('https://tb.example.com/api/')).toBe('https://tb.example.com/api');
    expect(push.normalizeServerUrl('http://10.0.2.2:8787')).toBe('http://10.0.2.2:8787');
    expect(() => push.normalizeServerUrl('http://tb.example.com')).toThrow(/https/);
    expect(() => push.normalizeServerUrl('https://user:pw@tb.example.com')).toThrow();
    expect(() => push.normalizeServerUrl('https://tb.example.com/?token=x')).toThrow();
    expect(() => push.normalizeServerUrl('not a url')).toThrow(/web address/);
  });
});

describe('pairing and the push token', () => {
  it('pairs with a one-time code, keeps the credential with the secrets, asks permission once and sends the token', async () => {
    await paired();
    const pair = h.requests.find((r) => r.url.endsWith('/v1/devices/pair'))!;
    expect(pair).toMatchObject({ method: 'POST', auth: null, body: { code: 'abcde-23456', name: 'Test phone', platform: 'android', appVersion: '1.20.0' } });
    expect((await getSecrets()).cloudDeviceCredential).toBe(CRED);
    const cloud = (await getLocal('cloud'))!;
    expect(JSON.stringify(cloud)).not.toContain(CRED.split('.')[2]); // the secret lives only with the other secrets
    expect(cloud).toMatchObject({ serverUrl: SERVER, name: 'Test phone', lastError: null });
    expect(cloud.categories).toEqual(['rising', 'falling', 'breakout', 'daytrade', 'intraday', 'early', 'picks', 'system']);
    expect(h.plugin.filter((x) => x === 'requestPermissions')).toHaveLength(1);
    const tok = h.requests.find((r) => r.url.endsWith('/v1/device/fcm-token'))!;
    expect(tok).toMatchObject({ method: 'PUT', auth: `Bearer ${CRED}`, body: { token: h.token } });
    const prefs = h.requests.find((r) => r.url.endsWith('/v1/device/preferences'))!;
    expect(prefs.body).toMatchObject({ categories: cloud.categories, quietHours: { enabled: false, start: '22:00', end: '07:00' } });
    expect(prefs.body.channelId).toMatch(/^[A-Za-z0-9_.-]{1,64}$/);
  });

  it('sends a refreshed token again when Firebase changes it', async () => {
    await paired();
    h.requests = [];
    h.listeners.registration!({ value: `fcm-token-${'z'.repeat(140)}:APA91b` });
    await vi.waitFor(() => expect(h.requests.filter((r) => r.url.endsWith('/v1/device/fcm-token'))).toHaveLength(1));
    expect(h.requests[0]!.body.token).toContain('zzz');
  });

  it('a wrong code changes nothing', async () => {
    await expect(push.pairWithServer(SERVER, 'ZZZZZ-99999', 'Phone', '1.20.0')).rejects.toThrow(/Wrong, used or expired/);
    expect(await getLocal('cloud')).toBeUndefined();
    expect((await getSecrets()).cloudDeviceCredential).toBeUndefined();
  });

  it('refuses before contacting the server when the APK has no Firebase (no crash, a clear message)', async () => {
    h.firebase = false;
    await expect(push.pairWithServer(SERVER, CODE, 'Phone', '1.20.0')).rejects.toThrow(/google-services\.json/);
    expect(h.requests).toHaveLength(0);
    expect(h.plugin).toHaveLength(0);
  });

  it('notifications not allowed: paired but not active, so the phone keeps alerting by itself', async () => {
    h.permAnswer = 'denied';
    await push.pairWithServer(SERVER, CODE, 'Phone', '1.20.0');
    const cloud = await getLocal('cloud');
    expect(cloud?.tokenSentAt).toBeNull();
    expect(cloud?.lastError).toMatch(/not allowed/);
    expect(coveredByCloud(cloud, RISE)).toBe(false);
  });

  it('category choices go to the server', async () => {
    await paired();
    await push.syncPreferences(['rising', 'system']);
    expect(h.requests.at(-1)!.body.categories).toEqual(['rising', 'system']);
    expect((await getLocal('cloud'))!.categories).toEqual(['rising', 'system']);
  });
});

describe('received and tapped pushes', () => {
  const data = (id: string, extra: Record<string, string> = {}) => ({ alertId: id, title: '📈 Rising now: TATASTEEL', message: 'Buy above ₹150', at: String(Date.now()), category: 'rising', source: 'tradebuddy-server', ...extra });

  it('app open: kept in the Alerts tab and shown as the in-app banner, once', async () => {
    const show = vi.fn();
    const detail = JSON.stringify({ symbol: 'TATASTEEL', side: 'buy', source: 'Rising now', entry: 150, stop: 147, targets: [153, 156], qty: 10, risk: 30, score: 72, reasons: ['Volume 2× normal'] });
    expect(await push.handlePushReceived(data(RISE, { detail }), show)).toBe(true);
    expect(await push.handlePushReceived(data(RISE), show)).toBe(false);
    expect(show).toHaveBeenCalledTimes(1);
    const hist = await getAlertHistory();
    expect(hist.items).toHaveLength(1);
    expect(hist.items[0]!.detail).toMatchObject({ symbol: 'TATASTEEL', targets: [153, 156] });
  });

  it('no duplicate when the phone already found the same alert (even with the server time a little earlier)', async () => {
    await recordAlert({ id: RISE, title: 'x', message: 'y', at: Date.now() });
    const show = vi.fn();
    expect(await push.handlePushReceived(data(RISE, { at: String(Date.now() - 40_000) }), show)).toBe(false);
    expect(show).not.toHaveBeenCalled();
    expect((await getAlertHistory()).items).toHaveLength(1);
  });

  it('ignores pushes that are not TradeBuddy alerts or have broken details', async () => {
    const show = vi.fn();
    expect(await push.handlePushReceived({ foo: 'bar' }, show)).toBe(false);
    expect(await push.handlePushReceived(undefined, show)).toBe(false);
    expect(await push.handlePushReceived(data('alert:pick-X-1', { detail: '{broken' }), show)).toBe(true);
    expect((await getAlertHistory()).items[0]!.detail).toBeUndefined();
  });

  it('tapped while the app was closed: stored, and the alert opens once the screens are ready', async () => {
    expect(await push.handlePushTapped(data(RISE))).toBe(RISE);
    expect((await getAlertHistory()).items.map((x) => x.id)).toEqual([RISE]);
    expect(takePendingNotificationClick()).toBe(RISE);
    expect(takePendingNotificationClick()).toBeNull(); // only once
  });

  it('the plugin listeners lead to the same handling', async () => {
    await paired();
    h.listeners.pushNotificationActionPerformed!({ actionId: 'tap', notification: { id: 'm1', data: data('alert:bo-INFY-2026-11-19') } });
    await vi.waitFor(() => expect(takePendingNotificationClick()).toBe('alert:bo-INFY-2026-11-19'));
    h.listeners.pushNotificationReceived!({ id: 'm2', data: data('alert:pick-INFY-2026-11-19') });
    await vi.waitFor(async () => expect((await getAlertHistory()).items.map((x) => x.id)).toContain('alert:pick-INFY-2026-11-19'));
  });
});

describe("the phone's own alerts", () => {
  const created = () => chrome.notifications.create.mock.calls.map((c) => ({ id: c[0], inAppOnly: (c[1] as { inAppOnly?: boolean }).inAppOnly === true }));

  it('stand-alone (not paired): every alert is a normal phone notification, as before', async () => {
    await notify(RISE as `alert:${string}`, { title: 'Rising', message: 'm' });
    await notify(PRICE as `alert:${string}`, { title: 'Stop hit', message: 'm' });
    expect(created()).toEqual([
      { id: RISE, inAppOnly: false },
      { id: PRICE, inAppOnly: false },
    ]);
  });

  it('cloud alerts on: market signals the server pushes are shown in the app only; the rest as before', async () => {
    await paired();
    await notify(RISE as `alert:${string}`, { title: 'Rising', message: 'm' });
    await notify(PRICE as `alert:${string}`, { title: 'Stop hit', message: 'm' });
    await notify('alert:wallet-sold-9', { title: 'Sold', message: 'm' });
    expect(created()).toEqual([
      { id: RISE, inAppOnly: true },
      { id: PRICE, inAppOnly: false },
      { id: 'alert:wallet-sold-9', inAppOnly: false },
    ]);
    // still in the Alerts tab, and the server's copy of it is not shown again
    expect((await getAlertHistory()).items.map((x) => x.id)).toContain(RISE);
    const show = vi.fn();
    expect(await push.handlePushReceived({ alertId: RISE, title: 'Rising', message: 'm', at: String(Date.now()) }, show)).toBe(false);
    expect(show).not.toHaveBeenCalled();
  });

  it('a market signal the user switched off for the cloud stays a phone notification', async () => {
    await paired();
    await push.syncPreferences(['breakout']);
    await notify(RISE as `alert:${string}`, { title: 'Rising', message: 'm' });
    expect(created()).toEqual([{ id: RISE, inAppOnly: false }]);
  });
});

describe('unpairing and start-up', () => {
  it('unpairs: the server forgets the phone, Firebase stops the token, the credential is deleted', async () => {
    await paired();
    await push.unpair();
    expect(h.requests.at(-1)).toMatchObject({ method: 'DELETE', url: `${SERVER}/v1/device`, auth: `Bearer ${CRED}` });
    expect(h.plugin).toContain('unregister');
    expect(await getLocal('cloud')).toBeNull();
    expect((await getSecrets()).cloudDeviceCredential).toBeUndefined();
  });

  it('unpairs on the phone even when the server cannot be reached', async () => {
    await paired();
    h.serverDown = true;
    await push.unpair();
    expect(await getLocal('cloud')).toBeNull();
    expect((await getSecrets()).cloudDeviceCredential).toBeUndefined();
    await expect(push.sendTestPush()).rejects.toThrow(/not paired/);
  });

  it('start-up when not paired does nothing at all (no permission prompt, no Firebase, no network)', async () => {
    await push.initCloudPush();
    expect(h.plugin).toHaveLength(0);
    expect(h.requests).toHaveLength(0);
  });

  it('start-up when paired refreshes the token (Firebase may have changed it)', async () => {
    await setLocal('cloud', { serverUrl: SERVER, deviceId: 'd', name: 'p', pairedAt: 1, categories: ['rising'], tokenSentAt: null, lastError: null });
    await chrome.storage.local.set({ secrets: { cloudDeviceCredential: CRED } });
    h.perm = 'granted';
    await push.initCloudPush();
    await tokenSent();
    expect(h.plugin).toEqual(['register']); // permission already given: not asked again
  });

  it('only ever talks to the paired server — never Upstox, never an order or GTT', async () => {
    await paired();
    await push.sendTestPush();
    await push.serverStatus();
    await push.unpair();
    expect(h.requests.length).toBeGreaterThan(4);
    for (const r of h.requests) {
      expect(r.url.startsWith(`${SERVER}/v1/device`)).toBe(true);
      expect(r.url).not.toMatch(/upstox|order|gtt/i);
    }
  });
});
