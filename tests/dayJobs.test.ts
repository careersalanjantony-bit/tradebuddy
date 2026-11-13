import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock } from './chromeMock';
import { dayClose, dayTake, dayTick, monitorDayTrades } from '../src/background/dayJobs';
import { DAY_RULES_VERSION, DEFAULT_VARIANT } from '../src/daytrade/backtest';
import { appendBar, completedBars, dayExitAt, liveConfig, marketMove, minutesIST, signalFrom, signalState, slotStart, type LiveStock } from '../src/daytrade/live';
import { findBreakout } from '../src/daytrade/rules';
import type { Bars, DaySignal, DayTrade } from '../src/daytrade/types';
import { parseIntraday, calendarDaysFor } from '../src/data/intraday';
import { mergeLtp, type Quote } from '../src/data/quotesParse';
import { fastIntervalMs } from '../src/background/dataJobs';
import { addDays, istEpoch } from '../src/lib/time';
import { getDb } from '../src/storage/db';
import { DEFAULT_SETTINGS } from '../src/storage/defaults';

const DAY = '2026-11-12'; // Thursday
const at = (hhmm: string, s = 0) => istEpoch(DAY, hhmm, s);
// HDFC Bank's real key (a Nifty 100 company: short selling allowed), plus two test keys
const HDFC = 'NSE_EQ|INE040A01034';
const AAA = 'NSE_EQ|INE000AAA011';
const BBB = 'NSE_EQ|INE000BBB011';
const KEYS = [HDFC, AAA, BBB];
const SYM: Record<string, string> = { [HDFC]: 'HDFCBANK', [AAA]: 'AAA', [BBB]: 'BBB' };

/** Today's candles the fake Upstox returns (newest first, like the real API). */
let todayCandles: Record<string, Array<[string, number, number, number, number, number]>> = {};
const orBars = (base: number, vol: number): Array<[string, number, number, number, number, number]> => [
  ['09:15', base, base * 1.004, base * 0.998, base * 1.002, vol],
  ['09:20', base * 1.002, base * 1.005, base * 0.999, base * 1.001, vol],
  ['09:25', base * 1.001, base * 1.004, base * 0.999, base * 1.003, vol],
];

let chrome: ReturnType<typeof installChromeMock>;
const quotes = async (list: Array<[string, number, number]>, fetchedAt: number, volume = 100_000) => {
  const q: Record<string, Quote> = {};
  for (const [key, ltp, open] of list) q[key] = { key, ltp, open, high: Math.max(ltp, open), low: Math.min(ltp, open), volume, prevClose: open, fetchedAt };
  await chrome.storage.session.set({ quotes: q });
};
const loaded = async () => {
  for (let i = 0; i < 50; i++) {
    const st = (await chrome.storage.session.get('dayLive')).dayLive as { loadedAt: number | null } | undefined;
    if (st?.loadedAt) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('day engine did not load');
};
const titles = () => chrome.notifications.create.mock.calls.map((c) => String(c[1].title));

beforeEach(async () => {
  chrome = installChromeMock();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.dayTrade.enabled = true;
  settings.risk.capitalInr = 90_000;
  settings.scanner.universe = 'watchlist';
  await chrome.storage.local.set({
    settings,
    watchlist: KEYS,
    secrets: { upstoxAnalyticsToken: 'analytics-test-token' },
    auth: { status: 'logged_out' },
    marketCalendar: null,
    dayTrades: [],
    dayTest: { key: 'k', report: { rulesVersion: DAY_RULES_VERSION, chosen: DEFAULT_VARIANT, passed: true } },
  });
  const db = await getDb();
  await db.clear('intraday');
  await db.clear('instruments');
  for (const key of KEYS) {
    await db.put('instruments', { instrument_key: key, trading_symbol: SYM[key]!, name: SYM[key]!, isin: key.slice(7), tick: 0.05, lot_size: 1, instrument_type: 'EQ' });
    // 12 earlier sessions whose first 15 minutes traded 10,000 shares
    for (let d = 1; d <= 12; d++) {
      await db.put('intraday', { key, date: addDays(DAY, -d - 20), t: [555, 560, 565, 570], o: [100, 100, 100, 100], h: [100.2, 100.2, 100.2, 100.2], l: [99.9, 99.9, 99.9, 99.9], c: [100, 100, 100, 100], v: [4000, 3000, 3000, 2000] });
    }
  }
  todayCandles = { [HDFC]: orBars(800, 10_000), [AAA]: orBars(100, 10_000), [BBB]: orBars(500, 1_000) };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      const m = /\/v3\/historical-candle\/intraday\/([^/]+)\/minutes\/5$/.exec(url.pathname);
      if (!m) return new Response(JSON.stringify({ status: 'error', errors: [{ error_code: 'X', message: 'not mocked' }] }), { status: 404 });
      const rows = (todayCandles[decodeURIComponent(m[1]!)] ?? []).map(([t, o, h, l, c, v]) => [`${DAY}T${t}:00+05:30`, o, h, l, c, v, 0]).reverse();
      return new Response(JSON.stringify({ status: 'success', data: { candles: rows } }), { status: 200 });
    }),
  );
});

