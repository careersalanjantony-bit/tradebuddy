import { OPEN_T, type OpeningRange } from '../daytrade/rules';
import type { Bars, Side } from '../daytrade/types';

/**
 * What the app "sees" at the moment of a day-trade signal — computed the SAME way for the past
 * (learning) and live (today), using only prices known at that moment. Values are signed so that
 * a positive number is good for the trade's direction (for a short sale, a falling price is good).
 */

export const FEATURES = [
  { id: 'rvol', more: 'heavy trading in the first 15 minutes', less: 'quiet first 15 minutes' },
  { id: 'orPct', more: 'a wide first-15-minute range', less: 'a narrow first-15-minute range' },
  { id: 'gap', more: 'a gap at the open in the trade’s direction', less: 'a gap at the open against the trade' },
  { id: 'fromOpen', more: 'price already far from its opening price', less: 'price still close to its opening price' },
  { id: 'vwap', more: 'price well past the day’s average price', less: 'price close to the day’s average price' },
  { id: 'body', more: 'a strong breakout candle', less: 'a weak breakout candle' },
  { id: 'range', more: 'a big, jumpy breakout candle', less: 'a calm breakout candle' },
  { id: 'pace', more: 'much more trading than usual so far today', less: 'less trading than usual so far today' },
  { id: 'yday', more: 'a move the same way yesterday', less: 'a move the other way yesterday' },
  { id: 'week', more: 'a trend the same way over the last week', less: 'a trend the other way over the last week' },
  { id: 'jumpy', more: 'a usually jumpy stock', less: 'a usually calm stock' },
  { id: 'time', more: 'later in the morning', less: 'early in the morning' },
  { id: 'market', more: 'the whole market moving the same way', less: 'the market moving the other way' },
  { id: 'long', more: 'buy signals', less: 'short-sell signals' },
  { id: 'closeLoc', more: 'price at the edge of the day’s range', less: 'price in the middle of the day’s range' },
] as const;
export const N_FEATURES = FEATURES.length;

export interface PrevDay {
  close: number;
  high: number;
  low: number;
  /** cumulative volume at each minute-of-day bar time (aligned to t) */
  t: number[];
  cumV: number[];
}

/** Summary of a stored day used by later days' features. */
export function prevDayOf(b: Bars): PrevDay | null {
  if (!b.t.length) return null;
  let high = -Infinity;
  let low = Infinity;
  let cum = 0;
  const cumV: number[] = [];
  for (let i = 0; i < b.t.length; i++) {
    high = Math.max(high, b.h[i]!);
    low = Math.min(low, b.l[i]!);
    cum += b.v[i]!;
    cumV.push(cum);
  }
  return { close: b.c[b.c.length - 1]!, high, low, t: b.t.slice(), cumV };
}

function cumAt(p: PrevDay, t: number): number | null {
  let v: number | null = null;
  for (let i = 0; i < p.t.length && p.t[i]! <= t; i++) v = p.cumV[i]!;
  return v;
}

const clamp = (x: number, lim: number) => (Number.isFinite(x) ? Math.max(-lim, Math.min(lim, x)) : 0);

/**
 * Feature vector for a signal on bar `i` of today's bars. `prev` = earlier days, oldest first (up to 10).
 * `market` = average move of all studied stocks from their open at that time (fraction).
 */
export function featureVector(b: Bars, i: number, side: Side, or: OpeningRange, prev: PrevDay[], market: number, rvol: number): number[] {
  const s = side === 'long' ? 1 : -1;
  const c = b.c[i]!;
  let pv = 0;
  let vv = 0;
  let hi = -Infinity;
  let lo = Infinity;
  let cum = 0;
  for (let j = 0; j <= i; j++) {
    const tp = (b.h[j]! + b.l[j]! + b.c[j]!) / 3;
    pv += tp * b.v[j]!;
    vv += b.v[j]!;
    hi = Math.max(hi, b.h[j]!);
    lo = Math.min(lo, b.l[j]!);
    cum += b.v[j]!;
  }
  const vwap = vv > 0 ? pv / vv : c;
  const last = prev[prev.length - 1];
  const prev2 = prev[prev.length - 2];
  const week = prev.length >= 6 ? prev[prev.length - 6] : prev[0];
  const usual = prev
    .slice(-10)
    .map((p) => cumAt(p, b.t[i]!))
    .filter((x): x is number => x !== null && x > 0);
  const avgCum = usual.length ? usual.reduce((a, x) => a + x, 0) / usual.length : 0;
  const ranges = prev.slice(-5).map((p) => ((p.high - p.low) / p.close) * 100);
  const loc = hi > lo ? (c - lo) / (hi - lo) : 0.5;
  return [
    clamp(Math.log(Math.max(rvol, 0.05)), 4),
    clamp(((or.high - or.low) / or.open) * 100, 10),
    last ? clamp(s * (or.open / last.close - 1) * 100, 15) : 0,
    clamp(s * (c / or.open - 1) * 100, 15),
    clamp(s * (c / vwap - 1) * 100, 15),
    clamp(s * ((c - b.o[i]!) / b.o[i]!) * 100, 10),
    clamp(((b.h[i]! - b.l[i]!) / b.o[i]!) * 100, 10),
    avgCum > 0 ? clamp(Math.log(cum / avgCum), 4) : 0,
    last && prev2 ? clamp(s * (last.close / prev2.close - 1) * 100, 20) : 0,
    last && week && week !== last ? clamp(s * (last.close / week.close - 1) * 100, 40) : 0,
    ranges.length ? clamp(ranges.reduce((a, x) => a + x, 0) / ranges.length, 20) : 0,
    (b.t[i]! - OPEN_T) / 60,
    clamp(s * market * 100, 10),
    side === 'long' ? 1 : 0,
    side === 'long' ? loc : 1 - loc,
  ];
}
