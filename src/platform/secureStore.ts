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

async function plugin() {
  return (await import('@capgo/capacitor-native-biometric')).NativeBiometric;
}

/** Saves the credential; returns where it went ('keystore' on a phone, 'app' otherwise or if the Keystore failed). */
export async function saveCloudCredential(credential: string): Promise<'keystore' | 'app'> {
  if (isNative()) {
    try {
      await (await plugin()).setData({ key: KEY, value: credential });
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
    const P = await plugin();
    const stored = await P.getData({ key: KEY })
      .then((d) => d.value || null)
      .catch(() => null);
    if (stored) return stored;
    if (legacy) {
      // from an earlier build: move it into the Keystore
      await P.setData({ key: KEY, value: legacy });
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
      await (await plugin()).deleteData({ key: KEY });
    } catch {
      /* nothing stored there */
    }
  }
  await updateSecrets({ cloudDeviceCredential: null });
}
