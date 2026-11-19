import { describe, expect, it } from 'vitest';
import type { Bars, DayBars } from '../src/daytrade/types';
import { backtestIntraday } from '../src/intraday/backtest';
import { classifyIntraday, INTRADAY, sortIntraday, volumeShare, type IntradayInput } from '../src/intraday/scanner';
import { parseFullQuotes } from '../src/background/intradayJobs';

/**
 * App v1.19 — the Intraday scanner. A stock that opens flat (like URBANCO and SUNTV on 18 Nov) and
 * rallies after the first 15 minutes with heavy volume must become a BUY; one that has already run,
 * trades below VWAP, is stretched or has a stale price must not.
 */

const K = 'NSE_EQ|INE0URBAN01';
const T0 = 9 * 60 + 15;
type Row5 = [number, number, number, number, number];
const bars = (rows: Row5[]): Bars => ({ t: rows.map((_, i) => T0 + 5 * i), o: rows.map((r) => r[0]), h: rows.map((r) => r[1]), l: rows.map((r) => r[2]), c: rows.map((r) => r[3]), v: rows.map((r) => r[4]) });
const day = (date: string, rows: Row5[]): DayBars => ({ key: K, date, ...bars(rows) });

// opens flat at 100 (yesterday 100), first 15 minutes 99.8–100.6, then rallies with heavy volume
const OPENING: Row5[] = [
  [100.1, 100.6, 99.8, 100.4, 80_000],
  [100.4, 100.6, 100.0, 100.3, 60_000],
  [100.3, 100.5, 99.9, 100.2, 50_000],
  [100.2, 101.0, 100.1, 100.9, 120_000], // 9:30 candle closes above 100.6: breakout at 9:35
  [100.9, 101.5, 100.8, 101.4, 110_000],
  [101.4, 101.95, 101.3, 101.9, 100_000],
];
const RALLY: Row5[] = [...OPENING, [101.9, 102.4, 101.85, 102.35, 100_000], [102.35, 103.2, 102.3, 103.1, 90_000], [103.1, 104.3, 103.0, 104.1, 90_000], [104.1, 104.1, 100.0, 100.0, 50_000]];
const FADE: Row5[] = [...OPENING, [101.9, 102.0, 100.5, 100.6, 150_000], [100.6, 100.8, 100.2, 100.4, 80_000]];
const QUIET: Row5[] = Array.from({ length: 20 }, (_, i): Row5 => [100, 100.1, 99.9, i === 19 ? 100 : 100.05, 50_000]);

const t930 = Date.parse('2026-11-19T04:00:00Z'); // 9:30 IST
function input(over: Partial<IntradayInput> & { rows?: Row5[] }): IntradayInput {
  const b = bars(over.rows ?? OPENING);
  const closeT = b.t[b.t.length - 1]! + 5;
  const now = t930 + (closeT - 570) * 60_000;
  const { rows: _r, ...rest } = over;
  return {
    key: K,
    symbol: 'URBANCO',
    tick: 0.05,
    now,
    t: closeT,
    ltp: b.c[b.c.length - 1]!,
    prevClose: 100,
    volume: b.v.reduce((s, x) => s + x, 0),
    vwap: null,
    buyQty: 60_000,
    sellQty: 40_000,
    bars: b,
    avgDailyVol: 1_000_000,
    fetchedAt: now,
    marketWeak: false,
    capital: 20_000,
    maxRisk: 100,
    ...rest,
  };
}

