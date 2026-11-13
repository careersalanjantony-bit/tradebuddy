import { describe, expect, it } from 'vitest';
import { backtestPicks, exitOnBar, type BacktestStock } from '../src/advisor/backtest';
import { cautiousRate, compareSuggestions, pastRecord, type BuySuggestion } from '../src/advisor/suggest';
import type { ExitStudy } from '../src/advisor/exitStudy';
import type { Candle } from '../src/indicators/types';
import { DEFAULT_SETTINGS } from '../src/storage/defaults';
import type { Settings } from '../src/storage/schema';
import { candlesFrom } from './helpers';

/** Deterministic pseudo-random numbers (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random-walk stocks with a mild upward drift and realistic daily ranges. */
function market(n: number, bars: number, seed = 7): BacktestStock[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, k) => {
    const drift = 0.0002 + r() * 0.0012;
    const vol = 0.01 + r() * 0.012;
    let p = 100 + r() * 1500;
    const closes = Array.from({ length: bars }, () => (p *= 1 + drift + vol * (r() + r() + r() - 1.5) * 1.4));
    const candles = candlesFrom(closes, { volume: 3_000_000, start: '2023-11-01' }).map((c) => ({ ...c, high: c.high * (1 + vol * r() * 0.5), low: c.low * (1 - vol * r() * 0.5) }));
    return { key: `NSE_EQ|S${k}`, symbol: `S${k}`, candles, tick: 0.05 };
  });
}

function settings(): Settings {
  const s: Settings = structuredClone(DEFAULT_SETTINGS);
  Object.assign(s.risk, { capitalInr: 100_000, chargesEstimatePct: 0.25, sizing: 'split', splitInto: 3 });
  return s;
}

const bar = (open: number, high: number, low: number, close: number): Candle => ({ date: '2026-01-01', open, high, low, close, volume: 1 });

describe('exitOnBar — how a followed pick ends', () => {
  it('gap below the sell price sells at the open (bigger loss than planned)', () => {
    expect(exitOnBar(bar(90, 92, 88, 91), 95, 110, 3, 20)).toEqual({ price: 90, reason: 'gap' });
  });
  it('sell price touched → sold at the sell price, even if the target was also touched (cautious)', () => {
    expect(exitOnBar(bar(100, 111, 94, 105), 95, 110, 3, 20)).toEqual({ price: 95, reason: 'stop' });
  });
  it('target reached → sold at the target, or at the open after a gap up', () => {
    expect(exitOnBar(bar(104, 111, 101, 108), 95, 110, 3, 20)).toEqual({ price: 110, reason: 'target' });
    expect(exitOnBar(bar(112, 115, 111, 113), 95, 110, 3, 20)).toEqual({ price: 112, reason: 'target' });
  });
  it('neither → held; sold at the close after the horizon', () => {
    expect(exitOnBar(bar(100, 104, 98, 102), 95, 110, 19, 20)).toBeNull();
    expect(exitOnBar(bar(100, 104, 98, 102), 95, 110, 20, 20)).toEqual({ price: 102, reason: 'time' });
  });
});

describe('past record of a pick + safety ranking', () => {
  const study = {
    stopAtr: 2,
    cases: [
      { mfeAtr: 3, stopped: false, endR: 0.5 }, // target (2 ATR) reached → +1R
      { mfeAtr: 2, stopped: true, endR: -1 }, // reached before the stop
      { mfeAtr: 0.5, stopped: true, endR: -1 }, // stopped
      { mfeAtr: 1, stopped: false, endR: 0.2 }, // timed, small profit
      { mfeAtr: 1, stopped: false, endR: 0.01 }, // timed, profit eaten by charges
    ],
  } as unknown as ExitStudy;
  it('counts every similar past case', () => {
    expect(pastRecord(study, 2, 0.05)).toEqual({ samples: 5, reached: 2, stopped: 1, timed: 2, profitable: 3, profitChance: 0.6 });
  });
  it('cautious rate: few cases count for less than many', () => {
    expect(cautiousRate(9, 10)).toBeLessThan(cautiousRate(45, 50));
    expect(cautiousRate(9, 10)).toBeLessThan(0.9);
    expect(cautiousRate(0, 0)).toBe(0);
    expect(cautiousRate(50, 100)).toBeCloseTo(0.437, 2);
  });
  it('safest first vs highest earning first', () => {
    const mk = (symbol: string, safetyScore: number, expectedPct: number, lossPct: number) =>
      ({ symbol, safetyScore, expectedPct, edge: expectedPct, plan: { entry: 100, riskPerShare: lossPct } }) as unknown as BuySuggestion;
    const list = [mk('RISKY', 0.55, 3, 8), mk('STEADY', 0.7, 1, 4), mk('STEADY2', 0.7, 1.5, 3)];
    expect([...list].sort(compareSuggestions('safety', true)).map((x) => x.symbol)).toEqual(['STEADY2', 'STEADY', 'RISKY']);
    expect([...list].sort(compareSuggestions('earning', true)).map((x) => x.symbol)).toEqual(['RISKY', 'STEADY2', 'STEADY']);
  });
});