describe('helpers', () => {
  it('parses 5-minute candles by day, oldest first, market hours only', () => {
    const data = { candles: [['2026-11-11T09:20:00+05:30', 2, 3, 1, 2.5, 50, 0], ['2026-11-11T09:15:00+05:30', 1, 2, 1, 2, 100, 0], ['2026-11-10T15:25:00+05:30', 5, 6, 4, 5, 10, 0], ['2026-11-10T15:30:00+05:30', 5, 6, 4, 5, 10, 0]] };
    const m = parseIntraday(data);
    expect([...m.keys()].sort()).toEqual(['2026-11-10', '2026-11-11']);
    expect(m.get('2026-11-11')).toEqual({ t: [555, 560], o: [1, 2], h: [2, 3], l: [1, 1], c: [2, 2.5], v: [100, 50] });
    expect(m.get('2026-11-10')!.t).toEqual([925]);
    expect(() => parseIntraday({})).toThrow();
    expect(calendarDaysFor(120)).toBeGreaterThan(170);
  });
  it('light price poll keeps the day’s open and stretches high/low', () => {
    const prev: Record<string, Quote> = { K: { key: 'K', ltp: 100, open: 99, high: 101, low: 98, volume: 10, prevClose: 97, fetchedAt: 1 } };
    const r = mergeLtp(prev, { 'NSE_EQ:X': { instrument_token: 'K', last_price: 102, volume: 15, cp: 97 }, bad: { instrument_token: 'Z', last_price: 0 } }, 5);
    expect(r.updated).toBe(1);
    expect(r.quotes.K).toEqual({ key: 'K', ltp: 102, open: 99, high: 102, low: 98, volume: 15, prevClose: 97, fetchedAt: 5 });
    expect(prev.K!.ltp).toBe(100);
  });
  it('fast refresh: 2 s per 500 stocks', () => {
    expect(fastIntervalMs(100)).toBe(2000);
    expect(fastIntervalMs(500)).toBe(2000);
    expect(fastIntervalMs(510)).toBe(4000);
  });
  it('time helpers and finished bars', () => {
    expect(minutesIST(at('09:31', 20))).toBe(571);
    expect(slotStart(571)).toBe(570);
    const b: Bars = { t: [555, 560, 565, 570], o: [1, 1, 1, 1], h: [1, 1, 1, 1], l: [1, 1, 1, 1], c: [1, 1, 1, 1], v: [1, 1, 1, 1] };
    expect(completedBars(b, 571).t).toEqual([555, 560, 565]);
    expect(completedBars(b, 575).t).toEqual([555, 560, 565, 570]);
  });
  it('market move needs prices with a day open', () => {
    const q = (ltp: number, open: number | null): Quote => ({ key: '', ltp, open, high: null, low: null, volume: null, prevClose: null, fetchedAt: 0 });
    expect(marketMove({ a: q(101, 100), b: q(99.5, 100) }, ['a', 'b'])).toBeCloseTo(0.0025, 6);
    expect(marketMove({ a: q(101, null) }, ['a', 'b'])).toBeNull();
  });
  it('a signal goes stale after 10 minutes or when the price has run away', () => {
    const s = { side: 'long', at: 1_000_000, entry: 100, stop: 99 } as DaySignal;
    expect(signalState(s, 100.2, 1_000_000 + 60_000)).toBe('fresh');
    expect(signalState(s, 100.5, 1_000_000 + 60_000)).toBe('moved');
    expect(signalState(s, 98.9, 1_000_000 + 60_000)).toBe('moved');
    expect(signalState(s, 100, 1_000_000 + 11 * 60_000)).toBe('old');
    expect(signalState({ ...s, late: true }, 100, 1_000_000)).toBe('old');
    expect(signalState({ ...s, side: 'short', stop: 101 }, 99.5, 1_000_000)).toBe('moved');
  });
  it('exit of an open day trade: stop first, then target, then 3:10 pm', () => {
    const long = { side: 'long' as const, stop: 99, target: 101.5 };
    expect(dayExitAt(long, 100, 600)).toBeNull();
    expect(dayExitAt(long, 98.7, 600)).toEqual({ price: 98.7, reason: 'stop' }); // gapped through: the worse price
    expect(dayExitAt(long, 101.7, 600)).toEqual({ price: 101.5, reason: 'target' });
    expect(dayExitAt(long, 100, 910)).toEqual({ price: 100, reason: 'time' });
    const short = { side: 'short' as const, stop: 101, target: null };
    expect(dayExitAt(short, 101.2, 600)).toEqual({ price: 101.2, reason: 'stop' });
    expect(dayExitAt(short, 95, 600)).toBeNull();
  });
  it('live settings come from a current test; a breakout must pass volume, market and short rules', () => {
    expect(liveConfig(null, 0, null)).toMatchObject({ variant: DEFAULT_VARIANT, trusted: false });
    expect(liveConfig({ rulesVersion: 'old', chosen: { target: '2', minRvol: 2, sides: 'long' }, passed: true } as never, 0, null).trusted).toBe(false);
    const cfg = liveConfig({ rulesVersion: DAY_RULES_VERSION, chosen: DEFAULT_VARIANT, passed: true } as never, 0, 1000);
    expect(cfg.trusted).toBe(true);
    const stock: LiveStock = { symbol: 'X', bars: { t: [555, 560, 565], o: [100, 100, 100], h: [100.5, 100.5, 100.5], l: [99.8, 99.8, 99.8], c: [100, 100, 100], v: [1, 1, 1] }, rvol: 2, done: false, cumVol: 1000, shortAllowed: false, tick: 0.05 };
    const q = (ltp: number): Quote => ({ key: 'X', ltp, open: 100, high: null, low: null, volume: 1500, prevClose: 100, fetchedAt: 0 });
    expect(appendBar(stock, 570, q(100.3))).toBeNull(); // inside the range
    const bo = appendBar(stock, 575, q(100.9))!;
    expect(bo.side).toBe('long');
    expect(stock.done).toBe(true);
    expect(stock.bars.v.slice(-2)).toEqual([500, 0]);
    const sig = signalFrom(DAY, 'K', stock, bo, 100.9, 0.002, cfg, 123)!;
    expect(sig).toMatchObject({ side: 'long', entry: 100.9, trusted: true, symbol: 'X' });
    expect(sig.stop).toBeCloseTo(99.85, 2); // 1% cap, rounded to the 5-paise step (the range low 99.8 is further away)
    expect(sig.target).toBeCloseTo(100.9 + 1.5 * (100.9 - sig.stop), 1);
    expect(signalFrom(DAY, 'K', stock, bo, 100.9, -0.001, cfg, 1)).toBeNull(); // market against it
    expect(signalFrom(DAY, 'K', { ...stock, rvol: 1.2 }, bo, 100.9, 0.002, cfg, 1)).toBeNull(); // not busy enough
    expect(signalFrom(DAY, 'K', stock, bo, 1200, 0.002, cfg, 1)).toBeNull(); // outside the price range
    expect(signalFrom(DAY, 'K', stock, { ...bo, side: 'short' }, 99.5, -0.002, cfg, 1)).toBeNull(); // short not allowed for this stock
    expect(findBreakout(stock.bars)!.idx).toBe(4);
  });
});

