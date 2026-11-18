import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetIntraday, intradayTick } from '../src/background/intradayJobs';
import { __resetDb, getDb } from '../src/storage/db';
import { installChromeMock } from './chromeMock';

/**
 * App v1.19 — the live Intraday scan against a stand-in Upstox: a stock outside the pre-open list,
 * priced only by Full Market Quotes, with today's official 5-minute candles and 20 days of history,
 * becomes a BUY; the alert goes out once — the next rounds do not repeat it. A BE-series stock never
 * reaches the scanner (the instrument list keeps EQ only).
 */

const URBANCO = 'NSE_EQ|INE0URBAN01';
const QUIET = 'NSE_EQ|INE0QUIET01';
// Wednesday 18 Nov 2026, 9:50 IST: six finished 5-minute candles (9:15 … 9:40)
const NOW = Date.parse('2026-11-18T04:20:00Z');

const candle = (hhmm: string, o: number, h: number, l: number, c: number, v: number) => [`2026-11-18T${hhmm}:00+05:30`, o, h, l, c, v, 0];
const TODAY = [
  candle('09:15', 100.1, 100.6, 99.8, 100.4, 80_000),
  candle('09:20', 100.4, 100.6, 100.0, 100.3, 60_000),
  candle('09:25', 100.3, 100.5, 99.9, 100.2, 50_000),
  candle('09:30', 100.2, 101.0, 100.1, 100.9, 120_000),
  candle('09:35', 100.9, 101.5, 100.8, 101.4, 110_000),
  candle('09:40', 101.4, 101.95, 101.3, 101.9, 100_000),
  candle('09:45', 101.9, 102.1, 101.8, 102.0, 30_000), // still forming at 9:50: not used
];
const DAILY = Array.from({ length: 25 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 9, 10 + i));
  return [`${d.toISOString().slice(0, 10)}T00:00:00+05:30`, 100, 101, 99, 100, 1_000_000, 0];
});

let chrome: ReturnType<typeof installChromeMock>;
const calls: string[] = [];

beforeEach(async () => {
  chrome = installChromeMock();
  __resetIntraday();
  await __resetDb();
  await chrome.storage.local.set({ secrets: { upstoxAnalyticsToken: 'test-token' }, settings: undefined });
  const db = await getDb();
  await db.put('instruments', { instrument_key: URBANCO, trading_symbol: 'URBANCO', name: 'Urban Company', isin: 'INE0URBAN01', tick: 0.05, lot_size: 1, instrument_type: 'EQ' });
  await db.put('instruments', { instrument_key: QUIET, trading_symbol: 'QUIETCO', name: 'Quiet', isin: 'INE0QUIET01', tick: 0.05, lot_size: 1, instrument_type: 'EQ' });
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = decodeURIComponent(String(url));
      calls.push(u);
      const ok = (data: unknown) => new Response(JSON.stringify({ status: 'success', data }), { status: 200 });
      if (u.includes('/v3/market-quote/quotes'))
        return ok({
          'NSE_EQ:URBANCO': { instrument_token: URBANCO, last_price: 101.9, prev_close_price: 100, volume: 520_000, average_price: 100.84, total_buy_quantity: 60_000, total_sell_quantity: 40_000 },
          'NSE_EQ:QUIETCO': { instrument_token: QUIET, last_price: 100.1, prev_close_price: 100, volume: 90_000, average_price: 100.05, total_buy_quantity: 1, total_sell_quantity: 1 },
        });
      if (u.includes('/historical-candle/intraday/')) return ok({ candles: [...TODAY].reverse() });
      if (u.includes('/historical-candle/')) return ok({ candles: DAILY });
      return new Response('{}', { status: 404 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Intraday scanner, live', () => {
  it('finds a flat opener outside the pre-open list, classifies it BUY, and alerts once', async () => {
    // first round: prices, candles and history are fetched; the usual volume arrives with the history
    await intradayTick(NOW, true);
    await intradayTick(NOW + 15_000, true);
    const st = (await chrome.storage.session.get('intraday')).intraday as { universe: number; rows: Array<{ symbol: string; call: string; breakoutT: number; plan: { entry: number } }> };
    expect(st.universe).toBe(2);
    expect(st.rows.map((r) => r.symbol)).toEqual(['URBANCO']); // QUIETCO is +0.1 %: not listed
    expect(st.rows[0]).toMatchObject({ call: 'BUY', breakoutT: 9 * 60 + 35 });
    // the official 5-minute candles and Full Market Quotes were used
    expect(calls.some((u) => u.includes('/historical-candle/intraday/NSE_EQ|INE0URBAN01/minutes/5'))).toBe(true);
    expect(calls.some((u) => u.includes('/v3/market-quote/quotes'))).toBe(true);
    const buyAlerts = () => chrome.notifications.create.mock.calls.filter((c) => String(c[0]).startsWith('alert:intraday-'));
    expect(buyAlerts()).toHaveLength(1);
    expect(String(buyAlerts()[0]![1].title)).toMatch(/Intraday BUY URBANCO at ₹101\.90/);
    // later rounds: still a BUY, no second alert
    await intradayTick(NOW + 30_000, true);
    await intradayTick(NOW + 45_000, true);
    expect(buyAlerts()).toHaveLength(1);
    // read-only towards Upstox
    expect(calls.filter((u) => /\/order|\/gtt/i.test(u))).toEqual([]);
  });

  it('does nothing outside 9:15–3:15 (unless asked)', async () => {
    expect(await intradayTick(Date.parse('2026-11-18T10:30:00Z'))).toBe(0); // 16:00 IST
    expect(calls).toEqual([]);
  });
});
