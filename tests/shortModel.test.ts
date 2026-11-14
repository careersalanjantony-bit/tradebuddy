import { describe, expect, it } from 'vitest';
import { atrSeries, featuresAt, ownCounts, stockChance, trainShortModel, FEATURE_NAMES } from '../src/advisor/shortModel';
import { dailyShortPlan } from '../src/advisor/shortPlan';
import { indicatorsOf } from '../src/advisor/shortSell';
import { mergeNews } from '../src/background/newsJobs';
import type { Candle } from '../src/indicators/types';

/** A deterministic "random" walk: `bias` < 0 makes days that open after a weak week fall more often. */
function stock(seed: number, n: number, bias: number): Candle[] {
  let x = seed * 9301 + 49297;
  const rnd = () => ((x = (x * 9301 + 49297) % 233280) / 233280);
  const out: Candle[] = [];
  let prev = 500 + seed * 40;
  for (let i = 0; i < n; i++) {
    const weak = out.length >= 5 && prev < out[out.length - 5]!.close;
    const gap = (rnd() - 0.5) * 0.01;
    const open = prev * (1 + gap);
    // weak stocks keep falling more often on the day (the pattern the model should find)
    const drift = (weak ? bias : 0) + (rnd() - 0.5) * 0.02;
    const close = open * (1 + drift);
    const d = new Date(Date.UTC(2025, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
    out.push({ date: d, open, high: Math.max(open, close) * (1 + rnd() * 0.004), low: Math.min(open, close) * (1 - rnd() * 0.004), close, volume: 100_000 + Math.round(rnd() * 50_000) });
    prev = close;
  }
  return out;
}

describe('per-stock short-selling model', () => {
  const stocks = Array.from({ length: 12 }, (_, s) => ({ key: `K${s}`, candles: stock(s + 1, 330, -0.006) }));

  it('computes ATR and the eleven numbers for a day', () => {
    const c = stocks[0]!.candles;
    const atr = atrSeries(c);
    expect(atr[5]).toBeNull();
    expect(atr[100]!).toBeGreaterThan(0);
    const x = featuresAt(c, 200, indicatorsOf(c), atr, 0.4, true)!;
    expect(x).toHaveLength(FEATURE_NAMES.length);
    expect(x.every((v) => Number.isFinite(v))).toBe(true);
    expect(featuresAt(c, 30, indicatorsOf(c), atr, 0.4, true)).toBeNull();
  });

  it('counts each stock\'s own habit of falling', () => {
    const own = ownCounts(stocks);
    expect(own.K0!.n).toBeGreaterThan(200);
    expect(own.K0!.fell).toBeGreaterThan(0);
    const before = ownCounts(stocks, stocks[0]!.candles[200]!.date);
    expect(before.K0!.n).toBeLessThan(own.K0!.n);
  });

  it('trains, tests itself on the newest third, and gives each stock its own chance', () => {
    const m = trainShortModel(stocks, '2026-11-15', Date.UTC(2026, 10, 15))!;
    expect(m).not.toBeNull();
    expect(m.samples).toBeGreaterThan(2000);
    expect(m.stocks).toBe(12);
    expect(m.test).not.toBeNull();
    expect(m.test!.auc!).toBeGreaterThan(0.5); // it found the planted pattern on days it never saw
    expect(m.test!.topRate).toBeGreaterThan(m.test!.baseRate);
    const chances = stocks.map((s) => stockChance(m, s.key, s.candles)!.chance);
    expect(chances.every((p) => p > 0 && p < 1)).toBe(true);
    // not one shared number: at least several different values
    expect(new Set(chances.map((p) => p.toFixed(3))).size).toBeGreaterThan(5);
    const c = stockChance(m, 'K0', stocks[0]!.candles)!;
    expect(c.live).toBe(false);
    expect(c.ownDays).toBeGreaterThan(200);
  });

  it('uses today\'s opening price while the market is open', () => {
    const m = trainShortModel(stocks, '2026-11-15', 0)!;
    const c = stocks[3]!.candles;
    const last = c[c.length - 1]!;
    const gapDown = [...c, { date: '2026-11-16', open: last.close * 0.985, high: last.close * 0.986, low: last.close * 0.98, close: last.close * 0.982, volume: 50_000, partial: true }];
    const gapUp = [...c, { date: '2026-11-16', open: last.close * 1.015, high: last.close * 1.02, low: last.close * 1.014, close: last.close * 1.018, volume: 50_000, partial: true }];
    const down = stockChance(m, 'K3', gapDown)!;
    const up = stockChance(m, 'K3', gapUp)!;
    expect(down.live).toBe(true);
    expect(down.chance).not.toBe(up.chance);
  });

  it('refuses to train on too little history', () => {
    expect(trainShortModel([{ key: 'A', candles: stock(1, 80, 0) }], '2026-11-15', 0)).toBeNull();
  });
});

describe('daily sell-first plan', () => {
  it('stop half a normal day above, targets 1 and 2 steps below, size for the risk, after charges', () => {
    const c = stock(7, 120, 0);
    const p = dailyShortPlan(c, 1000, 50)!;
    expect(p.stop).toBeGreaterThan(1000);
    expect(p.stopPct).toBeGreaterThanOrEqual(0.5);
    expect(p.stopPct).toBeLessThanOrEqual(2.01);
    expect(p.t1).toBeLessThan(1000);
    expect(p.t2).toBeLessThan(p.t1);
    expect(p.rr1).toBeCloseTo(1, 1);
    expect(p.rr2).toBeCloseTo(2, 1);
    expect(p.risk).toBeLessThanOrEqual(50 + p.stop - 1000);
    expect(p.netAtTargets).toBeLessThan(p.qty * (1000 - p.t1) * 2);
    expect(p.netAtStop).toBeLessThan(-p.risk + 0.01);
    expect(dailyShortPlan(c.slice(0, 5), 1000, 50)).toBeNull();
  });
});

describe('news kept for a week', () => {
  it('keeps the last 7 days and drops older ones', () => {
    const now = Date.UTC(2026, 10, 15, 12);
    const day = 86_400_000;
    const items = [
      { key: 'A', heading: 'new', link: 'https://x/1', at: now - day },
      { key: 'A', heading: 'six days', link: 'https://x/2', at: now - 6 * day },
      { key: 'A', heading: 'too old', link: 'https://x/3', at: now - 8 * day },
    ];
    const kept = mergeNews([], items, now).map((i) => i.heading);
    expect(kept).toEqual(['new', 'six days']);
  });
});
