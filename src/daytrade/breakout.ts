import { intradayCharges } from './rules';
import { ema, rsi } from './shortScan';
import type { Bars } from './types';

/**
 * App v1.9 — "🚀 Breakout Today": buy-first ideas when a stock breaks above its resistance.
 * Pure functions only (the live engine is background/breakoutJobs.ts).
 *
 * Resistance: the day's high of the finished 5-minute candles (from 2 candles on); with only the
 * first candle, the higher of its high and yesterday's high. Live, never below the day's high as
 * Upstox reports it when the candle starts (so a missed candle cannot hide the real high). A level that
 * was touched more than once is stronger.
 *
 * Breakout (early alert, on the live price — no waiting for the candle to close): the price is at
 * least 0.05 % above the resistance AND, all at once:
 *   - volume surge: this candle's volume so far is ≥ 2× a normal candle's for the time elapsed
 *     (or the latest 1-minute candle ≥ 2× a normal minute);
 *   - above the day's average price (VWAP) and above EMA 9 of the 5-minute closes;
 *   - RSI 14 (5-minute) between 55 and 80 — strength, but not already exhausted;
 *   - momentum: above today's opening price and up ≥ 0.2 % over the last 3 candles;
 *   - enough trading: a normal candle trades ≥ ₹25 lakh;
 *   - not run away: at most 0.8 % above the resistance (else it is "too late").
 * Confirmed breakout: a 5-minute candle CLOSES above the resistance with ≥ 1.5× normal volume, above
 * VWAP and EMA 9. A candle that closes back below the resistance marks the breakout as failed.
 * Plan: stop just under the broken resistance (0.35 %–1.5 % below the entry), target 1 at 1× the
 * risk (half), target 2 at 2× (the rest), quantity so the loss at the stop is the chosen ₹ risk.
 */

export const BREAKOUT_RULES_VERSION = 'breakout-v1';
export const BO = {
  firstT: 9 * 60 + 20,
  /** no new breakout ideas after 3:00 pm (same-day trades close by 3:10) */
  lastT: 15 * 60,
  exitT: 15 * 60 + 10,
  minBars: 2,
  crossPct: 0.0005,
  surge: 2,
  confirmSurge: 1.5,
  rsiMin: 55,
  rsiMax: 80,
  momentumPct: 0.2,
  maxExtPct: 0.008,
  minCandleValue: 25e5,
  stopMinPct: 0.0035,
  stopMaxPct: 0.015,
  /** an early / confirmed idea older than this is "too late" */
  freshMs: 10 * 60_000,
} as const;

