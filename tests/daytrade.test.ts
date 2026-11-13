import { describe, expect, it } from 'vitest';
import { DEFAULT_VARIANT, MIN_SESSIONS, VARIANTS, buildCandidates, evaluate, passes, runDayTest, simulateVariant, type Candidate, type DayStockRef } from '../src/daytrade/backtest';
import { DEFAULT_RULES, dayTradePnl, findBreakout, hhmm, intradayCharges, openingRange, relativeVolume, simulateExit, stopFor, targetFor } from '../src/daytrade/rules';
import type { Bars, DayBars } from '../src/daytrade/types';
import { addDays, isWeekend } from '../src/lib/time';

/** Bars from 09:15 in 5-minute steps: [open, high, low, close, volume] each. */
function bars(rows: Array<[number, number, number, number, number?]>, startT = 555): Bars {
  const b: Bars = { t: [], o: [], h: [], l: [], c: [], v: [] };
  rows.forEach(([o, h, l, c, v], i) => {
    b.t.push(startT + i * 5);
    b.o.push(o);
    b.h.push(h);
    b.l.push(l);
    b.c.push(c);
    b.v.push(v ?? 1000);
  });
  return b;
}
const flat = (n: number, p = 100): Array<[number, number, number, number]> => Array.from({ length: n }, () => [p, p + 0.2, p - 0.2, p]);

describe('opening range and breakout', () => {
  const or3: Array<[number, number, number, number, number]> = [
    [100, 100.6, 99.8, 100.4, 5000],
    [100.4, 100.9, 100.1, 100.3, 4000],
    [100.3, 100.7, 99.9, 100.5, 3000],
  ];
  it('opening range = first 15 minutes', () => {
    expect(openingRange(bars([...or3, [100.5, 101.5, 100.4, 101.4]]))).toEqual({ open: 100, high: 100.9, low: 99.8, vol: 12000, endIdx: 2 });
    expect(openingRange(bars([]))).toBeNull();
  });
  it('BUY: first 5-minute close above the range high (and above the average price)', () => {
    const b = bars([...or3, [100.5, 100.95, 100.4, 100.85], [100.85, 101.3, 100.8, 101.2], [101.2, 101.6, 101.1, 101.5]]);
    const bo = findBreakout(b)!;
    expect(bo.side).toBe('long');
    expect(bo.idx).toBe(4); // bar 3 only touched 100.95 but closed inside
    expect(bo.barCloseT).toBe(555 + 25);
    expect(hhmm(bo.barCloseT)).toBe('09:40');
  });
  it('SELL short: first close below the range low; only the first breakout counts', () => {
    const b = bars([...or3, [100.5, 100.6, 99.5, 99.6], [99.6, 101.5, 99.5, 101.4]]);
    expect(findBreakout(b)!.side).toBe('short');
  });
  it('no signal after 11:30, or when the range is too narrow / too wide', () => {
    const late = bars([...or3, ...flat(24, 100.3), [100.3, 101.5, 100.2, 101.4]]); // bar 27 closes 11:35
    expect(findBreakout(late)).toBeNull();
    const ok = bars([...or3, ...flat(23, 100.3), [100.3, 101.5, 100.2, 101.4]]); // closes 11:30
    expect(findBreakout(ok)?.side).toBe('long');
    const narrow = bars([[100, 100.05, 99.95, 100, 1], [100, 100.05, 99.95, 100, 1], [100, 100.05, 99.95, 100, 1], [100, 100.5, 100, 100.4, 1]]);
    expect(findBreakout(narrow)).toBeNull();
    const wide = bars([[100, 103, 99, 101, 1], [101, 102, 100, 101, 1], [101, 102, 100, 101, 1], [101, 104, 101, 103.5, 1]]);
    expect(findBreakout(wide)).toBeNull();
  });
  it('relative volume needs 10 earlier sessions', () => {
    expect(relativeVolume(3000, [1000, 1000])).toBeNull();
    expect(relativeVolume(3000, Array(10).fill(1500))).toBe(2);
    expect(relativeVolume(3000, [9e9, ...Array(10).fill(1000)])).toBe(3); // only the last 10
  });
});

