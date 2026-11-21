import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { installChromeMock } from './chromeMock';

/**
 * Regression for the real-phone pairing hang of m4-fcm-rc1 (Pair → "Pairing…" forever, the server
 * answered 201, nothing saved on the phone).
 *
 * Root cause: the app's helpers RETURNED a Capacitor plugin object from an async function. A Capacitor
 * plugin is a Proxy that answers every property — also `then` — so JavaScript treats it as a promise and
 * calls plugin.then(resolve, reject). Capacitor turns that into a native call of a method "then", which
 * does not exist, and never calls resolve or reject: the await waits forever.
 *
 * The other phone tests use plain stand-in objects (no `then`), so they could not see it. These tests use
 * the REAL @capacitor/core plugin proxies with a stand-in Android bridge — the same objects the app gets
 * on a phone: window.androidBridge, Capacitor.PluginHeaders, nativePromise and nativeCallback.
 */

const SERVER = 'https://tb.example.com';
const CODE = 'ABCDE-23456';
const DEVICE = '0d6c3b5e-1111-4222-8333-944455556666';
const CRED = `tbd.${DEVICE}.${'s'.repeat(43)}`;
const TOKEN = `fcm-token-${'y'.repeat(140)}:APA91b`;

const bridge = {
  calls: [] as Array<{ plugin: string; method: string }>,
  requests: [] as Array<{ method: string; path: string; auth: string | null; body: any }>,
  keystore: new Map<string, string>(),
  /** the Keystore plugin never answers (a phone that hangs there) */
  keystoreHangs: false,
  keystoreFails: false,
  /** the pairing request itself fails on the phone (no network, timeout) */
  httpError: null as string | null,
  listeners: new Map<string, (data: unknown) => void>(),
  perm: 'granted',
};

const promise = (names: string[]) => names.map((name) => ({ name, rtype: 'promise' }));
// the Android bridge as @capacitor/android sets it up — before @capacitor/core is loaded
Object.assign(globalThis, {
  androidBridge: {},
  Capacitor: {
    PluginHeaders: [
      { name: 'CapacitorHttp', methods: promise(['request']) },
      { name: 'PushSetup', methods: promise(['status']) },
      { name: 'NativeBiometric', methods: promise(['setData', 'getData', 'deleteData', 'isAvailable', 'verifyIdentity']) },
      { name: 'PushNotifications', methods: [...promise(['checkPermissions', 'requestPermissions', 'register', 'unregister', 'removeAllListeners', 'removeListener']), { name: 'addListener', rtype: 'callback' }] },
    ],
    nativePromise: (plugin: string, method: string, options: any) => {
      bridge.calls.push({ plugin, method });
      return nativeAnswer(plugin, method, options);
    },
    nativeCallback: (plugin: string, method: string, options: any, cb: (data: unknown) => void) => {
      bridge.calls.push({ plugin, method });
      if (plugin === 'PushNotifications' && method === 'addListener') bridge.listeners.set(options.eventName, cb);
      return `cb-${bridge.calls.length}`;
    },
  },
});

const never = () => new Promise<never>(() => undefined);

