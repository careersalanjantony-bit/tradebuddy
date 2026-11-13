import { App } from '@capacitor/app';
import { LocalNotifications } from '@capacitor/local-notifications';
import { InAppBrowser, ToolBarType } from '@capgo/capacitor-inappbrowser';
import { ForegroundService } from '@capawesome-team/capacitor-android-foreground-service';
import { notificationClicked, setAuthFlowRunner, setNotificationBackend } from './chromeShim';
import { isNative } from './http';

/**
 * Android-only wiring: notifications, the Upstox login window, keeping the app awake during market
 * hours, and catching up when the app comes back to the front. Does nothing in a desktop browser.
 */

/** Android notification ids are numbers; the app's ids are strings. */
export function numericId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(31, h) + id.charCodeAt(i)) | 0;
  return Math.abs(h) % 2_000_000_000;
}

const CHANNEL = 'trade-alerts';

export async function initNative(onResume: () => void): Promise<void> {
  if (!isNative()) return;

  try {
    await LocalNotifications.createChannel({ id: CHANNEL, name: 'Trade alerts', description: 'Buy signals, stop-loss, targets and trades found in Upstox', importance: 5, visibility: 1, vibration: true });
  } catch {
    /* older Android: channels not needed */
  }
  setNotificationBackend({
    async show(id, title, message, opts) {
      const perm = await LocalNotifications.checkPermissions();
      if (perm.display !== 'granted') return;
      await LocalNotifications.schedule({
        notifications: [{ id: numericId(id), title, body: message, largeBody: message, channelId: CHANNEL, extra: { id }, autoCancel: !opts.requireInteraction, ongoing: false }],
      });
    },
    async clear(id) {
      await LocalNotifications.cancel({ notifications: [{ id: numericId(id) }] }).catch(() => undefined);
    },
  });
  await LocalNotifications.addListener('localNotificationActionPerformed', (e) => {
    const id = (e.notification.extra as { id?: string } | undefined)?.id;
    if (id) notificationClicked(id);
  });

  setAuthFlowRunner(
    (url, redirectPrefix) =>
      new Promise<string>((resolve, reject) => {
        let done = false;
        const handles: Array<{ remove: () => Promise<void> }> = [];
        const finish = (fn: () => void) => {
          if (done) return;
          done = true;
          for (const h of handles) void h.remove();
          fn();
        };
        void (async () => {
          handles.push(
            await InAppBrowser.addListener('urlChangeEvent', (e) => {
              if (e.url?.startsWith(redirectPrefix)) {
                finish(() => resolve(e.url));
                void InAppBrowser.close().catch(() => undefined);
              }
            }),
          );
          handles.push(await InAppBrowser.addListener('closeEvent', () => finish(() => reject(new Error('The user did not approve access.')))));
          await InAppBrowser.openWebView({ url, title: 'Upstox login', toolbarType: ToolBarType.COMPACT, isPresentAfterPageLoad: false });
        })().catch((err: unknown) => finish(() => reject(err instanceof Error ? err : new Error(String(err)))));
      }),
  );

  await App.addListener('resume', onResume);
}

/** Asks Android for permission to show notifications (Android 13+). */
export async function askNotificationPermission(): Promise<boolean> {
  if (!isNative()) {
    if (typeof Notification === 'undefined') return false;
    if (Notification.permission === 'granted') return true;
    return (await Notification.requestPermission()) === 'granted';
  }
  const p = await LocalNotifications.requestPermissions();
  return p.display === 'granted';
}

export async function notificationPermission(): Promise<'granted' | 'denied' | 'prompt'> {
  if (!isNative()) {
    if (typeof Notification === 'undefined') return 'denied';
    return Notification.permission === 'default' ? 'prompt' : (Notification.permission as 'granted' | 'denied');
  }
  const p = await LocalNotifications.checkPermissions();
  return p.display === 'granted' ? 'granted' : p.display === 'denied' ? 'denied' : 'prompt';
}

let watching = false;
/**
 * While the market is open, Android may stop an app that is in the background. A "foreground
 * service" (a small permanent notification: "TradeBuddy is watching the market") keeps it running
 * so stop-loss and target alerts still arrive. Stopped again after the market closes.
 */
export async function setMarketWatch(on: boolean, text: string): Promise<void> {
  if (!isNative() || on === watching) return;
  try {
    if (on) await ForegroundService.startForegroundService({ id: 4242, title: 'TradeBuddy is watching the market', body: text, smallIcon: 'ic_stat_tradebuddy', silent: true });
    else await ForegroundService.stopForegroundService();
    watching = on;
  } catch (err) {
    console.warn('TradeBuddy: market watch service not available', err);
  }
}
