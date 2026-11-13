import type { StockData } from '../data/stockData';
import { istDate } from '../lib/time';
import type { Settings, TradePlan } from '../storage/schema';
import { adviseOpenTrade, type Advice } from './holdAdvice';
import { studyExits, type ExitStudy } from './exitStudy';

/** Hold-or-sell advice for an OPEN plan from the stock's current data (used by the UI and the service worker). */
export function adviceForPlan(plan: TradePlan, d: StockData | undefined, settings: Settings): Advice | null {
  if (plan.status !== 'open' || !d?.snapshot) return null;
  const s = d.snapshot;
  const entry = plan.fillPrice ?? plan.entry;
  const from = plan.openedDate ?? istDate(plan.updatedAt);
  const now = Date.now();
  const price = d.quote && istDate(d.quote.fetchedAt) === istDate(now) ? d.quote.ltp : s.price;
  return adviseOpenTrade({
    entry,
    stop: plan.stop,
    safeTarget: plan.target,
    holdTarget: plan.holdTarget ?? null,
    sinceEntry: d.candles.filter((c) => c.date >= from),
    price,
    atr: s.atr14,
    sma20: s.sma20,
    rsi: s.rsi14,
    stretch: s.stretch,
    trailAtr: settings.planner.trailAtrMultiple,
    timeStopSessions: settings.planner.timeStopSessions,
    tick: d.instrument?.tick ?? 0.05,
  });
}

/** History study for a stock with the owner's settings. */
export function studyFor(d: StockData | null | undefined, settings: Settings): ExitStudy | null {
  if (!d?.snapshot) return null;
  return studyExits(d.candles, {
    trend: d.snapshot.trend,
    stopAtr: settings.planner.stopAtrMultiple,
    horizon: settings.planner.exitHorizonSessions,
    lookback: settings.planner.exitLookbackSessions,
  });
}
