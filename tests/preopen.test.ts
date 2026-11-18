import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';
import { describe, expect, it } from 'vitest';
import { decodeFeedResponse } from '../src/data/feedProto';
import { mergeFullQuotes, mergeTicks, type Quote } from '../src/data/quotesParse';
import { intradayCharges } from '../src/daytrade/rules';
import type { Bars } from '../src/daytrade/types';
import { istEpoch } from '../src/lib/time';
import {
  DRIVE,
  drivePlan,
  openOutcome,
  PRE,
  preEstimate,
  prePhase,
  readDrive,
  readPreopen,
  recordSummary,
  runOpenTest,
  scoreDrive,
  sectorGaps,
  volumeHistory,
  type DriveIn,
  type PreIn,
  type PreSnap,
} from '../src/early/preopen';
import type { PrevDay } from '../src/ml/features';

/** App v1.16 — the pre-open rising candidates and the opening drive (pure parts). */

const DAY = '2026-11-17';
const at = (hhmm: string, s = 0) => istEpoch(DAY, hhmm, s);

// Upstox's own definition (the fixture matches upstox-nodejs / upstox-python as of 17 Nov 2026)
const root = new protobuf.Root();
root.addJSON((protobuf.common.get('google/protobuf/wrappers.proto') as { nested: Record<string, protobuf.AnyNestedObject> }).nested);
protobuf.parse(readFileSync(fileURLToPath(new URL('./fixtures/MarketDataFeed.proto', import.meta.url)), 'utf8'), root, { keepCase: true });
root.resolveAll();
const FeedResponse = root.lookupType('com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse');
const encode = (obj: object): Uint8Array => FeedResponse.encode(FeedResponse.fromObject(obj)).finish();

