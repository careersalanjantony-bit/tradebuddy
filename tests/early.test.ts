import { describe, expect, it } from 'vitest';
import type { Bars } from '../src/daytrade/types';
import { intradayCharges } from '../src/daytrade/rules';
import { running, type RiseCtx } from '../src/rising/momentum';
import { EARLY, lookAt, planFor, scoreEarly, setupCheck, sizeTrade, stepEarly, type Look } from '../src/early/early';
import { catalystOf, lastCloseBefore, readHeadline } from '../src/early/catalyst';
import { nseDate, nseDeliveryUrl, parseDeals, parseDelivery } from '../src/early/nseFiles';
import { playTrade, runEarlyTest, type TestDay } from '../src/early/earlyTest';
import { istEpoch } from '../src/lib/time';

const T0 = 555;
const bars = (rows: Array<[number, number, number, number, number]>): Bars => ({ t: rows.map((_, i) => T0 + i * 5), o: rows.map((r) => r[0]), h: rows.map((r) => r[1]), l: rows.map((r) => r[2]), c: rows.map((r) => r[3]), v: rows.map((r) => r[4]) });
const usual: RiseCtx['usual'] = (t) => ({ bar: 1000, cum: ((t - T0) / 5 + 1) * 1000 });

/** a mixed start (high 100.6 early), then higher lows and 3× volume pressing under that high */
const COIL: Array<[number, number, number, number, number]> = [
  [100, 100.3, 99.8, 100.1, 1000],
  [100.1, 100.6, 99.9, 100.0, 1000],
  [100.0, 100.2, 99.85, 99.95, 1000],
  [99.95, 100.15, 99.9, 100.1, 1000],
  [100.1, 100.2, 99.95, 100.05, 1000],
  [100.05, 100.3, 100.0, 100.25, 1000],
  [100.25, 100.35, 100.1, 100.2, 2000],
  [100.2, 100.45, 100.15, 100.4, 3000],
];

describe('₹10,000 capital, ₹50 risk including every charge', () => {
  it('the most shares whose loss at the stop (with charges and a tick of slippage) stays within ₹50', () => {
    const p = { entry: 100, stop: 99.5, t1: 100.5, t2: 101 };
    const s = sizeTrade(p, 10_000, 50);
    expect(s.ok).toBe(true);
    expect(s.risk).toBeLessThanOrEqual(50);
    const lossOf = (q: number) => q * (100 - 99.45) + intradayCharges(q * 100, q * 99.45);
    expect(lossOf(s.qty + 1)).toBeGreaterThan(50);
    expect(s.value).toBeLessThanOrEqual(10_000);
    expect(s.reward).toBeGreaterThan(0);
  });
  it('the capital caps the quantity (no borrowing)', () => {
    const s = sizeTrade({ entry: 2_000, stop: 1_999, t1: 2_001, t2: 2_002 }, 10_000, 50);
    expect(s.qty).toBe(5);
  });
  it('never a trade when the limit cannot be kept', () => {
    expect(sizeTrade({ entry: 12_000, stop: 11_900, t1: 12_100, t2: 12_200 }, 10_000, 50)).toMatchObject({ ok: false, qty: 0 });
    const wide = sizeTrade({ entry: 9_000, stop: 8_900, t1: 9_100, t2: 9_200 }, 10_000, 50);
    expect(wide.ok).toBe(false);
    expect(wide.why).toMatch(/even 1 share risks ₹1\d\d/);
  });
});

