import type { Candle } from '../indicators/types';
import { auc, fitEnsemble, predictEnsemble, type EnsembleModel } from '../ml/models';
import { FALL_LABEL_PCT, indicatorsOf, type Indicators } from './shortSell';

/**
 * App v1.7 — the short-selling chance per stock (owner: "do not display a fixed 43 % for every stock;
 * calculate the actual percentage separately for each stock based on its real market data").
 *
 * Instead of grouping setups into a few score bands (every stock in a band got the same number), a
 * model (the app's logistic regression + boosted trees ensemble) is trained on about a year of daily
 * candles of every stock in the list. For every past day it sees eleven numbers known at that day's
 * open — distance from the 20-day average, 20- vs 50-day average, 4-week and 1-week move, RSI, lower
 * highs, red-candle volume, yesterday's move, volatility (ATR %), the opening gap and the stock's own
 * habit of falling — and learns which combinations ended the day at least 0.3 % below the open. Each
 * stock today gets its own chance from its own numbers.
 *
 * Honesty check: before it is used, the model is trained on the older two thirds of the days and
 * tested on the newest third (days it never saw). The screen shows how the stocks it rated highest
 * really did on those days. Pure functions only.
 */

export const SHORT_MODEL_VERSION = 1;
export const FEATURE_NAMES = ['vs 20-day avg %', '20 vs 50-day avg %', '4-week move %', '1-week move %', 'RSI 14', 'lower highs', 'red-candle volume', "yesterday's move %", 'ATR %', 'opening gap %', 'own falling habit'];
const HISTORY_DAYS = 260;
const MAX_ROWS = 25_000;
const OWN_PRIOR_WEIGHT = 20;

export function atrSeries(c: Candle[], n = 14): Array<number | null> {
  const out: Array<number | null> = c.map(() => null);
  let a: number | null = null;
  for (let i = 1; i < c.length; i++) {
    const tr = Math.max(c[i]!.high - c[i]!.low, Math.abs(c[i]!.high - c[i - 1]!.close), Math.abs(c[i]!.low - c[i - 1]!.close));
    if (i < n) continue;
    if (a === null) {
      let s = 0;
      for (let k = i - n + 1; k <= i; k++) s += Math.max(c[k]!.high - c[k]!.low, Math.abs(c[k]!.high - c[k - 1]!.close), Math.abs(c[k]!.low - c[k - 1]!.close));
      a = s / n;
    } else a = (a * (n - 1) + tr) / n;
    out[i] = a;
  }
  return out;
}

/** The stock's own habit, pulled toward the list's average when it has few days. */
export const ownRate = (fell: number, n: number, base: number) => (fell + OWN_PRIOR_WEIGHT * base) / (n + OWN_PRIOR_WEIGHT);

/**
 * The eleven numbers for day i (from the days before it; the opening gap only with `withOpen`).
 * null when there is not enough history.
 */
export function featuresAt(c: Candle[], i: number, ind: Indicators, atr: Array<number | null>, own: number, withOpen: boolean): number[] | null {
  const p = i - 1;
  if (p < 55) return null;
  const close = c[p]!.close;
  const e20 = ind.ema20[p];
  const e50 = ind.ema50[p];
  const r = ind.rsi14[p];
  const a = atr[p];
  const v20 = ind.vol20[p - 1];
  if (e20 == null || e50 == null || r == null || a == null || !(close > 0)) return null;
  const hiRecent = Math.max(...c.slice(p - 4, p + 1).map((x) => x.high));
  const hiBefore = Math.max(...c.slice(p - 9, p - 4).map((x) => x.high));
  const volRatio = v20 ? Math.min(3, c[p]!.volume / v20) : 1;
  const gap = withOpen && i < c.length && c[i]!.open > 0 ? (c[i]!.open / close - 1) * 100 : 0;
  return [
    (close / e20 - 1) * 100,
    (e20 / e50 - 1) * 100,
    (close / c[p - 20]!.close - 1) * 100,
    (close / c[p - 5]!.close - 1) * 100,
    r,
    hiRecent < hiBefore ? 1 : 0,
    (c[p]!.close < c[p]!.open ? 1 : -1) * volRatio,
    (close / c[p - 1]!.close - 1) * 100,
    (a / close) * 100,
    Math.max(-5, Math.min(5, gap)),
    own,
  ];
}

export interface Row {
  key: string;
  date: string;
  x: number[];
  y: number;
}

const finished = (c: Candle[]) => (c.length && c[c.length - 1]!.partial ? c.slice(0, -1) : c);
const fell = (d: Candle) => d.close <= d.open * (1 - FALL_LABEL_PCT / 100);

/** Every usable past day of every stock (about a year each). `ownOf` gives each stock's habit to use. */
export function buildRows(stocks: Array<{ key: string; candles: Candle[] }>, ownOf: (key: string) => number, withOpen = true): Row[] {
  const rows: Row[] = [];
  for (const s of stocks) {
    const c = finished(s.candles);
    if (c.length < 70) continue;
    const ind = indicatorsOf(c);
    const atr = atrSeries(c);
    const own = ownOf(s.key);
    for (let i = Math.max(56, c.length - HISTORY_DAYS); i < c.length; i++) {
      const d = c[i]!;
      if (!(d.open > 0) || d.special) continue;
      const x = featuresAt(c, i, ind, atr, own, withOpen);
      if (x) rows.push({ key: s.key, date: d.date, x, y: fell(d) ? 1 : 0 });
    }
  }
  return rows;
}