export interface Bar {
  /** minutes since midnight IST when the candle started */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export const barsOf = (b: Bars): Bar[] => b.t.map((t, i) => ({ t, o: b.o[i]!, h: b.h[i]!, l: b.l[i]!, c: b.c[i]!, v: b.v[i]! }));

export interface Resistance {
  level: number;
  kind: 'day-high' | 'prev-day-high';
  /** finished candles whose high came within 0.15 % of the level */
  touches: number;
}

export function resistanceOf(bars: Bar[], prevDayHigh: number | null): Resistance | null {
  if (bars.length >= BO.minBars) {
    const level = Math.max(...bars.map((b) => b.h));
    const touches = bars.filter((b) => b.h >= level * 0.9985).length;
    return { level, kind: 'day-high', touches };
  }
  // only the first candle: it must clear both that candle's high and yesterday's high
  const first = bars.length ? Math.max(...bars.map((b) => b.h)) : 0;
  const prev = prevDayHigh && prevDayHigh > 0 ? prevDayHigh : 0;
  if (!first && !prev) return null;
  return prev >= first ? { level: prev, kind: 'prev-day-high', touches: 1 } : { level: first, kind: 'day-high', touches: 1 };
}

/** Normal candle volume today: the finished candles, without the very busy first one when there are 3+. */
export function normalCandleVolume(bars: Bar[]): number {
  const use = bars.length >= 3 ? bars.slice(1) : bars;
  if (!use.length) return 0;
  const vols = use.map((b) => b.v).sort((a, b) => a - b);
  // the median: one huge candle does not lift the bar
  return vols[Math.floor(vols.length / 2)]!;
}

export function vwapOf(bars: Bar[]): number | null {
  let pv = 0;
  let v = 0;
  for (const b of bars) {
    pv += ((b.h + b.l + b.c) / 3) * b.v;
    v += b.v;
  }
  return v > 0 ? pv / v : null;
}

export interface LiveInput {
  /** minutes since midnight IST, and the time in ms */
  t: number;
  nowMs: number;
  price: number;
  dayOpen: number | null;
  /** live VWAP (feed) when known */
  vwap: number | null;
  /** finished candles today */
  bars: Bar[];
  /** this candle so far: volume since it started (null when unknown) and when it started (ms) */
  cur: { volume: number | null; startMs: number };
  /** latest 1-minute candle's volume (full feed), if any */
  m1Vol: number | null;
  prevDayHigh: number | null;
  /** the day's high when this candle started (live, from Upstox): the resistance is never below it */
  levelFloor?: number | null;
}

export interface BreakoutPlan {
  entry: number;
  stop: number;
  t1: number;
  t2: number;
  qty: number;
  risk: number;
  charges: number;
  /** after charges: half at target 1 + half at target 2, and everything at the stop */
  netAtTargets: number;
  netAtStop: number;
}

export interface BreakoutCheck {
  level: number;
  kind: Resistance['kind'];
  price: number;
  /** volume pace vs a normal candle */
  volX: number;
  vwap: number | null;
  ema9: number;
  rsi: number | null;
  momentumPct: number;
  score: number;
  reasons: string[];
  /** true when the price already ran too far above the level */
  late: boolean;
}

const up = (x: number, tick: number) => Math.ceil(x / tick - 1e-9) * tick;
const down = (x: number, tick: number) => Math.floor(x / tick + 1e-9) * tick;
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Stop just under the broken level; targets at 1× and 2× the risk; quantity for the ₹ risk. */
export function planBreakout(entry: number, level: number, bars: Bar[], riskRupees: number, tick = 0.05): BreakoutPlan | null {
  if (!(entry > 0) || !(level > 0)) return null;
  const ranges = bars.slice(-6).map((b) => b.h - b.l);
  const avgRange = ranges.length ? ranges.reduce((s, x) => s + x, 0) / ranges.length : entry * 0.004;
  let stop = level - Math.max(level * 0.0015, avgRange * 0.5);
  const minDist = entry * BO.stopMinPct;
  const maxDist = entry * BO.stopMaxPct;
  if (entry - stop < minDist) stop = entry - minDist;
  if (entry - stop > maxDist) stop = entry - maxDist;
  stop = r2(down(stop, tick));
  const R = entry - stop;
  if (!(R > 0)) return null;
  const t1 = r2(up(entry + R, tick));
  const t2 = r2(up(entry + 2 * R, tick));
  const qty = Math.max(1, Math.floor(riskRupees / R));
  const half = Math.floor(qty / 2);
  const rest = qty - half;
  const sellT = t1 * half + t2 * rest;
  const charges = intradayCharges(entry * qty, sellT);
  return {
    entry: r2(entry),
    stop,
    t1,
    t2,
    qty,
    risk: r2(R * qty),
    charges: r2(charges),
    netAtTargets: r2(sellT - entry * qty - charges),
    netAtStop: r2(-R * qty - intradayCharges(entry * qty, stop * qty)),
  };
}

/**
 * Is the live price breaking out right now? Returns null when it is not above a resistance, or when a
 * filter fails (the reason is given, for the record); `late` when it already ran too far.
 */
export function checkBreakout(x: LiveInput): { check: BreakoutCheck | null; reason: string } {
  if (x.t < BO.firstT) return { check: null, reason: 'before 9:20' };
  let R = resistanceOf(x.bars, x.prevDayHigh);
  if (x.levelFloor && x.levelFloor > 0 && (!R || x.levelFloor > R.level * (1 + 1e-9))) R = { level: x.levelFloor, kind: 'day-high', touches: 1 };
  if (!R) return { check: null, reason: 'no resistance yet' };
  if (!(x.price > R.level * (1 + BO.crossPct))) return { check: null, reason: 'below the resistance' };
  const normal = normalCandleVolume(x.bars);
  if (!(normal > 0)) return { check: null, reason: 'no volume history yet' };
  if (normal * x.price < BO.minCandleValue) return { check: null, reason: 'too little trading' };
  const elapsed = Math.min(1, Math.max(0.15, (x.nowMs - x.cur.startMs) / 300_000));
  const pace = x.cur.volume !== null && x.cur.volume >= 0 ? x.cur.volume / (normal * elapsed) : 0;
  const minuteX = x.m1Vol !== null && x.m1Vol > 0 ? x.m1Vol / (normal / 5) : 0;
  const volX = Math.max(pace, minuteX);
  if (volX < BO.surge) return { check: null, reason: `no volume surge (${volX.toFixed(1)}×)` };
  const vwap = x.vwap && x.vwap > 0 ? x.vwap : vwapOf(x.bars);
  if (vwap !== null && !(x.price > vwap)) return { check: null, reason: 'below VWAP' };
  const closes = [...x.bars.map((b) => b.c), x.price];
  const e9 = ema(closes, 9)[closes.length - 1]!;
  if (!(x.price > e9)) return { check: null, reason: 'below EMA 9' };
  const r = rsi(closes, 14);
  if (r !== null && (r < BO.rsiMin || r > BO.rsiMax)) return { check: null, reason: `RSI ${Math.round(r)} outside 55–80` };
  const back = x.bars.length >= 3 ? x.bars[x.bars.length - 3]!.c : (x.dayOpen ?? x.bars[0]?.o ?? x.price);
  const momentumPct = (x.price / back - 1) * 100;
  if ((x.dayOpen !== null && !(x.price > x.dayOpen)) || momentumPct < BO.momentumPct) return { check: null, reason: 'weak momentum' };
  const ext = x.price / R.level - 1;
  const late = ext > BO.maxExtPct || x.t > BO.lastT;
  const reasons = [
    `broke ${R.kind === 'day-high' ? "today's high" : "yesterday's high"} ₹${R.level.toFixed(2)}${R.touches > 1 ? ` (tested ${R.touches}×)` : ''}`,
    `${volX.toFixed(1)}× normal volume`,
    vwap !== null ? `${((x.price / vwap - 1) * 100).toFixed(1)}% above VWAP` : 'above VWAP',
    `RSI ${r !== null ? Math.round(r) : '—'}`,
    `+${momentumPct.toFixed(1)}% in 15 min`,
  ];
  if (x.prevDayHigh && x.price > x.prevDayHigh && R.kind === 'day-high') reasons.push("above yesterday's high too");
  let score = 50 + Math.min(20, (volX - BO.surge) * 6) + Math.min(10, (R.touches - 1) * 5) + (x.prevDayHigh && x.price > x.prevDayHigh ? 8 : 0);
  if (r !== null) score += r >= 60 && r <= 72 ? 8 : 3;
  score += Math.min(6, momentumPct * 3);
  score -= Math.max(0, ext * 100 - 0.4) * 10;
  return { check: { level: R.level, kind: R.kind, price: x.price, volX, vwap, ema9: e9, rsi: r, momentumPct, score: Math.max(0, Math.min(100, Math.round(score))), reasons, late }, reason: 'breakout' };
}

/** A finished 5-minute candle against the level it was breaking: confirmed, failed or weak. */
export function confirmCandle(bar: Bar, level: number, before: Bar[], vwap: number | null): 'confirmed' | 'failed' | 'weak' {
  if (bar.c < level) return 'failed';
  const normal = normalCandleVolume(before);
  const closes = [...before.map((b) => b.c), bar.c];
  const e9 = ema(closes, 9)[closes.length - 1]!;
  const ok = bar.c > level * (1 + BO.crossPct) && normal > 0 && bar.v >= BO.confirmSurge * normal && (vwap === null || bar.c > vwap) && bar.c >= e9;
  return ok ? 'confirmed' : 'weak';
}

// ---------------------------------------------------------------- past test (confirmed rule)

export interface BreakoutTrade {
  pnl: number;
  r: number;
  t1: boolean;
  win: boolean;
}

/**
 * One past day of one stock: the first confirmed breakout (a finished candle closing above the day's
 * high with volume, VWAP, EMA 9, RSI and momentum as above), bought at the NEXT candle's open,
 * half sold at target 1 (stop moves to the entry), the rest at target 2, the stop, or 3:10 pm.
 */
export function simulateBreakoutDay(bars: Bar[], prevDayHigh: number | null, riskRupees: number): BreakoutTrade | null {
  for (let i = BO.minBars; i < bars.length - 1; i++) {
    const bar = bars[i]!;
    if (bar.t < BO.firstT - 5 || bar.t >= BO.lastT) continue;
    const before = bars.slice(0, i);
    const R = resistanceOf(before, prevDayHigh);
    if (!R) continue;
    const vwap = vwapOf(bars.slice(0, i + 1));
    if (confirmCandle(bar, R.level, before, vwap) !== 'confirmed') continue;
    const closes = [...before.map((b) => b.c), bar.c];
    const r = rsi(closes, 14);
    if (r !== null && (r < BO.rsiMin || r > BO.rsiMax)) continue;
    const back = i >= 3 ? bars[i - 3]!.c : bars[0]!.o;
    if ((bar.c / back - 1) * 100 < BO.momentumPct || bar.c <= bars[0]!.o) continue;
    if (normalCandleVolume(before) * bar.c < BO.minCandleValue) continue;
    if (bar.c / R.level - 1 > BO.maxExtPct) continue;
    const entry = bars[i + 1]!.o * 1.0002;
    const plan = planBreakout(entry, R.level, before, riskRupees);
    if (!plan || plan.stop >= entry) continue;
    return walk(bars, i + 1, plan, entry);
  }
  return null;
}

function walk(bars: Bar[], from: number, p: BreakoutPlan, entry: number): BreakoutTrade {
  const half = Math.floor(p.qty / 2);
  let left = p.qty;
  let stop = p.stop;
  let gross = 0;
  let sold = 0;
  let t1 = false;
  const sell = (n: number, price: number) => {
    gross += (price - entry) * n;
    sold += price * n;
    left -= n;
  };
  for (let j = from; j < bars.length && left > 0; j++) {
    const b = bars[j]!;
    if (b.t >= BO.exitT) {
      sell(left, b.o);
      break;
    }
    if (b.l <= stop) {
      sell(left, Math.min(stop, b.o));
      break;
    }
    if (!t1 && b.h >= p.t1 && half >= 1) {
      sell(half, p.t1);
      t1 = true;
      stop = entry;
    }
    if (left > 0 && b.h >= p.t2) {
      sell(left, p.t2);
      break;
    }
    if (j === bars.length - 1 && left > 0) sell(left, b.c);
  }
  const charges = intradayCharges(entry * p.qty, sold);
  const pnl = gross - charges;
  const riskR = (entry - p.stop) * p.qty;
  return { pnl: r2(pnl), r: riskR > 0 ? Math.round((pnl / riskR) * 100) / 100 : 0, t1, win: pnl > 0 };
}

export interface BreakoutTestHalf {
  trades: number;
  wins: number;
  t1Hits: number;
  pnl: number;
  avgR: number;
}

export interface BreakoutTestReport {
  version: string;
  days: number;
  from: string;
  to: string;
  riskRupees: number;
  older: BreakoutTestHalf;
  newer: BreakoutTestHalf;
  passed: boolean;
  /** share of winning trades on all tested days (0–1), the auto-trader's starting chance */
  winRate: number;
}

const half = (ts: BreakoutTrade[]): BreakoutTestHalf => ({
  trades: ts.length,
  wins: ts.filter((t) => t.win).length,
  t1Hits: ts.filter((t) => t.t1).length,
  pnl: r2(ts.reduce((s, t) => s + t.pnl, 0)),
  avgR: ts.length ? Math.round((ts.reduce((s, t) => s + t.r, 0) / ts.length) * 100) / 100 : 0,
});

/** The confirmed rule on every stored day: older half vs newest half (passes only if the newest half made money). */
export function runBreakoutTest(days: Array<{ date: string; bars: Bar[]; prevDayHigh: number | null }>, riskRupees: number): BreakoutTestReport | null {
  const dates = [...new Set(days.map((d) => d.date))].sort();
  if (dates.length < 10) return null;
  const cut = dates[Math.floor(dates.length / 2)]!;
  const older: BreakoutTrade[] = [];
  const newer: BreakoutTrade[] = [];
  for (const d of days) {
    const t = simulateBreakoutDay(d.bars, d.prevDayHigh, riskRupees);
    if (t) (d.date < cut ? older : newer).push(t);
  }
  const all = [...older, ...newer];
  const n = half(newer);
  return {
    version: BREAKOUT_RULES_VERSION,
    days: dates.length,
    from: dates[0]!,
    to: dates[dates.length - 1]!,
    riskRupees,
    older: half(older),
    newer: n,
    passed: n.trades >= 10 && n.pnl > 0 && n.avgR > 0,
    winRate: all.length ? all.filter((t) => t.win).length / all.length : 0,
  };
}
