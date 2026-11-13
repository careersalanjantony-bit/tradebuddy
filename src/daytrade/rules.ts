import type { Bars, Side } from './types';

/**
 * Day-trade rules (v0.11.0, owner 11 Nov 2026: "we focus on daily buy and sell").
 *
 * "Opening range breakout with volume" — a standard, fully mechanical same-day method:
 *  1. Opening range = the high and low of the first 15 minutes (09:15–09:30).
 *  2. Only stocks that are busy today: volume in those 15 minutes ≥ `minRvol` × the stock's own
 *     10-day average for the same 15 minutes ("stocks in play").
 *  3. BUY when a 5-minute candle closes above the opening-range high (and above the day's average
 *     price, VWAP) while the market as a whole is up from its open.
 *     SELL SHORT when a 5-minute candle closes below the opening-range low (and below VWAP) while
 *     the market is down. Only the first breakout of the day counts, and only until 11:30.
 *  4. Stop: the other side of the opening range, but never more than `maxStopPct` (1%) and never less
 *     than `minStopPct` (0.25%) away.
 *  5. Target: a multiple of the stop distance (or none) — chosen by the past test.
 *  6. Everything is closed at 15:10, whatever happens (Upstox squares off intraday trades ~15:15).
 *
 * Pure functions; the past test (backtest.ts) and the live engine use exactly these.
 */

/** 09:15 in minutes since midnight IST. */
export const OPEN_T = 555;

export interface DayRules {
  barMinutes: number;
  orMinutes: number;
  /** a signal bar must close at or before this time (minutes since midnight) */
  lastSignalT: number;
  /** all trades are closed at this time */
  exitT: number;
  /** opening range height as % of price: skip days outside this band */
  minOrPct: number;
  maxOrPct: number;
  minStopPct: number;
  maxStopPct: number;
  /** sessions used for the usual opening volume */
  rvolDays: number;
}

export const DEFAULT_RULES: DayRules = {
  barMinutes: 5,
  orMinutes: 15,
  lastSignalT: 11 * 60 + 30,
  exitT: 15 * 60 + 10,
  minOrPct: 0.2,
  maxOrPct: 2.0,
  minStopPct: 0.25,
  maxStopPct: 1.0,
  rvolDays: 10,
};

export interface OpeningRange {
  open: number;
  high: number;
  low: number;
  vol: number;
  /** index of the last bar inside the opening range */
  endIdx: number;
}

export function openingRange(b: Bars, r: DayRules = DEFAULT_RULES): OpeningRange | null {
  let high = -Infinity;
  let low = Infinity;
  let vol = 0;
  let endIdx = -1;
  let open = 0;
  for (let i = 0; i < b.t.length; i++) {
    const t = b.t[i]!;
    if (t < OPEN_T) continue;
    if (t >= OPEN_T + r.orMinutes) break;
    if (endIdx < 0) open = b.o[i]!;
    high = Math.max(high, b.h[i]!);
    low = Math.min(low, b.l[i]!);
    vol += b.v[i]!;
    endIdx = i;
  }
  if (endIdx < 0 || !(low > 0) || !(high >= low)) return null;
  return { open, high, low, vol, endIdx };
}

export const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Opening volume today ÷ the average of the previous sessions' opening volumes (1 = usual). */
export function relativeVolume(orVol: number, previous: number[], r: DayRules = DEFAULT_RULES): number | null {
  const last = previous.slice(-r.rvolDays);
  if (last.length < r.rvolDays) return null;
  const avg = mean(last);
  return avg > 0 ? orVol / avg : null;
}

export interface Breakout {
  side: Side;
  /** index of the bar that closed outside the opening range */
  idx: number;
  /** when that bar closed (minutes since midnight) */
  barCloseT: number;
  or: OpeningRange;
  close: number;
  vwap: number;
}

/** The first 5-minute close outside the opening range (and on the right side of VWAP) before `lastSignalT`. */
export function findBreakout(b: Bars, r: DayRules = DEFAULT_RULES): Breakout | null {
  const or = openingRange(b, r);
  if (!or) return null;
  const heightPct = ((or.high - or.low) / or.low) * 100;
  if (heightPct < r.minOrPct || heightPct > r.maxOrPct) return null;
  let pv = 0;
  let vv = 0;
  for (let i = 0; i < b.t.length; i++) {
    const c = b.c[i]!;
    const v = b.v[i]!;
    pv += ((b.h[i]! + b.l[i]! + c) / 3) * v;
    vv += v;
    if (i <= or.endIdx) continue;
    const barCloseT = b.t[i]! + r.barMinutes;
    if (barCloseT > r.lastSignalT) break;
    const vwap = vv > 0 ? pv / vv : c;
    if (c > or.high && c >= vwap) return { side: 'long', idx: i, barCloseT, or, close: c, vwap };
    if (c < or.low && c <= vwap) return { side: 'short', idx: i, barCloseT, or, close: c, vwap };
  }
  return null;
}

