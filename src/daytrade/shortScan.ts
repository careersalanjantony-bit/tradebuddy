import { OPEN_T, intradayCharges } from './rules';
import type { Bars } from './types';

/**
 * "Falling now" — sell-first (short) ideas for the same day (app v1.4, owner's design):
 * every stock's 5-minute candles are scored for weakness with the day's average price (VWAP),
 * EMA 9, RSI, selling volume, lower highs and bearish candles. Each idea has an entry, a
 * buy-back-if-it-rises price (stop), two take-profit targets and a quantity that keeps the loss
 * at the stop within the chosen rupees (default ₹50). Shorts must be bought back the same day.
 * Pure functions: the live scanner and the past test use exactly the same code.
 */

export const SHORT_RULES_VERSION = 'short-v1';
export const SHORT_FIRST_T = 9 * 60 + 35; // after the first 20 minutes
export const SHORT_LAST_T = 14 * 60 + 30; // no new shorts after 2:30 pm
export const SHORT_EXIT_T = 15 * 60 + 10;
export const MIN_SCORE = 60;

export interface Reason {
  id: string;
  text: string;
}

export interface ShortScore {
  score: number;
  reasons: Reason[];
  vwap: number;
  ema9: number;
  rsi: number | null;
  /** last candle's volume vs the average of the day's candles before it */
  volRatio: number | null;
}

export function ema(values: number[], n: number): number[] {
  const k = 2 / (n + 1);
  const out: number[] = [];
  values.forEach((v, i) => out.push(i === 0 ? v : v * k + out[i - 1]! * (1 - k)));
  return out;
}

