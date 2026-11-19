import { describe, expect, it } from 'vitest';
import { followStep, type IntradayTracked } from '../src/background/intradayJobs';
import type { Bars } from '../src/daytrade/types';
import { intradayCharges } from '../src/daytrade/rules';
import { classifyIntraday, sortIntraday, type IntradayInput } from '../src/intraday/scanner';
import { classifyShort, marketRising, sizeShort, type ShortInput } from '../src/intraday/short';

/**
 * App v1.20 — the Intraday scanner's SELL side (sell first, buy back later). A Nifty 500 stock that
 * breaks below its opening range on heavy selling, under VWAP, with a falling 5-minute trend, lower
 * highs and lows, weaker than NIFTY, bearish RSI and 1-minute confirmation becomes a SELL; take any one
 * of those away and it does not. The BUY engine is untouched.
 */

const K = 'NSE_EQ|INE0SHORT01';
const T0 = 9 * 60 + 15;
type Row5 = [number, number, number, number, number];
const bars = (rows: Row5[], start = T0, step = 5): Bars => ({ t: rows.map((_, i) => start + step * i), o: rows.map((r) => r[0]), h: rows.map((r) => r[1]), l: rows.map((r) => r[2]), c: rows.map((r) => r[3]), v: rows.map((r) => r[4]) });

// yesterday 500; the first 15 minutes 496–500; the 9:30 candle closes below 496 (breakdown at 9:35), then lower highs and lows
const FALL: Row5[] = [
  [499, 500, 497, 498, 100_000],
  [498, 499, 496.5, 497, 80_000],
  [497, 498, 496, 496.8, 70_000],
  [496.8, 497.5, 495.5, 495.8, 90_000],
  [495.8, 496.6, 494.5, 494.8, 90_000],
  [494.8, 495.6, 493.8, 494.0, 85_000],
  [494.0, 495.0, 493.0, 493.4, 80_000],
  [493.4, 494.4, 492.5, 492.8, 80_000],
  [492.8, 493.8, 492.0, 492.3, 75_000],
  [492.3, 493.2, 491.4, 491.7, 80_000],
  [491.7, 492.6, 490.8, 491.1, 85_000],
  [491.1, 491.9, 490.0, 490.3, 110_000],
];
/** 1-minute candles 9:15–10:14: a choppy decline (up 0.2, down 0.3) — RSI near 40, last ones red, below 496 */
function oneMinute(n = 60, start = 497, up = 0.2, down = -0.3): Bars {
  const rows: Row5[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    const d = i % 2 === 0 ? up : down;
    const c = Math.round((p + d) * 100) / 100;
    rows.push([p, Math.max(p, c) + 0.05, Math.min(p, c) - 0.05, c, 5_000]);
    p = c;
  }
  return bars(rows, T0, 1);
}

const tAt = (min: number) => Date.parse('2026-11-19T03:45:00Z') + (min - T0) * 60_000; // 9:15 IST + …
function input(over: Partial<ShortInput> = {}): ShortInput {
  const b = bars(FALL);
  const t = b.t[b.t.length - 1]! + 5; // 10:15
  const now = tAt(t);
  return {
    key: K,
    symbol: 'SHORTCO',
    tick: 0.05,
    now,
    t,
    ltp: 490.2,
    prevClose: 500,
    volume: b.v.reduce((s, x) => s + x, 0),
    vwap: null,
    buyQty: 30_000,
    sellQty: 70_000,
    bars: b,
    bars1: oneMinute(),
    avgDailyVol: 1_000_000,
    prevLow: 495,
    fetchedAt: now,
    niftyDayPct: -0.2,
    sectorDayPct: -0.4,
    marketStrong: false,
    eligible: true,
    capital: 20_000,
    maxRisk: 100,
    ...over,
  };
}

