import { atrSeries, smaSeries } from '../indicators/core';
import type { Trend } from '../indicators/snapshot';
import type { Candle } from '../indicators/types';

/**
 * Historical exit study (owner's request, 9 Nov 2026): instead of a fixed target, look at how far
 * THIS stock actually ran in the past from situations like today's.
 *
 * Method (all on adjusted, completed daily candles):
 *  1. Sample days: each of the last `lookback` sessions (default 250 ≈ 1 year) that has a full
 *     `horizon` (default 20 sessions) after it. If today's trend is Uptrend or Recovering, only days
 *     in the same trend state are used ("similar days"), when there are enough of them.
 *  2. For each sample, pretend we bought at that day's close with a stop `stopAtr` × ATR below.
 *     Walk forward up to `horizon` sessions: if the low touches the stop, the trade ends (that day's
 *     high is NOT counted — conservative). Otherwise track the highest high reached so far.
 *     → "run-up before the stop", measured in ATRs of that day.
 *  3. Levels (in ATRs above entry):
 *       safe        = 40th percentile → reached before the stop in ~60% of samples
 *       typical     = median          → ~50%
 *       hold-until  = 75th percentile → ~25% (the top of the usual range)
 *  4. For each candidate target the average result per trade in R is computed (target hit → +x/stopAtr R,
 *     stopped → −1R, neither → result at the close after `horizon` sessions). The best one is reported.
 *
 * This describes the past. It is not a forecast.
 */

export interface ExitStudyOptions {
  stopAtr?: number;
  horizon?: number;
  lookback?: number;
  minSamples?: number;
  /** today's trend, to pick similar days */
  trend?: Trend | null;
}

export interface ChancePoint {
  atr: number;
  /** share of samples that reached entry + atr×ATR before the stop (0–1) */
  chance: number;
  /** average result per trade in R if this were the fixed target */
  expectancyR: number;
}

export interface ExitStudy {
  samples: number;
  /** true when only days in the same trend state were used */
  similarOnly: boolean;
  horizon: number;
  lookback: number;
  stopAtr: number;
  safeAtr: number;
  typicalAtr: number;
  holdAtr: number;
  /** share of samples stopped out within the horizon */
  stoppedPct: number;
  curve: ChancePoint[];
  best: ChancePoint | null;
  /** every sample's run-up before the stop, in ATRs, ascending (for exact chances) */
  mfeSorted: number[];
  /** every sample (for exact averages at any target) */
  cases: Array<{ mfeAtr: number; stopped: boolean; endR: number }>;
}

export function quantile(sortedAsc: number[], q: number): number {
  if (!sortedAsc.length) return NaN;
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sortedAsc[lo]! + (sortedAsc[hi]! - sortedAsc[lo]!) * (pos - lo);
}

function trendAt(close: number, s50: number | null, s200: number | null): 'up' | 'recovering' | 'other' {
  if (s50 === null || s200 === null) return 'other';
  if (close > s50 && s50 > s200) return 'up';
  if (close > s200 && s50 < s200) return 'recovering';
  return 'other';
}

interface Sample {
  mfeAtr: number;
  stopped: boolean;
  /** result in R if held to the end of the horizon without a target */
  endR: number;
}

export function studyExits(candles: Candle[], opts: ExitStudyOptions = {}): ExitStudy | null {
  const stopAtr = opts.stopAtr ?? 2;
  const horizon = opts.horizon ?? 20;
  const lookback = opts.lookback ?? 250;
  const minSamples = opts.minSamples ?? 30;
  const bars = candles.filter((c) => !c.partial);
  const n = bars.length;
  if (n < horizon + 30) return null;

  const atrs = atrSeries(bars, 14);
  const closes = bars.map((c) => c.close);
  const s50 = smaSeries(closes, 50);
  const s200 = smaSeries(closes, 200);
  const want = opts.trend === 'Uptrend' ? 'up' : opts.trend === 'Recovering' ? 'recovering' : null;

  const all: Sample[] = [];
  const similar: Sample[] = [];
  const first = Math.max(15, n - lookback - horizon);
  for (let i = first; i <= n - 1 - horizon; i++) {
    const a = atrs[i];
    if (!a || a <= 0) continue;
    const entry = closes[i]!;
    const stop = entry - stopAtr * a;
    let high = entry;
    let stopped = false;
    let end = closes[i + horizon]!;
    for (let j = i + 1; j <= i + horizon; j++) {
      if (bars[j]!.low <= stop) {
        stopped = true;
        end = stop;
        break;
      }
      if (bars[j]!.high > high) high = bars[j]!.high;
    }
    const s: Sample = { mfeAtr: (high - entry) / a, stopped, endR: (end - entry) / (stopAtr * a) };
    all.push(s);
    if (want && trendAt(entry, s50[i] ?? null, s200[i] ?? null) === want) similar.push(s);
  }

  const similarOnly = !!want && similar.length >= minSamples;
  const used = similarOnly ? similar : all;
  if (used.length < Math.min(minSamples, 20)) return null;

  const mfe = used.map((s) => s.mfeAtr).sort((x, y) => x - y);
  const curve: ChancePoint[] = [];
  for (let x = 0.5; x <= 10 + 1e-9; x += 0.5) {
    let hit = 0;
    let sum = 0;
    for (const s of used) {
      if (s.mfeAtr >= x) {
        hit++;
        sum += x / stopAtr;
      } else sum += s.stopped ? -1 : s.endR;
    }
    curve.push({ atr: x, chance: hit / used.length, expectancyR: sum / used.length });
  }
  const best = curve.reduce<ChancePoint | null>((b, p) => (!b || p.expectancyR > b.expectancyR ? p : b), null);

  return {
    samples: used.length,
    similarOnly,
    horizon,
    lookback,
    stopAtr,
    safeAtr: quantile(mfe, 0.4),
    typicalAtr: quantile(mfe, 0.5),
    holdAtr: quantile(mfe, 0.75),
    stoppedPct: used.filter((s) => s.stopped).length / used.length,
    curve,
    best,
    mfeSorted: mfe,
    cases: used.map((c) => ({ mfeAtr: c.mfeAtr, stopped: c.stopped, endR: c.endR })),
  };
}

/**
 * Average result per trade, in units of the possible loss (R), if in every similar past case one had
 * sold at `atr` ATRs above entry (target reached before the stop), or lost 1R at the stop, or sold at
 * the close after the horizon. Exact, from the stored cases.
 */
export function expectancyAt(study: ExitStudy, atr: number): number {
  if (!study.cases.length) return 0;
  let sum = 0;
  for (const c of study.cases) sum += c.mfeAtr >= atr - 1e-9 ? atr / study.stopAtr : c.stopped ? -1 : c.endR;
  return sum / study.cases.length;
}

/** Share (0–1) of past samples that reached `atr` ATRs above entry before the stop — counted exactly. */
export function chanceOf(study: ExitStudy, atr: number): number {
  const m = study.mfeSorted;
  if (!m.length) return 0;
  let lo = 0;
  let hi = m.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (m[mid]! >= atr - 1e-9) hi = mid;
    else lo = mid + 1;
  }
  return (m.length - lo) / m.length;
}
