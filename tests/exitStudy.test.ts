import { describe, expect, it } from 'vitest';
import { chanceOf, expectancyAt, quantile, studyExits } from '../src/advisor/exitStudy';
import { adviseOpenTrade, trailingStopFor } from '../src/advisor/holdAdvice';
import type { Candle } from '../src/indicators/types';
import { candlesFrom, linear } from './helpers';

describe('quantile', () => {
  it('interpolates linearly', () => {
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(quantile([0, 10], 0.4)).toBe(4);
    expect(quantile([7], 0.75)).toBe(7);
  });
});

describe('studyExits — hand-checkable series', () => {
  // +1 per day, range 1 → every bar spans 2 (ATR = 2); stop = 2×ATR = 4 below entry.
  const up = candlesFrom(linear(500, 1000, 1), { range: 1 }); // 500 days so all 250 sampled days have an SMA200
  it('steady uptrend: never stopped; run-up = 20.5 points = 10.25 ATR in every sample', () => {
    const s = studyExits(up, { trend: 'Uptrend' })!;
    expect(s.similarOnly).toBe(true);
    expect(s.samples).toBe(250);
    expect(s.stoppedPct).toBe(0);
    expect(s.safeAtr).toBeCloseTo(10.25, 9);
    expect(s.holdAtr).toBeCloseTo(10.25, 9);
    expect(chanceOf(s, 10)).toBe(1);
    expect(chanceOf(s, 10.25)).toBe(1); // every sample reached exactly 10.25 ATR
    expect(chanceOf(s, 10.3)).toBe(0);
    expect(s.curve.find((p) => p.atr === 10)!.expectancyR).toBeCloseTo(5, 9); // +10 ATR / 2 ATR stop
    expect(s.best!.expectancyR).toBeGreaterThanOrEqual(5);
  });

  // −1 per day: the low reaches the stop (4 below) on day 4; before that the best high is +0.5.
  const down = candlesFrom(linear(500, 2000, -1), { range: 1 });
  it('steady downtrend: always stopped; run-up only 0.25 ATR', () => {
    const s = studyExits(down, { trend: 'Downtrend' })!;
    expect(s.similarOnly).toBe(false); // no "similar" filter for downtrends
    expect(s.stoppedPct).toBe(1);
    expect(s.safeAtr).toBeCloseTo(0.25, 9);
    expect(s.curve.find((p) => p.atr === 0.5)).toMatchObject({ chance: 0, expectancyR: -1 });
  });

  it('returns null without enough history and ignores a live partial candle', () => {
    expect(studyExits(up.slice(0, 40))).toBeNull();
    const withLive: Candle[] = [...up, { ...up[up.length - 1]!, date: '2099-01-01', close: 1, low: 0, partial: true }];
    expect(studyExits(withLive, { trend: 'Uptrend' })!.safeAtr).toBeCloseTo(10.25, 9);
  });

  it('uses only similar (uptrend) days when today is an uptrend', () => {
    // 300 flat-ish days then 150 rising days: today is an uptrend, but most of the year was not.
    const closes = [...Array.from({ length: 300 }, (_, i) => 1000 + (i % 2 ? 3 : -3)), ...linear(150, 1000, 2)];
    const c = candlesFrom(closes, { range: 2 });
    const similar = studyExits(c, { trend: 'Uptrend' })!;
    const all = studyExits(c, { trend: 'Sideways' })!;
    expect(similar.similarOnly).toBe(true);
    expect(similar.samples).toBeLessThan(all.samples);
    expect(similar.safeAtr).toBeGreaterThan(all.safeAtr);
  });
});

describe('chanceOf', () => {
  it('the safe level (40th percentile) is reached in about 60% of samples', () => {
    const closes = Array.from({ length: 520 }, (_, i) => 1000 + i * 0.8 + 25 * Math.sin(i / 6) + 7 * Math.sin(i * 1.7));
    const s = studyExits(candlesFrom(closes, { range: 6 }), { trend: 'Uptrend' })!;
    expect(chanceOf(s, s.safeAtr)).toBeGreaterThanOrEqual(0.6);
    expect(chanceOf(s, s.safeAtr)).toBeLessThan(0.66);
    expect(chanceOf(s, s.holdAtr)).toBeGreaterThanOrEqual(0.25);
    expect(chanceOf(s, s.holdAtr)).toBeLessThan(0.31);
  });
});

