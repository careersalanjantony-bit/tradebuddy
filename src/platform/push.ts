import { recordAlert, type AlertDetail } from '../alerts/history';
import { createLogger } from '../lib/log';
import { DEFAULT_CLOUD_CATEGORIES, isCategory, type AlertCategory } from '../notify/categories';
import type { CloudState } from '../notify/cloudMode';
import { alertChannel } from '../notify/toneList';
import { getLocal, getSettings, onLocalChanged, setLocal } from '../storage/local';
import { ALERT_EVENT, notificationClicked } from './chromeShim';
import { registerPlugin } from '@capacitor/core';
import type { PushNotificationsPlugin } from '@capacitor/push-notifications';
import { appFetch, isNative } from './http';
import { deleteCloudCredential, readCloudCredential, saveCloudCredential } from './secureStore';

/**
 * Milestone 4 — the phone's side of cloud alerts (Firebase Cloud Messaging).
 *
 *  Pairing: Settings → Cloud alerts → the server's https address + a one-time code from the server.
 *  The server answers with this phone's own credential (kept in Android Keystore-backed storage,
 *  secureStore.ts); the server's admin token, the Upstox token and the Firebase key are never on the phone.
 *  Heartbeat (review fix): while the app runs it checks every 3 minutes that the server covers it;
 *  only then does the phone leave market alerts to the server (cloudMode.ts).
 *  Push: Android's permission is asked once; the FCM token goes to the server and again whenever
 *  Firebase changes it (checked at every start — no background work of its own).
 *  Received while the app is open: kept in the Alerts tab and shown as the in-app banner (not twice
 *  if the phone already had it). Tapped (app closed or in the background): the app opens on the
 *  alert's details.
 * The app works exactly as before without pairing (stand-alone mode).
 */

const log = createLogger('push');

type PushData = Record<string, unknown> | undefined;

/**
 * The plugin is loaded only on a phone (and only when cloud alerts are used) — wrapped in a plain object.
 * RC2 fix: a Capacitor plugin object answers every property, also `then`; returned from an async function
 * (or awaited) it is taken for a promise that never settles. That is what made pairing hang on a real
 * phone in m4-fcm-rc1 (see secureStore.ts). `{ P }` is not "thenable".
 */
async function pushPlugin(): Promise<{ P: PushNotificationsPlugin }> {
  const { PushNotifications } = await import('@capacitor/push-notifications');
  return { P: PushNotifications };
}

/** RC2: a native call that does not answer must not hang the screen (Android's permission dialog excepted). */
export const NATIVE_CALL_TIMEOUT_MS = 15_000;
function withTimeout<T>(p: Promise<T>, what: string, ms = NATIVE_CALL_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new CloudError(`${what} did not answer within ${Math.round(ms / 1000)} s.`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export class CloudError extends Error {
  override name = 'CloudError';
  /**
   * `status` = the server's HTTP answer (undefined = no answer: offline, timed out), `code` = its error
   * code, `data` = the whole answer (app v1.22).
   */
  constructor(
    message: string,
    readonly status?: number,
    readonly code: string | null = null,
    readonly data: unknown = null,
  ) {
    super(message);
  }
}

/** The app's own check (android/.../PushSetupPlugin.java): was this APK built with google-services.json? */
const PushSetup = registerPlugin<{ status(): Promise<{ configured: boolean }> }>('PushSetup');
const NO_FIREBASE = 'This copy of the app was built without Firebase (google-services.json), so it cannot receive cloud alerts. See docs/FIREBASE_SETUP.md, step 3.';

/** Firebase must be set up in the APK before its push calls are used (otherwise Android stops the app). */
export async function firebaseReady(): Promise<boolean> {
  if (!isNative()) return false;
  return (await withTimeout(PushSetup.status(), 'The app’s Firebase check').catch(() => ({ configured: false }))).configured;
}

let localHttpForTests = false;
/** Tests only: allow http://127.0.0.1 (a test server on this computer). Never in the app. */
export function __allowLocalHttpForTests(on: boolean): void {
  localHttpForTests = on;
}

/**
 * The server's address as typed: https only (review fix: no plain-http exception — the pairing code and
 * the phone's credential must never travel unencrypted, not even to a local address).
 */
export function normalizeServerUrl(input: string): string {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new CloudError('That is not a web address. Example: https://tradebuddy.example.com');
  }
  const testLocal = localHttpForTests && u.protocol === 'http:' && u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !testLocal) throw new CloudError('The address must start with https:// (the connection has to be encrypted).');
  if (u.username || u.password || u.search || u.hash) throw new CloudError('Give only the server address, without a user, ? or #.');
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

async function api<T>(path: string, method: string, body?: unknown): Promise<T> {
  return cloudRequest<T>(path, method, body);
}

/**
 * App v1.22: a request to the paired server with this phone's own credential (never the admin token).
 * A refusal keeps the server's answer: `status` and its `error` code (e.g. 'conflict', 'not_controller').
 */
export async function cloudRequest<T>(path: string, method: string, body?: unknown, timeoutMs = 20_000): Promise<T> {
  const cloud = await getLocal('cloud');
  const cred = await readCloudCredential();
  if (!cloud || !cred) throw new CloudError('This phone is not paired with a server.');
  const res = await appFetch(`${cloud.serverUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${cred}`, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    timeoutMs,
  });
  const json = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
  if (!res.ok) throw new CloudError(json.message ?? `The server answered ${res.status}.`, res.status, json.error ?? null, json);
  return json as T;
}

