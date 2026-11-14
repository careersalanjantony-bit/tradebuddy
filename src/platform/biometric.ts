import { isNative } from './http';

/** Fingerprint / face unlock on the phone (nothing in a desktop browser). */
export async function biometricAvailable(): Promise<boolean> {
  if (!isNative()) return false;
  try {
    const { NativeBiometric } = await import('@capgo/capacitor-native-biometric');
    return (await NativeBiometric.isAvailable({ useFallback: false })).isAvailable;
  } catch {
    return false;
  }
}

export async function biometricUnlock(name: string): Promise<boolean> {
  if (!isNative()) return false;
  try {
    const { NativeBiometric } = await import('@capgo/capacitor-native-biometric');
    await NativeBiometric.verifyIdentity({ title: 'Unlock TradeBuddy', subtitle: `Welcome back, ${name}`, reason: 'Unlock TradeBuddy', negativeButtonText: 'Use PIN' });
    return true;
  } catch {
    return false;
  }
}
