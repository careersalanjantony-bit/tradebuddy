import { getCalendar } from '../data/calendarSync';
import { istDate } from '../lib/time';
import { createLogger } from '../lib/log';
import { getRecentCandles } from '../data/candles';
import { alertChannel } from '../notify/toneList';
import { drainBackground, syncBackground } from '../platform/backgroundChecker';
import { getLocal, getSecrets, getSettings } from '../storage/local';
import { dayKeys } from './dayJobs';
import { walletApplyBackground } from './walletJobs';

const log = createLogger('bg-check');

/**
 * For the closed-app breakout check (app v1.9): yesterday's high and the usual daily volume (last 20
 * days) of every stock in the list, from the stored daily candles. Worked out once a day.
 */
let levelsFor: { date: string; count: number; levels: Record<string, { ph: number; av: number }> } | null = null;

export async function breakoutLevels(keys: string[], today: string): Promise<Record<string, { ph: number; av: number }>> {
  if (levelsFor?.date === today && levelsFor.count === keys.length) return levelsFor.levels;
  const levels: Record<string, { ph: number; av: number }> = {};
  for (const key of keys) {
    const days = (await getRecentCandles(key, 25).catch(() => [])).filter((c) => c.date < today && !c.partial && !c.special);
    const last = days[days.length - 1];
    const recent = days.slice(-20);
    const av = recent.length ? recent.reduce((s, c) => s + c.volume, 0) / recent.length : 0;
    if (last && last.high > 0 && av > 0) levels[key] = { ph: last.high, av: Math.round(av) };
  }
  levelsFor = { date: today, count: keys.length, levels };
  return levels;
}

/** Hands the background checker its data; also tells it the app is running (so it stays quiet). */
export async function syncBackgroundChecker(now = Date.now()): Promise<void> {
  const [settings, secrets, wallet, cal, keys] = await Promise.all([getSettings(), getSecrets(), getLocal('wallet'), getCalendar(), dayKeys()]);
  const universe = keys.slice(0, 500);
  await syncBackground({
    enabled: settings.notifications.background,
    rising: settings.notifications.rising,
    breakouts: settings.notifications.breakouts !== false,
    breakoutRisk: settings.dayTrade.breakoutRiskInr ?? 100,
    channel: alertChannel(settings.notifications),
    levels: await breakoutLevels(universe, istDate(now)),
    token: secrets.upstoxAnalyticsToken ?? null,
    holidays: (cal?.holidays ?? []).map((h) => h.date),
    universe,
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
