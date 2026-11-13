import { describe, expect, it } from 'vitest';
import { practiceCharges, practiceExit, practiceFill, summarisePractice, type LiveDay } from '../src/practice/practice';
import type { Candle } from '../src/indicators/types';
import type { TradePlan } from '../src/storage/schema';
import { istEpoch } from '../src/lib/time';

const plan = { stop: 95, target: 110, openedDate: '2026-11-11', openedAt: istEpoch('2026-11-11', '10:00') };
const bar = (date: string, open: number, high: number, low: number, close: number): Candle => ({ date, open, high, low, close, volume: 1 });
const live = (date: string, hhmm: string, ltp: number, ohl: [number, number, number] | null = null, final = false): LiveDay => ({
  date,
  open: ohl?.[0] ?? null,
  high: ohl?.[1] ?? null,
  low: ohl?.[2] ?? null,
  ltp,
  final,
  at: istEpoch(date, hhmm),
});

describe('practiceExit — same sell rules as the past-year test', () => {
  it('buy day: only the last price after the buy counts (the morning low does not)', () => {
    // the day's low (90) happened before the 10:00 buy; only the last price is used
    expect(practiceExit(plan, [], live('2026-11-11', '11:00', 100, [99, 101, 90]), 20)).toBeNull();
    expect(practiceExit(plan, [], live('2026-11-11', '11:00', 94.5), 20)).toEqual({ price: 95, reason: 'stop', date: '2026-11-11' });
    expect(practiceExit(plan, [], live('2026-11-11', '14:00', 111), 20)).toEqual({ price: 110, reason: 'target', date: '2026-11-11' });
    expect(practiceExit(plan, [], live('2026-11-11', '09:59', 80), 20)).toBeNull(); // a price from before the buy
  });
  it('a later day: the whole day counts; a gap down sells at the opening price', () => {
    expect(practiceExit(plan, [], live('2026-11-12', '10:00', 97, [92, 98, 91]), 20)).toEqual({ price: 92, reason: 'gap', date: '2026-11-12' });
    expect(practiceExit(plan, [], live('2026-11-12', '10:00', 100, [100, 101, 94]), 20)).toEqual({ price: 95, reason: 'stop', date: '2026-11-12' });
    expect(practiceExit(plan, [], live('2026-11-12', '10:00', 109, [104, 112, 103]), 20)).toEqual({ price: 110, reason: 'target', date: '2026-11-12' });
  });
  it('days missed while the computer was off are caught up from the daily history', () => {
    const bars = [bar('2026-11-10', 100, 102, 90, 100), bar('2026-11-11', 100, 101, 99, 100), bar('2026-11-12', 101, 103, 96, 102), bar('2026-11-13', 101, 112, 100, 108)];
    // 10 Nov is before the buy (ignored); 13 Nov reaches the target
    expect(practiceExit(plan, bars, null, 20)).toEqual({ price: 110, reason: 'target', date: '2026-11-13' });
  });
  it('time limit: sold at the close after N sessions, only once that close is final', () => {
    const bars = [bar('2026-11-12', 100, 101, 99, 100), bar('2026-11-13', 100, 101, 99, 100)];
    expect(practiceExit(plan, bars, live('2026-11-16', '12:00', 101, [100, 102, 99]), 3)).toBeNull();
    expect(practiceExit(plan, bars, live('2026-11-16', '16:00', 101.5, [100, 102, 99], true), 3)).toEqual({ price: 101.5, reason: 'time', date: '2026-11-16' });
  });
  it('a stored candle for the live day is used instead of the quote', () => {
    const bars = [bar('2026-11-12', 100, 101, 99, 100)];
    expect(practiceExit(plan, bars, live('2026-11-12', '16:00', 80, [80, 80, 80], true), 20)).toBeNull();
  });
});

describe('practiceFill — an order placed while the market is closed', () => {
  const p = { entry: 100, createdAt: istEpoch('2026-11-10', '21:00') };
  const openAt = istEpoch('2026-11-11', '09:15');
  it('fills at the next opening price', () => {
    expect(practiceFill(p, live('2026-11-11', '09:16', 100.4, [100.5, 100.6, 100.2]), openAt)).toEqual({ fill: 100.5 });
    expect(practiceFill(p, live('2026-11-11', '09:16', 98, [98.2, 98.5, 97.9]), openAt)).toEqual({ fill: 98.2 });
  });
  it('skips when it opens more than 1% above the buy price', () => {
    expect(practiceFill(p, live('2026-11-11', '09:16', 102, [101.5, 102, 101.2]), openAt)).toMatchObject({ skip: expect.stringContaining('more than 1% above') });
  });
  it('waits: no quote from a session that opened after the order, or no opening price yet', () => {
    expect(practiceFill(p, live('2026-11-10', '21:05', 100, [99, 101, 98], true), istEpoch('2026-11-10', '09:15'))).toBeNull();
    expect(practiceFill(p, live('2026-11-11', '09:16', 100), openAt)).toBeNull();
    expect(practiceFill(p, null, openAt)).toBeNull();
  });
});

describe('summarisePractice', () => {
  const mk = (over: Partial<TradePlan>): TradePlan =>
    ({ id: Math.random().toString(), key: 'K', symbol: 'S', status: 'closed', createdAt: 0, updatedAt: 0, entry: 100, stop: 95, target: 110, qty: 10, riskRupees: 50, rewardRupees: 100, rr: 2, setup: null, trend: null, ticket: '', practice: true, ...over }) as TradePlan;
  it('adds up results after charges, per day', () => {
    const plans = [
      mk({ fillPrice: 100, exitPrice: 110, exitCharges: 2.5, exitDate: '2026-11-12' }), // +97.5
      mk({ fillPrice: 100, exitPrice: 95, exitCharges: 2.5, exitDate: '2026-11-12' }), // −52.5
      mk({ fillPrice: 200, exitPrice: 190, exitCharges: 5, exitDate: '2026-11-13' }), // −105
      mk({ key: 'O', status: 'open', fillPrice: 50 }),
      mk({ status: 'planned' }),
      mk({ status: 'cancelled' }),
      mk({ practice: false, fillPrice: 1, exitPrice: 1000 }), // real trade: ignored
    ];
    const s = summarisePractice(plans, (k) => (k === 'O' ? 55 : null), 0.25);
    expect(s.closed).toBe(3);
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(2);
    expect(s.realised).toBeCloseTo(97.5 - 52.5 - 105, 6);
    expect(s.days).toEqual([
      { date: '2026-11-13', pnl: -105, trades: 1 },
      { date: '2026-11-12', pnl: 45, trades: 2 },
    ]);
    expect(s.greenDays).toBe(1);
    expect(s.redDays).toBe(1);
    expect(s.open).toBe(1);
    expect(s.openPnl).toBeCloseTo(50 - practiceCharges(500, 0.25), 6);
    expect(s.waiting).toBe(1);
    expect(s.skipped).toBe(1);
    expect(s.best).toBeCloseTo(97.5);
    expect(s.worst).toBeCloseTo(-105);
  });
});