/** What the native side answers (like the Android plugins and the TradeBuddy server). */
async function nativeAnswer(plugin: string, method: string, o: any): Promise<unknown> {
  if (plugin === 'PushSetup') return { configured: true };
  if (plugin === 'NativeBiometric') {
    if (bridge.keystoreHangs) return never();
    if (bridge.keystoreFails) throw new Error('Failed to save data');
    if (method === 'setData') return void bridge.keystore.set(o.key, o.value);
    if (method === 'getData') {
      if (!bridge.keystore.has(o.key)) throw new Error('No data found');
      return { value: bridge.keystore.get(o.key) };
    }
    if (method === 'deleteData') return void bridge.keystore.delete(o.key);
  }
  if (plugin === 'PushNotifications') {
    if (method === 'checkPermissions' || method === 'requestPermissions') return { receive: bridge.perm };
    if (method === 'register') {
      // Firebase answers with the token through the "registration" listener
      setTimeout(() => bridge.listeners.get('registration')?.({ value: TOKEN }), 5);
      return undefined;
    }
    return undefined;
  }
  if (plugin === 'CapacitorHttp' && method === 'request') {
    if (bridge.httpError) throw new Error(bridge.httpError);
    const path = String(o.url).slice(SERVER.length);
    const auth = (o.headers?.Authorization as string | undefined) ?? null;
    const body = typeof o.data === 'string' && o.data ? JSON.parse(o.data) : (o.data ?? null);
    bridge.requests.push({ method: o.method, path, auth, body });
    // a JSON answer: Android's CapacitorHttp hands it over already parsed (responseType is ignored for JSON)
    const answer = (status: number, data: unknown) => ({ status, headers: { 'Content-Type': 'application/json; charset=utf-8' }, url: o.url, data });
    if (o.method === 'POST' && path === '/v1/devices/pair') {
      if (String(body?.code).replace(/[^A-Za-z0-9]/g, '').toUpperCase() !== CODE.replace('-', '')) return answer(401, { error: 'invalid_code', message: 'Wrong, used or expired code. Ask the server for a new one.' });
      return answer(201, { deviceId: DEVICE, credential: CRED, device: { id: DEVICE, name: body.name, tokenState: 'none' }, note: 'Keep the credential secret; it is shown only now.' });
    }
    if (auth !== `Bearer ${CRED}`) return answer(401, { error: 'unauthorized', message: 'This phone is not paired (or was revoked). Pair it again in Settings.' });
    if (o.method === 'PUT' && (path === '/v1/device/fcm-token' || path === '/v1/device/preferences')) return answer(200, { ok: true });
    if (o.method === 'DELETE' && path === '/v1/device') return answer(200, { revoked: true });
    if (o.method === 'GET' && path === '/v1/device') return answer(200, { device: { tokenState: 'active', lastPushAt: null, push: { sent: 0, failed: 0, pending: 0 } }, pushConfigured: true, server: { signals: true, push: true, tokenActive: true, at: Date.now() } });
    return answer(404, { error: 'not_found' });
  }
  throw new Error(`"${plugin}.${method}()" is not implemented on android`);
}

let chrome: ReturnType<typeof installChromeMock>;
const { Capacitor, registerPlugin } = await import('@capacitor/core');
const push = await import('../src/platform/push');
const secure = await import('../src/platform/secureStore');
const { getLocal, getSecrets } = await import('../src/storage/local');

/** Settles within `ms`, or says it is still waiting. */
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p.then((v) => ({ done: true as const, v }), (e: unknown) => ({ done: true as const, e })), new Promise<{ done: false }>((r) => setTimeout(() => r({ done: false }), ms))]);

beforeEach(async () => {
  chrome = installChromeMock();
  Object.assign(chrome.runtime, { getManifest: () => ({ version: '1.21.0' }) });
  Object.assign(bridge, { calls: [], requests: [], keystoreHangs: false, keystoreFails: false, httpError: null, perm: 'granted' });
  bridge.keystore.clear();
  bridge.listeners.clear();
  push.__resetCloudPush();
  secure.__setNativeStoreTimeoutForTests?.(200);
});

