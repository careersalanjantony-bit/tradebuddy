import type { Candle } from '../indicators/types';
import { intradayCharges } from '../daytrade/rules';
import { atrSeries } from './shortModel';

/**
 * App v1.7 — a sell-first plan from daily data (used when the market is closed, or before today's
 * 5-minute candles are in): buy back if the price rises half a normal day's range (ATR) above the
 * entry (0.5 %–2 %), target 1 one such step lower (half the shares), target 2 two steps lower.
 * During market hours the 5-minute plan from the "Falling now" scan is used instead.
 */

export interface DailyShortPlan {
  entry: number;
  stop: number;
  t1: number;
  t2: number;
  qty: number;
  /** ₹ lost at the stop (before charges) */
  risk: number;
  stopPct: number;
  /** risk : reward at target 1 and target 2 */
  rr1: number;
  rr2: number;
  atrPct: number | null;
  charges: number;
  /** after charges: half at target 1 + half at target 2, and everything at the stop */
  netAtTargets: number;
  netAtStop: number;
}

const up = (x: number, tick: number) => Math.ceil(x / tick - 1e-9) * tick;
const down = (x: number, tick: number) => Math.floor(x / tick + 1e-9) * tick;
const r2 = (x: number) => Math.round(x * 100) / 100;

export function dailyShortPlan(candles: Candle[], entry: number, riskRupees: number, tick = 0.05): DailyShortPlan | null {
  if (!(entry > 0) || candles.length < 20) return null;
  const done = candles[candles.length - 1]!.partial ? candles.slice(0, -1) : candles;
  const atr = atrSeries(done);
  const a = atr[atr.length - 1] ?? null;
  const atrPct = a ? (a / done[done.length - 1]!.close) * 100 : null;
  const stepPct = Math.min(2, Math.max(0.5, atrPct !== null ? atrPct * 0.5 : 1));
  const stop = r2(up(entry * (1 + stepPct / 100), tick));
  const R = stop - entry;
  if (!(R > 0)) return null;
  const t1 = r2(down(entry - R, tick));
  const t2 = r2(down(entry - 2 * R, tick));
  const qty = Math.max(1, Math.floor(riskRupees / R));
  const half = Math.floor(qty / 2);
  const rest = qty - half;
  const chargesT = intradayCharges(t1 * half + t2 * rest, entry * qty);
  const grossT = (entry - t1) * half + (entry - t2) * rest;
  const chargesS = intradayCharges(stop * qty, entry * qty);
  return {
    entry: r2(entry),
    stop,
    t1,
    t2,
    qty,
    risk: r2(R * qty),
    stopPct: r2((R / entry) * 100),
    rr1: r2((entry - t1) / R),
    rr2: r2((entry - t2) / R),
    atrPct: atrPct !== null ? r2(atrPct) : null,
    charges: r2(chargesT),
    netAtTargets: r2(grossT - chargesT),
    netAtStop: r2(-R * qty - chargesS),
  };
}