describe('live day-trade engine (service worker)', () => {
  it('waits for 09:30, loads today’s bars, then raises a BUY signal at the 5-minute mark — once', async () => {
    expect((await dayTick(at('09:25'))).state).toBe('waiting for 09:30');
    expect((await dayTick(at('09:30', 20))).state).toBe('waiting for 09:30');
    expect((await dayTick(at('09:31'))).state).toBe('loading');
    await loaded();
    const st = (await chrome.storage.session.get('dayLive')).dayLive as { lastSlotT: number; stocks: Record<string, LiveStock> };
    expect(st.lastSlotT).toBe(570);
    expect(st.stocks[HDFC]!.rvol).toBe(3); // 30,000 today vs 10,000 usual
    expect(st.stocks[BBB]!.rvol).toBeCloseTo(0.3, 6);
    expect(st.stocks[HDFC]!.shortAllowed).toBe(true);
    expect(st.stocks[AAA]!.shortAllowed).toBe(false);

    expect((await dayTick(at('09:33'))).state).toBe('watching');
    // 09:35: all three are above their range; the market is up. BBB is not busy enough (0.3×).
    await quotes([[HDFC, 806, 800], [AAA, 100.9, 100], [BBB, 504, 500]], at('09:35', 3));
    const r = await dayTick(at('09:35', 5));
    expect(r).toEqual({ signals: 2, state: 'watching' });
    const sigs = ((await chrome.storage.session.get('daySignals')).daySignals as { date: string; signals: DaySignal[] }).signals;
    expect(sigs.map((s) => `${s.symbol} ${s.side}`).sort()).toEqual(['AAA long', 'HDFCBANK long']);
    const h = sigs.find((s) => s.symbol === 'HDFCBANK')!;
    expect(h).toMatchObject({ entry: 806, trusted: true, announced: true, barT: 575 });
    expect(h.stop).toBeLessThan(806);
    expect(h.stop).toBeGreaterThanOrEqual(806 * 0.99 - 0.05);
    expect(h.target).toBeGreaterThan(806);
    expect(titles().filter((t) => t.includes('▲ BUY'))).toHaveLength(2);
    expect(titles().some((t) => t.includes('Practice signal'))).toBe(false);
    // the same breakout is never announced twice
    await quotes([[HDFC, 808, 800], [AAA, 101.2, 100], [BBB, 505, 500]], at('09:40', 2));
    expect((await dayTick(at('09:40', 4))).signals).toBe(0);
    expect(titles().filter((t) => t.includes('▲ BUY'))).toHaveLength(2);
  });

  it('SELL (short) only for Nifty 100 stocks and only when the market is down', async () => {
    await dayTick(at('09:31'));
    await loaded();
    await quotes([[HDFC, 796, 800], [AAA, 99.4, 100], [BBB, 497, 500]], at('09:35', 3));
    expect((await dayTick(at('09:35', 5))).signals).toBe(1);
    const sigs = ((await chrome.storage.session.get('daySignals')).daySignals as { signals: DaySignal[] }).signals;
    expect(sigs).toHaveLength(1);
    expect(sigs[0]).toMatchObject({ symbol: 'HDFCBANK', side: 'short', entry: 796 });
    expect(sigs[0]!.stop).toBeGreaterThan(796);
    expect(sigs[0]!.target).toBeLessThan(796);
    expect(titles().some((t) => t.includes('▼ SELL (short) HDFCBANK'))).toBe(true);
  });

  it('rules that did not pass the test only give practice signals', async () => {
    await chrome.storage.local.set({ dayTest: { key: 'k', report: { rulesVersion: DAY_RULES_VERSION, chosen: DEFAULT_VARIANT, passed: false } } });
    await dayTick(at('09:31'));
    await loaded();
    await quotes([[HDFC, 806, 800], [AAA, 100.9, 100], [BBB, 504, 500]], at('09:35', 3));
    await dayTick(at('09:35', 5));
    const sigs = ((await chrome.storage.session.get('daySignals')).daySignals as { signals: DaySignal[] }).signals;
    expect(sigs.every((s) => s.trusted === false)).toBe(true);
    expect(titles().every((t) => !t.includes('BUY') || t.startsWith('Practice signal'))).toBe(true);
  });

  it('a late start marks earlier breakouts as "late"; a missed 5-minute mark reloads; nothing after 11:30', async () => {
    // engine starts at 10:02: HDFC broke out at 09:40
    todayCandles[HDFC] = [...orBars(800, 10_000), ['09:30', 802, 803.5, 801, 803, 5000], ['09:35', 803, 808, 802.5, 807, 9000], ['09:40', 807, 809, 806, 808, 4000]];
    await quotes([[HDFC, 808, 800], [AAA, 100.2, 100], [BBB, 501, 500]], at('10:02'));
    expect((await dayTick(at('10:02'))).state).toBe('loading');
    await loaded();
    const sigs = ((await chrome.storage.session.get('daySignals')).daySignals as { signals: DaySignal[] }).signals;
    expect(sigs).toHaveLength(1);
    expect(sigs[0]).toMatchObject({ symbol: 'HDFCBANK', late: true });
    expect(sigs[0]!.announced).toBeUndefined();
    expect(titles().some((t) => t.includes('BUY'))).toBe(false);
    // computer asleep until 10:20 → reload instead of guessing the missing bars
    expect((await dayTick(at('10:20'))).state).toBe('reloading after a gap');
    expect((await dayTick(at('10:20', 5))).state).toBe('loading');
    await loaded();
    expect((await dayTick(at('11:36'))).state).toBe('reloading after a gap');
    expect((await dayTick(at('11:40'))).state).toBe('signal window over');
    expect((await dayTick(at('16:00'))).state).toBe('market closed');
  });

  it('09:25 candles not published yet → waits and loads again 15 s later', async () => {
    const full = { ...todayCandles };
    for (const k of KEYS) todayCandles[k] = full[k]!.slice(0, 2); // only 09:15 and 09:20 so far
    expect((await dayTick(at('09:30', 50))).state).toBe('loading');
    await new Promise((r) => setTimeout(r, 60));
    expect((await chrome.storage.session.get('dayLive')).dayLive).toBeUndefined();
    expect((await dayTick(at('09:30', 55))).state).toBe('waiting for the first candles');
    todayCandles = full;
    expect((await dayTick(at('09:31', 6))).state).toBe('loading');
    await loaded();
    const st = (await chrome.storage.session.get('dayLive')).dayLive as { stocks: Record<string, LiveStock> };
    expect(st.stocks[HDFC]!.bars.t).toEqual([555, 560, 565]);
  });

  it('off = no signals', async () => {
    const s = (await chrome.storage.local.get('settings')).settings as typeof DEFAULT_SETTINGS;
    s.dayTrade.enabled = false;
    await chrome.storage.local.set({ settings: s });
    expect((await dayTick(at('09:36'))).state).toBe('off');
  });
});

