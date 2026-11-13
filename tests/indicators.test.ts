import { describe, expect, it } from 'vitest';
import { atr, atrSeries, ema, emaSeries, rsi, rsiSeries, sma, smaSeries, trueRange } from '../src/indicators/core';
import { clusterLevels, supportResistance, swingHighs, swingLows } from '../src/indicators/levels';
import type { Candle } from '../src/indicators/types';

describe('SMA / EMA', () => {
  it('SMA of the last n values', () => {
    expect(sma([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3)).toBe(9);
    expect(sma([1, 2], 3)).toBeNull();
    expect(smaSeries([1, 2, 3, 4], 2)).toEqual([null, 1.5, 2.5, 3.5]);
  });
  it('EMA seeded with SMA, alpha = 2/(n+1)', () => {
    expect(emaSeries([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
    expect(ema([1, 2], 3)).toBeNull();
  });
});

describe('RSI (Wilder)', () => {
  // StockCharts' textbook example closes
  const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64];
  it('matches an independent reference implementation', () => {
    const got = rsiSeries(closes, 14).slice(14);
    const ref = [70.46, 66.25, 66.48, 69.35, 66.29, 57.92]; // computed separately in Python
    got.forEach((v, i) => expect(v).toBeCloseTo(ref[i]!, 1));
  });
  it('is within 0.15 of the StockCharts published values (they round intermediate averages)', () => {
    const got = rsiSeries(closes, 14).slice(14);
    const published = [70.53, 66.32, 66.55, 69.41, 66.36, 57.97];
    got.forEach((v, i) => expect(Math.abs(v! - published[i]!)).toBeLessThan(0.15));
  });
  it('is 100 when there are no losses, and null without enough data', () => {
    expect(rsi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], 14)).toBe(100);
    expect(rsi([1, 2, 3], 14)).toBeNull();
  });
});

describe('ATR (Wilder)', () => {
  const bar = (h: number, l: number, c: number) => ({ high: h, low: l, close: c });
  it('true range uses the previous close', () => {
    const bars = [bar(10, 9, 9.5), bar(12, 11, 11.5)]; // gap up: |12 − 9.5| = 2.5
    expect(trueRange(bars, 1)).toBe(2.5);
    expect(trueRange([bar(10, 9, 9.5), bar(10, 8, 9)], 1)).toBe(2);
  });
  it('constant range gives a constant ATR', () => {
    const bars = Array.from({ length: 30 }, () => bar(102, 100, 101));
    expect(atr(bars, 14)).toBeCloseTo(2, 10);
  });
  it('Wilder smoothing after the seed', () => {
    const bars = Array.from({ length: 15 }, () => bar(102, 100, 101));
    bars.push(bar(106, 100, 105)); // TR = 6
    const s = atrSeries(bars, 14);
    expect(s[14]).toBeCloseTo(2, 10);
    expect(s[15]).toBeCloseTo((2 * 13 + 6) / 14, 10);
  });
});

describe('swing points and support/resistance', () => {
  const mk = (highs: number[]): Candle[] => highs.map((h, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, open: h - 0.5, high: h, low: h - 1, close: h - 0.5, volume: 1 }));
  const series = mk([1, 2, 3, 4, 3, 2, 1, 2, 3, 2, 1]);
  it('finds swing highs and lows with k bars on each side', () => {
    expect(swingHighs(series, 2).map((p) => p.index)).toEqual([3, 8]);
    expect(swingLows(series, 2).map((p) => p.index)).toEqual([6]);
  });
  it('a flat top counts once', () => {
    expect(swingHighs(mk([1, 2, 5, 5, 2, 1, 0]), 2).map((p) => p.index)).toEqual([2]);
  });
  it('clusters nearby levels', () => {
    const pts = [100, 100.4, 103, 103.2].map((price, i) => ({ index: i, date: `2026-01-0${i + 1}`, price }));
    const lv = clusterLevels(pts, 0.5);
    expect(lv.map((l) => Number(l.price.toFixed(2)))).toEqual([100.2, 103.1]);
    expect(lv.map((l) => l.touches)).toEqual([2, 2]);
  });
  it('returns the nearest supports below and resistances above', () => {
    const { supports, resistances } = supportResistance(series, 2.5, 1, { k: 2, clusterAtr: 0.5 });
    expect(supports.map((l) => l.price)).toEqual([0]); // swing low at index 6 (low = 1 − 1)
    expect(resistances.map((l) => l.price)).toEqual([3, 4]);
  });
});
