import { recordAlert, type AlertDetail } from '../alerts/history';
import { createLogger } from '../lib/log';
import { DEFAULT_CLOUD_CATEGORIES, isCategory, type AlertCategory } from '../notify/categories';
import type { CloudState } from '../notify/cloudMode';
import { alertChannel } from '../notify/toneList';
import { getLocal, getSecrets, getSettings, onLocalChanged, setLocal, updateSecrets } from '../storage/local';
import { ALERT_EVENT, notificationClicked } from './chromeShim';
import { registerPlugin } from '@capacitor/core';
import { appFetch, isNative } from './http';

/**
 * Milestone 4 — the phone's side of cloud alerts (Firebase Cloud Messaging).
 *
 *  Pairing: Settings → Cloud alerts → the server's https address + a one-time code from the server.
 *  The server answers with this phone's own credential (kept with the app's other secrets); the
 *  server's admin token, the Upstox token and the Firebase key are never on the phone.
 *  Push: Android's permission is asked once; the FCM token goes to the server and again whenever
 *  Firebase changes it (checked at every start — no background work of its own).
 *  Received while the app is open: kept in the Alerts tab and shown as the in-app banner (not twice
 *  if the phone already had it). Tapped (app closed or in the background): the app opens on the
 *  alert's details.
 * The app works exactly as before without pairing (stand-alone mode).
 */

const log = createLogger('push');

type PushData = Record<string, unknown> | undefined;

/** The plugin is loaded only on a phone (and only when cloud alerts are used). */
async function plugin() {
  return (await import('@capacitor/push-notifications')).PushNotifications;
}

export class CloudError extends Error {
  override name = 'CloudError';
}

/** The app's own check (android/.../PushSetupPlugin.java): was this APK built with google-services.json? */
const PushSetup = registerPlugin<{ status(): Promise<{ configured: boolean }> }>('PushSetup');
const NO_FIREBASE = 'This copy of the app was built without Firebase (google-services.json), so it cannot receive cloud alerts. See docs/FIREBASE_SETUP.md, step 3.';

/** Firebase must be set up in the APK before its push calls are used (otherwise Android stops the app). */
export async function firebaseReady(): Promise<boolean> {
  if (!isNative()) return false;
  return (await PushSetup.status().catch(() => ({ configured: false }))).configured;
}

/** The server's address as typed: https only (http only for a test server on this computer / emulator). */
export function normalizeServerUrl(input: string): string {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new CloudError('That is not a web address. Example: https://tradebuddy.example.com');
  }
  const local = ['localhost', '127.0.0.1', '10.0.2.2'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new CloudError('The address must start with https:// (the connection has to be encrypted).');
  if (u.username || u.password || u.search || u.hash) throw new CloudError('Give only the server address, without a user, ? or #.');
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

async function api<T>(path: string, method: string, body?: unknown): Promise<T> {
  const cloud = await getLocal('cloud');
  const cred = (await getSecrets()).cloudDeviceCredential;
  if (!cloud || !cred) throw new CloudError('This phone is not paired with a server.');
  const res = await appFetch(`${cloud.serverUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${cred}`, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    timeoutMs: 20_000,
  });
  const json = (await res.json().catch(() => ({}))) as { message?: string };
  if (!res.ok) throw new CloudError(json.message ?? `The server answered ${res.status}.`);
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
  await updateSecrets({ cloudDeviceCredential: json.credential });
  const state: CloudState = { serverUrl: base, deviceId: json.deviceId, name: name.trim() || 'Android phone', pairedAt: Date.now(), categories: [...DEFAULT_CLOUD_CATEGORIES], tokenSentAt: null, lastError: null };
  await setLocal('cloud', state);
  await syncPreferences().catch(() => undefined);
  await startPush().catch((err: unknown) => patchCloud({ lastError: err instanceof Error ? err.message : String(err) }));
  return (await getLocal('cloud')) ?? state;
}

/** Sends the FCM token to the server (first time and whenever Firebase changes it). */
export async function sendToken(token: string, now = Date.now()): Promise<void> {
  await api('/v1/device/fcm-token', 'PUT', { token });
  await patchCloud({ tokenSentAt: now, lastError: null });
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
/** Tests only: forget the plugin listeners (the stand-in plugin is reset between tests). */
export function __resetCloudPush(): void {
  listening = false;
}

/** Asks Android for permission (once), listens for the token and for pushes, and registers with FCM. */
export async function startPush(): Promise<void> {
  if (!isNative()) throw new CloudError('Push notifications work in the Android app only.');
  if (!(await firebaseReady())) throw new CloudError(NO_FIREBASE);
  const P = await plugin();
  let perm = await P.checkPermissions();
  if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') perm = await P.requestPermissions();
  if (perm.receive !== 'granted') throw new CloudError('Notifications are not allowed for TradeBuddy. Allow them in Android settings → Apps → TradeBuddy → Notifications.');
  if (!listening) {
    listening = true;
    await P.addListener('registration', (t) => void sendToken(t.value).catch((err: unknown) => patchCloud({ lastError: `token: ${err instanceof Error ? err.message : String(err)}` })));
    await P.addListener('registrationError', (e) => void patchCloud({ lastError: `Firebase: ${e.error}` }));
    await P.addListener('pushNotificationReceived', (n) => void handlePushReceived(n.data as PushData));
    await P.addListener('pushNotificationActionPerformed', (a) => void handlePushTapped(a.notification.data as PushData));
  }
  await P.register();
}

/** Unpairs: the server forgets this phone, Firebase stops its token, the credential is deleted. */
export async function unpair(): Promise<void> {
  await api('/v1/device', 'DELETE').catch((err: unknown) => log.info('Server not reached while unpairing (the phone forgets it anyway)', { reason: String(err) }));
  if (await firebaseReady()) {
    try {
      const P = await plugin();
      await P.unregister();
      await P.removeAllListeners();
      listening = false;
    } catch {
      /* Firebase not reachable: the server has forgotten this phone anyway */
    }
  }
  await updateSecrets({ cloudDeviceCredential: null });
  await setLocal('cloud', null);
}

export async function sendTestPush(): Promise<void> {
  await api('/v1/device/test-push', 'POST');
}

export async function serverStatus(): Promise<{ device: { tokenState: string; lastPushAt: number | null; push: { sent: number; failed: number; pending: number } }; pushConfigured: boolean }> {
  return api('/v1/device', 'GET');
}

/** At app start: if paired, refresh the token (Firebase may have changed it) and keep preferences in step. */
export async function initCloudPush(): Promise<void> {
  if (!isNative() || !(await getLocal('cloud'))) return;
  await startPush().catch((err: unknown) => patchCloud({ lastError: err instanceof Error ? err.message : String(err) }));
  let timer: ReturnType<typeof setTimeout> | null = null;
  onLocalChanged('settings', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void syncPreferences().catch(() => undefined), 2_000);
  });
}

export const validCategories = (v: unknown[]): AlertCategory[] => v.filter(isCategory);