describe('stop, target and exit', () => {
  it('stop = other side of the range, kept between 0.25% and 1% away', () => {
    expect(stopFor('long', 100, { high: 100, low: 99.5 })).toBe(99.5);
    expect(stopFor('long', 100, { high: 100, low: 97 })).toBe(99); // capped at 1%
    expect(stopFor('long', 100, { high: 100, low: 99.95 })).toBe(99.75); // at least 0.25%
    expect(stopFor('short', 100, { high: 100.6, low: 100 })).toBe(100.6);
    expect(stopFor('short', 100, { high: 103, low: 100 })).toBe(101);
    expect(targetFor('long', 100, 99.5, 1.5)).toBe(100.75);
    expect(targetFor('short', 100, 100.6, 2)).toBe(98.8);
    expect(targetFor('long', 100, 99.5, null)).toBeNull();
  });
  it('same bar touches stop and target → the stop is assumed (cautious)', () => {
    const b = bars([[100, 101.5, 99.4, 100.5]]);
    expect(simulateExit(b, 0, 'long', 99.5, 101)).toMatchObject({ price: 99.5, reason: 'stop' });
  });
  it('a bar that opens beyond the stop sells at that open; target fills at the target', () => {
    const b = bars([[100, 100.4, 99.8, 100.2], [99.2, 99.4, 99, 99.1]]);
    expect(simulateExit(b, 0, 'long', 99.5, 101)).toMatchObject({ price: 99.2, reason: 'stop', idx: 1 });
    const up = bars([[100, 100.4, 99.8, 100.2], [100.2, 101.2, 100.1, 101.1]]);
    expect(simulateExit(up, 0, 'long', 99.5, 101)).toMatchObject({ price: 101, reason: 'target' });
    const short = bars([[100, 100.2, 99.6, 99.8], [99.8, 99.9, 98.7, 98.9]]);
    expect(simulateExit(short, 0, 'short', 100.6, 98.8)).toMatchObject({ price: 98.8, reason: 'target' });
    expect(simulateExit(bars([[100, 100.7, 99.9, 100.5]]), 0, 'short', 100.6, 98.8)).toMatchObject({ price: 100.6, reason: 'stop' });
  });
  it('everything is closed at 15:10', () => {
    const b = bars(flat(75)); // 09:15 … 15:25
    const ex = simulateExit(b, 4, 'long', 99, 105);
    expect(ex.reason).toBe('time');
    expect(hhmm(ex.t)).toBe('15:10');
    expect(ex.price).toBe(100);
  });
  it('Upstox intraday charges (checked 11 Nov 2026): about ₹82 for ₹1 lakh in and out', () => {
    expect(intradayCharges(100_000, 100_000)).toBeCloseTo(40 + 25 + 5.94 + 0.2 + 3 + (40 + 5.94 + 0.2) * 0.18, 2);
    // small trade: 0.1% brokerage instead of ₹20
    expect(intradayCharges(10_000, 10_000)).toBeLessThan(30);
    const long = dayTradePnl('long', 100, 100, 101);
    expect(long.pnl).toBeCloseTo(100 - long.charges, 6);
    const short = dayTradePnl('short', 100, 100, 99);
    expect(short.pnl).toBeCloseTo(100 - short.charges, 6);
    expect(dayTradePnl('short', 100, 100, 101).pnl).toBeLessThan(-100);
  });
});

