import { protectRules } from '../bot/protect';
import { runProtectTest, type ProtectTestDay, type ProtectTestResult } from '../bot/protectTest';
import { getIntradayDays } from '../data/intraday';
import { getQuotes } from '../data/quotes';
import { testKeys } from '../data/universe';
import { createLogger } from '../lib/log';
import { istDate } from '../lib/time';
import { getLocal, setLocal } from '../storage/local';
import { walletSummary } from '../wallet/wallet';
import { getBot } from './botJobs';

/**
 * App v1.13: runs the auto-trader's money protection over the stored 5-minute history (the Nifty 100 +
 * your stocks, up to 120 market days) for the money it trades with, and keeps the result. Once a day,
 * and again when the amount or the protection settings change.
 */

const log = createLogger('bot-test');
let running: Promise<ProtectTestResult | null> | null = null;

const MAX_DAYS = 120;

export function testProtect(now = Date.now(), force = false): Promise<ProtectTestResult | null> {
  running ??= (async () => {
    const bot = await getBot(now);
    const rules = protectRules(bot.rules);
    const quotes = await getQuotes();
    const money = Math.max(10_000, Math.round(walletSummary(bot.wallet, Object.fromEntries(Object.entries(quotes).map(([k, q]) => [k, { ltp: q.ltp, prevClose: q.prevClose, fetchedAt: q.fetchedAt }])), istDate(now)).total));
    // the same answer for the same inputs: skip unless a day old, or the money / rules changed
    const rulesKey = `${Math.round(money / 1000)}|${rules.lockStartPct}|${rules.giveBack}|${rules.dayLossPct}|${rules.quickExitMin}`;
    const prev = await getLocal('botProtectTest');
    if (!force && prev && prev.rulesKey === rulesKey && now - prev.at < 20 * 3600_000) return prev;
    const byDate = new Map<string, ProtectTestDay>();
    const today = istDate(now);
    for (const key of await testKeys()) {
      for (const d of await getIntradayDays(key).catch(() => [])) {
        if (d.date >= today || !d.t.length) continue;
        const day = byDate.get(d.date) ?? { date: d.date, stocks: [] };
        day.stocks.push({ key, bars: d });
        byDate.set(d.date, day);
      }
    }
    const days = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-MAX_DAYS);
    const r = runProtectTest(days, money, rules);
    await setLocal('botProtectTest', r ? { ...r, at: now, rulesKey } : null);
    if (r) log.info(`Protection past test: ${r.days} days, old ${r.old.pnl}, protected ${r.protected.pnl} (money ${money})`);
    return r;
  })().finally(() => {
    running = null;
  });
  return running;
}