describe('feed: the pre-open call auction fields', () => {
  it('reads IEP, matched quantity, a NEGATIVE imbalance, the reference price and LTPC.iep exactly as Upstox encodes them', () => {
    const bytes = encode({
      type: 1,
      feeds: {
        A: { fullFeed: { marketFF: { ltpc: { ltp: 500, ltt: 1, ltq: 0, cp: 500 }, tbq: 120_000, tsq: 40_000, iep: 512.35, rp: 500, ieq: 85_000, iiqTotal: -12_345, iiqM: 3_000, casEligible: true } } },
        B: { ltpc: { ltp: 100, ltt: 2, ltq: 0, cp: 99, iep: { value: 101.25 } } },
        // outside the auction Upstox sends 0: nothing is taken
        C: { fullFeed: { marketFF: { ltpc: { ltp: 50, ltt: 3, ltq: 1, cp: 49 }, iep: 0, ieq: 0, iiqTotal: 0, rp: 0 } } },
      },
    });
    const t = decodeFeedResponse(bytes).ticks;
    expect(t[0]).toMatchObject({ key: 'A', iep: 512.35, rp: 500, ieq: 85_000, iiq: -12_345, iiqM: 3_000, tbq: 120_000, tsq: 40_000 });
    expect(t[1]).toMatchObject({ key: 'B', iep: 101.25 });
    expect(t[2]!.iep).toBeUndefined();
    expect(t[2]!.ieq).toBeUndefined();
    expect(t[2]!.iiq).toBeUndefined();
  });

  it("reads Upstox's pre-open session status from the market-info message", () => {
    const bytes = encode({ type: 2, currentTs: 5, marketInfo: { segmentStatus: { NSE_EQ: 0 }, preOpenSessionStatus: { NSE_EQ: { status: 'PRE_OPEN_M_END', updatedTime: 1794456305123 } } } });
    const d = decodeFeedResponse(bytes);
    expect(d.ticks).toEqual([]);
    expect(d.preOpen).toEqual({ NSE_EQ: { status: 'PRE_OPEN_M_END', at: 1794456305123 } });
  });

  it('stores the auction on the quote; a later tick without it keeps the last reading; nonsense prices are ignored', () => {
    const watched = new Set(['A']);
    let q = mergeTicks({}, [{ key: 'A', ltp: 500, cp: 500, iep: 512.35, ieq: 85_000, iiq: -12_345, iiqM: 3_000, rp: 500, tbq: 1, tsq: 2 }], watched, 1000).quotes;
    expect(q.A!.pre).toEqual({ iep: 512.35, ieq: 85_000, imb: -12_345, imbM: 3_000, rp: 500, at: 1000, src: 'feed' });
    q = mergeTicks(q, [{ key: 'A', ltp: 501, cp: 500 }], watched, 2000).quotes;
    expect(q.A!.pre!.at).toBe(1000);
    q = mergeTicks(q, [{ key: 'A', ltp: 501, cp: 500, iep: 900 }], watched, 3000).quotes;
    expect(q.A!.pre!.iep).toBe(512.35);
  });

  it('Full Market Quotes V3: the documented field names, merged without touching the live price', () => {
    const prev: Record<string, Quote> = { 'NSE_EQ|A': { key: 'NSE_EQ|A', ltp: 500, open: null, high: null, low: null, volume: null, prevClose: 498, fetchedAt: 10 } };
    const data = {
      'NSE_EQ:AAA': { instrument_token: 'NSE_EQ|A', last_price: 499, volume: 0, prev_close_price: 500, total_buy_quantity: 150_000, total_sell_quantity: 50_000, indicative_equilibrium_price: 511.2, reference_price: 500, indicative_equilibrium_quantity: 60_000, indicative_imbalance_quantity_total: 9000, indicative_imbalance_quantity_market: 1000, cas_eligible: true },
      'NSE_EQ:BBB': { instrument_token: 'NSE_EQ|B', last_price: 120, prev_close_price: 119, indicative_equilibrium_price: 0 },
      junk: { last_price: 5 },
    };
    const r = mergeFullQuotes(prev, data, 99);
    expect(r).toMatchObject({ updated: 2, withIep: 1 });
    expect(r.quotes['NSE_EQ|A']).toMatchObject({ ltp: 500, prevClose: 500, buyQty: 150_000, sellQty: 50_000, fetchedAt: 10, pre: { iep: 511.2, ieq: 60_000, imb: 9000, imbM: 1000, rp: 500, at: 99, src: 'quote' } });
    expect(r.quotes['NSE_EQ|B']).toMatchObject({ ltp: 120, prevClose: 119, fetchedAt: 99 });
    expect(r.quotes['NSE_EQ|B']!.pre).toBeUndefined();
  });
});

describe('the pre-open schedule', () => {
  it('9:00 reading, 9:05 ranked, 9:08 entry closed, 9:13 final, 9:15 open', () => {
    expect(prePhase(8 * 60 + 59)).toBe('before');
    expect(prePhase(9 * 60)).toBe('collecting');
    expect(prePhase(9 * 60 + 5)).toBe('ranking');
    expect(prePhase(9 * 60 + 7.9)).toBe('ranking');
    expect(prePhase(9 * 60 + 8)).toBe('discovery');
    expect(prePhase(9 * 60 + 13)).toBe('final');
    expect(prePhase(9 * 60 + 15)).toBe('open');
  });
});

/** readings every 15 s from 9:00 to `until`, the IEP moving from `from` to `to` */
function snaps(until: string, from: number, to: number, ieq0: number, ieq1: number, buy = 70_000, sell = 30_000): PreSnap[] {
  const out: PreSnap[] = [];
  const end = at(until);
  const n = Math.round((end - at('09:00')) / 15_000);
  for (let i = 0; i <= n; i++) {
    const f = n ? i / n : 1;
    const s = at('09:00') + i * 15_000;
    out.push({ at: s, iep: Math.round((from + (to - from) * f) * 100) / 100, ieq: Math.round(ieq0 + (ieq1 - ieq0) * Math.min(1, (s - at('09:00')) / (at('09:08') - at('09:00')))), buy, sell });
  }
  return out;
}