describe('open day trades', () => {
  const trades = async () => (await chrome.storage.local.get('dayTrades')).dayTrades as DayTrade[];

  it('real trade: one alert at the target, one at 3:05 pm; "I closed it" records the result after charges', async () => {
    const t = await dayTake({ key: AAA, symbol: 'AAA', side: 'long', qty: 300, stop: 99, target: 101.5, practice: false, price: 100 }, at('09:40'));
    expect(t).toMatchObject({ entry: 100, status: 'open', practice: false, date: DAY });
    await quotes([[AAA, 100.6, 100]], at('09:50'));
    expect(await monitorDayTrades(at('09:50', 2))).toBe(0);
    await quotes([[AAA, 101.6, 100]], at('10:10'));
    expect(await monitorDayTrades(at('10:10', 2))).toBe(1);
    expect(titles().some((x) => x.startsWith('SELL AAA NOW — target reached'))).toBe(true);
    expect(await monitorDayTrades(at('10:10', 30))).toBe(0); // not twice
    expect((await trades())[0]!.status).toBe('open'); // a real trade is never closed by the extension
    await quotes([[AAA, 101.0, 100]], at('15:05'));
    expect(await monitorDayTrades(at('15:05', 2))).toBe(1);
    expect(titles().some((x) => x.startsWith('Close AAA now'))).toBe(true);
    const r = await dayClose(t.id, 101.4, at('15:06'));
    expect(r.pnl).toBeGreaterThan(300 * 1.4 - 80);
    expect(r.pnl).toBeLessThan(300 * 1.4);
    expect((await trades())[0]).toMatchObject({ status: 'closed', exitPrice: 101.4, exitReason: 'manual' });
    await expect(dayClose(t.id, 101)).rejects.toThrow(/already closed/);
  });

  it('practice trades close by themselves: stop (long), target (short) and 3:10 pm', async () => {
    await quotes([[AAA, 100, 100], [HDFC, 800, 801], [BBB, 500, 500]], at('09:40'));
    const a = await dayTake({ key: AAA, symbol: 'AAA', side: 'long', qty: 100, stop: 99, target: 101.5, practice: true }, at('09:40', 5));
    const h = await dayTake({ key: HDFC, symbol: 'HDFCBANK', side: 'short', qty: 10, stop: 808, target: 788, practice: true }, at('09:40', 5));
    const b = await dayTake({ key: BBB, symbol: 'BBB', side: 'long', qty: 10, stop: 495, target: null, practice: true }, at('09:40', 5));
    expect(a.entry).toBe(100);
    await expect(dayTake({ key: AAA, symbol: 'AAA', side: 'long', qty: 1, stop: 99, target: null, practice: true }, at('09:41'))).rejects.toThrow(/already have/);
    await quotes([[AAA, 98.8, 100], [HDFC, 787, 801], [BBB, 502, 500]], at('10:00'));
    expect(await monitorDayTrades(at('10:00', 2))).toBe(2);
    let all = await trades();
    expect(all.find((x) => x.id === a.id)).toMatchObject({ status: 'closed', exitReason: 'stop', exitPrice: 98.8 });
    expect(all.find((x) => x.id === h.id)).toMatchObject({ status: 'closed', exitReason: 'target', exitPrice: 788 });
    expect(all.find((x) => x.id === b.id)!.status).toBe('open');
    await quotes([[BBB, 503, 500]], at('15:10'));
    expect(await monitorDayTrades(at('15:10', 3))).toBe(1);
    all = await trades();
    expect(all.find((x) => x.id === b.id)).toMatchObject({ status: 'closed', exitReason: 'time', exitPrice: 503 });
    expect(titles().filter((x) => x.startsWith('Practice day trade closed'))).toHaveLength(3);
    await expect(dayTake({ key: BBB, symbol: 'BBB', side: 'long', qty: 1, stop: 495, target: null, practice: true }, at('15:12'))).rejects.toThrow(/too late/);
  });

  it('a stale price never closes or alerts', async () => {
    await quotes([[AAA, 100, 100]], at('09:40'));
    await dayTake({ key: AAA, symbol: 'AAA', side: 'long', qty: 100, stop: 99, target: 101.5, practice: true }, at('09:40', 5));
    await quotes([[AAA, 90, 100]], at('09:45'));
    expect(await monitorDayTrades(at('09:50'))).toBe(0); // price is 5 minutes old
    expect((await trades())[0]!.status).toBe('open');
  });
});