describe('Intraday SELL engine', () => {
  it('a breakdown with every sign is a SELL: entry, stop above, two targets below, quantity within the risk', () => {
    const r = classifyShort(input())!;
    expect(r).toMatchObject({ call: 'SELL', side: 'sell', breakdownT: 9 * 60 + 35, orLow: 496 });
    expect(r.why).toMatch(/breakdown below the opening-range low ₹496\.00 at 9:35/);
    expect(r.plan).toEqual({ entry: 490.2, stop: 492.65, t1: 487.75, target: 485.3, rr: 2 });
    expect(r.plan!.stop).toBeGreaterThan(r.plan!.entry);
    expect(r.plan!.t1!).toBeLessThan(r.plan!.entry);
    expect(r.plan!.target).toBeLessThan(r.plan!.t1!);
    expect(r.size!.ok).toBe(true);
    expect(r.size!.risk).toBeLessThanOrEqual(100);
    // all required checks passed (never one indicator alone)
    const ok = Object.fromEntries(r.checks.map((c) => [c.id, c.ok]));
    expect(ok).toMatchObject({ vwap: true, ema: true, structure: true, volume: true, relative: true, rsi: true, breakdown: true, confirm: true });
    expect(r.score).toBeGreaterThanOrEqual(85);
    expect(r.rsi).toBeGreaterThan(25);
    expect(r.rsi).toBeLessThanOrEqual(45);
    expect(r.relNifty).toBeCloseTo(-1.76, 1);
  });

  it('any one missing condition keeps it from SELL (WAIT says what is missing)', () => {
    const cases: Array<[Partial<ShortInput>, RegExp]> = [
      [{ avgDailyVol: 20_000_000 }, /selling volume not rising/],
      [{ avgDailyVol: null }, /usual volume not known/],
      [{ bars1: null }, /RSI not known|1-minute candles/], // no 1-minute candles yet: no RSI and no confirmation
      [{ bars1: oneMinute(60, 500) }, /1-minute candles below ₹496\.00/], // the 1-minute candles are back above the broken level
      [{ niftyDayPct: -1.5 }, /not weaker than NIFTY/],
      [{ sectorDayPct: -1.8 }, /not weaker than NIFTY and its sector/],
      [{ niftyDayPct: null }, /NIFTY 50 price not known/],
      [{ marketStrong: true }, /market is rising/],
      [{ bars1: oneMinute(60, 497, 0.05, -0.3) }, /oversold/],
      [{ maxRisk: 2 }, /risks ₹\d+ with charges/],
      [{ t: 14 * 60 + 50 }, /after 2:45 pm/],
    ];
    for (const [over, why] of cases) {
      const r = classifyShort(input(over))!;
      expect(r.call, JSON.stringify(over)).toBe('WAIT');
      expect(r.why).toMatch(why);
      expect(r.why).toMatch(/^sell-first: /);
    }
  });

  it('only a fall below the opening-range low, closed by a 5-minute candle, triggers it', () => {
    // the same day while it is still inside the opening range
    const early = bars(FALL.slice(0, 3));
    const r = classifyShort(input({ bars: early, t: 9 * 60 + 30, now: tAt(570), fetchedAt: tAt(570), ltp: 496.5 }))!;
    expect(r.call).toBe('WAIT');
    expect(r.why).toMatch(/waiting for a break below the opening-range low ₹496\.00/);
    expect(r.plan?.entry).toBe(495.95); // sell only below
    // before 9:30: the opening range is still forming
    const r2 = classifyShort(input({ bars: bars(FALL.slice(0, 2)), t: 9 * 60 + 25, now: tAt(565), fetchedAt: tAt(565), ltp: 497 }))!;
    expect(r2.why).toMatch(/opening range forms until 9:30/);
  });

  it('a failed upward breakout with selling also counts as the trigger', () => {
    // up over the opening-range high (500) at 9:35 to 503, then back below it and under VWAP on red
    // candles — still above the opening-range low (498.80): no breakdown, a failed breakout
    const rows: Row5[] = [
      [499, 500, 498.8, 499.5, 100_000],
      [499.5, 500, 499, 499.6, 80_000],
      [499.6, 499.9, 499.2, 499.5, 70_000],
      [499.5, 502, 499.4, 501.5, 150_000],
      [501.5, 503, 501.2, 502.5, 120_000],
      [502.5, 502.6, 501.3, 501.5, 110_000],
      [501.5, 501.6, 500.3, 500.4, 120_000],
      [500.4, 500.5, 499.7, 499.8, 130_000],
      [499.8, 499.9, 499.2, 499.3, 120_000],
      [499.3, 499.4, 498.95, 499.0, 110_000],
      [499.0, 499.3, 498.85, 498.9, 100_000],
      [498.9, 499.1, 498.8, 498.85, 100_000],
    ];
    const b = bars(rows);
    const t = b.t[b.t.length - 1]! + 5;
    const r = classifyShort(input({ bars: b, t, now: tAt(t), fetchedAt: tAt(t), ltp: 498.85, prevClose: 500, volume: b.v.reduce((s, x) => s + x, 0), niftyDayPct: 1.0, sectorDayPct: null, bars1: oneMinute(60, 501) }))!;
    const failed = r.checks.find((c) => c.id === 'failed')!;
    expect(failed.ok).toBe(true);
    expect(r.checks.find((c) => c.id === 'breakdown')!.ok).toBe(false);
    expect(r.call).toBe('SELL');
    expect(r.why).toMatch(/failed breakout above ₹500\.00/);
  });

  it('never: not shortable, above VWAP, too far down, stale, near the lower band, stretched', () => {
    expect(classifyShort(input({ eligible: false }))).toBeNull(); // outside Nifty 500: brokers' Intraday lists
    expect(classifyShort(input({ ltp: 499.5, vwap: 499 }))).toBeNull(); // −0.1 % and above VWAP: not looked at
    expect(classifyShort(input({ vwap: 488 }))!).toMatchObject({ call: 'NO TRADE', why: expect.stringMatching(/above VWAP/) });
    expect(classifyShort(input({ ltp: 460 }))!).toMatchObject({ call: 'NO TRADE', why: expect.stringMatching(/too late to short/) });
    expect(classifyShort(input({ fetchedAt: tAt(615) - 60_000 }))!).toMatchObject({ call: 'NO TRADE', why: expect.stringMatching(/not fresh/) });
    expect(classifyShort(input({ lowerCircuit: 485 }))!).toMatchObject({ call: 'NO TRADE', why: expect.stringMatching(/lower price band/) });
    expect(classifyShort(input({ t: 15 * 60 + 16 }))!).toMatchObject({ call: 'NO TRADE', why: expect.stringMatching(/after 3:15/) });
    expect(classifyShort(input({ ltp: 481 }))!).toMatchObject({ call: 'WAIT', why: expect.stringMatching(/stretched/) });
  });

  it('sizes a short by the loss if it RISES to the stop, with every charge counted', () => {
    const p = { entry: 490.2, stop: 492.65, t1: 487.75, t2: 485.3 };
    const s = sizeShort(p, 20_000, 100);
    expect(s.ok).toBe(true);
    const loss = (q: number) => q * (p.stop + 0.05 - p.entry) + intradayCharges(q * (p.stop + 0.05), q * p.entry);
    expect(loss(s.qty)).toBeLessThanOrEqual(100);
    expect(loss(s.qty + 1)).toBeGreaterThan(100); // the most shares that fit
    expect(s.reward).toBeGreaterThan(0);
    expect(sizeShort(p, 400, 100)).toMatchObject({ ok: false }); // one share costs more than the capital
  });

  it('the rising-market gate is the mirror of the falling one', () => {
    expect(marketRising({ niftyDayPct: 0.6, niftyFromOpenPct: null, listFromOpenPct: null }).strong).toBe(true);
    expect(marketRising({ niftyDayPct: 0.2, niftyFromOpenPct: 0.35, listFromOpenPct: null }).strong).toBe(true);
    expect(marketRising({ niftyDayPct: -0.3, niftyFromOpenPct: -0.1, listFromOpenPct: 0.1 }).strong).toBe(false);
  });

  it('BUY and SELL sort first; the BUY engine still makes its own call', () => {
    const buyIn: IntradayInput = {
      key: 'NSE_EQ|INE0URBAN01',
      symbol: 'URBANCO',
      tick: 0.05,
      now: tAt(600),
      t: 600,
      ltp: 101.9,
      prevClose: 100,
      volume: 520_000,
      vwap: null,
      buyQty: 60_000,
      sellQty: 40_000,
      bars: bars([
        [100.1, 100.6, 99.8, 100.4, 80_000],
        [100.4, 100.6, 100.0, 100.3, 60_000],
        [100.3, 100.5, 99.9, 100.2, 50_000],
        [100.2, 101.0, 100.1, 100.9, 120_000],
        [100.9, 101.5, 100.8, 101.4, 110_000],
        [101.4, 101.95, 101.3, 101.9, 100_000],
      ]),
      avgDailyVol: 1_000_000,
      fetchedAt: tAt(600),
      marketWeak: false,
      capital: 20_000,
      maxRisk: 100,
    };
    const buy = classifyIntraday(buyIn)!;
    expect(buy.call).toBe('BUY');
    expect(buy.side).toBeUndefined(); // the BUY engine's rows are unchanged
    const sell = classifyShort(input())!;
    const wait = classifyShort(input({ bars1: null }))!;
    const order = sortIntraday([{ ...wait, key: 'w' }, sell, buy]).map((r) => r.call);
    expect(order.slice(0, 2).sort()).toEqual(['BUY', 'SELL']); // both on top, the higher score first
    expect(order[2]).toBe('WAIT');
  });
});

