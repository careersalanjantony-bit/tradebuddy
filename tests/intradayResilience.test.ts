import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetIntraday, intradayTick, type IntradayState } from '../src/background/intradayJobs';
import { __resetDb, getDb } from '../src/storage/db';
import { installChromeMock } from './chromeMock';

/**
 * App v1.20.1 — the Intraday list must appear on every phone. A phone that is busy (the morning's
 * history download, or Upstox's request limit reached) used to wait inside one round for minutes, and
 * the list stayed empty with no filters. Now each round saves the list within its time budget with what
 * it has; slow requests go on in the background and are used by the next round.
 */

const URBANCO = 'NSE_EQ|INE0URBAN01';
// Wednesday 18 Nov 2026, 9:50 IST
const NOW = Date.parse('2026-11-18T04:20:00Z');
const c5 = (hhmm: string, o: number, h: number, l: number, c: number, v: number) => [`2026-11-18T${hhmm}:00+05:30`, o, h, l, c, v, 0];
const TODAY = [
  c5('09:15', 100.1, 100.6, 99.8, 100.4, 80_000),
  c5('09:20', 100.4, 100.6, 100.0, 100.3, 60_000),
  c5('09:25', 100.3, 100.5, 99.9, 100.2, 50_000),
  c5('09:30', 100.2, 101.0, 100.1, 100.9, 120_000),
  c5('09:35', 100.9, 101.5, 100.8, 101.4, 110_000),
  c5('09:40', 101.4, 101.95, 101.3, 101.9, 100_000),
];
const DAILY = Array.from({ length: 25 }, (_, i) => [`${new Date(Date.UTC(2026, 9, 10 + i)).toISOString().slice(0, 10)}T00:00:00+05:30`, 100, 101, 99, 100, 1_000_000, 0]);
const never = () => new Promise<Response>(() => undefined);

let chrome: ReturnType<typeof installChromeMock>;
let hang = { quotes: false, candles: false, history: false };

beforeEach(async () => {
  chrome = installChromeMock();
  __resetIntraday({ quotes: 150, bars: 100, history: 50, bars1: 50 });
  await __resetDb();
  hang = { quotes: false, candles: false, history: false };
  await chrome.storage.local.set({ secrets: { upstoxAnalyticsToken: 'test-token' }, settings: undefined });
  await (await getDb()).put('instruments', { instrument_key: URBANCO, trading_symbol: 'URBANCO', name: 'Urban Company', isin: 'INE0URBAN01', tick: 0.05, lot_size: 1, instrument_type: 'EQ' });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = decodeURIComponent(String(url));
      const ok = (data: unknown) => new Response(JSON.stringify({ status: 'success', data }), { status: 200 });
      if (u.includes('/v3/market-quote/quotes')) return hang.quotes ? never() : ok({ 'NSE_EQ:URBANCO': { instrument_token: URBANCO, last_price: 101.9, prev_close_price: 100, volume: 520_000, average_price: 100.84, total_buy_quantity: 60_000, total_sell_quantity: 40_000 } });
      if (u.includes('/historical-candle/intraday/')) return hang.candles ? never() : ok({ candles: [...TODAY].reverse() });
      if (u.includes('/historical-candle/')) return hang.history ? never() : ok({ candles: DAILY });
      return new Response('{}', { status: 404 });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

const state = async () => (await chrome.storage.session.get('intraday')).intraday as IntradayState | undefined;

describe('Intraday list on a busy phone', () => {
  it('the cause of the empty list: a riser whose 5-minute candles have not loaded no longer stops the whole round', async () => {
    const { classifyIntraday } = await import('../src/intraday/scanner');
    // 9:50, +1.9 %, no candles yet (only 12 stocks' candles are fetched per round; a failed fetch waits)
    const row = classifyIntraday({ key: URBANCO, symbol: 'URBANCO', tick: 0.05, now: NOW, t: 9 * 60 + 50, ltp: 101.9, prevClose: 100, volume: 520_000, vwap: 100.84, buyQty: 6, sellQty: 4, bars: { t: [], o: [], h: [], l: [], c: [], v: [] }, avgDailyVol: 1_000_000, fetchedAt: NOW, marketWeak: false, capital: 20_000, maxRisk: 100 })!;
    expect(row.call).toBe('WAIT'); // the same decision as before — it used to throw here instead
    expect(row.why).toMatch(/candles are still loading/);
  });

  it('candles and history stuck at Upstox: the round still saves the list (with the stock) and says what is still coming', async () => {
    hang = { quotes: false, candles: true, history: true };
    const t0 = Date.now();
    await intradayTick(NOW, true);
    expect(Date.now() - t0).toBeLessThan(2_000); // not waiting for the stuck requests
    const st = (await state())!;
    expect(st.rows.map((r) => r.symbol)).toEqual(['URBANCO']);
    expect(st.rows[0]!.call).not.toBe('BUY'); // no BUY without candles and usual volume — honest WAIT
    expect(st.slow).toEqual(expect.arrayContaining(['candles', 'volume history']));
    // the next round does not start a second copy of the stuck downloads, and still saves
    await intradayTick(NOW + 15_000, true);
    expect((await state())!.at).toBe(NOW + 15_000);
  });

  it('prices stuck: the list is saved anyway (empty, with the filters) and says prices are still coming', async () => {
    hang = { quotes: true, candles: false, history: false };
    await intradayTick(NOW, true);
    const st = (await state())!;
    expect(st).toMatchObject({ date: '2026-11-18', rows: [], counts: { buy: 0, sell: 0, wait: 0, noTrade: 0 } });
    expect(st.slow).toContain('prices');
  });

  it('when nothing is stuck it is the same BUY as before (the morning logic, unchanged)', async () => {
    await intradayTick(NOW, true);
    await intradayTick(NOW + 15_000, true);
    const st = (await state())!;
    expect(st.rows[0]).toMatchObject({ symbol: 'URBANCO', call: 'BUY', breakoutT: 9 * 60 + 35 });
    expect(st.slow).toBeUndefined();
  });
});
