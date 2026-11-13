import { createLogger } from '../lib/log';

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
