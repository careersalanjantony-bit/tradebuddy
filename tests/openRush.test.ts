import { describe, expect, it } from 'vitest';
import { avgGrossR, avgNetR, chooseStyle, EXIT_STYLES, OPEN_RUSH, replayRush, runRushTest, rushPlan, rushTarget, type ExitStyle, type RushGroup, type RushStyleResult } from '../src/bot/openRush';
import { evaluate, priorsFrom } from '../src/bot/evidence';
import { maxPositionFor } from '../src/bot/protect';
import { decide, entryWindow, FIRST_ENTRY_T, type Book, type DecideContext, type Idea } from '../src/bot/policy';
import { newBrain } from '../src/bot/brain';
import type { Bars } from '../src/daytrade/types';
import type { PrevDay } from '../src/ml/features';
import { openDriveEntry, runOpenTest, type OpenTestDay } from '../src/early/preopen';

/**
 * App v1.25 — the Opening rush: the auto-trader buys a stock holding its opening jump as it makes a new
 * high (9:15–9:35), with a close safety net; the way of selling is chosen by the past test.
 */

/** 5-minute candles from 9:15: [open, high, low, close, volume] each. */
function bars(rows: Array<[number, number, number, number, number?]>, from = 9 * 60 + 15): Bars {
  const b: Bars = { t: [], o: [], h: [], l: [], c: [], v: [] };
  rows.forEach(([o, h, l, c, v], i) => {
    b.t.push(from + i * 5);
    b.o.push(o);
    b.h.push(h);
    b.l.push(l);
    b.c.push(c);
    b.v.push(v ?? 10_000);
  });
  return b;
}

/** flat candles at `p` until 3:25 (fills a day after the interesting part) */
const flat = (p: number, n: number): Array<[number, number, number, number]> => Array.from({ length: n }, () => [p, p, p, p]);

describe('Opening rush: the live plan', () => {
  const at = { price: 101, open: 100.2, high: 101, low: 100.1, vwap: 100.6 };

  it('buys only at its high since the open, with a close safety net under the average price', () => {
    const p = rushPlan(at, 'standard')!;
    expect(p).not.toBeNull();
    // the safety net under the day's average price (100.6 − 1 tick), kept 0.3–1.2 % below
    expect(p.stop).toBe(100.55);
    expect(p.target).toBe(rushTarget(101, 100.55, 'standard')); // 2× the risk
    expect(p.target).toBe(101.9);
    const pct = ((101 - p.stop) / 101) * 100;
    expect(pct).toBeGreaterThanOrEqual(0.3);
    expect(pct).toBeLessThanOrEqual(1.25);
  });

  it('never after it fell back from its high, and never after it ran 2.5 % from the open', () => {
    expect(rushPlan({ ...at, price: 100.8 }, 'standard')).toBeNull(); // 0.2 % under its high
    expect(rushPlan({ ...at, price: 100.86 }, 'standard')).not.toBeNull(); // within 0.15 %
    expect(rushPlan({ ...at, open: 98.5, low: 98.4, vwap: 99.5 }, 'standard')).toBeNull(); // +2.5 % from the open
  });

  it('each way of selling has its own target: 1×, 2× or far away (the safety net that follows decides)', () => {
    expect(rushTarget(100, 99, 'quick')).toBe(101);
    expect(rushTarget(100, 99, 'standard')).toBe(102);
    expect(rushTarget(100, 99, 'runner')).toBe(100 + OPEN_RUSH.runnerTargetR);
  });

  it('the entry window: 9:15–9:35 for the Opening rush, 9:30 for the other kinds', () => {
    expect(entryWindow('open-drive', 'breakout')).toEqual({ from: 9 * 60 + 15, to: 9 * 60 + 35 });
    expect(entryWindow('intraday-buy', 'breakout').from).toBe(FIRST_ENTRY_T);
    expect(entryWindow('swing-pick', 'swing').to).toBe(15 * 60 + 15);
  });
});

