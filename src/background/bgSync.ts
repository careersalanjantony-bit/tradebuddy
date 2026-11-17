import { getCalendar } from '../data/calendarSync';
import { istDate } from '../lib/time';
import { createLogger } from '../lib/log';
import { getRecentCandles } from '../data/candles';
import { getIntradayDays } from '../data/intraday';
import { alertChannel } from '../notify/toneList';
import { AUTO_SQUARE_OFF_T, DAY_EXIT_T } from '../wallet/wallet';
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
    let days: { high: number; volume: number }[] = (await getRecentCandles(key, 25).catch(() => [])).filter((c) => c.date < today && !c.partial && !c.special);
    if (!days.length) {
      // app v1.11: scan-list stocks outside the Stocks tab have only the 5-minute history — use its days
      days = (await getIntradayDays(key).catch(() => []))
        .filter((d) => d.date < today && d.h.length)
        .sort((a, b) => (a.date < b.date ? -1 : 1))
        .map((d) => ({ high: Math.max(...d.h), volume: d.v.reduce((a, b) => a + b, 0) }));
    }
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
  // the whole scan list (the checker asks Upstox in batches of 500, so no stock is left out)
  const universe = keys;
  await syncBackground({
    enabled: settings.notifications.background,
    rising: settings.notifications.rising,
    // app v1.14: Breakout Today is switched off (also with the app closed)
    breakouts: false,
    breakoutRisk: settings.dayTrade.breakoutRiskInr ?? 100,
    channel: alertChannel(settings.notifications),
    levels: {},
    token: secrets.upstoxAnalyticsToken ?? null,
    holidays: (cal?.holidays ?? []).map((h) => h.date),
    universe,
    holdings: (wallet?.holdings ?? []).map((h) => ({
      key: h.key,
      symbol: h.symbol,
      qty: h.qty,
      avgPrice: h.avgPrice,
      stop: h.stop,
      target: h.target,
      sellByClose: h.sellByClose,
      product: h.product ?? 'delivery',
      // when it is closed for the day: 3:10 pm (the plan) or Upstox's 3:20 pm Intraday square-off
      exitT: h.sellByClose ? DAY_EXIT_T : h.product === 'intraday' ? AUTO_SQUARE_OFF_T : null,
    })),
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
