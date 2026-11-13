import { describe, expect, it } from 'vitest';
import { classifyTrend, computeSnapshot, isShortlisted } from '../src/indicators/snapshot';
import { DEFAULT_SETTINGS } from '../src/storage/defaults';
import { candlesFrom, linear } from './helpers';

const settings = DEFAULT_SETTINGS.indicators;

describe('classifyTrend', () => {
  it('follows the spec rules', () => {
    expect(classifyTrend(110, 105, 100, true)).toBe('Uptrend');
    expect(classifyTrend(90, 95, 100, false)).toBe('Downtrend');
    expect(classifyTrend(105, 98, 100, true)).toBe('Recovering');
    expect(classifyTrend(105, 104, 100, false)).toBe('Sideways');
    expect(classifyTrend(105, null, 100, true)).toBeNull();
  });
});

describe('computeSnapshot', () => {
  it('steady zig-zag uptrend: Uptrend + Clean uptrend, no flags', () => {
    // +6, −4 alternating: net +1/day, RSI ≈ 60 (a perfectly straight line would have RSI 100 = "Stretched")
    const closes = Array.from({ length: 300 }, (_, i) => 500 + Math.ceil(i / 2) * 6 - Math.floor(i / 2) * 4);
    const s = computeSnapshot(candlesFrom(closes, { volume: 200_000 }), { settings })!;
    expect(s.trend).toBe('Uptrend');
    expect(s.sma200Rising).toBe(true);
    expect(s.rsi14!).toBeGreaterThan(55);
    expect(s.rsi14!).toBeLessThan(65);
    expect(s.setup).toBe('Clean uptrend');
    expect(s.flags).toEqual([]);
    expect(s.sessions).toBe(300);
    expect(isShortlisted(s)).toBe(true);
  });

  it('SMA20 is the mean of the last 20 closes', () => {
    const s = computeSnapshot(candlesFrom(linear(300, 500, 2)), { settings })!;
    expect(s.sma20).toBeCloseTo(1098 - 19, 6);
  });

  it('downtrend: Downtrend + Below 200-day, not shortlisted', () => {
    const s = computeSnapshot(candlesFrom(linear(300, 1100, -2)), { settings })!;
    expect(s.trend).toBe('Downtrend');
    expect(s.flags).toContain('Below 200-day');
    expect(isShortlisted(s)).toBe(false);
  });

  it('breakout: close above the prior 20-day high on 5-day volume ≥ 1.5× the 50-day', () => {
    const closes = [...linear(280, 500, 2), ...Array(19).fill(1058), 1100];
    const vol = (i: number) => (i >= closes.length - 5 ? 600_000 : 200_000);
    const s = computeSnapshot(candlesFrom(closes, { volume: vol, range: 4 }), { settings })!;
    expect(s.volumeRatio!).toBeGreaterThanOrEqual(1.5);
    expect(s.price).toBeGreaterThan(s.high20!);
    expect(s.setup).toBe('Breakout');
  });

  it('flags low liquidity, stretch, a suspected bad adjustment and stale data', () => {
    const c = candlesFrom(linear(300, 50, 0.1), { volume: 10_000 }); // ~₹0.08 cr/day
    const s = computeSnapshot(c, { settings, unadjustedSuspected: true, stale: true })!;
    expect(s.flags).toEqual(expect.arrayContaining(['Low liquidity', 'Possible unadjusted action', 'Stale data']));
    expect(isShortlisted(s)).toBe(false);
    const spike = computeSnapshot(candlesFrom([...linear(299, 500, 1), 900]), { settings })!;
    expect(spike.flags).toContain('Stretched');
  });

  it('with too little history: no trend, "Not enough data"', () => {
    const s = computeSnapshot(candlesFrom(linear(60, 100, 1)), { settings })!;
    expect(s.trend).toBeNull();
    expect(s.sma200).toBeNull();
    expect(s.flags).toContain('Not enough data');
  });

  it('live partial candle moves price-based values but not ATR or the 20-day high', () => {
    const c = candlesFrom(linear(300, 500, 2));
    const base = computeSnapshot(c, { settings })!;
    const live = computeSnapshot([...c, { date: '2099-01-01', open: 1098, high: 1150, low: 1090, close: 1140, volume: 50_000, partial: true }], { settings })!;
    expect(live.live).toBe(true);
    expect(live.price).toBe(1140);
    expect(live.prevClose).toBe(1098);
    expect(live.changePct).toBeCloseTo((1140 / 1098 - 1) * 100, 8);
    expect(live.atr14).toBe(base.atr14);
    // with a live candle, the prior 20-day high is the last 20 COMPLETED sessions (today excluded)
    expect(live.high20).toBe(Math.max(...c.slice(-20).map((x) => x.high)));
    expect(live.high20).toBeLessThan(1150); // today's intraday high is not included
    expect(live.sma20).not.toBe(base.sma20);
  });
});
