import { createLogger } from '../lib/log';
import { getSettings } from '../storage/local';
import { playTone, type SoundKind } from './tones';

export type { SoundKind };
const log = createLogger('sound');

/** Plays an alert sound unless sounds are off in Settings. Never throws. */
export async function playSound(kind: SoundKind, force = false): Promise<boolean> {
  try {
    if (!force && !(await getSettings()).notifications.sounds) return false;
    await playTone(kind);
    return true;
  } catch (err) {
    log.warn('Could not play alert sound', { error: err });
    return false;
  }
}
