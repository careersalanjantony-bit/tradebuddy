import { createLogger } from '../lib/log';
import { isNative } from '../platform/http';
import { getSettings } from '../storage/local';
import { toneUrl } from './toneList';
import { playTone, type SoundKind } from './tones';

export type { SoundKind };
const log = createLogger('sound');

let lastToneAt = 0;
let playing: HTMLAudioElement | null = null;

/**
 * Plays a notification tone inside the app (app v1.9): the Settings preview, and alerts while the app
 * is on screen. The phone's own sound ("system") or a file that cannot play falls back to the built-in
 * beeps (a falling one for a stop-loss, a rising one for a target).
 */
export async function playAlertTone(tone: string | undefined, kind: SoundKind = 'info'): Promise<boolean> {
  lastToneAt = Date.now();
  const url = toneUrl(tone);
  if (url && typeof Audio !== 'undefined') {
    try {
      playing?.pause();
      const a = new Audio(url);
      a.volume = 1;
      playing = a;
      // never wait long: an alert must not be held up by its sound
      await Promise.race([a.play(), new Promise((r) => setTimeout(r, 1_500))]);
      return true;
    } catch (err) {
      log.debug('Tone file could not play; using the built-in beep', { error: err });
    }
  }
  await playTone(tone === 'system' ? kind : 'target');
  return true;
}

/** An alert's tone was just played (or will be by Android): do not play a second sound for it. */
export const toneJustPlayed = (now = Date.now()): boolean => now - lastToneAt < 4_000;

/**
 * The sound after an alert. Unless `force` (the test button), nothing plays twice: while the app is on
 * screen the alert already played the chosen tone, and on Android with the app in the background the
 * notification itself plays it. Never throws.
 */
export async function playSound(kind: SoundKind, force = false): Promise<boolean> {
  try {
    const n = (await getSettings()).notifications;
    if (force) return await playAlertTone(n.tone, kind);
    if (!n.sounds || toneJustPlayed()) return false;
    if (isNative()) return false;
    return await playAlertTone(n.tone, kind);
  } catch (err) {
    log.warn('Could not play alert sound', { error: err });
    return false;
  }
}