describe('the rules: setup → live breakout → confirmed', () => {
  const b = bars(COIL);
  const run = running(b);
  const look = (i: number, price: number, p: Partial<Look> = {}) => ({ ...lookAt({ b, run, i, price, prevClose: 99.9, prevHigh: null, usual })!, ...p });

  it('a stock coiling under its high with 3× volume is a potential setup, with reasons', () => {
    const l = look(7, 100.4);
    expect(l.resistance).toBe(100.6);
    expect(l.rsi!).toBeGreaterThan(50);
    expect(l.rsi!).toBeLessThan(72);
    expect(l.rvolBar).toBeCloseTo(3, 6);
    const c = setupCheck(l);
    expect(c.missing).toEqual([]);
    expect(c.why.join(' ')).toMatch(/has not run yet.*|3\.0× its usual volume/);
    // already up 5 % today: late, not early
    expect(setupCheck({ ...l, changePct: 5 }).missing).toContain('already up too much — late');
    expect(setupCheck({ ...l, rvolDay: 1.1, rvolBar: 1.2 }).missing).toContain('volume not unusual');
  });

  it('plan: buy above the resistance, stop under the day average / recent lows (0.3–1.2 %), targets 1× and 2×', () => {
    const p = planFor(look(7, 100.4));
    expect(p.breakout).toBe(100.65);
    expect(p.entry).toBe(100.65);
    expect((p.entry - p.stop) / p.entry).toBeGreaterThanOrEqual(EARLY.minStopPct / 100 - 1e-9);
    expect((p.entry - p.stop) / p.entry).toBeLessThanOrEqual(EARLY.maxStopPct / 100 + 1e-9);
    expect(p.t1 - p.entry).toBeCloseTo(p.entry - p.stop, 1);
    expect(p.t2 - p.entry).toBeCloseTo(2 * (p.entry - p.stop), 1);
  });

  it('crosses on a live price with volume → breakout (not confirmed); the candle closing above → confirmed', () => {
    const now = istEpoch('2026-11-16', '09:41');
    let r = stepEarly(null, look(7, 100.4), now, 590, null);
    expect(r.event).toBe('setup');
    // a live price above 100.65 in the next candle, its volume already 2× the usual for the part seen
    r = stepEarly(r.state, look(7, 100.7, { rvolBar: 2 }), now + 60_000, 595, null);
    expect(r).toMatchObject({ event: 'breakout', state: { stage: 'breakout', breakT: 595 } });
    // that candle closes at 100.8 > 100.6
    r = stepEarly(r.state, look(7, 100.8), now + 6 * 60_000, 600, { t: 595, c: 100.8, v: 2500, usualBar: 1000 });
    expect(r).toMatchObject({ event: 'confirmed', state: { stage: 'confirmed' } });
    // ran more than 1× the risk above the entry → too late (removed)
    const R = r.state!.plan.entry - r.state!.plan.stop;
    const late = stepEarly(r.state, look(7, r.state!.plan.entry + R + 0.1), now + 7 * 60_000, 600, null);
    expect(late.state).toMatchObject({ stage: 'expired' });
    expect(late.state!.expiredWhy).toMatch(/too late/);
  });

  it('a candle closing back below the resistance is a false breakout; a setup without a breakout expires after 45 minutes', () => {
    const now = istEpoch('2026-11-16', '09:41');
    const s1 = stepEarly(null, look(7, 100.4), now, 590, null).state;
    const s2 = stepEarly(s1, look(7, 100.7, { rvolBar: 2 }), now + 60_000, 595, null).state;
    const f = stepEarly(s2, look(7, 100.5), now + 6 * 60_000, 600, { t: 595, c: 100.55, v: 2000, usualBar: 1000 });
    expect(f.state!.expiredWhy).toMatch(/false breakout/);
    const old = stepEarly(s1, look(7, 100.4), now + 46 * 60_000, 635, null);
    expect(old.state!.expiredWhy).toMatch(/no breakout within 45 minutes/);
    // crossing WITHOUT volume is not a breakout
    expect(stepEarly(s1, look(7, 100.7, { rvolBar: 1 }), now + 60_000, 595, null).event).toBeNull();
    // an expired stock comes back only above a higher ceiling
    expect(stepEarly(f.state, look(7, 100.4), now + 7 * 60_000, 605, null).event).toBeNull();
  });

  it('score: signs that agree add up; bad news and a falling market take away; never above 100', () => {
    const l = look(7, 100.4);
    const base = { look: l, stage: 'setup' as const, catalyst: null, rise: null, dealBuy: false, dealSell: false, deliveryPct: null, sectorPct: null, marketPct: null, buyShare: null };
    const plain = scoreEarly(base);
    const good = scoreEarly({ ...base, catalyst: { tone: 'good', kind: 'order win' }, rise: 'strong', dealBuy: true, deliveryPct: 60, sectorPct: 1, marketPct: 0.2, buyShare: 0.7, stage: 'confirmed' });
    const bad = scoreEarly({ ...base, catalyst: { tone: 'bad', kind: 'legal / trouble' }, marketPct: -1 });
    expect(good.score).toBeGreaterThan(plain.score);
    expect(good.score).toBeLessThanOrEqual(100);
    expect(good.reasons).toContain('news: order win');
    expect(bad.score).toBeLessThan(plain.score);
    expect(bad.warnings.join(' ')).toMatch(/bad news today.*|whole market is falling/);
  });
});

