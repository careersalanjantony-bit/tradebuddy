import type { Settings } from '../storage/schema';
import { atr, ema, mean, rsiSeries, sma, smaSeries } from './core';
import { supportResistance, swingLows, type Level } from './levels';
import type { Candle } from './types';

/**
 * Technical snapshot (spec §9) from ADJUSTED daily candles, oldest → newest, optionally ending with
 * today's live partial candle.
 *
 * Which values use the live partial candle:
 *  - price-based averages and momentum (SMA, EMA, RSI, stretch, returns, trend) use it;
 *  - ATR, 20-day high/low, volume ratio, traded value and swing levels use completed sessions only,
 *    so stops and levels do not jump around during the day.
 */

export type Trend = 'Uptrend' | 'Downtrend' | 'Recovering' | 'Sideways';
export type SetupLabel = 'Breakout' | 'Pullback in uptrend' | 'Clean uptrend' | 'Recovering — trend not confirmed' | 'No setup';
export type Flag = 'Stretched' | 'Below 200-day' | 'Low liquidity' | 'Possible unadjusted action' | 'Stale data' | 'Not enough data';

export interface TechSnapshot {
  /** date of the last candle used (today if a live candle was included) */
  asOf: string;
  live: boolean;
  price: number;
  prevClose: number | null;
  changePct: number | null;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  ema20: number | null;
  rsi14: number | null;
  prevRsi14: number | null;
  atr14: number | null;
  high20: number | null;
  low20: number | null;
  high52w: number | null;
  low52w: number | null;
  volumeRatio: number | null;
  avgTradedValueCr: number | null;
  stretch: number | null;
  ret1m: number | null;
  ret3m: number | null;
  ret6m: number | null;
  ret1y: number | null;
  sma200Rising: boolean | null;
  trend: Trend | null;
  setup: SetupLabel;
  flags: Flag[];
  supports: Level[];
  resistances: Level[];
  lastSwingLow: number | null;
  distSma20Pct: number | null;
  distSma200Pct: number | null;
  sessions: number;
}

export type IndicatorSettings = Settings['indicators'];

export interface SnapshotOptions {
  settings: IndicatorSettings;
  /** the data has an unexplained big gap (spec §7.5 step 4) */
  unadjustedSuspected?: boolean;
  stale?: boolean;
}

const ret = (closes: number[], n: number): number | null => {
  if (closes.length <= n) return null;
  const then = closes[closes.length - 1 - n]!;
  return then ? (closes[closes.length - 1]! / then - 1) * 100 : null;
};

export function classifyTrend(price: number, sma50: number | null, sma200: number | null, sma200Rising: boolean | null): Trend | null {
  if (sma50 === null || sma200 === null || sma200Rising === null) return null;
  if (price > sma50 && sma50 > sma200 && sma200Rising) return 'Uptrend';
  if (price < sma50 && sma50 < sma200 && !sma200Rising) return 'Downtrend';
  if (price > sma200 && sma50 < sma200) return 'Recovering';
  return 'Sideways';
}