async function patchCloud(p: Partial<CloudState>): Promise<CloudState | null> {
  const c = await getLocal('cloud');
  if (!c) return null;
  const next = { ...c, ...p };
  await setLocal('cloud', next);
  return next;
}

/** The alert kinds, quiet hours and notification channel the server should use for this phone. */
export async function syncPreferences(categories?: AlertCategory[]): Promise<void> {
  const c = await getLocal('cloud');
  if (!c) return;
  const n = (await getSettings()).notifications;
  const cats = categories ?? c.categories;
  await api('/v1/device/preferences', 'PUT', { categories: cats, quietHours: n.quietHours, channelId: alertChannel(n) });
  if (categories) await patchCloud({ categories: cats });
}

/** Pairs this phone with the server using a one-time code, then turns on push notifications. */
export async function pairWithServer(serverUrl: string, code: string, name: string, appVersion: string): Promise<CloudState> {
  const base = normalizeServerUrl(serverUrl);
  if (!(await firebaseReady())) throw new CloudError(isNative() ? NO_FIREBASE : 'Cloud alerts work in the Android app only.');
  const res = await appFetch(`${base}/v1/devices/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ code: code.trim(), name: name.trim() || 'Android phone', platform: 'android', appVersion }),
    timeoutMs: 20_000,
  });
  const json = (await res.json().catch(() => ({}))) as { deviceId?: string; credential?: string; message?: string };
  if (!res.ok || !json.deviceId || !json.credential) throw new CloudError(json.message ?? `Pairing failed (the server answered ${res.status}).`);
  log.info(`Pairing: the server accepted this phone (device ${json.deviceId.slice(0, 8)}…)`);
  const state: CloudState = { serverUrl: base, deviceId: json.deviceId, name: name.trim() || 'Android phone', pairedAt: Date.now(), categories: [...DEFAULT_CLOUD_CATEGORIES], tokenSentAt: null, lastError: null, serverOkAt: null };
  try {
    // review fix: the credential goes to the Android Keystore-backed storage, not the app's ordinary storage
    const where = await saveCloudCredential(json.credential);
    await setLocal('cloud', state);
    log.info(`Pairing: saved on the phone (credential in ${where === 'keystore' ? 'the Android Keystore' : 'the app storage'})`);
  } catch (err) {
    // RC2: the server has this phone now but the phone could not keep it — undo it on the server (with the
    // phone's own new credential), so no half-paired registration is left behind, and say so
    const reason = err instanceof Error ? err.message : String(err);
    const revoked = await revokeOnServer(base, json.credential);
    await deleteCloudCredential().catch(() => undefined);
    throw new CloudError(`The server accepted this phone, but the phone could not save the pairing (${reason}). ${revoked ? 'The server registration was removed again' : 'Ask for it to be revoked on the server'} — try again with a new code.`);
  }
  await syncPreferences().catch(() => undefined);
  await startPush().catch((err: unknown) => patchCloud({ lastError: err instanceof Error ? err.message : String(err) }));
  return (await getLocal('cloud')) ?? state;
}

/** Removes a just-made registration on the server with its own credential (best effort, 10 s). */
async function revokeOnServer(base: string, credential: string): Promise<boolean> {
  try {
    const res = await appFetch(`${base}/v1/device`, { method: 'DELETE', headers: { Authorization: `Bearer ${credential}`, Accept: 'application/json' }, timeoutMs: 10_000 });
    return res.ok;
  } catch {
    return false;
  }
}

/** Sends the FCM token to the server (first time and whenever Firebase changes it). */
export async function sendToken(token: string, now = Date.now()): Promise<void> {
  await api('/v1/device/fcm-token', 'PUT', { token });
  await patchCloud({ tokenSentAt: now, lastError: null });
  await checkServer(Date.now()).catch(() => false);
}

/** What GET /v1/device says about the server right now. */
export interface ServerReport {
  device: { tokenState: string; lastPushAt: number | null; push: { sent: number; failed: number; pending: number } };
  pushConfigured: boolean;
  server?: { signals: boolean; push: boolean; tokenActive: boolean; at: number };
}

/**
 * Review fix — the cloud heartbeat. While the app runs (its own scanners only run then), it asks the
 * server every few minutes whether it is making signals, its pushes work and this phone's token is
 * active. Only after a yes does the phone stop popping up its own copy of a market alert; when the
 * server is down, unreachable or not making signals, the phone's own notifications come back by
 * themselves within CLOUD_FRESH_MS. Returns whether the server covers this phone now.
 */
export async function checkServer(now = Date.now()): Promise<boolean> {
  const c = await getLocal('cloud');
  if (!c) return false;
  try {
    const r = await api<ServerReport>('/v1/device', 'GET');
    const ok = !!r.server && r.server.signals && r.server.push && r.server.tokenActive;
    await patchCloud(ok ? { serverOkAt: now, lastError: null } : { serverOkAt: null, lastError: !r.server ? 'the server is too old for cloud alerts' : !r.server.signals ? 'the server is not making signals right now (Upstox token or jobs)' : !r.server.push ? 'the server cannot push right now (Firebase)' : 'the server has no valid push token for this phone' });
    return ok;
  } catch (err) {
    // unreachable: keep the last yes — it runs out by itself after CLOUD_FRESH_MS
    await patchCloud({ lastError: `server not reached: ${err instanceof Error ? err.message : String(err)}` });
    return false;
  }
}

/** The data of a pushed alert, checked (FCM data is strings only). */
export function parsePushData(data: PushData): { id: string; title: string; message: string; at: number; detail?: AlertDetail } | null {
  if (!data || typeof data.alertId !== 'string' || typeof data.title !== 'string') return null;
  let detail: AlertDetail | undefined;
  if (typeof data.detail === 'string') {
    try {
      const d = JSON.parse(data.detail) as AlertDetail;
      if (d && typeof d.symbol === 'string' && Array.isArray(d.targets) && Array.isArray(d.reasons)) detail = d;
    } catch {
      /* no details then */
    }
  }
  const at = Number(data.at);
  return { id: data.alertId, title: data.title, message: typeof data.message === 'string' ? data.message : '', at: Number.isFinite(at) && at > 0 ? at : Date.now(), ...(detail ? { detail } : {}) };
}

const defaultShow = (a: { id: string; title: string; message: string }) => {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(ALERT_EVENT, { detail: { ...a, at: Date.now() } }));
};

/** A push while the app is open: into the Alerts tab and the banner — unless the phone already had it. */
export async function handlePushReceived(data: PushData, show: (a: { id: string; title: string; message: string }) => void = defaultShow): Promise<boolean> {
  const a = parsePushData(data);
  if (!a) return false;
  const fresh = await recordAlert(a).catch(() => false);
  if (fresh) show(a);
  return fresh;
}

/** A tapped push (the app was closed or in the background): keep it, then open its details. */
export async function handlePushTapped(data: PushData): Promise<string | null> {
  const a = parsePushData(data);
  if (!a) return null;
  await recordAlert(a).catch(() => false);
  notificationClicked(a.id);
  return a.id;
}

let listening = false;
/** Tests only: forget the plugin listeners (the stand-in plugin is reset between tests) and the heartbeat. */
export function __resetCloudPush(): void {
  listening = false;
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
}

/** Asks Android for permission (once), listens for the token and for pushes, and registers with FCM. */
export async function startPush(): Promise<void> {
  if (!isNative()) throw new CloudError('Push notifications work in the Android app only.');
  if (!(await firebaseReady())) throw new CloudError(NO_FIREBASE);
  const { P } = await pushPlugin();
  let perm = await withTimeout(P.checkPermissions(), 'Android (notification permission)');
  // Android's own dialog: no time limit, the user answers it (the pairing is already saved by then)
  if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') perm = await P.requestPermissions();
  if (perm.receive !== 'granted') throw new CloudError('Notifications are not allowed for TradeBuddy. Allow them in Android settings → Apps → TradeBuddy → Notifications.');
  if (!listening) {
    listening = true;
    await P.addListener('registration', (t) => void sendToken(t.value).catch((err: unknown) => patchCloud({ lastError: `token: ${err instanceof Error ? err.message : String(err)}` })));
    await P.addListener('registrationError', (e) => void patchCloud({ lastError: `Firebase: ${e.error}` }));
    await P.addListener('pushNotificationReceived', (n) => void handlePushReceived(n.data as PushData));
    await P.addListener('pushNotificationActionPerformed', (a) => void handlePushTapped(a.notification.data as PushData));
  }
  await withTimeout(P.register(), 'Firebase (registering for push)');
}

/** Unpairs: the server forgets this phone, Firebase stops its token, the credential is deleted. */
export async function unpair(): Promise<void> {
  await api('/v1/device', 'DELETE').catch((err: unknown) => log.info('Server not reached while unpairing (the phone forgets it anyway)', { reason: String(err) }));
  if (await firebaseReady()) {
    try {
      const { P } = await pushPlugin();
      await withTimeout(P.unregister(), 'Firebase (unregistering)');
      await withTimeout(P.removeAllListeners(), 'Firebase (listeners)');
      listening = false;
    } catch {
      /* Firebase not reachable: the server has forgotten this phone anyway */
    }
  }
  await deleteCloudCredential();
  await setLocal('cloud', null);
}

export async function sendTestPush(): Promise<void> {
  await api('/v1/device/test-push', 'POST');
}

export async function serverStatus(): Promise<ServerReport> {
  return api('/v1/device', 'GET');
}

/** How often the running app asks the server whether it covers this phone (one small request). */
export const HEARTBEAT_MS = 3 * 60_000;
let heartbeat: ReturnType<typeof setInterval> | null = null;

/** At app start: if paired, refresh the token (Firebase may have changed it), keep preferences in step and start the heartbeat. */
export async function initCloudPush(): Promise<void> {
  if (!isNative() || !(await getLocal('cloud'))) return;
  await startPush().catch((err: unknown) => patchCloud({ lastError: err instanceof Error ? err.message : String(err) }));
  let timer: ReturnType<typeof setTimeout> | null = null;
  onLocalChanged('settings', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void syncPreferences().catch(() => undefined), 2_000);
  });
  void checkServer().catch(() => false);
  heartbeat ??= setInterval(() => {
    void getLocal('cloud').then((c) => (c ? checkServer() : false)).catch(() => false);
  }, HEARTBEAT_MS);
  (heartbeat as { unref?: () => void }).unref?.();
}

export const validCategories = (v: unknown[]): AlertCategory[] => v.filter(isCategory);