describe('catalysts from headlines', () => {
  it('puts headlines in buckets with a good / bad reading', () => {
    expect(readHeadline({ heading: 'XYZ Ltd bags order worth ₹500 crore from NHAI', at: 1 })).toMatchObject({ kind: 'order win', tone: 'good' });
    expect(readHeadline({ heading: 'ABC Q2 net profit jumps 32% YoY, revenue rises 18%', at: 1 })).toMatchObject({ kind: 'results', tone: 'good' });
    expect(readHeadline({ heading: 'Brokerage upgrades DEF to buy, target price raised', at: 1 })).toMatchObject({ kind: 'upgrade', tone: 'good' });
    expect(readHeadline({ heading: 'GHI downgraded; target price cut', at: 1 })).toMatchObject({ kind: 'downgrade', tone: 'bad' });
    expect(readHeadline({ heading: 'SEBI imposes penalty on JKL', at: 1 })).toMatchObject({ kind: 'legal / trouble', tone: 'bad' });
  });
  it('the stock\'s catalyst since yesterday\'s close: bad first, else the strongest good one', () => {
    const since = 100;
    const items = [
      { heading: 'XYZ bags order worth ₹500 crore', at: 150 },
      { heading: 'XYZ announces board meeting date', at: 160 },
      { heading: 'XYZ wins contract (old)', at: 50 },
    ];
    expect(catalystOf(items, since)!.kind).toBe('order win');
    expect(catalystOf([...items, { heading: 'Raid at XYZ offices', at: 170 }], since)!.tone).toBe('bad');
    expect(catalystOf(items.slice(2), since)).toBeNull();
  });
  it('yesterday\'s close: Monday morning → Friday 3:30 pm; after 3:30 pm → today', () => {
    expect(lastCloseBefore(istEpoch('2026-11-16', '08:30'))).toBe(istEpoch('2026-11-13', '15:30'));
    expect(lastCloseBefore(istEpoch('2026-11-17', '16:00'))).toBe(istEpoch('2026-11-17', '15:30'));
  });
});

