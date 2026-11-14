import { describe, expect, it } from 'vitest';
import { breadthAdvice, breadthOf } from '../src/advisor/breadth';
import { intradayCharges } from '../src/daytrade/rules';
import { bearishScore, ema, planShort, rsi, runShortTest, simulateShort } from '../src/daytrade/shortScan';
import type { Bars } from '../src/daytrade/types';

/** 5-minute candles from 9:15 built from closes; volume `v` each, the last one `lastVol`. */
function bars(closes: number[], v = 1000, lastVol = v): Bars {
  const b: Bars = { t: [], o: [], h: [], l: [], c: [], v: [] };
  closes.forEach((c, i) => {
    const o = i === 0 ? c : closes[i - 1]!;
    b.t.push(555 + i * 5);
    b.o.push(o);
    b.h.push(Math.max(o, c) + 0.2);
    b.l.push(Math.min(o, c) - 0.2);
    b.c.push(c);
    b.v.push(i === closes.length - 1 ? lastVol : v);
  });
  return b;
}

/** a realistic falling day: down 0.30, up 0.15, heavier volume on the falling candles */
function zigzag(n: number): Bars {
  const closes: number[] = [100];
  for (let i = 1; i < n; i++) closes.push(closes[i - 1]! + (i % 2 ? -0.3 : 0.15));
  const b = bars(closes);
  b.v = closes.map((c, i) => (i > 0 && c < closes[i - 1]! ? 3000 : 1000));
  return b;
}

describe('indicators', () => {
  it('EMA follows the price; RSI is low when prices keep falling', () => {
    const e = ema([10, 10, 10, 20], 3);
    expect(e[3]).toBeCloseTo(15, 5);
    expect(rsi(Array.from({ length: 20 }, (_, i) => 100 - i))!).toBeLessThan(5);
    expect(rsi(Array.from({ length: 20 }, (_, i) => 100 + i))!).toBe(100);
    expect(rsi([1, 2, 3])).toBeNull();
  });
});

describe('falling now: bearish score and plan', () => {
  const falling = bars([100, 100.4, 100.2, 99.8, 99.6, 99.3, 99.1, 98.8, 98.5, 98.0], 1000, 3000);

  it('a stock sliding below its average price with lower highs and heavy selling scores high, with plain reasons', () => {
    const s = bearishScore(falling, falling.t.length - 1, 100.5)!;
    expect(s.score).toBeGreaterThanOrEqual(60);
    const ids = s.reasons.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(['vwap', 'ema', 'lowerHighs', 'volume', 'belowYday']));
    expect(s.reasons.find((r) => r.id === 'volume')!.text).toContain('3.0×');
  });

  it('a rising stock scores low', () => {
    const up = bars([100, 100.3, 100.6, 100.9, 101.2, 101.5, 101.8, 102.1]);
    expect(bearishScore(up, up.t.length - 1, 99)!.score).toBeLessThan(30);
  });

  it('plan: stop above resistance, two targets, quantity for ₹50 risk, results after charges', () => {
    const i = falling.t.length - 1;
    const s = bearishScore(falling, i, 100.5)!;
    const p = planShort(falling, i, 98.0, s.vwap, 50)!;
    expect(p.stop).toBeGreaterThan(p.entry);
    expect(p.t1).toBeLessThan(p.entry);
    expect(p.t2).toBeLessThan(p.t1);
    expect(p.risk).toBeLessThanOrEqual(50);
    expect(p.qty).toBeGreaterThan(0);
    expect((p.stop - p.entry) / p.entry).toBeGreaterThanOrEqual(0.0029);
    expect((p.stop - p.entry) / p.entry).toBeLessThanOrEqual(0.0124); // 1.2% + rounding to 5 paise
    expect(p.charges).toBeGreaterThan(0);
    expect(p.netAtStop).toBeLessThan(-p.risk + 0.01);
    expect(p.netAtTargets).toBeLessThan(p.qty * (p.entry - (p.t1 + p.t2) / 2));
  });

  it('follow-through: half at target 1, rest at target 2; a stop before target 1 loses the planned risk plus charges', () => {
    const b = bars([100, 100, 100, 100, 100]);
    const p = { entry: 100, stop: 101, t1: 99, t2: 98, qty: 50, risk: 50, charges: 0, netAtTargets: 0, netAtStop: 0 };
    const win = { ...b, t: [...b.t, 580, 585], o: [...b.o, 100, 99], h: [...b.h, 100.2, 99.2], l: [...b.l, 98.9, 97.9], c: [...b.c, 99, 98], v: [...b.v, 1000, 1000] };
    const w = simulateShort(win, 4, p, 0);
    expect(w.reason).toBe('t2');
    expect(w.pnl).toBeCloseTo(25 * 1 + 25 * 2 - intradayCharges(25 * 99 + 25 * 98, 5000), 6);
    const lose = { ...b, t: [...b.t, 580], o: [...b.o, 100], h: [...b.h, 101.5], l: [...b.l, 99.8], c: [...b.c, 101.2], v: [...b.v, 1000] };
    const l = simulateShort(lose, 4, p, 0);
    expect(l.reason).toBe('stop');
    expect(l.pnl).toBeCloseTo(-50 - intradayCharges(5050, 5000), 6);
  });

  it('past test: needs 20 days; splits older / newer days', () => {
    const days = Array.from({ length: 30 }, (_, d) => ({ key: 'K', date: `2026-10-${String(d + 1).padStart(2, '0')}`, bars: zigzag(40), prevClose: 100.5 }));
    const rep = runShortTest(days, 50)!;
    expect(rep.days).toBe(30);
    expect(rep.older.trades + rep.newer.trades).toBe(30);
    expect(rep.newer.pnl).toBeGreaterThan(0);
    expect(runShortTest(days.slice(0, 10), 50)).toBeNull();
  });
});

describe('market breadth', () => {
  it('counts up / down / unchanged and explains it', () => {
    const q = { A: { ltp: 101, prevClose: 100 }, B: { ltp: 99, prevClose: 100 }, C: { ltp: 100, prevClose: 100 } };
    expect(breadthOf(q, ['A', 'B', 'C', 'D'])).toEqual({ advanced: 1, declined: 1, unchanged: 1, total: 3 });
    expect(breadthAdvice({ advanced: 159, declined: 337, unchanged: 4, total: 500 })!.tone).toBe('strong-down');
    expect(breadthAdvice({ advanced: 159, declined: 337, unchanged: 4, total: 500 })!.points[0]!.text).toContain('Sell-first');
    expect(breadthAdvice({ advanced: 300, declined: 190, unchanged: 10, total: 500 })!.tone).toBe('up');
    expect(breadthAdvice({ advanced: 5, declined: 5, unchanged: 0, total: 10 })).toBeNull();
  });
});
