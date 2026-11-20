import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetIntraday, intradayTick, type IntradayState } from '../src/background/intradayJobs';
import { BUNDLED } from '../src/data/indexLists';
import { NIFTY_KEY } from '../src/data/indices';
import { memberKey } from '../src/data/universeParse';
import { __resetDb, getDb } from '../src/storage/db';
import { installChromeMock } from './chromeMock';

/**
 * App v1.20 — the live Intraday scan with both engines against a stand-in Upstox: a rising stock is a
 * BUY (as before), a falling Nifty 500 stock that broke its opening-range low is a SELL (confirmed with
 * its 1-minute candles), a falling small stock outside Nifty 500 is never shorted. One call per stock,
 * the counts add up, each alert goes out once, and the SELL is then followed to its target.
 */

const URBANCO = 'NSE_EQ|INE0URBAN01';
const SMALL = 'NSE_EQ|INE0SMALL01';
const member = BUNDLED.nifty500.find((m) => !BUNDLED.nifty100.some((x) => x.isin === m.isin))!;
const SHORTK = memberKey(member);
// Wednesday 18 Nov 2026, 10:19 IST: the 5-minute candles 9:15 … 10:10 are finished
const NOW = Date.parse('2026-11-18T04:49:00Z');

const c5 = (hhmm: string, o: number, h: number, l: number, c: number, v: number) => [`2026-11-18T${hhmm}:00+05:30`, o, h, l, c, v, 0];
const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const UP = [
  c5('09:15', 100.1, 100.6, 99.8, 100.4, 80_000),
  c5('09:20', 100.4, 100.6, 100.0, 100.3, 60_000),
  c5('09:25', 100.3, 100.5, 99.9, 100.2, 50_000),
  c5('09:30', 100.2, 101.0, 100.1, 100.9, 120_000),
  c5('09:35', 100.9, 101.5, 100.8, 101.4, 110_000),
  c5('09:40', 101.4, 101.95, 101.3, 101.9, 100_000),
  c5('09:45', 101.9, 102.0, 101.7, 101.9, 40_000),
  c5('09:50', 101.9, 102.0, 101.8, 101.9, 30_000),
  c5('09:55', 101.9, 102.0, 101.8, 101.95, 30_000),
  c5('10:00', 101.95, 102.0, 101.85, 101.9, 30_000),
  c5('10:05', 101.9, 102.0, 101.85, 101.95, 30_000),
  c5('10:10', 101.95, 102.05, 101.9, 102.0, 30_000),
];
const FALL = [
  c5('09:15', 499, 500, 497, 498, 100_000),
  c5('09:20', 498, 499, 496.5, 497, 80_000),
  c5('09:25', 497, 498, 496, 496.8, 70_000),
  c5('09:30', 496.8, 497.5, 495.5, 495.8, 90_000),
  c5('09:35', 495.8, 496.6, 494.5, 494.8, 90_000),
  c5('09:40', 494.8, 495.6, 493.8, 494.0, 85_000),
  c5('09:45', 494.0, 495.0, 493.0, 493.4, 80_000),
  c5('09:50', 493.4, 494.4, 492.5, 492.8, 80_000),
  c5('09:55', 492.8, 493.8, 492.0, 492.3, 75_000),
  c5('10:00', 492.3, 493.2, 491.4, 491.7, 80_000),
  c5('10:05', 491.7, 492.6, 490.8, 491.1, 85_000),
  c5('10:10', 491.1, 491.9, 490.0, 490.3, 110_000),
  c5('10:15', 490.3, 490.5, 490.0, 490.2, 20_000), // still forming at 10:19: not used
];
/** 1-minute candles 9:15–10:18: a choppy decline (RSI near 40), the last ones red and below 496 */
const ONE = Array.from({ length: 64 }, (_, i) => {
  const p0 = 497 + Math.floor(i / 2) * -0.1 + (i % 2 === 1 ? 0.2 : 0);
  const p1 = i % 2 === 0 ? p0 + 0.2 : p0 - 0.3;
  return c5(hm(9 * 60 + 15 + i), p0, Math.max(p0, p1) + 0.05, Math.min(p0, p1) - 0.05, Math.round(p1 * 100) / 100, 5_000);
});
const daily = (base: number) =>
  Array.from({ length: 25 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 9, 10 + i));
    return [`${d.toISOString().slice(0, 10)}T00:00:00+05:30`, base, base * 1.01, base * 0.99, base, 1_000_000, 0];
  });

