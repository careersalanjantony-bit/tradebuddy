import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppFetchInit } from '../../src/platform/http';
import { installChromeMock } from '../../tests/chromeMock';
import { addDeviceRoutes } from '../src/http/deviceRoutes';
import { Router } from '../src/http/router';
import { createHttpServer, type HttpServer } from '../src/http/server';
import { DeviceStore } from '../src/push/devices';
import type { PushMessage, SendResult } from '../src/push/fcm';
import { PushService } from '../src/push/outbox';
import { openStore, type Store } from '../src/storage/sqlite';
import { API_TOKEN, tempDir } from './helpers';

/**
 * Milestone 4, end to end without Firebase: the app's real pairing / push code talks over real HTTP to
 * the server's real device routes (SQLite on disk); a stand-in plays Firebase on both sides.
 */

const h = vi.hoisted(() => ({
  token: `fcm-${'q'.repeat(150)}:APA91b`,
  listeners: {} as Record<string, (x: unknown) => void>,
  urls: [] as string[],
  keystore: new Map<string, string>(),
  signals: true,
}));

vi.mock('@capgo/capacitor-native-biometric', () => ({
  NativeBiometric: {
    setData: async ({ key, value }: { key: string; value: string }) => void h.keystore.set(key, value),
    getData: async ({ key }: { key: string }) => {
      if (!h.keystore.has(key)) throw new Error('not found');
      return { value: h.keystore.get(key)! };
    },
    deleteData: async ({ key }: { key: string }) => void h.keystore.delete(key),
  },
}));

vi.mock('../../src/platform/http', () => ({
  isNative: () => true,
  appFetch: async (url: string, init: AppFetchInit = {}) => {
    h.urls.push(String(url));
    return fetch(url, { method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ?? null });
  },
}));
vi.mock('@capacitor/push-notifications', () => ({
  PushNotifications: {
    checkPermissions: async () => ({ receive: 'granted' }),
    requestPermissions: async () => ({ receive: 'granted' }),
    addListener: async (ev: string, fn: (x: unknown) => void) => {
      h.listeners[ev] = fn;
      return { remove: async () => undefined };
    },
    register: async () => void setTimeout(() => h.listeners.registration?.({ value: h.token }), 0),
    unregister: async () => undefined,
    removeAllListeners: async () => {
      h.listeners = {};
    },
  },
}));
vi.mock('@capacitor/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@capacitor/core')>();
  return { ...actual, registerPlugin: (name: string, impl?: unknown) => (name === 'PushSetup' ? { status: async () => ({ configured: true }) } : actual.registerPlugin(name, impl as never)) };
});

const phone = await import('../../src/platform/push');
const { notify } = await import('../../src/notify/chrome');
const { getAlertHistory } = await import('../../src/alerts/history');
const { getLocal } = await import('../../src/storage/local');
const { readCloudCredential } = await import('../../src/platform/secureStore');
// the test server runs on this computer without TLS (the app itself accepts only https)
phone.__allowLocalHttpForTests(true);

let tmp: ReturnType<typeof tempDir>;
let store: Store;
let http: HttpServer;
let base: string;
let devices: DeviceStore;
let push: PushService;
const sent: PushMessage[] = [];
const fcm = {
  projectId: 'tb-test',
  send: async (m: PushMessage): Promise<SendResult> => {
    sent.push(m);
    return { ok: true, messageId: `projects/tb-test/messages/${sent.length}` };
  },
};
let chrome: ReturnType<typeof installChromeMock>;

beforeAll(async () => {
  chrome = installChromeMock();
  Object.assign(chrome.runtime, { getManifest: () => ({ version: '1.20.0' }) });
  tmp = tempDir();
  store = openStore(tmp.dir);
  devices = new DeviceStore(store.db, () => Date.now());
  push = new PushService(store.db, devices, fcm, () => Date.now());
  const router = new Router();
  addDeviceRoutes(router, { devices, push, projectId: fcm.projectId, now: () => Date.now(), signals: async () => h.signals });
  http = createHttpServer({ host: '127.0.0.1', port: 0, apiToken: API_TOKEN, router, deviceAuth: (c) => devices.authenticate(c) });
  base = `http://127.0.0.1:${await http.listen()}`;
});

afterAll(async () => {
  await http.close(2000);
  store.close();
  tmp.cleanup();
});

const ALERT = 'alert:rise-INFY-2026-11-19';

