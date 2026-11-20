import type { NativeBiometricPlugin } from '@capgo/capacitor-native-biometric';
import { createLogger } from '../lib/log';
import { getSecrets, updateSecrets } from '../storage/local';
import { isNative } from './http';

/**
 * Milestone 4 (review fix) — where the phone keeps its cloud-alerts device credential.
 *
 * On Android: encrypted with a key in the Android Keystore (the app's own native storage plugin,
 * @capgo/capacitor-native-biometric setData / getData — Keystore + SharedPreferences), not in the app's
 * ordinary storage. The app's data is also excluded from Android backups (allowBackup="false").
 * A copy left in the ordinary storage by an earlier build is moved over and deleted on first read.
 * In a desktop browser (development only) it stays with the app's other secrets.
 */

const KEY = 'tradebuddy.cloud.deviceCredential';
const log = createLogger('secure-store');

/**
 * The native storage plugin, wrapped in a plain object.
 *
 * RC2 fix (pairing hung on a real phone with m4-fcm-rc1): NEVER return a Capacitor plugin object itself
 * from an async function, and never `await` it. A Capacitor plugin is a Proxy that answers every
 * property — also `then` — so JavaScript takes it for a promise, calls plugin.then(resolve, reject), and
 * Capacitor turns that into a native call of a method "then" that does not exist and never calls back:
 * the await waits forever. Wrapped as `{ NB }`, the object is no longer "thenable".
 */
async function keystore(): Promise<{ NB: NativeBiometricPlugin }> {
  const { NativeBiometric } = await import('@capgo/capacitor-native-biometric');
  return { NB: NativeBiometric };
}

/** Longest wait for one call to the Keystore plugin; after it the app storage is used (RC2: never hang). */
let nativeTimeoutMs = 8_000;
/** Tests only. */
export function __setNativeStoreTimeoutForTests(ms: number): void {
  nativeTimeoutMs = ms;
}

function withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not answer within ${Math.round(nativeTimeoutMs / 1000)} s`)), nativeTimeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Saves the credential; returns where it went ('keystore' on a phone, 'app' otherwise or if the Keystore failed). */
export async function saveCloudCredential(credential: string): Promise<'keystore' | 'app'> {
  if (isNative()) {
    try {
      const { NB } = await keystore();
      await withTimeout(NB.setData({ key: KEY, value: credential }), 'the Android Keystore');
      await updateSecrets({ cloudDeviceCredential: null });
      return 'keystore';
    } catch (err) {
      log.warn('Android Keystore storage failed — the credential is kept in the app storage instead', { reason: String(err) });
    }
  }
  await updateSecrets({ cloudDeviceCredential: credential });
  return 'app';
}

export async function readCloudCredential(): Promise<string | null> {
  const legacy = (await getSecrets()).cloudDeviceCredential ?? null;
  if (!isNative()) return legacy;
  try {
    const { NB } = await keystore();
    const stored = await withTimeout(NB.getData({ key: KEY }), 'the Android Keystore')
      .then((d) => d.value || null)
      .catch(() => null);
    if (stored) {
      // a copy also kept in the app storage (the Keystore answered late once): keep only the Keystore one
      if (legacy === stored) await updateSecrets({ cloudDeviceCredential: null });
      return stored;
    }
    if (legacy) {
      // from an earlier build (or a Keystore that did not answer in time): move it into the Keystore
      await withTimeout(NB.setData({ key: KEY, value: legacy }), 'the Android Keystore');
      await updateSecrets({ cloudDeviceCredential: null });
    }
    return legacy;
  } catch {
    return legacy;
  }
}

export async function deleteCloudCredential(): Promise<void> {
  if (isNative()) {
    try {
      const { NB } = await keystore();
      await withTimeout(NB.deleteData({ key: KEY }), 'the Android Keystore');
    } catch {
      /* nothing stored there */
    }
  }
  await updateSecrets({ cloudDeviceCredential: null });
}
