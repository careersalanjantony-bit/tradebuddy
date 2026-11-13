import { describe, expect, it } from 'vitest';
import { DEFAULT_VARIANT, type Candidate } from '../src/daytrade/backtest';
import { featureVector, N_FEATURES, prevDayOf } from '../src/ml/features';
import { explainImportance, learn } from '../src/ml/learn';
import { auc, fitBoosted, fitLogistic, predictBoosted, predictEnsemble, predictLogistic } from '../src/ml/models';

/** small seeded random generator, so the tests always see the same numbers */
function rng(seed: number) {
  let s = seed >>> 0;
  const next = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const normal = () => Math.sqrt(-2 * Math.log(next() + 1e-12)) * Math.cos(2 * Math.PI * next());
  return { next, normal };
}

function dates(n: number): string[] {
  const out: string[] = [];
  const d = new Date('2026-01-01T00:00:00Z');
  while (out.length < n) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** Past signals whose result depends on feature 0 ("heavy trading") when `learnable`, else pure luck. */
function makeCandidates(learnable: boolean, seed = 7): { cands: Candidate[]; days: string[] } {
  const r = rng(seed);
  const days = dates(120);
  const cands: Candidate[] = [];
  for (const date of days) {
    for (let k = 0; k < 14; k++) {
      const f = Array.from({ length: N_FEATURES }, () => r.normal());
      const good = learnable ? f[0]! + 0.6 * r.normal() > 0.3 : r.next() < 0.45;
      const entry = 1000;
      // a real pattern pays more than it loses; luck alone loses after charges
      const exit = learnable ? (good ? 1012 : 994) : good ? 1006 : 994;
      cands.push({
        key: `K${k}`,
        symbol: `S${k}`,
        date,
        side: 'long',
        signalT: 570 + k * 5,
        slot: 3 + k,
        rvol: 1.2,
        entry,
        stop: 990,
        outcomes: { '1': { price: exit, t: 700, reason: good ? 'target' : 'stop' }, '1.5': { price: exit, t: 700, reason: good ? 'target' : 'stop' }, '2': { price: exit, t: 700, reason: 'time' }, eod: { price: exit, t: 910, reason: 'time' } },
        market: 0.002,
        f,
      });
    }
  }
  return { cands, days };
}

const cfg = { amount: 100_000, slots: 2, maxLosses: 2 };

describe('learning methods', () => {
  it('logistic regression and boosted trees learn a simple pattern', () => {
    const r = rng(3);
    const X: number[][] = [];
    const y: number[] = [];
    for (let i = 0; i < 800; i++) {
      const x = [r.normal(), r.normal(), r.normal()];
      X.push(x);
      y.push(x[0]! - 0.5 * x[1]! + 0.3 * r.normal() > 0 ? 1 : 0);
    }
    const lm = fitLogistic(X, y);
    expect(lm.w[0]!).toBeGreaterThan(0.5);
    expect(lm.w[1]!).toBeLessThan(-0.2);
    const bm = fitBoosted(X, y);
    const pl = X.map((x) => predictLogistic(lm, x));
    const pb = X.map((x) => predictBoosted(bm, x));
    expect(auc(pl, y)!).toBeGreaterThan(0.9);
    expect(auc(pb, y)!).toBeGreaterThan(0.85);
  });

  it('AUC: perfect ranking = 1, reversed = 0, ties = 0.5', () => {
    expect(auc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1])).toBe(1);
    expect(auc([0.9, 0.8, 0.2, 0.1], [0, 0, 1, 1])).toBe(0);
    expect(auc([0.5, 0.5], [0, 1])).toBe(0.5);
    expect(auc([0.5, 0.5], [1, 1])).toBeNull();
  });
});

describe('self-learning with the unseen-days check', () => {
  it('finds a real pattern, beats the plain rules on unseen days, and is switched on', () => {
    const { cands, days } = makeCandidates(true);
    const rep = learn(cands, days, cfg, DEFAULT_VARIANT)!;
    expect(rep).not.toBeNull();
    expect(rep.auc!).toBeGreaterThan(0.75);
    expect(rep.ml.trades).toBeGreaterThanOrEqual(15);
    expect(rep.ml.pnl).toBeGreaterThan(0);
    expect(rep.ml.pnl).toBeGreaterThan(rep.base.pnl);
    expect(rep.passed).toBe(true);
    expect(rep.importance[0]!.id).toBe('rvol');
    expect(explainImportance(rep.importance).more[0]).toContain('heavy trading');
    // the live model gives a winner-like signal a higher chance than a loser-like one
    const hi = Array.from({ length: N_FEATURES }, (_, i) => (i === 0 ? 2 : 0));
    const lo = Array.from({ length: N_FEATURES }, (_, i) => (i === 0 ? -2 : 0));
    expect(predictEnsemble(rep.model, hi)).toBeGreaterThan(predictEnsemble(rep.model, lo) + 0.3);
    // learned on the older days, checked on the newer ones
    expect(rep.trainTo < rep.checkFrom).toBe(true);
  });

  it('pure luck is NOT switched on (the check protects against fooling itself)', () => {
    const { cands, days } = makeCandidates(false, 11);
    const rep = learn(cands, days, cfg, DEFAULT_VARIANT)!;
    expect(rep.passed).toBe(false);
    expect(rep.auc!).toBeLessThan(0.62);
  });

  it('needs enough history', () => {
    const { cands, days } = makeCandidates(true);
    expect(learn(cands.slice(0, 50), days.slice(0, 20), cfg, DEFAULT_VARIANT)).toBeNull();
  });
});

describe('features', () => {
  it('are computed from what was known at the signal, signed for the trade direction', () => {
    const b = { t: [555, 560, 565, 570], o: [100, 101, 101.5, 102], h: [101, 101.8, 102, 103.2], l: [99.8, 100.9, 101.2, 101.9], c: [101, 101.6, 101.9, 103], v: [1000, 800, 700, 2000] };
    const or = { open: 100, high: 102, low: 99.8, vol: 2500, endIdx: 2 };
    const prev = [prevDayOf({ t: [555, 570], o: [97, 98], h: [99, 99.5], l: [96.5, 97.5], c: [98, 99], v: [3000, 3000] })!];
    const long = featureVector(b, 3, 'long', or, prev, 0.004, 2);
    const short = featureVector(b, 3, 'short', or, prev, 0.004, 2);
    expect(long).toHaveLength(N_FEATURES);
    expect(long[0]).toBeCloseTo(Math.log(2), 5);
    expect(long[2]).toBeCloseTo((100 / 99 - 1) * 100, 5); // gap up: good for a buy
    expect(short[2]).toBeCloseTo(-(100 / 99 - 1) * 100, 5); // … bad for a short sale
    expect(long[12]).toBeCloseTo(0.4, 5);
    expect(long[13]).toBe(1);
    expect(short[13]).toBe(0);
    expect(long.every((x) => Number.isFinite(x))).toBe(true);
  });
});
