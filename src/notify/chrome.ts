import { createLogger } from '../lib/log';
import { appOnScreen } from '../platform/appState';
import { getSettings } from '../storage/local';
import { playAlertTone } from './sound';

/**
 * Minimal Chrome notifications for M1 (login reminder, session ended). The full notifier with
 * sounds, quiet hours and Telegram arrives in M5/M8.
 */

const log = createLogger('notify');

export type NotificationId = 'login-reminder' | 'session-expired' | 'analytics-invalid' | 'scan-summary' | `alert:${string}`;

export interface NotifyOptions {
  title: string;
  message: string;
  requireInteraction?: boolean;
  priority?: 0 | 1 | 2;
}

export async function notify(id: NotificationId, opts: NotifyOptions): Promise<void> {
  try {
    await chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
      title: opts.title,
      message: opts.message,
      requireInteraction: opts.requireInteraction ?? false,
      priority: opts.priority ?? 1,
    });
    log.info(`Notification shown: ${opts.title}`, { id });
    // app v1.9: the app is on screen and shows the alert itself — play the chosen tone here
    // (when it is not on screen, Android plays the tone with the pop-up notification)
    if (id.startsWith('alert:') && appOnScreen()) {
      const n = (await getSettings()).notifications;
      if (n.sounds) void playAlertTone(n.tone).catch(() => undefined);
    }
  } catch (err) {
    log.warn('Could not show notification', { id, error: err });
  }
}

export async function clearNotification(id: NotificationId): Promise<void> {
  try {
    await chrome.notifications.clear(id);
  } catch {
    // ignore
  }
}
