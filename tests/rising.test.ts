import { describe, expect, it } from 'vitest';
import type { Bars } from '../src/daytrade/types';
import { prevDayOf } from '../src/ml/features';
import {
  PLAN,
  holdAdvice,
  isOldRising,
  isRisingMoment,
  quickPlan,
  readRise,
  riseFeatures,
  riseOutcome,
  running,
  samplesOfDay,
  thin,
  trainRise,
  usualFrom,
  type RiseCtx,
  type RiseSample,
} from '../src/rising/momentum';

const T0 = 555; // 9:15

function bars(rows: Array<[number, number, number, number, number]>, start = T0): Bars {
  return { t: rows.map((_, i) => start + i * 5), o: rows.map((r) => r[0]), h: rows.map((r) => r[1]), l: rows.map((r) => r[2]), c: rows.map((r) => r[3]), v: rows.map((r) => r[4]) };
}
const flatCtx: RiseCtx = { prevClose: 100, usual: () => ({ bar: 1000, cum: null }), market: () => 0 };

describe('the quick trade: +0.6 % before −0.4 % within 20 minutes', () => {
  it('target first = win, stop first = loss, both in one candle = loss (the cautious side)', () => {
    const b = bars([
      [100, 100, 100, 100, 1],
      [100, 100.3, 99.9, 100.2, 1],
      [100.2, 100.7, 100.1, 100.5, 1],
    ]);
    expect(riseOutcome(b, 0)).toEqual({ win: true, ret: PLAN.target });
    const s = bars([
      [100, 100, 100, 100, 1],
      [100, 100.2, 99.5, 99.7, 1],
    ]);
    expect(riseOutcome(s, 0)).toEqual({ win: false, ret: -PLAN.stop });
    const both = bars([
      [100, 100, 100, 100, 1],
      [100, 100.8, 99.5, 100, 1],
    ]);
    expect(riseOutcome(both, 0)!.win).toBe(false);
    // neither within 4 candles: sold at the 4th close
    const flat = bars([[100, 100, 100, 100, 1], ...Array.from({ length: 5 }, () => [100, 100.2, 99.8, 100.1, 1] as [number, number, number, number, number])]);
    const f = riseOutcome(flat, 0)!;
    expect(f.win).toBe(false);
    expect(f.ret).toBeCloseTo(0.001, 9);
    // a gap above the target at the next open counts at that open
    const gap = bars([
      [100, 100, 100, 100, 1],
      [101, 101.2, 100.9, 101, 1],
    ]);
    const g = riseOutcome(gap, 0)!;
    expect(g.win).toBe(true);
    expect(g.ret).toBeCloseTo(0.01, 9);
  });

  it('running values: day average price, high/low, RSI', () => {
    const b = bars([
      [100, 101, 99, 100, 100],
      [100, 102, 100, 102, 300],
      [102, 103, 101, 101, 100],
      [101, 101, 100, 100, 100],
    ]);
    const r = running(b);
    expect(r.vwap[0]).toBe(100);
    expect(r.vwap[1]).toBeCloseTo((100 * 100 + (304 / 3) * 300) / 400, 6);
    expect(r.hi[2]).toBe(103);
    expect(r.lo[3]).toBe(99);
    expect(r.rsi[2]).toBeNull();
    expect(r.rsi[3]).toBeGreaterThan(30);
  });
});

describe('features and the plain-words tag', () => {
  // flat open, then a strong push with 4× volume
  const day = bars([
    [100, 100.2, 99.9, 100, 1000],
    [100, 100.2, 99.9, 100.1, 1000],
    [100.1, 100.3, 100, 100.2, 1000],
    [100.2, 100.8, 100.2, 100.7, 4000],
    [100.7, 101.2, 100.6, 101.1, 4000],
  ]);
  it('a strong push is a rising moment with clear reasons; a fall below the day average is not', () => {
    const x = riseFeatures(day, 4, running(day), flatCtx)!;
    expect(x).toHaveLength(17);
    expect(isRisingMoment(x)).toBe(true);
    expect(isOldRising(x)).toBe(false); // the old list also needed more volume over the whole day
    const r = readRise(x, null);
    expect(r.tag).toBe('unclear'); // no model yet: never "likely"
    expect(r.reasons.join(' ')).toMatch(/4\.0× its usual volume/);
    const down = bars([
      [100, 100.2, 99.9, 100, 1000],
      [100, 100.1, 99.5, 99.6, 1000],
      [99.6, 99.7, 99.2, 99.3, 1000],
    ]);
    const xd = riseFeatures(down, 2, running(down), flatCtx)!;
    expect(readRise(xd, null).tag).toBe('fading');
  });
  it('no features before the 9:25 candle', () => {
    expect(riseFeatures(day, 1, running(day), flatCtx)).toBeNull();
  });
  it('plan: +0.6 % / −0.4 % on 5-paise ticks, sell within 20 minutes', () => {
    expect(quickPlan(420, 0)).toEqual({ entry: 420, target: 422.55, stop: 418.3, sellBy: 20 * 60_000 });
  });
  it('holding advice: keep with a protect price, protect tightly, or take the profit', () => {
    const strong = { tag: 'strong' as const, chance: 0.6, measured: 0.55, reasons: [] };
    expect(holdAdvice(strong, 425, 420)).toEqual({ action: 'keep', protectAt: 423.3, text: 'Likely to keep rising — keep, sell if it drops to ₹423.30' });
    expect(holdAdvice({ ...strong, tag: 'unclear' }, 425, 420).protectAt).toBe(423.9);
    expect(holdAdvice({ ...strong, tag: 'fading' }, 425, 420)).toMatchObject({ action: 'sell', text: 'Slowing — take the profit (+1.2%)' });
    // 0.4 % up: never protect below what you paid
    expect(holdAdvice({ ...strong, tag: 'strong' }, 420.2, 418.5).protectAt).toBe(418.9);
  });
});