// ---- synthetic market for the past test
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
function tradingDates(n: number, start = '2026-05-04'): string[] {
  const out: string[] = [];
  let d = start;
  while (out.length < n) {
    if (!isWeekend(d)) out.push(d);
    d = addDays(d, 1);
  }
  return out;
}
/** Each day has a market direction; stocks follow it with their own noise (so breakouts exist). */
function market(nStocks: number, nDays: number, seed = 5): { refs: DayStockRef[]; data: Map<string, DayBars[]> } {
  const r = rng(seed);
  const dates = tradingDates(nDays);
  const dayDrift = dates.map(() => (r() - 0.5) * 0.0012);
  const data = new Map<string, DayBars[]>();
  const refs: DayStockRef[] = [];
  for (let k = 0; k < nStocks; k++) {
    const key = `NSE_EQ|S${k}`;
    refs.push({ key, symbol: `S${k}`, shortAllowed: k % 2 === 0, tick: 0.05 });
    let p = 100 + r() * 900;
    const days: DayBars[] = [];
    dates.forEach((date, di) => {
      const b: DayBars = { key, date, t: [], o: [], h: [], l: [], c: [], v: [] };
      const busy = 0.5 + r() * 2.5;
      const own = (r() - 0.5) * 0.0008;
      for (let i = 0; i < 75; i++) {
        const o = p;
        const c = o * (1 + dayDrift[di]! + own + (r() - 0.5) * 0.0035);
        b.t.push(555 + i * 5);
        b.o.push(o);
        b.h.push(Math.max(o, c) * (1 + r() * 0.001));
        b.l.push(Math.min(o, c) * (1 - r() * 0.001));
        b.c.push(c);
        b.v.push(Math.round((i < 3 ? 40000 * busy : 9000) * (0.6 + r())));
        p = c;
      }
      p *= 1 + (r() - 0.5) * 0.01; // overnight gap
      days.push(b);
    });
    data.set(key, days);
  }
  return { refs, data };
}
const cfg = { amount: 100_000, slots: 3, maxLosses: 2, slippagePct: 0.02, yieldMs: 1e9 };

