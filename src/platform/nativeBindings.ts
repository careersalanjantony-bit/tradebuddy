import { App } from '@capacitor/app';
import { LocalNotifications } from '@capacitor/local-notifications';
import { InAppBrowser, ToolBarType } from '@capgo/capacitor-inappbrowser';
import { ForegroundService } from '@capawesome-team/capacitor-android-foreground-service';
import { alertChannel, QUIET_CHANNEL, SILENT_CHANNEL, SYSTEM_CHANNEL, TONES } from '../notify/toneList';
import { getSettings } from '../storage/local';
import { setAppActive } from './appState';
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

/**
 * One notification channel per tone (Android fixes a channel's sound when it is created), all "high
 * importance" so alerts pop up at the top of the screen, also on the lock screen. Plus a quiet channel
 * (the app is on screen and shows the alert itself) and a silent one (sounds switched off).
 */
async function createChannels(): Promise<void> {
  const make = (c: Parameters<typeof LocalNotifications.createChannel>[0]) => LocalNotifications.createChannel(c).catch(() => undefined);
  await make({ id: SYSTEM_CHANNEL, name: "Trade alerts (phone's own sound)", description: 'Buy signals, breakouts, stop-loss, targets and trades found in Upstox', importance: 5, visibility: 1, vibration: true });
  for (const t of TONES) {
    if (!t.file) continue;
    await make({ id: t.channel, name: `Trade alerts — ${t.name}`, description: `Buy signals, breakouts, stop-loss and targets with the "${t.name}" sound`, importance: 5, visibility: 1, vibration: true, sound: `${t.file}.ogg`, lights: true, lightColor: '#10B981' });
  }
  await make({ id: SILENT_CHANNEL, name: 'Trade alerts without sound', description: 'Used when sounds are off in TradeBuddy', importance: 5, visibility: 1, vibration: true, sound: 'tone_silent.ogg' });
  await make({ id: QUIET_CHANNEL, name: 'Alerts while TradeBuddy is open', description: 'The app shows these itself; a quiet copy stays here', importance: 2, visibility: 1, vibration: false });
}

export async function initNative(onResume: () => void): Promise<void> {
  if (!isNative()) return;

  await createChannels();
  setNotificationBackend({
    async show(id, title, message, opts) {
      const perm = await LocalNotifications.checkPermissions();
      if (perm.display !== 'granted') return;
      const n = (await getSettings()).notifications;
      const channelId = opts.onScreen ? QUIET_CHANNEL : alertChannel(n);
      await LocalNotifications.schedule({
        notifications: [{ id: numericId(id), title, body: message, largeBody: message, channelId, extra: { id }, autoCancel: !opts.requireInteraction, ongoing: false }],
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
  // on screen or not (alerts pop up from Android only when the app is not on screen)
  await App.addListener('appStateChange', (st) => setAppActive(st.isActive));
  const st = await App.getState().catch(() => null);
  if (st) setAppActive(st.isActive);
}

/**
 * App v1.9: a test alert a few seconds from now, delivered by Android itself (so it also pops up after
 * you leave the app or lock the phone) on the chosen tone's channel.
 */
export async function scheduleTestAlert(channelId: string, seconds: number, title: string, body: string): Promise<boolean> {
  if (!isNative()) return false;
  const perm = await LocalNotifications.checkPermissions();
  if (perm.display !== 'granted') return false;
  await LocalNotifications.schedule({
    notifications: [{ id: numericId('alert:test-popup'), title, body, largeBody: body, channelId, extra: { id: 'alert:test-popup' }, autoCancel: true, schedule: { at: new Date(Date.now() + seconds * 1000), allowWhileIdle: true } }],
  });
  return true;
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
