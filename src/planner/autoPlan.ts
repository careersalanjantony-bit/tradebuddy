import { studyFor } from '../advisor/forPlan';
import type { StockData } from '../data/stockData';
import type { Settings, TradePlan } from '../storage/schema';
import { computePlan, orderTicket, type PlanResult } from './plan';

export type PurchasePlan = Omit<TradePlan, 'id' | 'createdAt' | 'updatedAt' | 'status'>;

/**
 * The plan for shares that were ALREADY bought (typed in by the owner, or found in the Upstox
 * account): a sell-if-falls price from the stock's usual daily move, and a profit target from its own
 * history (or 2× the possible loss when there is too little history). Same maths as a pick.
 */
export function planForPurchase(d: StockData, settings: Settings, symbol: string, price: number, qty: number, today: string): { plan: PurchasePlan; result: PlanResult } | { error: string } {
  const snap = d.snapshot;
  if (!snap) return { error: `No price history for ${symbol} yet.` };
  const study = studyFor(d, settings);
  const tick = d.instrument?.tick ?? 0.05;
  const result = computePlan({
    symbol,
    entry: price,
    tick,
    stopMethod: 'atr',
    targetMethod: study ? 'history' : '2R',
    atr: snap.atr14,
    lastSwingLow: snap.lastSwingLow,
    resistances: snap.resistances.map((l) => l.price),
    history: study ? { safeAtr: study.safeAtr, holdAtr: study.holdAtr } : null,
    allocation: price * qty + tick,
    // the purchase is a fact: size checks against the amount do not apply
    settings: { ...settings.risk, ...settings.planner, capitalInr: Math.max(settings.risk.capitalInr ?? 0, price * qty) },
    snapshot: { flags: snap.flags, setup: snap.setup, trend: snap.trend },
    otherOpenRisks: [],
    today,
  });
  if (!result.ok) return { error: result.errors[0] ?? `Could not work out a sell price for ${symbol}.` };
  return {
    result,
    plan: {
      key: d.key,
      symbol,
      entry: price,
      stop: result.stop,
      target: result.target,
      qty,
      riskRupees: Number((qty * Math.max(0, price - result.stop)).toFixed(2)),
      rewardRupees: Number((qty * (result.target - price)).toFixed(2)),
      rr: result.rr,
      targetMode: result.targetMode,
      holdTarget: result.holdTarget,
      ...(study ? { studySamples: study.samples } : {}),
      setup: snap.setup,
      trend: snap.trend,
      ticket: orderTicket(symbol, { ...result, qty }, 'NEW'),
    },
  };
}