describe('Opening rush: one trade replayed with the live rules', () => {
  // bought at 100 in the 9:20 candle, safety net 99 (1 R = ₹1 a share)
  it('the safety net: a loss of a bit more than 1 R (one tick of slippage) and the charges', () => {
    const b = bars([[100, 100.2, 99.9, 100.1], [100, 100.3, 99.5, 99.6], [99.6, 99.7, 98.8, 98.9], ...flat(99, 70)]);
    const x = replayRush(b, 1, 100, 99, 102, 100);
    expect(x.grossR).toBeCloseTo(-1.05, 5);
    expect(x.netR).toBeLessThan(x.grossR);
    expect(x.pnl).toBeLessThan(-105);
  });

  it('quick profit: everything at 1 R', () => {
    const b = bars([[100, 100.2, 99.9, 100.1], [100, 100.5, 99.8, 100.4], [100.4, 101.2, 100.3, 101.1], ...flat(101, 70)]);
    expect(replayRush(b, 1, 100, 99, rushTarget(100, 99, 'quick'), 100).grossR).toBeCloseTo(1, 5);
  });

  it('half and half: half at 1 R, the rest at 2 R', () => {
    const b = bars([[100, 100.2, 99.9, 100.1], [100, 100.5, 99.8, 100.4], [100.4, 101.2, 100.3, 101.1], [101.1, 102.3, 101, 102.2], ...flat(102, 70)]);
    expect(replayRush(b, 1, 100, 99, rushTarget(100, 99, 'standard'), 100).grossR).toBeCloseTo(1.5, 5);
  });

  it('let it run: half at 1 R, the rest rides the rise and is sold when the safety net that follows it is hit', () => {
    const up: Array<[number, number, number, number]> = [[100, 100.2, 99.9, 100.1], [100, 100.5, 99.8, 100.4], [100.4, 101.2, 100.3, 101.1], [101.1, 102.3, 101, 102.2], [102.2, 103.6, 102.1, 103.5], [103.5, 104.1, 103.4, 104]];
    const b = bars([...up, [104, 104, 102.5, 102.6], ...flat(102.6, 66)]);
    const run = replayRush(b, 1, 100, 99, rushTarget(100, 99, 'runner'), 100);
    const std = replayRush(b, 1, 100, 99, rushTarget(100, 99, 'standard'), 100);
    expect(std.grossR).toBeCloseTo(1.5, 5);
    // best 104.1: the safety net follows 0.75 R under it → 103.35; the rest sold there, one tick less (+3.3 R)
    expect(run.grossR).toBeCloseTo(0.5 + 0.5 * 3.3, 5);
    expect(run.grossR).toBeGreaterThan(std.grossR);
  });

  it('everything is sold at 3:10 pm', () => {
    const b = bars([[100, 100.2, 99.9, 100.1], [100, 100.5, 99.8, 100.4], ...flat(100.4, 71)]);
    const x = replayRush(b, 1, 100, 99, rushTarget(100, 99, 'runner'), 100, { on: true, lockStartPct: 0.4, giveBack: 0.5, dayLossPct: 1, swingSharePct: 30, quickExitMin: 0 });
    expect(x.grossR).toBeCloseTo(0.4, 5);
  });
});

const g = (trades: number, avgNet: number): RushGroup => ({ trades, wins: Math.round(trades / 2), grossR: trades * (avgNet + 0.2), netR: trades * avgNet, pnl: trades * avgNet * 100 });
const st = (older: number, newer: number, n = 30): RushStyleResult => ({ all: g(n, (older + newer) / 2), older: g(n / 2, older), newer: g(n / 2, newer) });