describe('pairing on a real Capacitor bridge (regression: m4-fcm-rc1 hung after the server said 201)', () => {
  it('the stand-in bridge is the real thing: Capacitor sees Android and its plugin objects are "thenable"', async () => {
    expect(Capacitor.getPlatform()).toBe('android');
    expect(Capacitor.isNativePlatform()).toBe(true);
    const NB = registerPlugin('NativeBiometric') as unknown as { then: (ok: () => void, fail: () => void) => Promise<unknown> };
    expect(typeof NB.then).toBe('function');
    // why rc1 hung: `await` (or returning it from an async function) calls plugin.then(resolve, reject) …
    let settled = false;
    const call = NB.then(
      () => (settled = true),
      () => (settled = true),
    );
    // … Capacitor makes that a native call of a method "then", which fails on its own promise
    // (on the phone: 'Uncaught (in promise) Error: "NativeBiometric.then()" is not implemented on android') …
    expect(String(await call.catch((e: unknown) => e))).toMatch(/"NativeBiometric\.then\(\)" is not implemented on android/);
    await new Promise((r) => setTimeout(r, 50));
    // … and never calls resolve or reject: the await waits forever
    expect(settled).toBe(false);
  });

  it('pairs: finishes, keeps the credential in the Keystore (not in app storage), sends the FCM token', async () => {
    const r = await within(push.pairWithServer(SERVER, CODE.toLowerCase(), 'My phone', '1.21.0'), 3_000);
    expect(r.done).toBe(true);
    expect('e' in r ? String(r.e) : 'ok').toBe('ok');
    const cloud = await getLocal('cloud');
    expect(cloud).toMatchObject({ serverUrl: SERVER, deviceId: DEVICE, name: 'My phone' });
    expect(bridge.keystore.get('tradebuddy.cloud.deviceCredential')).toBe(CRED);
    expect((await getSecrets()).cloudDeviceCredential).toBeUndefined();
    // Firebase's token reaches the server with this phone's own credential
    await expect.poll(() => bridge.requests.find((q) => q.path === '/v1/device/fcm-token')?.body?.token, { timeout: 2_000 }).toBe(TOKEN);
    expect(bridge.requests.find((q) => q.path === '/v1/device/fcm-token')!.auth).toBe(`Bearer ${CRED}`);
    await expect.poll(async () => (await getLocal('cloud'))?.tokenSentAt, { timeout: 2_000 }).toBeTypeOf('number');
    // the Keystore copy is read back through the real proxy as well (heartbeat, test push, unpair)
    expect(await within(secure.readCloudCredential(), 1_000)).toEqual({ done: true, v: CRED });
  });

  it('a Keystore that never answers no longer blocks pairing: the credential is kept in app storage instead', async () => {
    bridge.keystoreHangs = true;
    const r = await within(push.pairWithServer(SERVER, CODE, 'My phone', '1.21.0'), 3_000);
    expect(r.done).toBe(true);
    expect('e' in r ? String(r.e) : 'ok').toBe('ok');
    expect((await getLocal('cloud'))?.deviceId).toBe(DEVICE);
    expect((await getSecrets()).cloudDeviceCredential).toBe(CRED);
  });

  it('when the phone cannot keep the pairing at all, the server registration is revoked again and the reason is shown', async () => {
    bridge.keystoreFails = true;
    // the app storage refuses too (e.g. the phone's storage is full)
    const set = chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set = (async (items: Record<string, unknown>) => {
      if ('secrets' in items || 'cloud' in items) throw new Error('QuotaExceededError: storage full');
      return set(items);
    }) as typeof chrome.storage.local.set;
    const r = await within(push.pairWithServer(SERVER, CODE, 'My phone', '1.21.0'), 3_000);
    expect(r.done).toBe(true);
    expect('e' in r && String(r.e)).toMatch(/could not save|storage full/i);
    expect(await getLocal('cloud')).toBeFalsy();
    // no half-paired phone left on the server: it was revoked with the phone's own credential
    expect(bridge.requests.some((q) => q.method === 'DELETE' && q.path === '/v1/device' && q.auth === `Bearer ${CRED}`)).toBe(true);
  });

  it('a failed pairing request is reported (and nothing is saved)', async () => {
    bridge.httpError = 'java.net.SocketTimeoutException: timeout';
    const r = await within(push.pairWithServer(SERVER, CODE, 'My phone', '1.21.0'), 3_000);
    expect(r.done).toBe(true);
    expect('e' in r && String(r.e)).toMatch(/timeout/);
    expect(await getLocal('cloud')).toBeFalsy();
  });

  it('a wrong code is reported with the server’s reason', async () => {
    const r = await within(push.pairWithServer(SERVER, 'ZZZZZ-99999', 'My phone', '1.21.0'), 3_000);
    expect(r.done && 'e' in r && String(r.e)).toMatch(/Wrong, used or expired code/);
  });

  it('unpairing finishes on the real bridge too (server revoked, Keystore copy deleted)', async () => {
    await push.pairWithServer(SERVER, CODE, 'My phone', '1.21.0');
    const r = await within(push.unpair(), 3_000);
    expect(r.done).toBe(true);
    expect(bridge.requests.some((q) => q.method === 'DELETE' && q.path === '/v1/device')).toBe(true);
    expect(bridge.keystore.size).toBe(0);
    expect(await getLocal('cloud')).toBeFalsy();
  });
});

describe('guard: no Capacitor plugin object is returned from an async function anywhere in the app', () => {
  it('src/ has no `return (await import(...)).Plugin` or `return Plugin` of a plugin in an async function', () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d, { withFileTypes: true })) {
        if (f.isDirectory()) walk(join(d, f.name));
        else if (/\.tsx?$/.test(f.name)) files.push(join(d, f.name));
      }
    };
    walk(join(__dirname, '..', 'src'));
    const bad = files.flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .map((line, i) => ({ f, i: i + 1, line }))
        .filter(({ line }) => /return\s*\(\s*await\s+import\(\s*['"]@(capacitor|capgo)\//.test(line)),
    );
    expect(bad.map((b) => `${b.f}:${b.i}`)).toEqual([]);
  });
});