/** Wilder's RSI on closes; null with too few values. */
export function rsi(closes: number[], n = 14): number | null {
  if (closes.length <= n) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= n;
  loss /= n;
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    gain = (gain * (n - 1) + Math.max(0, d)) / n;
    loss = (loss * (n - 1) + Math.max(0, -d)) / n;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

function vwapUpTo(b: Bars, i: number): number {
  let pv = 0;
  let v = 0;
  for (let j = 0; j <= i; j++) {
    pv += ((b.h[j]! + b.l[j]! + b.c[j]!) / 3) * b.v[j]!;
    v += b.v[j]!;
  }
  return v > 0 ? pv / v : b.c[i]!;
}

/** Bearish score (0–100) for the candle that just finished, index `i` of today's bars. */
export function bearishScore(b: Bars, i: number, prevClose: number | null): ShortScore | null {
  if (i < 4) return null;
  const c = b.c[i]!;
  const o = b.o[i]!;
  const h = b.h[i]!;
  const l = b.l[i]!;
  const closes = b.c.slice(0, i + 1);
  const vwap = vwapUpTo(b, i);
  const ema9 = ema(closes, 9)[i]!;
  const r = rsi(closes, 14);
  const prevVols = b.v.slice(0, i);
  const avgVol = prevVols.reduce((a, x) => a + x, 0) / Math.max(1, prevVols.length);
  const volRatio = avgVol > 0 ? b.v[i]! / avgVol : null;
  const reasons: Reason[] = [];
  let score = 0;
  const add = (pts: number, id: string, text: string) => {
    score += pts;
    reasons.push({ id, text });
  };
  if (c < vwap) add(20, 'vwap', 'below the day’s average price');
  if (c < ema9) add(12, 'ema', 'below its 9-candle average (EMA 9)');
  // lower highs: the last three candles' highs step down
  if (b.h[i]! < b.h[i - 1]! && b.h[i - 1]! < b.h[i - 2]!) add(14, 'lowerHighs', 'lower highs — each bounce is weaker');
  const body = o - c;
  const range = h - l;
  if (body > 0 && range > 0 && body / range >= 0.6 && (c - l) / range <= 0.25) add(12, 'redCandle', 'a strong red candle closing near its low');
  if (b.c[i - 1]! > b.o[i - 1]! && o >= b.c[i - 1]! && c < b.o[i - 1]!) add(10, 'engulf', 'a bearish engulfing candle');
  const upperWick = h - Math.max(o, c);
  if (range > 0 && upperWick / range >= 0.55 && h >= Math.max(...b.h.slice(Math.max(0, i - 3), i))) add(8, 'star', 'a shooting-star top (sellers pushed it back down)');
  if (volRatio !== null && volRatio >= 1.5 && c < o) add(volRatio >= 2.5 ? 14 : 10, 'volume', `heavy selling (${volRatio.toFixed(1)}× the usual candle volume)`);
  if (r !== null && r < 45 && r > 25) add(8, 'rsi', `weak momentum (RSI ${Math.round(r)})`);
  if (r !== null && r <= 25) score -= 8; // already very oversold: bounces are likely
  const dayOpen = b.o[0]!;
  if (c < dayOpen) add(6, 'belowOpen', 'below today’s opening price');
  if (prevClose && c < prevClose) add(4, 'belowYday', 'below yesterday’s close');
  return { score: Math.max(0, Math.min(100, score)), reasons, vwap, ema9, rsi: r, volRatio };
}

export interface ShortPlan {
  /** sell first at about this price */
  entry: number;
  /** buy back if it rises to this price */
  stop: number;
  /** take part of the profit (half the shares) */
  t1: number;
  /** take the rest */
  t2: number;
  qty: number;
  /** ₹ lost at the stop, before charges */
  risk: number;
  /** estimated Upstox intraday charges for the round trip */
  charges: number;
  /** ₹ after charges if both targets are reached (half at each) */
  netAtTargets: number;
  /** ₹ after charges if the stop is hit */
  netAtStop: number;
}

const tickUp = (x: number, tick: number) => Math.ceil(x / tick - 1e-9) * tick;
const tickDown = (x: number, tick: number) => Math.floor(x / tick + 1e-9) * tick;
const r2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Entry at the current price; stop just above the nearest resistance (the last three highs or the
 * day's average price, whichever is higher), kept between 0.3% and 1.2% away; targets at 1× and 2×
 * that distance; quantity so that the loss at the stop is at most `riskRupees`.
 */
export function planShort(b: Bars, i: number, price: number, vwap: number, riskRupees: number, tick = 0.05): ShortPlan | null {
  if (!(price > 0) || !(riskRupees > 0)) return null;
  const recentHigh = Math.max(...b.h.slice(Math.max(0, i - 2), i + 1));
  const resistance = Math.max(recentHigh, vwap > price ? vwap : 0);
  let dist = resistance * 1.001 - price;
  dist = Math.min(Math.max(dist, price * 0.003), price * 0.012);
  const entry = r2(tickDown(price, tick));
  const stop = r2(tickUp(entry + dist, tick));
  const per = stop - entry;
  const t1 = r2(tickDown(entry - per, tick));
  const t2 = r2(tickDown(entry - 2 * per, tick));
  const qty = Math.floor(riskRupees / per);
  if (qty < 1 || t2 <= 0) return null;
  const half = Math.floor(qty / 2);
  const charges = r2(intradayCharges(qty * ((half * t1 + (qty - half) * t2) / qty), qty * entry));
  const netAtTargets = r2(half * (entry - t1) + (qty - half) * (entry - t2) - charges);
  const stopCharges = intradayCharges(qty * stop, qty * entry);
  return { entry, stop, t1, t2, qty, risk: r2(qty * per), charges, netAtTargets, netAtStop: r2(-qty * per - stopCharges) };
}

export type ShortExit = { price: number; t: number; reason: 'stop' | 't2' | 'time' | 't1-then-stop'; pnl: number };

/**
 * Follows a short from the candle after `entryIdx`: half the shares are bought back at T1 (then the
 * stop moves to the entry price), the rest at T2, the stop, or 3:10 pm. When one candle touches both
 * the stop and a target, the stop is assumed first (the cautious reading).
 */
export function simulateShort(b: Bars, entryIdx: number, p: ShortPlan, slip = 0.0002): ShortExit {
  const half = Math.floor(p.qty / 2);
  let left = p.qty;
  let stop = p.stop;
  let gross = 0;
  let bought = 0;
  const entry = p.entry * (1 - slip);
  let t1Done = false;
  for (let j = entryIdx + 1; j < b.t.length; j++) {
    const hi = b.h[j]!;
    const lo = b.l[j]!;
    if (b.t[j]! >= SHORT_EXIT_T) {
      const px = b.o[j]! * (1 + slip);
      gross += (entry - px) * left;
      bought += px * left;
      return { price: px, t: b.t[j]!, reason: 'time', pnl: gross - intradayCharges(bought, entry * p.qty) };
    }
    if (hi >= stop) {
      const px = Math.max(stop, b.o[j]!) * (1 + slip);
      gross += (entry - px) * left;
      bought += px * left;
      return { price: px, t: b.t[j]!, reason: t1Done ? 't1-then-stop' : 'stop', pnl: gross - intradayCharges(bought, entry * p.qty) };
    }
    if (!t1Done && lo <= p.t1 && half > 0) {
      const px = p.t1 * (1 + slip);
      gross += (entry - px) * half;
      bought += px * half;
      left -= half;
      t1Done = true;
      stop = p.entry; // the rest can no longer lose
    }
    if (lo <= p.t2) {
      const px = p.t2 * (1 + slip);
      gross += (entry - px) * left;
      bought += px * left;
      return { price: px, t: b.t[j]!, reason: 't2', pnl: gross - intradayCharges(bought, entry * p.qty) };
    }
  }
  const last = b.c[b.c.length - 1]! * (1 + slip);
  gross += (entry - last) * left;
  bought += last * left;
  return { price: last, t: b.t[b.t.length - 1]!, reason: 'time', pnl: gross - intradayCharges(bought, entry * p.qty) };
}

export interface ShortTestTrade {
  date: string;
  key: string;
  t: number;
  score: number;
  pnl: number;
  reason: ShortExit['reason'];
}

export interface ShortTestResult {
  trades: number;
  wins: number;
  pnl: number;
  /** trades that reached target 1 */
  t1Hits: number;
}

export interface ShortTestReport {
  version: string;
  days: number;
  from: string;
  to: string;
  riskRupees: number;
  older: ShortTestResult;
  /** the newest third of the days — the honest number */
  newer: ShortTestResult;
  passed: boolean;
  computedMs: number;
}

const summarize = (ts: ShortTestTrade[]): ShortTestResult => ({
  trades: ts.length,
  wins: ts.filter((t) => t.pnl > 0).length,
  pnl: r2(ts.reduce((a, t) => a + t.pnl, 0)),
  t1Hits: ts.filter((t) => t.reason === 't2' || t.reason === 't1-then-stop').length,
});

/**
 * Past test on stored 5-minute days: for each stock-day, the first candle from 9:35 to 2:30 that
 * scores ≥ MIN_SCORE opens a short at the next candle's open; at most `perDay` shorts a day (the
 * earliest first). Split into older 2/3 and newer 1/3 of the days.
 */
export function runShortTest(days: Array<{ key: string; date: string; bars: Bars; prevClose: number | null }>, riskRupees: number, perDay = 3, now = Date.now()): ShortTestReport | null {
  const t0 = now;
  const byDate = new Map<string, Array<{ key: string; t: number; score: number; plan: ShortPlan; bars: Bars; idx: number }>>();
  for (const d of days) {
    for (let i = 4; i < d.bars.t.length - 1; i++) {
      const tEnd = d.bars.t[i]! + 5;
      if (tEnd < SHORT_FIRST_T || tEnd > SHORT_LAST_T) continue;
      const s = bearishScore(d.bars, i, d.prevClose);
      if (!s || s.score < MIN_SCORE) continue;
      const plan = planShort(d.bars, i, d.bars.o[i + 1]!, s.vwap, riskRupees);
      if (!plan) continue;
      const l = byDate.get(d.date) ?? [];
      l.push({ key: d.key, t: tEnd, score: s.score, plan, bars: d.bars, idx: i + 1 });
      byDate.set(d.date, l);
      break;
    }
  }
  const dates = [...new Set(days.map((d) => d.date))].sort();
  if (dates.length < 20) return null;
  const trades: ShortTestTrade[] = [];
  for (const date of dates) {
    const list = (byDate.get(date) ?? []).sort((a, b) => a.t - b.t || b.score - a.score).slice(0, perDay);
    for (const c of list) {
      const ex = simulateShort(c.bars, c.idx - 1 + 0, c.plan);
      trades.push({ date, key: c.key, t: c.t, score: c.score, pnl: r2(ex.pnl), reason: ex.reason });
    }
  }
  const cut = dates[Math.floor((dates.length * 2) / 3)]!;
  const older = summarize(trades.filter((t) => t.date < cut));
  const newer = summarize(trades.filter((t) => t.date >= cut));
  return { version: SHORT_RULES_VERSION, days: dates.length, from: dates[0]!, to: dates[dates.length - 1]!, riskRupees, older, newer, passed: newer.trades >= 15 && newer.pnl > 0 && older.pnl > 0, computedMs: Date.now() - t0 };
}

/** minutes since midnight of the candle that ends at or before `t` (5-minute candles from 9:15) */
export const lastClosedIndex = (b: Bars, t: number): number => {
  let idx = -1;
  for (let i = 0; i < b.t.length; i++) if (b.t[i]! + 5 <= t && b.t[i]! >= OPEN_T) idx = i;
  return idx;
};