describe('Opening rush: which way of selling the live trades use', () => {
  it('"half and half" (fixed in advance) unless another did better after charges on both the older and the newer days', () => {
    expect(chooseStyle({ quick: st(0.1, 0.1), standard: st(0.05, 0.05), runner: st(0, 0) }).best).toBe('quick');
    expect(chooseStyle({ quick: st(0.3, -0.1), standard: st(0.05, 0.05), runner: st(0, 0) }).best).toBe('standard'); // better on one half only
    expect(chooseStyle({ quick: st(0.1, 0.1), standard: st(0.05, 0.05), runner: st(0.2, 0.2) }).best).toBe('runner');
    const few = chooseStyle({ quick: st(0.5, 0.5, 10), standard: st(0, 0, 10), runner: st(0, 0, 10) });
    expect(few.best).toBe('standard');
    expect(few.why).toMatch(/fewer than 20 past-test trades/);
  });

  it('plain words with the numbers after charges', () => {
    expect(chooseStyle({ quick: st(0.1, 0.1), standard: st(0.05, 0.05), runner: st(0, 0) }).why).toMatch(/"Quick profit": \+0\.10 R a trade after charges, better than "Half and half" \(\+0\.05 R\)/);
  });
});

/** One stock-day that opens 2 % up, holds its first candle on heavy volume, and breaks above it at 9:20. */
function gapDay(date: string, after: Array<[number, number, number, number]>, key = 'K'): OpenTestDay & { key: string } {
  // earlier days: 1,000 shares in every 5-minute candle (the first candle's 9,000 is heavy volume)
  const prev: PrevDay[] = Array.from({ length: 5 }, () => ({ close: 100, high: 101, low: 99, t: Array.from({ length: 75 }, (_, i) => 555 + i * 5), cumV: Array.from({ length: 75 }, (_, i) => (i + 1) * 1_000) }));
  // 9:20: it breaks above the first candle's high (102.65) by a little — bought there
  const b = bars([[102, 102.6, 101.9, 102.5, 9_000], [102.5, 102.7, 102.4, 102.6], ...after, ...flat(103, 75 - 2 - after.length)]);
  return { key, date, bars: b, prevClose: 100, prev };
}

describe('Opening rush: the past test', () => {
  const win: Array<[number, number, number, number]> = [[102.6, 104.5, 102.5, 104.4], [104.4, 106, 104.3, 105.9]];
  const loss: Array<[number, number, number, number]> = [[102.6, 102.65, 101.5, 101.6]];

  it('the same entries as the Early Movers opening-drive test', () => {
    const d = gapDay('2026-11-02', win);
    const e = openDriveEntry(d)!;
    expect(e).not.toBeNull();
    expect(e.j).toBe(1);
    expect(e.fill).toBe(e.plan.entry);
    const days = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'].map((x) => gapDay(x, win));
    expect(runOpenTest(days, 10_000, 50)!.drive.trades).toBe(5);
  });

  it('every way of selling has the same trades; sized like the auto-trader; older and newer halves', () => {
    const dates = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09'];
    const days = dates.map((x, i) => gapDay(x, i % 3 === 2 ? loss : win));
    const r = runRushTest(days, 100_000, 0.0025)!;
    expect(r).not.toBeNull();
    expect(r.days).toBe(6);
    expect(r.gapDays).toBe(6);
    expect(r.from).toBe('2026-11-02');
    for (const s of EXIT_STYLES) {
      expect(r.styles[s].all.trades).toBe(6);
      expect(r.styles[s].older.trades + r.styles[s].newer.trades).toBe(6);
    }
    expect(r.styles.quick.all.wins).toBe(4);
    // a losing day: about −1 R before charges, worse after
    const lossOnly = runRushTest(dates.map((x) => gapDay(x, loss)), 100_000, 0.0025)!;
    expect(avgGrossR(lossOnly.styles.standard.all)!).toBeLessThan(-1);
    expect(avgNetR(lossOnly.styles.standard.all)!).toBeLessThan(avgGrossR(lossOnly.styles.standard.all)!);
    // the size: 0.25 % of ₹1 lakh at risk, at most a fair share of the money (₹35,000 here)
    const e = openDriveEntry(days[0]!)!;
    const qty = Math.min(Math.floor(250 / (e.fill - e.plan.stop)), Math.floor(maxPositionFor(100_000) / e.fill));
    expect(lossOnly.styles.standard.all.pnl / 6).toBeLessThan(0);
    expect(qty * e.fill).toBeLessThanOrEqual(35_000);
    expect(r.best).toBe(chooseStyle(r.styles).best);
  });

  it('nothing with fewer than 5 market days', () => {
    expect(runRushTest(['2026-11-02', '2026-11-03'].map((x) => gapDay(x, win)), 100_000, 0.0025)).toBeNull();
  });

  it('its result is the kind’s head start: 20+ test trades at a positive estimate make it "trial"', () => {
    const styles = Object.fromEntries(EXIT_STYLES.map((s) => [s, st(0.3, 0.3, 30)])) as Record<ExitStyle, RushStyleResult>;
    const rush = { days: 60, gapDays: 300, from: '2026-08-01', to: '2026-11-20', money: 100_000, riskShare: 0.0025, styles, best: 'standard' as const, bestWhy: '' };
    const priors = priorsFrom({ rushTest: rush }, 0.4);
    expect(priors['open-drive']).toMatchObject({ trades: 30, avgR: 0.5 });
    expect(priors['open-drive']!.label).toMatch(/Opening rush past test \("Half and half"\), 2026-08-01–2026-11-20/);
    expect(evaluate('open-drive', [], priors['open-drive']!).state).toBe('trial');
    expect(evaluate('open-drive', [], null).state).toBe('watch');
  });
});