describe('following an announced signal', () => {
  const at = tAt(9 * 60 + 50);
  const buy: IntradayTracked = { key: K, symbol: 'X', side: 'buy', entry: 101.9, stop: 100.75, t1: null, target: 104.2, qty: 17, risk: 99, score: 85, level: 100.6, at, state: 'open' };
  const sell: IntradayTracked = { ...buy, side: 'sell', entry: 490.2, stop: 492.65, t1: 487.75, target: 485.3, level: 496 };

  it('BUY: target, stop-loss, invalidated (a 5-minute close back under the breakout level)', () => {
    expect(followStep(buy, 104.25, null, null, null)).toMatchObject({ event: 'target' });
    expect(followStep(buy, 100.7, null, null, null)).toMatchObject({ event: 'stop' });
    expect(followStep(buy, 101, 100.5, 10 * 60, 101)).toMatchObject({ event: 'invalid' });
    expect(followStep(buy, 101, 100.5, 9 * 60 + 45, 101)).toBeNull(); // that candle closed before the alert
    expect(followStep(buy, 102.5, 102.4, 10 * 60, 101)).toBeNull();
    expect(followStep({ ...buy, state: 'done' }, 110, null, null, null)).toBeNull();
  });

  it('SELL: target 1 (half, stop to entry), then target 2 or back at entry; stop-loss; invalidated', () => {
    expect(followStep(sell, 487.7, null, null, null)).toMatchObject({ event: 't1' });
    const afterT1 = { ...sell, state: 't1' as const };
    expect(followStep(afterT1, 489, null, null, null)).toBeNull();
    expect(followStep(afterT1, 485.3, null, null, null)).toMatchObject({ event: 'target' });
    expect(followStep(afterT1, 490.25, null, null, null)).toMatchObject({ event: 'stop', text: expect.stringMatching(/back to the entry/) });
    expect(followStep(sell, 492.7, null, null, null)).toMatchObject({ event: 'stop' });
    expect(followStep(sell, 491, 496.2, 10 * 60, 494)).toMatchObject({ event: 'invalid' });
    expect(followStep(sell, 489, 489.5, 10 * 60, 494)).toBeNull();
  });
});