/** How often each stock's past days fell ≥ 0.3 % from the open (only days before `before`, if given). */
export function ownCounts(stocks: Array<{ key: string; candles: Candle[] }>, before?: string): Record<string, { fell: number; n: number }> {
  const out: Record<string, { fell: number; n: number }> = {};
  for (const s of stocks) {
    const c = finished(s.candles).slice(-HISTORY_DAYS);
    let f = 0;
    let n = 0;
    for (const d of c) {
      if (before && d.date >= before) continue;
      if (!(d.open > 0) || d.special) continue;
      n++;
      if (fell(d)) f++;
    }
    out[s.key] = { fell: f, n };
  }
  return out;
}

export interface ShortModelTest {
  /** days it never saw */
  n: number;
  from: string;
  to: string;
  /** how well it ranks (0.5 = coin toss, 1 = perfect) */
  auc: number | null;
  /** share of all test days that fell ≥ 0.3 % from the open */
  baseRate: number;
  /** share of the 20 % of test days it rated highest that really fell */
  topRate: number;
  /** its average chance for those days (to compare with topRate) */
  topPredicted: number;
}

export interface ShortModel {
  v: number;
  /** IST date it was trained */
  date: string;
  trainedAt: number;
  /** model with today's opening gap (market open) and without it (setups for the next session) */
  withOpen: EnsembleModel;
  noOpen: EnsembleModel;
  samples: number;
  stocks: number;
  baseRate: number;
  own: Record<string, { fell: number; n: number }>;
  test: ShortModelTest | null;
}

const capRows = (rows: Row[]) => (rows.length > MAX_ROWS ? rows.slice(rows.length - MAX_ROWS) : rows);

function evaluate(stocks: Array<{ key: string; candles: Candle[] }>): ShortModelTest | null {
  const dates = [...new Set(stocks.flatMap((s) => finished(s.candles).slice(-HISTORY_DAYS).map((c) => c.date)))].sort();
  if (dates.length < 90) return null;
  const cut = dates[Math.floor(dates.length * (2 / 3))]!;
  const own = ownCounts(stocks, cut);
  const all = Object.values(own);
  const base = all.reduce((s, o) => s + o.fell, 0) / Math.max(1, all.reduce((s, o) => s + o.n, 0));
  const rows = buildRows(stocks, (k) => ownRate(own[k]?.fell ?? 0, own[k]?.n ?? 0, base), true);
  const train = capRows(rows.filter((r) => r.date < cut));
  const test = rows.filter((r) => r.date >= cut);
  if (train.length < 500 || test.length < 200) return null;
  const m = fitEnsemble(train.map((r) => r.x), train.map((r) => r.y));
  const p = test.map((r) => predictEnsemble(m, r.x));
  const y = test.map((r) => r.y);
  const order = p.map((v, i) => [v, i] as const).sort((a, b) => b[0] - a[0]);
  const top = order.slice(0, Math.max(1, Math.floor(order.length * 0.2)));
  return {
    n: test.length,
    from: cut,
    to: dates[dates.length - 1]!,
    auc: auc(p, y),
    baseRate: y.reduce((s, v) => s + v, 0) / y.length,
    topRate: top.reduce((s, [, i]) => s + y[i]!, 0) / top.length,
    topPredicted: top.reduce((s, [v]) => s + v, 0) / top.length,
  };
}

/** Trains on all stocks' past year (and tests on the newest third first). null when there is too little history. */
export function trainShortModel(stocks: Array<{ key: string; candles: Candle[] }>, date: string, now: number): ShortModel | null {
  const own = ownCounts(stocks);
  const all = Object.values(own);
  const n = all.reduce((s, o) => s + o.n, 0);
  if (n < 1500) return null;
  const base = all.reduce((s, o) => s + o.fell, 0) / n;
  const ownOf = (k: string) => ownRate(own[k]?.fell ?? 0, own[k]?.n ?? 0, base);
  const rowsOpen = capRows(buildRows(stocks, ownOf, true));
  const rowsNext = capRows(buildRows(stocks, ownOf, false));
  if (rowsOpen.length < 800) return null;
  const withOpen = fitEnsemble(rowsOpen.map((r) => r.x), rowsOpen.map((r) => r.y));
  const noOpen = fitEnsemble(rowsNext.map((r) => r.x), rowsNext.map((r) => r.y));
  return { v: SHORT_MODEL_VERSION, date, trainedAt: now, withOpen, noOpen, samples: rowsOpen.length, stocks: Object.keys(own).length, baseRate: base, own, test: evaluate(stocks) };
}

export interface StockChance {
  /** 0–1: chance today's (or the next session's) close is ≥ 0.3 % below the open */
  chance: number;
  /** true: uses today's opening price (market open) */
  live: boolean;
  /** the stock's own past year */
  ownFell: number;
  ownDays: number;
}

/** This stock's own chance from its own numbers today. */
export function stockChance(m: ShortModel, key: string, candles: Candle[]): StockChance | null {
  if (candles.length < 70) return null;
  const last = candles[candles.length - 1]!;
  const live = !!last.partial;
  const c = live ? candles : [...candles, { ...last, date: '9999-12-31', open: last.close, high: last.close, low: last.close, volume: 0 }];
  const ind = indicatorsOf(c);
  const atr = atrSeries(c);
  const o = m.own[key] ?? { fell: 0, n: 0 };
  const x = featuresAt(c, c.length - 1, ind, atr, ownRate(o.fell, o.n, m.baseRate), live);
  if (!x) return null;
  const chance = predictEnsemble(live ? m.withOpen : m.noOpen, x);
  return { chance: Math.round(chance * 1000) / 1000, live, ownFell: o.fell, ownDays: o.n };
}