describe('backtestPicks — replaying the picks over the past year', () => {
  it('follows the rules, keeps the books straight and runs fast enough for 100 stocks', async () => {
    const stocks = market(100, 760);
    const t0 = Date.now();
    const rep = (await backtestPicks(stocks, settings(), 100_000, { yieldMs: 1e9 }))!;
    const ms = Date.now() - t0;
    expect(rep).not.toBeNull();
    expect(rep.sessions).toBe(250);
    expect(rep.slots).toBe(3);
    expect(rep.results.map((r) => r.rankBy)).toEqual(['safety', 'earning']);
    for (const r of rep.results) {
      expect(r.trades.length).toBeGreaterThan(5);
      expect(r.wins + r.losses).toBe(r.closed);
      expect(r.closed + r.stillOpen).toBe(r.trades.length);
      expect(r.totalPnl).toBeCloseTo(r.trades.reduce((a, t) => a + t.pnl, 0), 6);
      expect(r.maxDrawdown).toBeLessThanOrEqual(0);
      for (const t of r.trades) {
        expect(t.buyDate >= rep.from && t.sellDate <= rep.to).toBe(true);
        expect(t.qty * t.buyPrice).toBeLessThanOrEqual(100_000 / 3 + 1e-6);
        expect(t.stop).toBeLessThan(t.buyPrice);
        expect(t.target).toBeGreaterThan(t.buyPrice);
        if (t.reason === 'stop') expect(t.sellPrice).toBe(t.stop);
        if (t.reason === 'gap') expect(t.sellPrice).toBeLessThanOrEqual(t.stop);
        if (t.reason === 'target') expect(t.sellPrice).toBeGreaterThanOrEqual(t.target);
        if (t.reason === 'time') expect(t.sessions).toBe(DEFAULT_SETTINGS.planner.exitHorizonSessions);
        expect(t.sessions).toBeLessThanOrEqual(DEFAULT_SETTINGS.planner.exitHorizonSessions);
      }
      // never more than 3 trades at once
      const events = r.trades.flatMap((t) => [
        { d: t.buyDate, x: 1 },
        { d: t.sellDate, x: -1 },
      ]);
      events.sort((a, b) => (a.d === b.d ? a.x - b.x : a.d < b.d ? -1 : 1));
      let open = 0;
      for (const e of events) {
        open += e.x;
        expect(open).toBeLessThanOrEqual(3);
      }
    }
    expect(rep.holdAllPct).not.toBeNull();
    process.stdout.write(`\nBT: backtest 100 stocks × 250 days: ${ms} ms; safety ${rep.results[0]!.totalPct.toFixed(1)}%, earning ${rep.results[1]!.totalPct.toFixed(1)}%, hold-all ${rep.holdAllPct!.toFixed(1)}%; trades ${rep.results.map((r) => r.trades.length).join("/")}\n`);
    expect(ms).toBeLessThan(60_000);
  }, 120_000);

  it('uses no future data: changing the future does not change earlier buys', async () => {
    const a = market(20, 700, 11);
    const cut = a[0]!.candles[600]!.date;
    const b = a.map((s) => ({ ...s, candles: s.candles.map((c) => (c.date > cut ? { ...c, open: c.open * 0.7, high: c.high * 0.7, low: c.low * 0.7, close: c.close * 0.7 } : c)) }));
    const ra = (await backtestPicks(a, settings(), 100_000, { yieldMs: 1e9 }))!;
    const rb = (await backtestPicks(b, settings(), 100_000, { yieldMs: 1e9 }))!;
    for (let k = 0; k < 2; k++) {
      // trades that were finished by the cut date are identical
      const done = (r: typeof ra) => r.results[k]!.trades.filter((t) => t.sellDate <= cut && t.reason !== 'open').map((t) => `${t.symbol}@${t.buyDate}→${t.sellDate}:${t.sellPrice}`);
      expect(done(rb)).toEqual(done(ra));
      expect(done(ra).length).toBeGreaterThan(0);
    }
  }, 120_000);

  it('needs enough history', async () => {
    expect(await backtestPicks(market(3, 200), settings(), 100_000)).toBeNull();
  });
});
