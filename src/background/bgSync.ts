import { getCalendar } from '../data/calendarSync';
import { istDate } from '../lib/time';
import { createLogger } from '../lib/log';
import { drainBackground, syncBackground } from '../platform/backgroundChecker';
import { getLocal, getSecrets, getSettings } from '../storage/local';
import { dayKeys } from './dayJobs';
import { walletApplyBackground } from './walletJobs';

const log = createLogger('bg-check');

/** Hands the background checker its data; also tells it the app is running (so it stays quiet). */
export async function syncBackgroundChecker(now = Date.now()): Promise<void> {
  const [settings, secrets, wallet, cal, keys] = await Promise.all([getSettings(), getSecrets(), getLocal('wallet'), getCalendar(), dayKeys()]);
  await syncBackground({
    enabled: settings.notifications.background,
    rising: settings.notifications.rising,
    token: secrets.upstoxAnalyticsToken ?? null,
    holidays: (cal?.holidays ?? []).map((h) => h.date),
    universe: keys.slice(0, 500),
    holdings: (wallet?.holdings ?? []).map((h) => ({ key: h.key, symbol: h.symbol, qty: h.qty, avgPrice: h.avgPrice, stop: h.stop, target: h.target, sellByClose: h.sellByClose })),
    appActiveAt: now,
    lastOpenDate: istDate(now),
  });
}

/** Applies practice sales the checker found while the app was closed. */
export async function collectBackgroundSales(): Promise<number> {
  const hits = await drainBackground();
  if (!hits.length) return 0;
  const n = await walletApplyBackground(hits);
  log.info(`${n} practice sale(s) found by the background check applied`);
  return n;
}