const base = (over: Partial<PreIn> = {}): PreIn => ({
  prevClose: 100,
  snaps: snaps('09:10', 102.9, 103, 20_000, 40_000),
  catalyst: { tone: 'good', kind: 'results' },
  prevVolRatio: 2.2,
  avgDailyVol: 1_000_000,
  sectorGap: 1.6,
  now: at('09:10'),
  ...over,
});

describe('pre-open points (the owner’s weights, set in advance — not a chance)', () => {
  it('a strong candidate: every part counted, 3% gap, buyers 70%, growing matched quantity, results news', () => {
    const r = readPreopen(base())!;
    const pts = Object.fromEntries(r.parts.map((p) => [p.id, Math.round(p.pts * 10) / 10]));
    expect(r.listed).toBe(true);
    expect(r.gapPct).toBeCloseTo(3, 5);
    expect(pts).toEqual({ gap: 25, demand: 20, qty: 15, news: 15, prevVol: 10, sector: 10, stable: 5 });
    expect(r.score).toBe(100);
    expect(r.parts.map((p) => p.max)).toEqual([25, 20, 15, 15, 10, 10, 5]);
    expect(r.ieqTrend).toBe('up');
    expect(r.buyShare).toBeCloseTo(0.7, 5);
    expect(r.parts.find((p) => p.id === 'qty')!.text).toContain('4.0% of a usual day');
  });

  it('under 1% is not listed; bad news is never listed', () => {
    expect(readPreopen(base({ snaps: snaps('09:10', 100.8, 100.9, 1, 1) }))).toMatchObject({ listed: false });
    expect(readPreopen(base({ catalyst: { tone: 'bad', kind: 'legal / trouble' } }))).toMatchObject({ listed: false, why: 'bad news (legal / trouble)' });
  });

  it('missing data counts 0 and says so (never made up)', () => {
    const r = readPreopen(base({ snaps: [{ at: at('09:03'), iep: 102, ieq: null, buy: null, sell: null }], catalyst: null, prevVolRatio: null, avgDailyVol: null, sectorGap: null, now: at('09:03') }))!;
    expect(r.listed).toBe(true);
    const by = Object.fromEntries(r.parts.map((p) => [p.id, p]));
    expect(by.demand!.pts).toBe(0);
    expect(by.demand!.text).toContain('not available');
    expect(by.qty!.text).toContain('not available');
    expect(by.prevVol!.text).toContain('not known');
    expect(by.sector!.text).toContain('too few');
    expect(by.stable!.text).toContain('too early');
    // only the 2 % gap counts (full gap points)
    expect(r.score).toBe(25);
  });

  it('big gaps get fewer points and a warning; sellers outnumbering buyers is flagged', () => {
    const big = readPreopen(base({ snaps: snaps('09:10', 106, 106, 20_000, 40_000) }))!;
    expect(big.parts[0]!.pts).toBe(18);
    expect(big.warnings.join()).toContain('big gaps fade');
    const huge = readPreopen(base({ snaps: snaps('09:10', 110, 110, 20_000, 40_000) }))!;
    expect(huge.parts[0]!.pts).toBe(10);
    const sellers = readPreopen(base({ snaps: snaps('09:10', 103, 103, 20_000, 40_000, 30_000, 70_000) }))!;
    expect(sellers.parts[1]!.pts).toBe(0);
    expect(sellers.warnings).toContain('more sellers than buyers waiting');
  });

  it('listed only with buyers clearly ahead (60%+ of the waiting quantity) and a pre-open price not falling from its high', () => {
    // 18 Nov: DALBHARAT +2.0% with 21% buyers was on the list — now it is not
    const bearish = readPreopen(base({ snaps: snaps('09:10', 102, 102, 20_000, 40_000, 21_000, 79_000) }))!;
    expect(bearish).toMatchObject({ listed: false, out: 'sellers' });
    expect(bearish.why).toContain('21% of the waiting quantity is buying');
    expect(readPreopen(base({ snaps: snaps('09:10', 103, 103, 20_000, 40_000, 60_000, 40_000) }))!.listed).toBe(true);
    expect(readPreopen(base({ snaps: snaps('09:10', 103, 103, 20_000, 40_000, 59_000, 41_000) }))!.out).toBe('sellers');
    // unknown buy / sell quantities: not refused for that (shown as not available)
    expect(readPreopen(base({ snaps: snaps('09:10', 103, 103, 20_000, 40_000).map((x) => ({ ...x, buy: null, sell: null })) }))!.listed).toBe(true);
    // 4 % at 9:02, sliding to 2.6 % by 9:10: out, with the prices in the warning
    const sliding = readPreopen(base({ snaps: snaps('09:10', 104.2, 102.6, 20_000, 40_000) }))!;
    expect(sliding).toMatchObject({ listed: false, out: 'falling' });
    expect(sliding.warnings.some((w) => /pre-open price fell from ₹10\d\.\d\d to ₹102\.60/.test(w))).toBe(true);
    // the first two minutes' jumps do not count (orders are still arriving)
    const early = snaps('09:10', 103, 103, 20_000, 40_000).map((x) => (x.at < at('09:02') ? { ...x, iep: 106 } : x));
    expect(readPreopen(base({ snaps: early }))!.listed).toBe(true);
  });

  it('IEP steadiness: a jumpy or slipping pre-open price loses its 5 points', () => {
    // steady at 104 until two minutes ago, then down to 103
    const falling = snaps('09:10', 104, 104, 20_000, 40_000).map((x, i, all) => (i >= all.length - 8 ? { ...x, iep: Math.round((104 - (i - (all.length - 9)) * 0.125) * 100) / 100 } : x));
    expect(falling[falling.length - 1]!.iep).toBe(103);
    const slip = readPreopen(base({ snaps: falling }))!;
    expect(slip.parts.find((p) => p.id === 'stable')!.pts).toBe(0);
    expect(slip.warnings).toContain('pre-open price slipping from its high');
    const shrinking = readPreopen(base({ snaps: snaps('09:10', 103, 103, 40_000, 20_000) }))!;
    expect(shrinking.ieqTrend).toBe('down');
    expect(shrinking.parts.find((p) => p.id === 'qty')!.pts).toBeCloseTo(10 * ((20_000 / 1e6 - 0.005) / 0.025), 5);
  });

  it('sector gaps come from the OTHER stocks of the sector (2+); volume history from the stored days', () => {
    const g = sectorGaps([
      { key: 'a', sector: 'IT', gapPct: 3 },
      { key: 'b', sector: 'IT', gapPct: 1 },
      { key: 'c', sector: 'IT', gapPct: 2 },
      { key: 'd', sector: 'Bank', gapPct: 5 },
      { key: 'e', sector: 'Bank', gapPct: 1 },
    ]);
    expect(g.get('a')).toBe(1.5);
    expect(g.has('d')).toBe(false);
    const day = (v: number): PrevDay => ({ close: 1, high: 1, low: 1, t: [555], cumV: [v] });
    expect(volumeHistory([day(100), day(100), day(100), day(300)])).toEqual({ prevVolRatio: 3, avgDailyVol: 150 });
    expect(volumeHistory([day(100)])).toEqual({ prevVolRatio: null, avgDailyVol: 100 });
  });

  it('the first estimate keeps ₹50 including every charge and one tick of slippage', () => {
    const e = preEstimate(512.35, 10_000, 50);
    expect(e.entry).toBe(512.35);
    expect(e.stop).toBeLessThan(e.entry * 0.993);
    expect(e.size.ok).toBe(true);
    const exit = e.stop - 0.05;
    expect(e.size.qty * (e.entry - exit) + intradayCharges(e.size.qty * e.entry, e.size.qty * exit)).toBeLessThanOrEqual(50);
    expect(e.size.value).toBeLessThanOrEqual(10_000);
    expect(preEstimate(12_000, 10_000, 50).size.ok).toBe(false);
  });
});