describe('Intraday scanner: the calls', () => {
  it('a flat opener that breaks out with heavy volume is a BUY, with breakout time, plan and 1:2 risk/reward', () => {
    const r = classifyIntraday(input({}))!;
    expect(r.call).toBe('BUY');
    expect(r.breakoutT).toBe(9 * 60 + 35);
    expect(r.changePct).toBeCloseTo(1.9, 5);
    expect(r.rvol!).toBeGreaterThan(3);
    expect(r.plan).toMatchObject({ entry: 101.9, stop: 100.75, target: 104.2, rr: 2 });
    expect(r.size?.ok).toBe(true);
    expect(r.size!.risk).toBeLessThanOrEqual(100);
    expect(r.checks.filter((c) => c.ok).map((c) => c.id)).toEqual(['change', 'volume', 'vwap', 'orb', 'ema', 'candle', 'buyers']);
    expect(r.score).toBe(100);
  });

  it('never chases: already up too much → NO TRADE; stretched above VWAP / EMA → WAIT for a pullback', () => {
    expect(classifyIntraday(input({ ltp: 108 }))).toMatchObject({ call: 'NO TRADE', why: expect.stringContaining('too late to chase') });
    const stretched = classifyIntraday(input({ ltp: 104, vwap: 100.8 }))!;
    expect(stretched.call).toBe('WAIT');
    expect(stretched.why).toMatch(/stretched.*pullback/);
  });

  it('below VWAP → NO TRADE; stale price → NO TRADE; too thin → NO TRADE', () => {
    expect(classifyIntraday(input({ vwap: 102.5 }))?.call).toBe('NO TRADE');
    const x = input({});
    expect(classifyIntraday({ ...x, fetchedAt: x.now - 60_000 })).toMatchObject({ call: 'NO TRADE', why: expect.stringContaining('not fresh') });
    expect(classifyIntraday(input({ volume: 20_000 }))).toMatchObject({ call: 'NO TRADE', why: expect.stringContaining('too thin') });
  });

  it('early movers are WAIT (not yet +1 %, opening range still forming, volume unknown, market falling)', () => {
    expect(classifyIntraday(input({ ltp: 100.95 }))).toMatchObject({ call: 'WAIT', why: expect.stringContaining('early') });
    const early = input({ rows: OPENING.slice(0, 2), ltp: 101.2 });
    expect(classifyIntraday({ ...early, t: 9 * 60 + 25 })).toMatchObject({ call: 'WAIT', why: expect.stringContaining('opening range') });
    expect(classifyIntraday(input({ avgDailyVol: null }))).toMatchObject({ call: 'WAIT', why: expect.stringContaining('usual volume') });
    expect(classifyIntraday(input({ marketWeak: true }))).toMatchObject({ call: 'WAIT', why: expect.stringContaining('market is falling') });
  });

  it('not looked at below +0.6 %; BUY sorts before WAIT before NO TRADE', () => {
    expect(classifyIntraday(input({ ltp: 100.4 }))).toBeNull();
    const rows = [classifyIntraday(input({ ltp: 108 }))!, classifyIntraday(input({ ltp: 100.95 }))!, classifyIntraday(input({}))!];
    expect(sortIntraday(rows).map((r) => r.call)).toEqual(['BUY', 'WAIT', 'NO TRADE']);
  });

  it('the usual-volume curve is front-loaded and reaches the whole day at 3:30', () => {
    expect(volumeShare(9 * 60 + 30)).toBeCloseTo(0.12, 5);
    expect(volumeShare(10 * 60 + 15)).toBeCloseTo(0.25, 5);
    expect(volumeShare(15 * 60 + 30)).toBe(1);
  });
});

describe('Intraday scanner: past test on 5-minute history', () => {
  const days = [
    day('2026-11-10', QUIET),
    day('2026-11-11', QUIET),
    day('2026-11-12', QUIET),
    day('2026-11-13', QUIET),
    day('2026-11-14', QUIET),
    day('2026-11-17', RALLY),
    day('2026-11-18', FADE),
  ];
  const r = backtestIntraday([{ key: K, symbol: 'URBANCO', tick: 0.05, days }], { capital: 20_000, maxRisk: 100, slippagePct: 0.02, now: 1 });

  it('replays the live rules: one BUY per stock-day, at the next candle, exits at target or stop-loss', () => {
    expect(r.trades).toBe(2);
    expect(r.byExit).toEqual({ target: 1, stop: 1, time: 0 });
    expect(r.wins).toBe(1);
    expect(r.winRate).toBe(0.5);
    const [win, loss] = r.sample;
    expect(win).toMatchObject({ date: '2026-11-17', why: 'target', entryT: 9 * 60 + 45 });
    expect(win!.r).toBeGreaterThan(1.9);
    expect(loss).toMatchObject({ date: '2026-11-18', why: 'stop' });
    expect(loss!.pnl).toBeLessThan(0);
    expect(loss!.pnl).toBeGreaterThan(-130); // risk limit ₹100 with charges, plus the stop slippage
    expect(r.days).toBe(2); // the two days with enough history before them
    expect(r.movers).toBe(2);
  });
});

describe('Full Market Quotes for the whole universe', () => {
  it('reads price, previous close, volume, VWAP and the waiting buy / sell quantities', () => {
    const m = parseFullQuotes(
      {
        'NSE_EQ:URBANCO': { instrument_token: K, last_price: 101.9, prev_close_price: 100, volume: 520000, average_price: 100.7, total_buy_quantity: 60000, total_sell_quantity: 40000 },
        'NSE_EQ:BAD': { instrument_token: 'X', last_price: 0 },
      },
      5,
    );
    expect([...m.keys()]).toEqual([K]);
    expect(m.get(K)).toEqual({ ltp: 101.9, prevClose: 100, volume: 520000, vwap: 100.7, buyQty: 60000, sellQty: 40000, at: 5 });
  });

  it('constants: scans 9:15–3:15, no new BUY after 2:45, BUY from +1 %', () => {
    expect([INTRADAY.firstT, INTRADAY.lastT, INTRADAY.buyUntilT, INTRADAY.buyPct]).toEqual([555, 915, 885, 1]);
  });
});