let chrome: ReturnType<typeof installChromeMock>;
const calls: string[] = [];
let fallPrice = 490.2;

beforeEach(async () => {
  chrome = installChromeMock();
  __resetIntraday();
  await __resetDb();
  fallPrice = 490.2;
  await chrome.storage.local.set({ secrets: { upstoxAnalyticsToken: 'test-token' }, settings: undefined });
  // NIFTY 50 slightly down (the stock is much weaker), fresh
  await chrome.storage.session.set({ quotes: { [NIFTY_KEY]: { key: NIFTY_KEY, ltp: 24_950, open: 24_980, high: 25_010, low: 24_930, volume: null, prevClose: 25_000, fetchedAt: NOW } } });
  const db = await getDb();
  await db.put('instruments', { instrument_key: URBANCO, trading_symbol: 'URBANCO', name: 'Urban Company', isin: 'INE0URBAN01', tick: 0.05, lot_size: 1, instrument_type: 'EQ' });
  await db.put('instruments', { instrument_key: SHORTK, trading_symbol: member.symbol, name: member.name, isin: member.isin, tick: 0.05, lot_size: 1, instrument_type: 'EQ' });
  await db.put('instruments', { instrument_key: SMALL, trading_symbol: 'SMALLCO', name: 'Small', isin: 'INE0SMALL01', tick: 0.05, lot_size: 1, instrument_type: 'EQ' });
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = decodeURIComponent(String(url));
      calls.push(u);
      const ok = (data: unknown) => new Response(JSON.stringify({ status: 'success', data }), { status: 200 });
      if (u.includes('/v3/market-quote/quotes'))
        return ok({
          'NSE_EQ:URBANCO': { instrument_token: URBANCO, last_price: 102.0, prev_close_price: 100, volume: 620_000, average_price: 101.2, total_buy_quantity: 60_000, total_sell_quantity: 40_000 },
          [`NSE_EQ:${member.symbol}`]: { instrument_token: SHORTK, last_price: fallPrice, prev_close_price: 500, volume: 1_025_000, average_price: 494.37, total_buy_quantity: 30_000, total_sell_quantity: 70_000 },
          'NSE_EQ:SMALLCO': { instrument_token: SMALL, last_price: 49, prev_close_price: 50, volume: 2_000_000, average_price: 49.6, total_buy_quantity: 1, total_sell_quantity: 3 },
        });
      if (u.includes('/historical-candle/intraday/')) {
        const one = u.includes('/minutes/1');
        if (u.includes(SHORTK)) return ok({ candles: [...(one ? ONE : FALL)].reverse() });
        if (u.includes(URBANCO)) return ok({ candles: one ? [] : [...UP].reverse() });
        return ok({ candles: [] });
      }
      if (u.includes('/historical-candle/')) return ok({ candles: daily(u.includes(SHORTK) ? 500 : u.includes(SMALL) ? 50 : 100) });
      return new Response('{}', { status: 404 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const state = async () => (await chrome.storage.session.get('intraday')).intraday as IntradayState;
const created = () => chrome.notifications.create.mock.calls.map((c) => ({ id: String(c[0]), title: String(c[1].title) }));

describe('Intraday scanner with BUY and SELL, live', () => {
  it('BUY for the riser, SELL for the falling Nifty 500 stock, nothing for the small faller; counts add up', async () => {
    await intradayTick(NOW, true);
    await intradayTick(NOW + 15_000, true);
    const st = await state();
    const by = Object.fromEntries(st.rows.map((r) => [r.symbol, r]));
    expect(by.URBANCO?.call).toBe('BUY');
    expect(by[member.symbol]).toMatchObject({ call: 'SELL', side: 'sell', plan: { entry: 490.2, stop: 492.65, t1: 487.75, target: 485.3 } });
    expect(by.SMALLCO).toBeUndefined(); // outside Nifty 500: never shorted
    expect(st.counts).toEqual({ buy: 1, sell: 1, wait: 0, noTrade: 0 });
    expect(st.counts.buy + st.counts.sell! + st.counts.wait + st.counts.noTrade).toBe(st.rows.length);
    expect(new Set(st.rows.map((r) => r.key)).size).toBe(st.rows.length); // one call per stock
    // the 5-minute and the 1-minute candles of the falling stock were read
    expect(calls.some((u) => u.includes(`/historical-candle/intraday/${SHORTK}/minutes/5`))).toBe(true);
    expect(calls.some((u) => u.includes(`/historical-candle/intraday/${SHORTK}/minutes/1`))).toBe(true);
    // one BUY and one SELL alert, each once
    await intradayTick(NOW + 30_000, true);
    await intradayTick(NOW + 45_000, true);
    const sells = created().filter((c) => c.id.startsWith('alert:intraday-short-'));
    const buys = created().filter((c) => /^alert:intraday-NSE_EQ/.test(c.id));
    expect(sells).toHaveLength(1);
    expect(sells[0]!.title).toMatch(new RegExp(`Intraday SELL ${member.symbol} at ₹490\\.20`));
    expect(buys).toHaveLength(1);
    expect(calls.filter((u) => /\/order|\/gtt/i.test(u))).toEqual([]); // read-only towards Upstox
  });

  it('follows the SELL: target 1 once, then target 2 once', async () => {
    await intradayTick(NOW, true);
    await intradayTick(NOW + 15_000, true);
    fallPrice = 487.7; // target 1 (487.75)
    await intradayTick(NOW + 30_000, true);
    await intradayTick(NOW + 45_000, true);
    fallPrice = 485.2; // target 2 (485.30)
    await intradayTick(NOW + 60_000, true);
    await intradayTick(NOW + 75_000, true);
    // a SELL's follow-ups have their own ids (alert:intraday-sell-<event>-…), apart from a BUY's on the same stock
    const follow = created().filter((c) => /^alert:intraday-sell-(t1|tgt|stop|inv)-/.test(c.id));
    expect(follow.map((c) => c.id.split('-')[2])).toEqual(['t1', 'tgt']);
    expect(follow[0]!.title).toMatch(/SELL target 1 reached/);
    expect(follow[1]!.title).toMatch(/SELL target 2 reached/);
    const alerted = (await chrome.storage.session.get('intradayAlerted')).intradayAlerted as { track: Record<string, { state: string }> };
    expect(alerted.track[`sell:${SHORTK}`]!.state).toBe('done');
    // review fix (1.20.2): the result goes to the record — half at target 1, the rest at target 2, after charges
    const rec = (await chrome.storage.local.get('intradayRecord')).intradayRecord as Array<{ items: Array<{ side: string; outcome: string; t1Hit: boolean; exit: number; pnl: number }> }>;
    expect(rec[0]!.items).toEqual([expect.objectContaining({ side: 'sell', outcome: 'target', t1Hit: true, exit: 485.2 })]);
    expect(rec[0]!.items[0]!.pnl).toBeGreaterThan(0);
    // SELL is new and unproven: its alert says practice only
    expect(created().find((c) => c.id.startsWith('alert:intraday-short-'))!.title).toMatch(/practice only$/);
  });
  it('review fix (1.20.2): "Save mobile data" — only Nifty 500 stocks are asked for, and rounds come every 30 s', async () => {
    const { DEFAULT_SETTINGS } = await import('../src/storage/defaults');
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.data.saveData = true;
    await chrome.storage.local.set({ settings });
    await intradayTick(NOW, true);
    const quoteCalls = calls.filter((u) => u.includes('/v3/market-quote/quotes'));
    expect(quoteCalls.length).toBeGreaterThan(0);
    expect(quoteCalls.some((u) => u.includes(SHORTK))).toBe(true); // Nifty 500: still checked
    expect(quoteCalls.some((u) => u.includes(SMALL) || u.includes(URBANCO))).toBe(false); // outside Nifty 500: not asked for
    // the next round is paced 30 s apart (not 15 s)
    const n = calls.length;
    expect(await intradayTick(NOW + 16_000)).toBe(0);
    expect(calls.length).toBe(n);
  });
});