const drive = (over: Partial<DriveIn> = {}): DriveIn => ({ price: 103.4, open: 103, prevClose: 100, high: 103.6, low: 102.9, vwap: 103.2, volume: 90_000, usualVol: 40_000, buyShare: 0.66, secsSinceOpen: 60, ...over });

describe('the opening drive (from 9:15 — no waiting for the 9:20 candle)', () => {
  it('holding: above its open and VWAP, gap kept, 1.5×+ volume pace, buyers ahead', () => {
    const d = readDrive(drive());
    expect(d.state).toBe('holding');
    expect(d.pace).toBeCloseTo(2.25, 5);
    expect(d.gapPct).toBeCloseTo(3, 5);
  });

  it('waiting while something is missing; out for good once it falls below its open or runs too far', () => {
    expect(readDrive(drive({ secsSinceOpen: 10 })).missing).toContain('first seconds of trading');
    expect(readDrive(drive({ volume: 40_000 }))).toMatchObject({ state: 'waiting', missing: ['volume not heavy yet'] });
    expect(readDrive(drive({ buyShare: 0.4 })).missing).toContain('more sellers than buyers waiting');
    expect(readDrive(drive({ price: 102.6 }))).toMatchObject({ state: 'faded', outWhy: 'fell below its opening price' });
    expect(readDrive(drive({ price: 103.1, vwap: 103.6 }))).toMatchObject({ state: 'faded', outWhy: "fell below the day's average price" });
    expect(readDrive(drive({ price: 105.7, high: 105.8 })).state).toBe('ran');
    // unknown usual volume is said, not guessed
    expect(readDrive(drive({ usualVol: null })).why).toContain('usual volume not known — volume not checked');
  });

  it('plan: buy above the high since the open, stop under VWAP / the low (0.3–1.2 %), targets 1R and 2R', () => {
    const p = drivePlan(drive());
    expect(p.breakout).toBe(103.65);
    expect(p.entry).toBe(103.65);
    expect(p.stop).toBe(103.15);
    expect(p.t1).toBe(104.15);
    expect(p.t2).toBe(104.65);
    // a wide range is capped at 1.2 %
    const wide = drivePlan(drive({ vwap: 101, low: 101 }));
    expect(wide.entry - wide.stop).toBeLessThanOrEqual(wide.entry * 0.012 + 0.05);
  });

  it('score: half the pre-open points plus the live signs (points, not a chance)', () => {
    const d = readDrive(drive());
    expect(scoreDrive(d, 80, { goodNews: true, sectorPct: 1, marketPct: 0.2, buyShare: 0.66 }).score).toBe(40 + 15 + 15 + 10 + 5 + 5);
    expect(scoreDrive(d, null, { goodNews: true, sectorPct: null, marketPct: -0.8, buyShare: null })).toMatchObject({ score: 10 + 15 + 15 + 5 + 5 - 10 });
  });
});