describe('phone ↔ server, end to end', () => {
  it('pairs with a code from the server and registers its push token and preferences', async () => {
    const { code } = devices.issuePairingCode();
    await phone.pairWithServer(base, code, 'Pixel 8', '1.20.0');
    await vi.waitFor(async () => expect((await getLocal('cloud'))?.tokenSentAt).toBeTypeOf('number'));
    // the heartbeat: the real server confirms it makes signals, can push and has this phone's token
    await vi.waitFor(async () => expect((await getLocal('cloud'))?.serverOkAt).toBeTypeOf('number'));
    const [d] = devices.list();
    expect(d).toMatchObject({ name: 'Pixel 8', platform: 'android', appVersion: '1.20.0', tokenState: 'active', fcmToken: h.token, channelId: 'alerts-cash', quietHours: { enabled: false } });
    expect(d!.categories).toEqual(['rising', 'falling', 'breakout', 'daytrade', 'intraday', 'early', 'picks', 'system']);
    expect(devices.authenticate(await readCloudCredential())?.id).toBe(d!.id);
    // the code worked once
    const again = await fetch(`${base}/v1/devices/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name: 'x', platform: 'android' }) });
    expect(again.status).toBe(401);
  });

  it('a server alert reaches the phone once, with its details, and the phone does not repeat it', async () => {
    const detail = { symbol: 'INFY', side: 'buy' as const, source: 'Rising now', entry: 1500, stop: 1480, targets: [1530], qty: 3, risk: 60, score: 70, reasons: ['Volume 2× normal'] };
    expect(push.enqueue({ id: ALERT, title: '📈 Rising now: INFY', message: 'Buy above ₹1,500', at: Date.now() - 20_000, detail })).toBe(1);
    expect(push.enqueue({ id: ALERT, title: '📈 Rising now: INFY', message: 'again', at: Date.now() })).toBe(0); // same alert id: never queued twice
    expect(await push.processDue()).toMatchObject({ sent: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ token: h.token, channelId: 'alerts-cash', data: { alertId: ALERT, category: 'rising' } });

    const show = vi.fn();
    expect(await phone.handlePushReceived(sent[0]!.data, show)).toBe(true);
    expect(await phone.handlePushReceived(sent[0]!.data, show)).toBe(false);
    expect(show).toHaveBeenCalledTimes(1);
    expect((await getAlertHistory()).items[0]).toMatchObject({ id: ALERT, detail: { symbol: 'INFY', targets: [1530] } });
    // the phone's own scan finds the same signal a moment later: no second notification
    await notify(ALERT, { title: '📈 Rising now: INFY', message: 'Buy above ₹1,500' });
    expect(chrome.notifications.create).not.toHaveBeenCalled();
  });

  it('a market alert the phone finds first is shown in the app only; the push copy is then ignored', async () => {
    const id = 'alert:bo-TCS-2026-11-19';
    await notify(id, { title: 'Breakout: TCS', message: 'm' });
    expect(chrome.notifications.create).toHaveBeenCalledWith(id, expect.objectContaining({ inAppOnly: true }));
    push.enqueue({ id, title: 'Breakout: TCS', message: 'm', at: Date.now() - 5_000 });
    await push.processDue();
    const show = vi.fn();
    expect(await phone.handlePushReceived(sent.at(-1)!.data, show)).toBe(false);
    expect(show).not.toHaveBeenCalled();
  });

  it("the phone's test push goes through the outbox (one per 30 seconds)", async () => {
    await phone.sendTestPush();
    expect(await push.processDue()).toMatchObject({ sent: 1 });
    expect(sent.at(-1)!.data.alertId).toMatch(/^test-push-/);
    expect((await phone.serverStatus()).device.push.sent).toBe(3);
    await expect(phone.sendTestPush()).rejects.toThrow(/One test push every 30 seconds/);
  });

  it('when the server stops making signals, the phone takes its alerts back', async () => {
    h.signals = false;
    expect(await phone.checkServer()).toBe(false);
    const id = 'alert:bo-HCLTECH-2026-11-19';
    await notify(id, { title: 'Breakout: HCLTECH', message: 'm' });
    expect(chrome.notifications.create).toHaveBeenLastCalledWith(id, expect.not.objectContaining({ inAppOnly: true }));
    h.signals = true;
    expect(await phone.checkServer()).toBe(true);
  });

  it('unpairing revokes the phone on the server: its credential stops working and nothing more is sent', async () => {
    const cred = (await readCloudCredential())!;
    await phone.unpair();
    expect(devices.list()[0]!.revokedAt).toBeTypeOf('number');
    const res = await fetch(`${base}/v1/device`, { headers: { Authorization: `Bearer ${cred}` } });
    expect(res.status).toBe(401);
    expect(push.enqueue({ id: 'alert:rise-WIPRO-2026-11-19', title: 't', message: 'm', at: Date.now() })).toBe(0);
    expect(await getLocal('cloud')).toBeNull();
  });

  it('the app only ever called its own server (no Upstox, no orders, no GTT)', () => {
    expect(h.urls.length).toBeGreaterThan(5);
    for (const u of h.urls) {
      expect(u.startsWith(base)).toBe(true);
      expect(u).not.toMatch(/upstox|order|gtt/i);
    }
  });
});
