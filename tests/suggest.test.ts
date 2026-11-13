import { describe, expect, it } from 'vitest';
import { newTopPicks, suggestBuys, type StockInput } from '../src/advisor/suggest';
import { computeSnapshot } from '../src/indicators/snapshot';
import type { StockData } from '../src/data/stockData';
import { inPriceRange } from '../src/data/universeParse';
import { DEFAULT_SETTINGS } from '../src/storage/defaults';
import type { Settings, TradePlan } from '../src/storage/schema';
import { candlesFrom, linear } from './helpers';

function makeSettings(over: Partial<Settings['risk']> = {}): Settings {
  const s: Settings = structuredClone(DEFAULT_SETTINGS);
  Object.assign(s.risk, { capitalInr: 100_000, riskPerTradePct: 0.5, chargesEstimatePct: 0.25 }, over);
  return s;
}

function stock(symbol: string, closes: number[]): StockInput {
  const candles = candlesFrom(closes, { volume: 2_000_000, range: closes[0]! * 0.012 });
  const snapshot = computeSnapshot(candles, { settings: DEFAULT_SETTINGS.indicators })!;
  const data: StockData = {
    key: `NSE_EQ|${symbol}`,
    instrument: { instrument_key: `NSE_EQ|${symbol}`, trading_symbol: symbol, name: `${symbol} LTD`, isin: `INE${symbol}`, tick: 0.05, lot_size: 1, instrument_type: 'EQ' },
    raw: candles,
    candles,
    events: [],
    suspicious: [],
    quote: null,
    snapshot,
    stale: false,
    corp: null,
    lastCandleDate: candles[candles.length - 1]!.date,
  };
  return { key: data.key, symbol, data };
}

// zig-zag uptrends (+up/−down per day): Good setups with a strong history
const zig = (start: number, up = 6, down = 4) => Array.from({ length: 520 }, (_, i) => start + Math.ceil(i / 2) * up - Math.floor(i / 2) * down);
const down = linear(520, 3000, -2);
const spiky = [...linear(519, 400, 0.4), 700];
const plan = (key: string, status: TradePlan['status'], qty = 10, entry = 100): TradePlan => ({
  id: key, key, symbol: key, status, createdAt: 0, updatedAt: 0, entry, stop: entry * 0.95, target: entry * 1.1, qty, riskRupees: 50, rewardRupees: 100, rr: 2, setup: null, trend: null, ticket: '',
});

describe('suggestBuys — split the whole amount (default)', () => {
  it('invests amount ÷ 3 per stock and explains every skipped stock', () => {
    const r = suggestBuys([stock('AAA', zig(500)), stock('DOWN', down), stock('HOT', spiky)], makeSettings(), [], '2026-11-10');
    expect(r.blockedReason).toBeNull();
    expect(r.freeSlots).toBe(3);
    expect(r.suggestions.map((s) => s.symbol)).toEqual(['AAA']);
    const s = r.suggestions[0]!;
    expect(s.plan.qty).toBe(Math.floor(100_000 / 3 / s.plan.entry));
    expect(s.plan.positionValue).toBeLessThanOrEqual(100_000 / 3);
    expect(s.plan.targetMode).toBe('history');
    expect(s.expectedPct).toBeGreaterThan(0);
    expect(s.expectedRupees).toBeCloseTo((s.expectedPct / 100) * s.plan.positionValue, 6);
    expect(s.maxEarning).toBeGreaterThanOrEqual(s.targetEarning);
    expect(s.plan.riskRupees).toBe(Number((s.plan.qty * s.plan.riskPerShare).toFixed(4)));
    const reasons = Object.fromEntries(r.skipped.map((x) => [x.symbol, x.reason]));
    expect(reasons.DOWN).toMatch(/^Avoid:/);
    expect(reasons.HOT).toMatch(/^Wait:/);
  });

  it('ranks by past average % earning; extra good stocks go to "more"', () => {
    const settings = makeSettings({ splitInto: 2 });
    const r = suggestBuys([stock('SLOW', zig(500, 5.2, 4)), stock('FAST', zig(500, 7, 4)), stock('MID', zig(500, 6, 4))], settings, [], '2026-11-10');
    const all = [...r.suggestions, ...r.more];
    expect(all.length).toBe(3);
    for (let i = 1; i < all.length; i++) expect(all[i - 1]!.expectedPct).toBeGreaterThanOrEqual(all[i]!.expectedPct);
    expect(r.suggestions).toHaveLength(2);
    expect(r.more).toHaveLength(1);
  });

  it('money already in trades reduces what is left; full slots block new buys', () => {
    const full = suggestBuys([stock('AAA', zig(500))], makeSettings(), [plan('A', 'open'), plan('B', 'planned'), plan('C', 'open')], '2026-11-10');
    expect(full.blockedReason).toMatch(/already have 3 trade/);
    expect(full.more.map((s) => s.symbol)).toEqual(['AAA']); // still shown as "next best"
    const one = suggestBuys([stock('AAA', zig(500)), stock('BBB', zig(500))], makeSettings(), [plan('NSE_EQ|AAA', 'open'), plan('X', 'planned')], '2026-11-10');
    expect(one.freeSlots).toBe(1);
    expect(one.suggestions.map((s) => s.symbol)).toEqual(['BBB']);
    expect(one.skipped.find((s) => s.symbol === 'AAA')?.reason).toMatch(/already have a trade/);
  });

  it('price range hides stocks outside it', () => {
    const r = suggestBuys([stock('AAA', zig(500))], makeSettings(), [], '2026-11-10', { priceMin: 0, priceMax: 300 });
    expect(r.outsideRange).toBe(1);
    expect(r.suggestions).toEqual([]);
    expect(r.skipped).toEqual([]);
  });

  it('asks for the amount first', () => {
    expect(suggestBuys([stock('AAA', zig(500))], makeSettings({ capitalInr: null }), [], '2026-11-10').blockedReason).toMatch(/amount you want to invest/);
  });
});

describe('suggestBuys — careful sizing (risk mode)', () => {
  it('each trade loses at most 0.5% of the amount', () => {
    const r = suggestBuys([stock('AAA', zig(500))], makeSettings({ sizing: 'risk' }), [], '2026-11-10');
    expect(r.suggestions[0]!.plan.riskRupees).toBeLessThanOrEqual(500);
  });
  it('never suggests more money than the amount', () => {
    const r = suggestBuys([stock('AAA', zig(500)), stock('BBB', zig(520)), stock('CCC', zig(540))], makeSettings({ sizing: 'risk', capitalInr: 20_000 }), [], '2026-11-10');
    expect(r.suggestions.reduce((a, s) => a + s.plan.positionValue, 0)).toBeLessThanOrEqual(20_000);
  });
});

describe('helpers', () => {
  it('newTopPicks returns only picks not announced yet', () => {
    const r = suggestBuys([stock('AAA', zig(500)), stock('BBB', zig(500))], makeSettings(), [], '2026-11-10');
    expect(newTopPicks(['NSE_EQ|AAA'], r.suggestions).map((p) => p.symbol)).toEqual(['BBB']);
  });
  it('inPriceRange: inclusive, open-ended max, unknown price shown', () => {
    expect(inPriceRange(500, 0, 500)).toBe(true);
    expect(inPriceRange(501, 0, 500)).toBe(false);
    expect(inPriceRange(50_000, 1000, null)).toBe(true);
    expect(inPriceRange(null, 1000, 2000)).toBe(true);
  });
});