/** a day of 5-minute candles from 9:15 */
function day(rows: Array<[number, number, number, number, number]>): Bars {
  return { t: rows.map((_, i) => 555 + i * 5), o: rows.map((r) => r[0]), h: rows.map((r) => r[1]), l: rows.map((r) => r[2]), c: rows.map((r) => r[3]), v: rows.map((r) => r[4]) };
}

describe('what happened after the open (the daily record)', () => {
  it('first 30 minutes: best / worst move from the open, 9:45 price, and whether +1% came before −1%', () => {
    const up = day([
      [100, 100.5, 99.6, 100.4, 1],
      [100.4, 101.2, 100.2, 101, 1],
      [101, 101.3, 98.8, 99, 1],
      [99, 99.5, 98.9, 99.2, 1],
      [99.2, 99.6, 99, 99.5, 1],
      [99.5, 100, 99.4, 99.8, 1],
    ]);
    expect(openOutcome(up)).toEqual({ upPct: expect.closeTo(1.3, 5), downPct: expect.closeTo(-1.2, 5), at945Pct: expect.closeTo(-0.2, 5), upFirst: true });
    const down = day([
      [100, 100.2, 98.9, 99, 1],
      [99, 101.5, 99, 101.2, 1],
      [101, 101, 101, 101, 1],
      [101, 101, 101, 101, 1],
      [101, 101, 101, 101, 1],
      [101, 101, 101, 101, 1],
    ]);
    expect(openOutcome(down)!.upFirst).toBe(false);
    expect(openOutcome(day([[100, 101, 99, 100, 1]]))).toBeNull();
  });

  it('the record summary counts only days with outcomes', () => {
    const s = recordSummary([
      { date: '2026-11-17', rows: [{ out: { upPct: 2, downPct: -0.5, at945Pct: 1, upFirst: true } }, { out: { upPct: 0.4, downPct: -2, at945Pct: -1.5, upFirst: false } }] },
      { date: '2026-11-18', rows: [{ out: null }] },
    ]);
    expect(s).toEqual({ days: 1, stocks: 2, upFirst: 1, avg945: -0.25, since: '2026-11-17' });
    expect(recordSummary(null)).toMatchObject({ stocks: 0, since: null });
  });
});