const EPS = 1e-9;
const down = (x: number, tick: number) => Number((Math.floor(x / tick + EPS) * tick).toFixed(4));
const up = (x: number, tick: number) => Number((Math.ceil(x / tick - EPS) * tick).toFixed(4));

/** Stop price: the other side of the opening range, kept between minStopPct and maxStopPct away. */
export function stopFor(side: Side, entry: number, or: { high: number; low: number }, r: DayRules = DEFAULT_RULES, tick = 0.05): number {
  const minRisk = (entry * r.minStopPct) / 100;
  const maxRisk = (entry * r.maxStopPct) / 100;
  const raw = side === 'long' ? entry - or.low : or.high - entry;
  const risk = Math.min(maxRisk, Math.max(minRisk, raw));
  return side === 'long' ? down(entry - risk, tick) : up(entry + risk, tick);
}

/** Target price at `multiple` × the stop distance (null = no target, hold to the time exit). */
export function targetFor(side: Side, entry: number, stop: number, multiple: number | null, tick = 0.05): number | null {
  if (multiple === null) return null;
  const risk = Math.abs(entry - stop);
  return side === 'long' ? down(entry + multiple * risk, tick) : up(entry - multiple * risk, tick);
}

export interface ExitResult {
  idx: number;
  /** minutes since midnight of the exit */
  t: number;
  price: number;
  reason: 'stop' | 'target' | 'time';
}

/**
 * How a day trade entered at the OPEN of bar `entryIdx` ends. Cautious order inside one bar: the stop
 * is checked before the target; a bar that opens beyond the stop sells at that open.
 */
export function simulateExit(b: Bars, entryIdx: number, side: Side, stop: number, target: number | null, r: DayRules = DEFAULT_RULES): ExitResult {
  const n = b.t.length;
  for (let i = entryIdx; i < n; i++) {
    const t = b.t[i]!;
    const o = b.o[i]!;
    if (t >= r.exitT) return { idx: i, t, price: o, reason: 'time' };
    if (side === 'long') {
      if (i > entryIdx && o <= stop) return { idx: i, t, price: o, reason: 'stop' };
      if (b.l[i]! <= stop) return { idx: i, t: t + r.barMinutes, price: stop, reason: 'stop' };
      if (target !== null) {
        if (i > entryIdx && o >= target) return { idx: i, t, price: o, reason: 'target' };
        if (b.h[i]! >= target) return { idx: i, t: t + r.barMinutes, price: target, reason: 'target' };
      }
    } else {
      if (i > entryIdx && o >= stop) return { idx: i, t, price: o, reason: 'stop' };
      if (b.h[i]! >= stop) return { idx: i, t: t + r.barMinutes, price: stop, reason: 'stop' };
      if (target !== null) {
        if (i > entryIdx && o <= target) return { idx: i, t, price: o, reason: 'target' };
        if (b.l[i]! <= target) return { idx: i, t: t + r.barMinutes, price: target, reason: 'target' };
      }
    }
  }
  const last = n - 1;
  return { idx: last, t: b.t[last]! + r.barMinutes, price: b.c[last]!, reason: 'time' };
}

/**
 * Upstox charges for one equity INTRADAY round trip (upstox.com/brokerage-charges, checked 11 Nov 2026):
 * brokerage ₹20 or 0.1% per order (whichever is lower), STT 0.025% on the sell side, NSE transaction
 * charge 0.00297% both sides, SEBI ₹10 per crore, stamp duty 0.003% on the buy side, GST 18% on
 * brokerage + transaction + SEBI charges.
 */
export function intradayCharges(buyValue: number, sellValue: number): number {
  const brokerage = Math.min(20, buyValue * 0.001) + Math.min(20, sellValue * 0.001);
  const stt = sellValue * 0.00025;
  const txn = (buyValue + sellValue) * 0.0000297;
  const sebi = (buyValue + sellValue) * 0.000001;
  const stamp = buyValue * 0.00003;
  const gst = (brokerage + txn + sebi) * 0.18;
  return brokerage + stt + txn + sebi + stamp + gst;
}

/** ₹ result of a day trade after charges. For a short, `entry` is the sell price and `exit` the buy-back price. */
export function dayTradePnl(side: Side, qty: number, entry: number, exit: number): { pnl: number; charges: number } {
  const buy = (side === 'long' ? entry : exit) * qty;
  const sell = (side === 'long' ? exit : entry) * qty;
  const charges = intradayCharges(buy, sell);
  return { pnl: sell - buy - charges, charges };
}

export const hhmm = (t: number): string => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