// ---------------------------------------------------------------- learning on a synthetic market

/** Deterministic pseudo-random numbers. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x6d2b79f5) >>> 0;
    return (s >>> 8) / 2 ** 24;
  };
}

/**
 * A market where a push with a volume surge tends to continue for a few candles, and a push without
 * volume tends to fade — something real for the model to find.
 */
function synthDay(r: () => number): Bars {
  const rows: Array<[number, number, number, number, number]> = [];
  let p = 100;
  let push = 0;
  for (let i = 0; i < 75; i++) {
    let vol = 1000 * (0.7 + 0.6 * r());
    if (push === 0 && r() < 0.06) push = r() < 0.5 ? 4 : -3; // surge (continues) or weak push (fades)
    let d = (r() - 0.5) * 0.25;
    if (push > 0) {
      d += 0.3;
      vol *= 3.5;
      push--;
    } else if (push < 0) {
      d += push === -3 ? 0.35 : -0.25;
      push++;
    }
    const o = p;
    const c = Math.max(1, p * (1 + d / 100));
    rows.push([o, Math.max(o, c) * (1 + r() * 0.001), Math.min(o, c) * (1 - r() * 0.001), c, Math.round(vol)]);
    p = c;
  }
  return bars(rows);
}

describe('learning which rises keep going (synthetic market)', () => {
  it('learns on the older 70 % of days, tests on the newest 30 %, and finds the volume-backed rises', () => {
    const r = rng(7);
    const samples: RiseSample[] = [];
    const stocks = 30;
    const daysN = 30;
    const history: Bars[][] = Array.from({ length: stocks }, () => Array.from({ length: daysN }, () => synthDay(r)));
    const dates = Array.from({ length: daysN }, (_, d) => `2026-09-${String(d + 1).padStart(2, '0')}`);
    for (let s = 0; s < stocks; s++) {
      for (let d = 3; d < daysN; d++) {
        const prev = history[s]!.slice(Math.max(0, d - 10), d).map((b) => prevDayOf(b)!);
        const b = history[s]![d]!;
        samples.push(...samplesOfDay(dates[d]!, b, { prevClose: history[s]![d - 1]!.c[74]!, usual: usualFrom(prev), market: () => 0 }));
      }
    }
    const t0 = Date.now();
    const m = trainRise(samples, 1, { maxTrain: 20_000 })!;
    const ms = Date.now() - t0;
    process.stdout.write(`RISE: ${samples.length} moments, trained+tested in ${ms} ms; base ${(m.report.base.win * 100).toFixed(1)}%, strong ${((m.report.strong?.win ?? 0) * 100).toFixed(1)}% (${m.report.strong?.n}), old ${(m.report.old.win * 100).toFixed(1)}% (${m.report.old.n}), auc ${m.report.auc?.toFixed(3)}\n`);
    expect(m.report.testFrom >= dates[Math.floor(daysN * 0.6)]!).toBe(true);
    expect(m.report.trainDays + m.report.testDays).toBe(daysN - 3);
    expect(m.report.auc!).toBeGreaterThan(0.6);
    expect(m.report.strongFrom).not.toBeNull();
    expect(m.report.strong!.win).toBeGreaterThan(m.report.base.win + 0.08);
    expect(m.report.strong!.avgNetPct).toBeGreaterThan(0);
    expect(m.report.bands).toHaveLength(5);
    expect(m.report.bands[4]!.win).toBeGreaterThan(m.report.bands[0]!.win);
    expect(m.report.importance[0]!.name).toBeTruthy();
    // a fresh volume-backed push reads "likely"; a measured rate comes with it
    const day = synthDay(rng(99));
    const run = running(day);
    const ctx: RiseCtx = { prevClose: 100, usual: () => ({ bar: 1000, cum: 1000 * 20 }), market: () => 0 };
    let sawStrong = false;
    for (let i = 2; i < day.t.length; i++) {
      const x = riseFeatures(day, i, run, ctx);
      const read = readRise(x, m);
      if (read.tag === 'strong') {
        sawStrong = true;
        expect(read.measured!).toBeGreaterThan(m.report.base.win);
        expect(read.chance!).toBeLessThan(1);
      }
    }
    expect(sawStrong).toBe(true);
  });

  it('too little history: no model (and the screen says so)', () => {
    expect(trainRise([], 1)).toBeNull();
  });

  it('thins evenly', () => {
    expect(thin([1, 2, 3, 4, 5, 6], 3)).toEqual([1, 3, 5]);
    expect(thin([1, 2], 3)).toEqual([1, 2]);
  });
});