describe('expectancyAt', () => {
  it('matches the coarse curve at grid points and is exact in between', () => {
    const closes = Array.from({ length: 520 }, (_, i) => 1000 + i * 0.8 + 25 * Math.sin(i / 6) + 7 * Math.sin(i * 1.7));
    const s = studyExits(candlesFrom(closes, { range: 6 }), { trend: 'Uptrend' })!;
    const p = s.curve.find((c) => c.atr === 2)!;
    expect(expectancyAt(s, 2)).toBeCloseTo(p.expectancyR, 10);
    expect(Number.isFinite(expectancyAt(s, 2.3))).toBe(true);
  });
  it('steady downtrend: −1R at any target', () => {
    const s = studyExits(candlesFrom(linear(500, 2000, -1), { range: 1 }), {})!;
    expect(expectancyAt(s, 1)).toBe(-1);
  });
});

describe('trailing stop', () => {
  it('keeps the initial stop until +1R; then max(entry, highest close − 2×ATR)', () => {
    expect(trailingStopFor(100, 96, [101, 102], 2)).toBe(96); // not yet +1R (104)
    expect(trailingStopFor(100, 96, [99], 2)).toBe(96);
    expect(trailingStopFor(100, 96, [104.5], 10)).toBe(100); // +1R reached → breakeven
    expect(trailingStopFor(100, 96, [104, 107], 2)).toBe(103); // 107 − 4
  });
});

describe('adviseOpenTrade', () => {
  const day = (close: number, partial = false): Candle => ({ date: '2026-11-10', open: close, high: close, low: close, close, volume: 1, ...(partial ? { partial } : {}) });
  const base = { entry: 100, stop: 96, safeTarget: 107, holdTarget: 112, atr: 2, sma20: 104, rsi: 62, stretch: 1.5, tick: 0.05 };

  it('EXIT at or below the stop', () => {
    expect(adviseOpenTrade({ ...base, sinceEntry: [day(97)], price: 95.9 }).action).toBe('EXIT');
  });
  it('SELL when the last completed close is below the trailing stop', () => {
    const a = adviseOpenTrade({ ...base, sinceEntry: [day(104), day(110), day(105)], price: 105.5 });
    expect(a.trailingStop).toBe(106);
    expect(a.action).toBe('SELL');
  });
  it('an intraday dip below the trailing stop alone does not trigger SELL (closing basis)', () => {
    const a = adviseOpenTrade({ ...base, sinceEntry: [day(104), day(110), day(108), day(105.5, true)], price: 105.5 });
    expect(a.action).not.toBe('SELL');
  });
  it('safe target + healthy trend → HOLD and raise the stop', () => {
    const a = adviseOpenTrade({ ...base, sinceEntry: [day(103), day(106)], price: 108 });
    expect(a.action).toBe('HOLD');
    expect(a.headline).toMatch(/Safe target ₹107.00 reached; trend still healthy — hold toward ₹112.00/);
    expect(a.moveStopTo).toBeGreaterThanOrEqual(100);
  });
  it('safe target + fading momentum → BOOK_PROFIT', () => {
    const a = adviseOpenTrade({ ...base, rsi: 80, sinceEntry: [day(103), day(106)], price: 108 });
    expect(a.action).toBe('BOOK_PROFIT');
    expect(a.reasons[0]).toMatch(/RSI 80/);
  });
  it('hold-until target → BOOK_PROFIT', () => {
    expect(adviseOpenTrade({ ...base, sinceEntry: [day(108), day(111)], price: 112.5 }).action).toBe('BOOK_PROFIT');
  });
  it('REVIEW after the time stop with little progress', () => {
    const flat = Array.from({ length: 16 }, () => day(100.5));
    const a = adviseOpenTrade({ ...base, sinceEntry: flat, price: 100.8 });
    expect(a.action).toBe('REVIEW');
    expect(a.sessionsHeld).toBe(16);
  });
  it('HOLD before +1R keeps the initial stop (no daily stop changes)', () => {
    const a = adviseOpenTrade({ ...base, sinceEntry: [day(101), day(103)], price: 103.5 });
    expect(a.action).toBe('HOLD');
    expect(a.moveStopTo).toBeNull();
    expect(a.trailingStop).toBe(96);
    expect(a.r).toBeCloseTo(0.875, 9);
  });
  it('after +1R: HOLD and suggest raising the GTT stop to the trailing stop', () => {
    const a = adviseOpenTrade({ ...base, sinceEntry: [day(103), day(105)], price: 105.5 });
    expect(a.action).toBe('HOLD');
    expect(a.moveStopTo).toBe(101); // max(100, 105 − 4)
  });
  it('safe target + only overextended → BOOK_PROFIT worded as "overextended", with a stop to protect profit', () => {
    const a = adviseOpenTrade({ ...base, stretch: 3.4, sinceEntry: [day(104), day(108)], price: 109 });
    expect(a.action).toBe('BOOK_PROFIT');
    expect(a.headline).toMatch(/overextended — book profit, or at least raise your stop to ₹104.00/);
  });
});