describe('the past test of the opening rule (stored 5-minute days, nothing tuned)', () => {
  const prev: PrevDay[] = Array.from({ length: 10 }, () => ({ close: 100, high: 101, low: 99, t: Array.from({ length: 75 }, (_, i) => 555 + i * 5), cumV: Array.from({ length: 75 }, (_, i) => (i + 1) * 10_000) }));
  // gapped up 2 %, the first candle held with 3× volume, then ran up
  const held = day([
    [102, 102.6, 101.9, 102.5, 30_000],
    [102.5, 103.5, 102.4, 103.4, 20_000],
    ...Array.from({ length: 10 }, (_, i): [number, number, number, number, number] => [103.4 + i * 0.2, 103.8 + i * 0.2, 103.3 + i * 0.2, 103.6 + i * 0.2, 10_000]),
  ]);
  // gapped up 2 % and faded at once
  const faded = day([
    [102, 102.1, 101, 101.2, 30_000],
    [101.2, 101.3, 100.2, 100.4, 20_000],
    ...Array.from({ length: 10 }, (): [number, number, number, number, number] => [100.4, 100.5, 100, 100.2, 10_000]),
  ]);
  const days = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09'].flatMap((date, i) => [
    { date, bars: held, prevClose: 100, prev },
    { date, bars: i % 2 ? faded : held, prevClose: 100, prev },
    // no gap: not part of this test
    { date, bars: day(Array.from({ length: 12 }, (): [number, number, number, number, number] => [100, 100.2, 99.8, 100, 10_000])), prevClose: 100, prev },
  ]);

  it('buys only gap-ups that held their first candle with heavy volume; "any gap-up" is the comparison', () => {
    const r = runOpenTest(days, 10_000, 50)!;
    expect(r.days).toBe(6);
    expect(r.gapDays).toBe(12);
    expect(r.drive.trades).toBe(9);
    expect(r.anyGap.trades).toBe(12);
    expect(r.drive.pnl).toBeGreaterThan(0);
    expect(r.drive.pnl).toBeGreaterThan(r.anyGap.pnl);
    expect(r.older.trades + r.newer.trades).toBe(r.drive.trades);
    expect(runOpenTest(days.slice(0, 6), 10_000, 50)).toBeNull();
  });

  it('the same thresholds the live check uses', () => {
    expect(DRIVE).toMatchObject({ minOpenGapPct: 1, keepGapPct: 0.5, maxFromOpenPct: 2.5, pace: 1.5 });
    expect(PRE).toMatchObject({ minGapPct: 1, top: 10, finalT: 9 * 60 + 13 });
  });
});