describe('day-trade past test', () => {
  it('36 settings: 4 targets × 3 volume levels × buy / short / both', () => {
    expect(VARIANTS).toHaveLength(36);
    expect(VARIANTS).toContainEqual(DEFAULT_VARIANT);
  });
  it('the market must agree with the trade', () => {
    const c = { side: 'long' as const, rvol: 1.6, market: 0.002 };
    expect(passes(c, DEFAULT_VARIANT)).toBe(true);
    expect(passes({ ...c, market: -0.001 }, DEFAULT_VARIANT)).toBe(false);
    expect(passes({ ...c, rvol: 1.2 }, DEFAULT_VARIANT)).toBe(false);
    expect(passes(c, { ...DEFAULT_VARIANT, sides: 'short' })).toBe(false);
    expect(passes({ side: 'short', rvol: 2, market: -0.001 }, DEFAULT_VARIANT)).toBe(true);
  });
  it('keeps the books straight: slots, loss limit, no short where not allowed, charges, split', async () => {
    const { refs, data } = market(40, 90);
    const t0 = Date.now();
    const { candidates, dates } = await buildCandidates(refs, async (k) => data.get(k)!, cfg);
    expect(dates).toHaveLength(90);
    expect(candidates.length).toBeGreaterThan(200);
    for (const c of candidates) {
      expect(c.signalT).toBeLessThanOrEqual(DEFAULT_RULES.lastSignalT);
      expect(c.signalT).toBeGreaterThanOrEqual(555 + 20);
      if (c.side === 'short') expect(refs.find((r) => r.key === c.key)!.shortAllowed).toBe(true);
      const risk = Math.abs(c.entry - c.stop) / c.entry;
      expect(risk).toBeLessThan(0.0105);
      expect(risk).toBeGreaterThan(0.002);
      for (const o of Object.values(c.outcomes)) expect(o.t).toBeLessThanOrEqual(DEFAULT_RULES.exitT + 5);
      expect(c.outcomes.eod.reason).not.toBe('target');
    }
    const rep = evaluate(candidates, dates, 40, cfg)!;
    process.stdout.write(`\nDT: 40 stocks × 90 days: ${Date.now() - t0} ms; ${candidates.length} breakouts; chosen ${JSON.stringify(rep.chosen)}; older days ${rep.train.pnl.toFixed(0)} (${rep.train.trades}), fresh days ${rep.check.pnl.toFixed(0)} (${rep.check.trades}); passed ${rep.passed}\n`);
    expect(rep.sessions).toBe(90);
    expect(rep.trainTo < rep.checkFrom).toBe(true);
    expect(rep.train.days + rep.check.days).toBe(90);
    expect(rep.check.days).toBe(30);
    expect(rep.variants).toHaveLength(36);
    // the choice is the best on the OLDER days among settings with enough trades
    const eligible = rep.variants.filter((x) => x.trainTrades >= 20);
    expect(rep.train.pnl).toBeCloseTo(Math.max(...eligible.map((x) => x.trainPnl)), 6);
    expect(rep.passed).toBe(rep.train.pnl > 0 && rep.check.pnl > 0 && rep.check.trades >= 15);

    const byDate = new Map<string, Candidate[]>();
    for (const c of candidates) byDate.set(c.date, [...(byDate.get(c.date) ?? []), c]);
    const sim = simulateVariant(byDate, dates, DEFAULT_VARIANT, cfg);
    const perDay = new Map<string, typeof sim.trades>();
    for (const t of sim.trades) perDay.set(t.date, [...(perDay.get(t.date) ?? []), t]);
    for (const list of perDay.values()) {
      expect(list.length).toBeLessThanOrEqual(3);
      expect(new Set(list.map((t) => t.key)).size).toBe(list.length);
      list.forEach((t, i) => {
        // no new trade once two earlier trades had already lost
        expect(list.slice(0, i).filter((x) => x.exitT <= t.entryT && x.pnl < 0).length).toBeLessThan(2);
        expect(t.qty * t.entry).toBeLessThanOrEqual(100_000 / 3 + 1e-6);
        const gross = t.side === 'long' ? (t.exit - t.entry) * t.qty : (t.entry - t.exit) * t.qty;
        expect(t.pnl).toBeLessThan(gross); // charges always cost something
      });
    }
    expect(sim.result.trades).toBe(sim.trades.length);
    expect(sim.result.wins + sim.result.losses).toBe(sim.result.trades);
    expect(sim.result.long.trades + sim.result.short.trades).toBe(sim.result.trades);
    expect(sim.result.pnl).toBeCloseTo(sim.trades.reduce((a, t) => a + t.pnl, 0), 6);
    expect(sim.result.maxDrawdown).toBeLessThanOrEqual(0);
  }, 60_000);

  it('uses no future data: changing later days does not change earlier trades', async () => {
    const a = market(20, 80, 9);
    const cut = tradingDates(80)[50]!;
    const b = new Map([...a.data].map(([k, days]) => [k, days.map((d) => (d.date > cut ? { ...d, c: d.c.map((x) => x * 1.3), h: d.h.map((x) => x * 1.3), v: d.v.map((x) => x * 5) } : d))]));
    const run = async (data: Map<string, DayBars[]>) => {
      const { candidates, dates } = await buildCandidates(a.refs, async (k) => data.get(k)!, cfg);
      const byDate = new Map<string, Candidate[]>();
      for (const c of candidates) byDate.set(c.date, [...(byDate.get(c.date) ?? []), c]);
      return simulateVariant(byDate, dates, DEFAULT_VARIANT, cfg).trades.filter((t) => t.date <= cut).map((t) => `${t.date} ${t.symbol} ${t.side} ${t.entry.toFixed(2)}→${t.exit.toFixed(2)}`);
    };
    const ta = await run(a.data);
    expect(ta.length).toBeGreaterThan(10);
    expect(await run(b)).toEqual(ta);
  }, 60_000);

  it('needs enough days; fast enough for 100 stocks × 120 days', async () => {
    const small = market(5, MIN_SESSIONS - 5);
    expect(await runDayTest(small.refs, async (k) => small.data.get(k)!, cfg)).toBeNull();
    const big = market(100, 120, 3);
    const t0 = Date.now();
    const rep = (await runDayTest(big.refs, async (k) => big.data.get(k)!, cfg))!;
    const ms = Date.now() - t0;
    process.stdout.write(`\nDT: 100 stocks × 120 days × 75 bars: ${ms} ms, ${rep.candidates} breakouts\n`);
    expect(rep.sessions).toBe(120);
    expect(ms).toBeLessThan(30_000);
  }, 120_000);
});