describe('Opening rush in the decisions: 9:15 for it, 9:30 for the rest, no second try after a loss', () => {
  const ctx = (state?: 'trial'): DecideContext => ({
    evidence: state ? { 'open-drive': { id: 'open-drive', state, n: 0, shadow: 0, wins: 0, avgGrossR: null, avgNetR: null, safeR: 0.4, last20R: null, prior: null, priorCounted: true, why: '' } } : {},
    market: { buys: null, shorts: null },
    charges: (_p, qty, price) => Math.min(40, qty * price * 0.0006) + qty * price * 0.0003,
  });
  const book = (t: number, over: Partial<Book> = {}): Book => ({ equity: 100_000, free: 100_000, openKeys: [], openCount: 0, newToday: 0, todayPnl: 0, t, rules: { on: true, lockStartPct: 0.4, giveBack: 0.5, dayLossPct: 1, swingSharePct: 30, quickExitMin: 45 }, ...over });
  const idea = (playbook: Idea['playbook'], key = 'A'): Idea => ({ key, symbol: key, strategy: 'breakout', playbook, side: 'long', price: 101, stop: 100.55, target: 101.9, ctx: { strategy: 'breakout', prior: 0.5, movePct: 1, pressure: 0.3, breadth: 0.1, t: 556, news: 0, vwapPct: 0.4, riskPct: 0.45 }, reasons: ['test'] });

  it('at 9:16 only the Opening rush is taken; the other kinds wait until 9:30', () => {
    const p = decide(newBrain(), [idea('open-drive', 'A'), idea('intraday-buy', 'B')], book(9 * 60 + 16), ctx('trial'));
    expect(p.decisions.map((d) => d.idea.key)).toEqual(['A']);
    expect(p.decisions[0]!.state).toBe('trial');
    // a close safety net: a big position (a fair share of the money) for ₹250 or less at risk
    const d = p.decisions[0]!;
    expect(d.riskRupees).toBeLessThanOrEqual(250);
    expect(d.qty * 101).toBeGreaterThan(30_000);
    expect(decide(newBrain(), [idea('intraday-buy', 'B')], book(9 * 60 + 16), ctx()).note).toMatch(/other kinds start at 9:30/);
  });

  it('not after 9:35', () => {
    expect(decide(newBrain(), [idea('open-drive')], book(9 * 60 + 36), ctx('trial')).decisions).toHaveLength(0);
  });

  it('no second trade in a stock that already lost money today', () => {
    const p = decide(newBrain(), [idea('open-drive', 'A')], book(9 * 60 + 20, { lostToday: ['A'] }), ctx('trial'));
    expect(p.decisions).toHaveLength(0);
    expect(p.note).toMatch(/already lost money today: no second try today/);
  });
});