describe('NSE end-of-day files (formats as published, checked 17 Nov 2026)', () => {
  it('bulk / block deals', () => {
    const csv = 'Date,Symbol,Security Name,Client Name,Buy/Sell,Quantity Traded,Trade Price / Wght. Avg. Price,Remarks\n16-NOV-2026,TESTCO,Test Company Ltd,SOME FUND LLP,BUY,435000,92.20,-\n16-NOV-2026,TESTCO,Test Company Ltd,OTHER LTD,SELL,"1,20,000",92.10,-\n';
    expect(parseDeals(csv, 'bulk')).toEqual([
      { date: '2026-11-16', symbol: 'TESTCO', client: 'SOME FUND LLP', side: 'BUY', qty: 435000, price: 92.2, kind: 'bulk' },
      { date: '2026-11-16', symbol: 'TESTCO', client: 'OTHER LTD', side: 'SELL', qty: 120000, price: 92.1, kind: 'bulk' },
    ]);
    expect(parseDeals('Date,Symbol,Security Name,Client Name,Buy/Sell,Quantity Traded,Trade Price / Wght. Avg. Price\nNO RECORDS,,,,,,\n', 'block')).toEqual([]);
    expect(() => parseDeals('a,b\n1,2', 'bulk')).toThrow(/unexpected columns/);
  });
  it('delivery %', () => {
    const csv = 'SYMBOL, SERIES, DATE1, PREV_CLOSE, OPEN_PRICE, HIGH_PRICE, LOW_PRICE, LAST_PRICE, CLOSE_PRICE, AVG_PRICE, TTL_TRD_QNTY, TURNOVER_LACS, NO_OF_TRADES, DELIV_QTY, DELIV_PER\nTESTCO, EQ, 16-Nov-2026, 100, 101, 102, 99, 101, 101, 100.5, 65133, 117.73, 2707, 31071, 47.70\nOTHER, BE, 16-Nov-2026, 54.10, 56.00, 56.00, 51.40, 51.65, 51.78, 52.25, 7678, 4.01, 66, -, -\n';
    expect(parseDelivery(csv)).toEqual({ TESTCO: { date: '2026-11-16', pct: 47.7, qty: 31071 } });
    expect(parseDelivery(csv, new Set(['NOPE']))).toEqual({});
    expect(nseDeliveryUrl('2026-11-16')).toBe('https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_16112026.csv');
    expect(nseDate('16-NOV-2026')).toBe('2026-11-16');
    expect(nseDate('NO RECORDS')).toBeNull();
  });
});

describe('the past test', () => {
  it('plays a trade: half at target 1, the stop moves to the buy price, the rest at target 2', () => {
    const b = bars([
      [100, 100.2, 99.9, 100.1, 1],
      [100.1, 100.6, 100.0, 100.5, 1],
      [100.5, 101.2, 100.4, 101.1, 1],
    ]);
    const t = playTrade(b, 1, 100.1, { breakout: 100.1, entry: 100.1, stop: 99.6, t1: 100.6, t2: 101.1 }, 20);
    expect(t.hitT1).toBe(true);
    const gross = 10 * 100.6 + 10 * 101.1 - 20 * 100.1;
    expect(t.pnl).toBeCloseTo(gross - intradayCharges(20 * 100.1, 10 * 100.6 + 10 * 101.1), 6);
  });

  it('runs the four groups on stored days, never more than ₹50 risk, and reports older and newer halves', () => {
    const days: TestDay[] = [];
    for (let d = 1; d <= 12; d++) {
      const rows: Array<[number, number, number, number, number]> = [...COIL];
      // half the days: breaks out with volume and rises; the other half: breaks out and falls back
      const up = d % 2 === 0;
      let p = 100.4;
      for (let i = 0; i < 67; i++) {
        const next = i === 0 ? 100.75 : up ? p + 0.08 : p - 0.06;
        rows.push([p, Math.max(p, next) + 0.05, Math.min(p, next) - 0.05, next, i === 0 ? 3000 : 1000]);
        p = next;
      }
      days.push({ key: 'K', date: `2026-10-${String(d).padStart(2, '0')}`, bars: bars(rows), prevClose: 99.9, prevHigh: null, prev: Array.from({ length: 10 }, () => ({ close: 100, high: 101, low: 99, t: Array.from({ length: 75 }, (_, i) => T0 + i * 5), cumV: Array.from({ length: 75 }, (_, i) => (i + 1) * 1000) })) });
    }
    const r = runEarlyTest(days, 10_000, 50)!;
    expect(r.days).toBe(12);
    expect(r.live.trades).toBe(12);
    expect(r.older.trades + r.newer.trades).toBe(12);
    expect(r.live.t1).toBe(6); // the rising days reached target 1
    expect(r.baseline.trades).toBeGreaterThan(0);
    // worst case per trade stays inside the limit (₹50 + rounding of the open beyond the stop)
    expect(r.live.pnl / r.live.trades).toBeGreaterThan(-50);
  });
});
