import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetIntraday, intradayTick, type IntradayState } from '../src/background/intradayJobs';
import { classifyIntraday } from '../src/intraday/scanner';
import { __resetDb, getDb } from '../src/storage/db';
import { installChromeMock } from './chromeMock';

/**
 * Milestone 4 final check — the Intraday scanner also runs on the server every 15 s, and its alerts are
 * what the server pushes. A rising stock whose 5-minute candles have not loaded yet (after 9:30) made
 * classifyIntraday throw, which stopped the WHOLE round: no list, no Intraday BUY / SELL alert and no
 * push for as long as that stock had no candles. Now that stock is an honest WAIT and the round goes on.
 */

const URBANCO = 'NSE_EQ|INE0URBAN01';
// Wednesday 18 Nov 2026, 9:50 IST
const NOW = Date.parse('2026-11-18T04:20:00Z');
const DAILY = Array.from({ length: 25 }, (_, i) => [`${new Date(Date.UTC(2026, 9, 10 + i)).toISOString().slice(0, 10)}T00:00:00+05:30`, 100, 101, 99, 100, 1_000_000, 0]);

let chrome: ReturnType<typeof installChromeMock>;

beforeEach(async () => {
  chrome = installChromeMock();
  __resetIntraday();
  await __resetDb();
  await chrome.storage.local.set({ secrets: { upstoxAnalyticsToken: 'test-token' }, settings: undefined });
  await (await getDb()).put('instruments', { instrument_key: URBANCO, trading_symbol: 'URBANCO', name: 'Urban Company', isin: 'INE0URBAN01', tick: 0.05, lot_size: 1, instrument_type: 'EQ' });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = decodeURIComponent(String(url));
      const ok = (data: unknown) => new Response(JSON.stringify({ status: 'success', data }), { status: 200 });
      if (u.includes('/v3/market-quote/quotes')) return ok({ 'NSE_EQ:URBANCO': { instrument_token: URBANCO, last_price: 101.9, prev_close_price: 100, volume: 520_000, average_price: 100.84, total_buy_quantity: 60_000, total_sell_quantity: 40_000 } });
      // Upstox has no 5-minute candles for it yet (or the request failed)
      if (u.includes('/historical-candle/intraday/')) return ok({ candles: [] });
      if (u.includes('/historical-candle/')) return ok({ candles: DAILY });
      return new Response('{}', { status: 404 });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe('Intraday round with a riser that has no candles yet', () => {
  it('classifyIntraday gives WAIT instead of throwing', () => {
    const row = classifyIntraday({ key: URBANCO, symbol: 'URBANCO', tick: 0.05, now: NOW, t: 9 * 60 + 50, ltp: 101.9, prevClose: 100, volume: 520_000, vwap: 100.84, buyQty: 6, sellQty: 4, bars: { t: [], o: [], h: [], l: [], c: [], v: [] }, avgDailyVol: 1_000_000, fetchedAt: NOW, marketWeak: false, capital: 20_000, maxRisk: 100 })!;
    expect(row.call).toBe('WAIT');
    expect(row.why).toMatch(/candles are still loading/);
  });

  it('the round (as the server runs it) finishes and saves the list with that stock', async () => {
    await expect(intradayTick(NOW, true)).resolves.toBeGreaterThanOrEqual(1);
    const st = (await chrome.storage.session.get('intraday')).intraday as IntradayState;
    expect(st.date).toBe('2026-11-18');
    expect(st.rows.find((r) => r.symbol === 'URBANCO')?.call).toBe('WAIT');
  });
});

describe('Follow-up alerts of a BUY and a SELL on the same stock the same day', () => {
  // A BUY that failed and then a SELL on the same stock (the failed-breakout SELL) are both followed. Their
  // follow-up alerts must have different ids: an id already shown in the last 24 hours is never shown
  // (or pushed by the server) again, so a shared id silently drops the SELL's stop-loss alert.
  it('both stop-loss alerts go out, each with its own id', async () => {
    const base = { key: URBANCO, symbol: 'URBANCO', qty: 10, risk: 40, score: 60, at: NOW - 30 * 60_000, state: 'open' as const };
    await chrome.storage.session.set({
      intradayAlerted: {
        date: '2026-11-18',
        keys: [URBANCO],
        sells: [URBANCO],
        track: {
          [`buy:${URBANCO}`]: { ...base, side: 'buy', entry: 104, stop: 103, t1: null, target: 106, level: 103.5 },
          [`sell:${URBANCO}`]: { ...base, side: 'sell', entry: 100, stop: 101.5, t1: 99, target: 98, level: 100.5 },
        },
      },
    });
    await intradayTick(NOW, true); // price ₹101.90: under the BUY's stop ₹103 and over the SELL's stop ₹101.50
    const ids = chrome.notifications.create.mock.calls.map(([id]) => id).filter((id) => id.includes('stop'));
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    // the BUY's id is unchanged (a server updated during the day does not repeat a BUY follow-up)
    expect(ids).toContain(`alert:intraday-stop-${URBANCO}-2026-11-18`);
  });
});
