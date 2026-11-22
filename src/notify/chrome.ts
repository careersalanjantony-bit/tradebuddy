import { recordAlert, type AlertDetail } from '../alerts/history';
import { cloudCovers } from './cloudMode';
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
  /** app v1.18: the trade behind a trade alert, for the detail view (stored with the history only) */
  detail?: AlertDetail;
}

export async function notify(id: NotificationId, opts: NotifyOptions): Promise<void> {
  try {
    // app v1.18: every notification goes into the Alerts tab history; the same one is not shown again
    // within 24 hours (a cleared or dismissed alert must not come back when the app catches up)
    const fresh = await recordAlert({ id, title: opts.title, message: opts.message, at: Date.now(), ...(opts.detail ? { detail: opts.detail } : {}) }).catch((err: unknown) => {
      log.warn('Could not store the notification in the history', { id, error: err });
      return true;
    });
    if (!fresh) {
      log.info(`Notification not shown again (already shown in the last 24 hours): ${opts.title}`, { id });
      return;
    }
    // milestone 4: the server pushes this market signal to this phone — show it in the app only
    const cloud = await cloudCovers(id).catch(() => false);
    await chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
      title: opts.title,
      message: opts.message,
      requireInteraction: opts.requireInteraction ?? false,
      priority: opts.priority ?? 1,
      ...(cloud ? ({ inAppOnly: true } as object) : {}),
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