export function computeSnapshot(all: Candle[], opts: SnapshotOptions): TechSnapshot | null {
  if (!all.length) return null;
  const s = opts.settings;
  const last = all[all.length - 1]!;
  const live = !!last.partial;
  const completed = live ? all.slice(0, -1) : all;
  if (!completed.length) return null;

  const closes = all.map((c) => c.close);
  const price = last.close;
  const prevClose = completed.length >= (live ? 1 : 2) ? completed[completed.length - (live ? 1 : 2)]!.close : null;

  const sma20v = sma(closes, 20);
  const sma50v = sma(closes, 50);
  const sma200s = smaSeries(closes, 200);
  const sma200v = sma200s[sma200s.length - 1] ?? null;
  const sma200Ago = sma200s.length > 20 ? (sma200s[sma200s.length - 1 - 20] ?? null) : null;
  const sma200Rising = sma200v !== null && sma200Ago !== null ? sma200v > sma200Ago : null;

  const rsis = rsiSeries(closes, 14);
  const rsi14 = rsis[rsis.length - 1] ?? null;
  const prevRsi14 = rsis.length > 1 ? (rsis[rsis.length - 2] ?? null) : null;
  const atr14 = atr(completed, 14);

  // "Prior" 20-day high/low: the 20 completed sessions BEFORE the bar that gives today's price
  // (with a live candle that is the last 20 completed; after the close it excludes the last candle).
  const prior20 = live ? completed.slice(-20) : completed.slice(-21, -1);
  const high20 = prior20.length === 20 ? Math.max(...prior20.map((c) => c.high)) : null;
  const low20 = prior20.length === 20 ? Math.min(...prior20.map((c) => c.low)) : null;
  const yearBars = all.slice(-250);
  const high52w = yearBars.length >= 200 ? Math.max(...yearBars.map((c) => c.high)) : null;
  const low52w = yearBars.length >= 200 ? Math.min(...yearBars.map((c) => c.low)) : null;

  const regular = completed.filter((c) => !c.special);
  const vol5 = regular.length >= 50 ? mean(regular.slice(-5).map((c) => c.volume)) : null;
  const vol50 = regular.length >= 50 ? mean(regular.slice(-50).map((c) => c.volume)) : null;
  const volumeRatio = vol5 !== null && vol50 ? vol5 / vol50 : null;
  const tv = completed.length >= 20 ? mean(completed.slice(-20).map((c) => c.close * c.volume)) : null;
  const avgTradedValueCr = tv !== null ? tv / 1e7 : null;

  const stretch = sma20v !== null && atr14 ? (price - sma20v) / atr14 : null;
  const trend = classifyTrend(price, sma50v, sma200v, sma200Rising);

  // Setup label (first match wins), spec §9
  let setup: SetupLabel = 'No setup';
  if (high20 !== null && volumeRatio !== null && price > high20 && volumeRatio >= s.breakoutVolumeRatio && (trend === 'Uptrend' || trend === 'Recovering')) {
    setup = 'Breakout';
  } else if (
    trend === 'Uptrend' &&
    sma20v !== null &&
    atr14 !== null &&
    Math.abs(price - sma20v) <= s.pullbackAtrBand * atr14 &&
    rsi14 !== null &&
    rsi14 >= s.pullbackRsiMin &&
    rsi14 <= s.pullbackRsiMax &&
    sma50v !== null &&
    price > sma50v
  ) {
    setup = 'Pullback in uptrend';
  } else if (sma20v !== null && sma50v !== null && sma200v !== null && price > sma20v && sma20v > sma50v && sma50v > sma200v) {
    setup = 'Clean uptrend';
  } else if (trend === 'Recovering') {
    setup = 'Recovering — trend not confirmed';
  }

  const flags: Flag[] = [];
  if (sma200v === null) flags.push('Not enough data');
  if ((stretch !== null && stretch > s.stretchMax) || (rsi14 !== null && rsi14 > s.rsiOverbought)) flags.push('Stretched');
  if (sma200v !== null && price < sma200v) flags.push('Below 200-day');
  if (avgTradedValueCr !== null && avgTradedValueCr < s.lowLiquidityCrorePerDay) flags.push('Low liquidity');
  if (opts.unadjustedSuspected) flags.push('Possible unadjusted action');
  if (opts.stale) flags.push('Stale data');

  const sr = atr14 ? supportResistance(completed, price, atr14, { k: s.swingK, lookback: s.srLookbackSessions, clusterAtr: s.srClusterAtr }) : { supports: [], resistances: [] };
  const lows = swingLows(completed.slice(-s.srLookbackSessions), s.swingK).filter((p) => p.price < price);
  const lastSwingLow = lows.length ? lows[lows.length - 1]!.price : null;

  return {
    asOf: last.date,
    live,
    price,
    prevClose,
    changePct: prevClose ? (price / prevClose - 1) * 100 : null,
    sma20: sma20v,
    sma50: sma50v,
    sma200: sma200v,
    ema20: ema(closes, 20),
    rsi14,
    prevRsi14,
    atr14,
    high20,
    low20,
    high52w,
    low52w,
    volumeRatio,
    avgTradedValueCr,
    stretch,
    ret1m: ret(closes, 21),
    ret3m: ret(closes, 63),
    ret6m: ret(closes, 126),
    ret1y: ret(closes, 250),
    sma200Rising,
    trend,
    setup,
    flags,
    supports: sr.supports,
    resistances: sr.resistances,
    lastSwingLow,
    distSma20Pct: sma20v ? (price / sma20v - 1) * 100 : null,
    distSma200Pct: sma200v ? (price / sma200v - 1) * 100 : null,
    sessions: completed.length,
  };
}

/** Setups the scanner puts on the shortlist (price above SMA200 required, spec §10). */
export function isShortlisted(snap: TechSnapshot): boolean {
  if (snap.sma200 === null || snap.price <= snap.sma200) return false;
  if (snap.flags.includes('Possible unadjusted action')) return false;
  return snap.setup === 'Breakout' || snap.setup === 'Pullback in uptrend' || snap.setup === 'Clean uptrend';
}
