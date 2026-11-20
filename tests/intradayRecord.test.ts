import { describe, expect, it } from 'vitest';
import { intradayCharges } from '../src/daytrade/rules';
import { addResult, PROVEN_MIN, sideStats, signalPnl, type SignalResult } from '../src/intraday/record';
import { followStep, type IntradayTracked } from '../src/background/intradayJobs';

/** Review fix (1.20.2): the Intraday alerts' own record; SELL practice-only until proven. */

const res = (over: Partial<SignalResult>): SignalResult => ({ key: 'K', symbol: 'S', side: 'buy', at: 1, entry: 100, exit: 101, outcome: 'target', t1Hit: false, qty: 10, pnl: 5, ...over });

describe('Intraday record', () => {
  it('₹ result after every Intraday charge: BUY, SELL, and SELL with half bought back at target 1', () => {
    expect(signalPnl({ side: 'buy', entry: 100, qty: 10, t1: null }, 102, false)).toBeCloseTo(20 - intradayCharges(1000, 1020), 2);
    expect(signalPnl({ side: 'sell', entry: 100, qty: 10, t1: 99 }, 101, false)).toBeCloseTo(-10 - intradayCharges(1010, 1000), 2);
    // target 1 at 99 for 5 shares, the rest back at the entry 100
    expect(signalPnl({ side: 'sell', entry: 100, qty: 10, t1: 99 }, 100, true)).toBeCloseTo(5 - intradayCharges(995, 1000), 2);
  });

  it('one result per signal, newest 20 days kept', () => {
    let rec = addResult(null, '2026-11-20', res({}));
    rec = addResult(rec, '2026-11-20', res({}));
    expect(rec[0]!.items).toHaveLength(1);
    for (let d = 1; d <= 25; d++) rec = addResult(rec, `2026-10-${String(d).padStart(2, '0')}`, res({ at: d }));
    expect(rec).toHaveLength(20);
    expect(rec.at(-1)!.date).toBe('2026-11-20');
  });

  it(`SELL is "proven" only after ${PROVEN_MIN} results that won more often and made money in total`, () => {
    const day = (n: number, pnl: number) => Array.from({ length: n }, (_, i) => res({ side: 'sell', at: i + pnl * 1000, pnl }));
    expect(sideStats([{ date: 'd', items: day(19, 10) }], 'sell').proven).toBe(false);
    expect(sideStats([{ date: 'd', items: [...day(12, 10), ...day(8, -5)] }], 'sell')).toMatchObject({ finished: 20, wins: 12, losses: 8, pnl: 80, proven: true });
    expect(sideStats([{ date: 'd', items: [...day(12, 3), ...day(8, -10)] }], 'sell').proven).toBe(false);
    expect(sideStats(null, 'buy')).toEqual({ finished: 0, wins: 0, losses: 0, pnl: 0, proven: false });
  });

  it('the follow-up rules that end a signal are unchanged (target / stop-loss)', () => {
    const s: IntradayTracked = { key: 'K', symbol: 'S', side: 'buy', entry: 100, stop: 99, t1: null, target: 102, qty: 10, risk: 20, score: 80, level: 99.5, at: 0, state: 'open' };
    expect(followStep(s, 102.1, null, null, null)?.event).toBe('target');
    expect(followStep(s, 98.9, null, null, null)?.event).toBe('stop');
  });
});

describe('practice order window price boxes (review fix 1.20.2)', () => {
  it('keeps digits and one decimal point; commas (thousands) are dropped', async () => {
    const { decimalText } = await import('../src/ui/components/TradeSheet');
    expect(decimalText('247.05')).toBe('247.05');
    expect(decimalText('247.')).toBe('247.');
    expect(decimalText('2.4.7')).toBe('2.47');
    expect(decimalText('₹ 1,500.50')).toBe('1500.50');
    expect(decimalText('abc')).toBe('');
  });
});
