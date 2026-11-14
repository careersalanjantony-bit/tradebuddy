import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock } from './chromeMock';
import { marketMood, nervesFromVix } from '../src/advisor/mood';
import { mergeNews } from '../src/background/newsJobs';
import { syncPortfolio } from '../src/background/portfolioJobs';
import { NIFTY_KEY, VIX_KEY } from '../src/data/indices';
import { headlines, inTheNews, parseNews } from '../src/data/news';
import type { Quote } from '../src/data/quotesParse';
import type { DayTrade } from '../src/daytrade/types';
import { istEpoch } from '../src/lib/time';
import { parsePositions, reconcileDay, reconcileDelivery, type UpstoxPosition } from '../src/portfolio/sync';
import { getDb } from '../src/storage/db';
import { DEFAULT_SETTINGS } from '../src/storage/defaults';
import type { TradePlan } from '../src/storage/schema';
import { candlesFrom } from './helpers';

const DAY = '2026-11-12';
const K = 'NSE_EQ|INE775A01035'; // Samvardhana Motherson
const pos = (over: Partial<UpstoxPosition>): UpstoxPosition => ({ key: K, symbol: 'MOTHERSON', product: 'I', quantity: 0, dayBuyQty: 0, dayBuyPrice: 0, daySellQty: 0, daySellPrice: 0, ...over });
const trade = (over: Partial<DayTrade>): DayTrade => ({ id: 'D1', date: DAY, key: K, symbol: 'MOTHERSON', side: 'long', qty: 100, entry: 163.1, stop: 161.5, target: 165.5, openedAt: 0, practice: false, status: 'open', ...over });
const plan = (over: Partial<TradePlan>): TradePlan => ({ id: 'P1', key: K, symbol: 'MOTHERSON', status: 'open', createdAt: 0, updatedAt: 0, entry: 163.1, stop: 155, target: 172, qty: 100, riskRupees: 810, rewardRupees: 890, rr: 1.1, setup: null, trend: null, ticket: '', fillPrice: 163.1, openedDate: '2026-11-10', ...over });

describe('reading Upstox positions (docs example shapes)', () => {
  it('keeps equity positions, maps BSE to the NSE key, ignores derivatives', () => {
    const data = [
      { exchange: 'NFO', product: 'D', instrument_token: 'NSE_FO|52618', quantity: 15, trading_symbol: 'BANKNIFTY23OCT38000PE' },
      { exchange: 'NSE', product: 'D', instrument_token: 'NSE_EQ|INE062A01020', average_price: null, day_buy_quantity: 1, day_buy_price: 570.95, day_sell_quantity: 1, day_sell_price: 571.4, quantity: 0, trading_symbol: 'SBIN', buy_price: 570.95, sell_price: 571.4 },
      { exchange: 'BSE', product: 'I', instrument_token: 'BSE_EQ|INE775A01035', day_buy_quantity: 100, day_buy_price: 163.1, day_sell_quantity: 0, day_sell_price: 0, quantity: 100, trading_symbol: 'MOTHERSON', buy_price: 163.1, sell_price: 0 },
      { exchange: 'NSE', product: 'MTF', instrument_token: 'NSE_EQ|INE002A01018', quantity: 5 },
    ];
    expect(parsePositions(data)).toEqual([
      { key: 'NSE_EQ|INE062A01020', symbol: 'SBIN', product: 'D', quantity: 0, dayBuyQty: 1, dayBuyPrice: 570.95, daySellQty: 1, daySellPrice: 571.4 },
      { key: K, symbol: 'MOTHERSON', product: 'I', quantity: 100, dayBuyQty: 100, dayBuyPrice: 163.1, daySellQty: 0, daySellPrice: 0 },
    ]);
    expect(() => parsePositions({ nope: 1 })).toThrow();
  });
});

describe('intraday positions → day trades', () => {
  it('a new position is found; the same one is not found twice', () => {
    const p = [pos({ quantity: 100, dayBuyQty: 100, dayBuyPrice: 163.1 })];
    expect(reconcileDay(p, [], DAY)).toEqual([{ type: 'open', key: K, symbol: 'MOTHERSON', side: 'long', qty: 100, entry: 163.1 }]);
    expect(reconcileDay(p, [trade({})], DAY)).toEqual([]);
  });
  it('a short position (sold first) is found with its sell price', () => {
    expect(reconcileDay([pos({ quantity: -50, daySellQty: 50, daySellPrice: 170 })], [], DAY)).toEqual([{ type: 'open', key: K, symbol: 'MOTHERSON', side: 'short', qty: 50, entry: 170 }]);
  });
  it('more shares bought → quantity and average price follow Upstox', () => {
    expect(reconcileDay([pos({ quantity: 150, dayBuyQty: 150, dayBuyPrice: 163.4 })], [trade({})], DAY)).toEqual([{ type: 'update', id: 'D1', side: 'long', qty: 150, entry: 163.4 }]);
  });
  it('position flat again → the trade is closed at the price Upstox reports', () => {
    const flat = [pos({ quantity: 0, dayBuyQty: 100, dayBuyPrice: 163.1, daySellQty: 100, daySellPrice: 166.9 })];
    expect(reconcileDay(flat, [trade({})], DAY)).toEqual([{ type: 'close', id: 'D1', exitPrice: 166.9 }]);
    expect(reconcileDay(flat, [trade({ side: 'short', entry: 166.9 })], DAY)).toEqual([{ type: 'close', id: 'D1', exitPrice: 163.1 }]);
  });
  it('bought and sold before the extension looked → recorded once as a finished trade', () => {
    const flat = [pos({ quantity: 0, dayBuyQty: 100, dayBuyPrice: 163.1, daySellQty: 100, daySellPrice: 166.9 })];
    expect(reconcileDay(flat, [], DAY)).toEqual([{ type: 'record', key: K, symbol: 'MOTHERSON', qty: 100, entry: 163.1, exitPrice: 166.9 }]);
    const done = trade({ status: 'closed', exitPrice: 166.9, auto: true });
    expect(reconcileDay(flat, [done], DAY)).toEqual([]);
    // a second round in the same stock: the totals of the record follow
    const more = [pos({ quantity: 0, dayBuyQty: 200, dayBuyPrice: 163.5, daySellQty: 200, daySellPrice: 166 })];
    expect(reconcileDay(more, [done], DAY)).toEqual([{ type: 'rerecord', id: 'D1', qty: 200, entry: 163.5, exitPrice: 166 }]);
  });
  it('practice trades, other days and delivery positions are left alone', () => {
    const p = [pos({ quantity: 100, dayBuyQty: 100, dayBuyPrice: 163.1 })];
    expect(reconcileDay(p, [trade({ practice: true })], DAY)).toHaveLength(1);
    expect(reconcileDay(p, [trade({ date: '2026-11-11' })], DAY)).toHaveLength(1);
    expect(reconcileDay([pos({ product: 'D', quantity: 100, dayBuyQty: 100, dayBuyPrice: 163.1 })], [], DAY)).toEqual([]);
  });
});

describe('delivery positions → trades held for days', () => {
  const bought = [pos({ product: 'D', quantity: 100, dayBuyQty: 100, dayBuyPrice: 163.1 })];
  it('a delivery purchase is found; a saved pick for it is marked bought', () => {
    expect(reconcileDelivery(bought, [], DAY)).toEqual([{ type: 'bought', key: K, symbol: 'MOTHERSON', qty: 100, price: 163.1 }]);
    expect(reconcileDelivery(bought, [plan({ status: 'planned' })], DAY)).toEqual([{ type: 'bought', key: K, symbol: 'MOTHERSON', qty: 100, price: 163.1, planId: 'P1' }]);
    expect(reconcileDelivery(bought, [plan({ auto: true, openedDate: DAY })], DAY)).toEqual([]);
    expect(reconcileDelivery(bought, [plan({ practice: true })], DAY)).toHaveLength(1);
  });
  it('selling the whole holding closes the trade; a partial sale is counted once', () => {
    const soldAll = [pos({ product: 'D', quantity: -100, daySellQty: 100, daySellPrice: 166.76 })];
    expect(reconcileDelivery(soldAll, [plan({})], DAY)).toEqual([{ type: 'sold', planId: 'P1', soldQty: 100, price: 166.76, all: true }]);
    const part = [pos({ product: 'D', quantity: -40, daySellQty: 40, daySellPrice: 166 })];
    expect(reconcileDelivery(part, [plan({})], DAY)).toEqual([{ type: 'sold', planId: 'P1', soldQty: 40, price: 166, all: false }]);
    expect(reconcileDelivery(part, [plan({ qty: 60, syncSold: { date: DAY, qty: 40 } })], DAY)).toEqual([]);
    const rest = [pos({ product: 'D', quantity: -100, daySellQty: 100, daySellPrice: 166.2 })];
    expect(reconcileDelivery(rest, [plan({ qty: 60, syncSold: { date: DAY, qty: 40 } })], DAY)).toEqual([{ type: 'sold', planId: 'P1', soldQty: 100, price: 166.2, all: true }]);
  });
});

describe('market mood', () => {
  const q = (ltp: number, prevClose: number): Quote => ({ key: '', ltp, open: prevClose, high: null, low: null, volume: null, prevClose, fetchedAt: 0 });
  const stocks = (up: number, total: number) => Object.fromEntries(Array.from({ length: total }, (_, i) => [`S${i}`, q(i < up ? 101 : 99, 100)]));
  const keys = Array.from({ length: 20 }, (_, i) => `S${i}`);
  it('rising / falling / mixed from Nifty and the share of stocks that are up', () => {
    expect(marketMood({ ...stocks(15, 20), [NIFTY_KEY]: q(25100, 25000), [VIX_KEY]: q(12, 12.5) }, keys)).toMatchObject({ direction: 'rising', nerves: 'calm', up: 15, total: 20, caution: null });
    expect(marketMood({ ...stocks(5, 20), [NIFTY_KEY]: q(24800, 25000), [VIX_KEY]: q(19, 16) }, keys)).toMatchObject({ direction: 'falling', nerves: 'nervous' });
    expect(marketMood({ ...stocks(10, 20), [NIFTY_KEY]: q(25010, 25000) }, keys)).toMatchObject({ direction: 'mixed', nerves: 'unknown' });
    expect(marketMood({}, keys)).toMatchObject({ direction: 'unknown', nerves: 'unknown' });
    expect(marketMood({ [VIX_KEY]: q(25, 20) }, keys).caution).toMatch(/very nervous/);
  });
  it('nervousness bands', () => {
    expect([10, 14, 18, 23, null].map(nervesFromVix)).toEqual(['calm', 'normal', 'nervous', 'very nervous', 'unknown']);
  });
});

describe('news (Upstox News API shapes)', () => {
  const now = istEpoch(DAY, '10:00');
  const data = {
    'NSE_EQ|A': [
      { heading: 'A wins a large order', summary: 's', thumbnail: 't', article_link: 'https://upstox.com/news/a1', published_time: now - 3600_000 },
      { heading: '  ', article_link: 'https://upstox.com/news/empty', published_time: now },
      { heading: 'Old story', article_link: 'javascript:alert(1)', published_time: now - 40 * 3600_000 },
    ],
    'NSE_EQ|B': [{ heading: 'A wins a large order', article_link: 'https://upstox.com/news/a1', published_time: now - 3600_000 }],
    bad: 'x',
  };
  it('keeps the headline, time and a safe link only', () => {
    const items = parseNews(data);
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({ key: 'NSE_EQ|A', heading: 'A wins a large order', link: 'https://upstox.com/news/a1', at: now - 3600_000 });
    expect(items.find((i) => i.heading === 'Old story')!.link).toBe('');
    expect(parseNews(null)).toEqual([]);
  });
  it('one line per article; "in the news" = a headline in the last 24 hours', () => {
    const items = parseNews(data);
    expect(headlines(items, 5).map((i) => i.heading)).toEqual(['A wins a large order', 'Old story']);
    expect([...inTheNews(items, now)].sort()).toEqual(['NSE_EQ|A', 'NSE_EQ|B']);
    expect(mergeNews(items, items, now)).toHaveLength(3);
    expect(mergeNews(items, [], now + 4 * 24 * 3600_000)).toHaveLength(3); // kept a week (app v1.7)
    expect(mergeNews(items, [], now + 8 * 24 * 3600_000)).toEqual([]);
  });
});

describe('automatic sync job (service worker)', () => {
  let chrome: ReturnType<typeof installChromeMock>;
  let positions: unknown[] = [];
  let calls = 0;
  const now = istEpoch(DAY, '09:40');
  beforeEach(async () => {
    chrome = installChromeMock();
    positions = [];
    calls = 0;
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.risk.capitalInr = 100_000;
    await chrome.storage.local.set({ settings, secrets: {}, auth: { status: 'logged_in', accessToken: 'tok', expiresAt: Math.max(now, Date.now()) + 10 * 3600_000 }, marketCalendar: null, plans: [], alerts: [], dayTrades: [], dayTest: null, watchlist: [K] });
    const db = await getDb();
    await db.clear('candles');
    await db.put('instruments', { instrument_key: K, trading_symbol: 'MOTHERSON', name: 'Samvardhana Motherson', isin: 'INE775A01035', tick: 0.05, lot_size: 1, instrument_type: 'EQ' });
    const closes = Array.from({ length: 300 }, (_, i) => 120 + i * 0.15 + (i % 2) * 0.6);
    const tx = db.transaction('candles', 'readwrite');
    for (const c of candlesFrom(closes, { start: '2025-09-01', volume: 5_000_000 })) void tx.store.put({ ...c, instrument_key: K });
    await tx.done;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = new URL(String(input));
        if (url.pathname === '/v2/portfolio/short-term-positions') {
          calls++;
          return new Response(JSON.stringify({ status: 'success', data: positions }), { status: 200 });
        }
        return new Response(JSON.stringify({ status: 'error', errors: [{ error_code: 'X', message: 'not mocked' }] }), { status: 404 });
      }),
    );
  });
  const titles = () => chrome.notifications.create.mock.calls.map((c) => String(c[1].title));
  const raw = (over: Record<string, unknown>) => ({ exchange: 'NSE', instrument_token: K, trading_symbol: 'MOTHERSON', product: 'I', quantity: 0, day_buy_quantity: 0, day_buy_price: 0, day_sell_quantity: 0, day_sell_price: 0, ...over });

  it('intraday buy in Upstox → watched day trade with stop and target → closed when sold, with the result', async () => {
    positions = [raw({ quantity: 100, day_buy_quantity: 100, day_buy_price: 163.1 })];
    expect(await syncPortfolio(now)).toMatchObject({ ok: true, changes: 1 });
    let trades = (await chrome.storage.local.get('dayTrades')).dayTrades as DayTrade[];
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ symbol: 'MOTHERSON', side: 'long', qty: 100, entry: 163.1, practice: false, status: 'open', auto: true });
    expect(trades[0]!.stop).toBeCloseTo(163.1 * 0.99, 0);
    expect(trades[0]!.target).toBeGreaterThan(163.1);
    expect(titles()[0]).toMatch(/^Found in Upstox: bought 100 MOTHERSON at ₹163\.10/);
    // within 10 seconds nothing is asked again
    expect(await syncPortfolio(now + 3_000)).toMatchObject({ skipped: 'recent' });
    expect(calls).toBe(1);
    positions = [raw({ quantity: 0, day_buy_quantity: 100, day_buy_price: 163.1, day_sell_quantity: 100, day_sell_price: 166.9 })];
    expect(await syncPortfolio(now + 11_000)).toMatchObject({ ok: true, changes: 1 });
    trades = (await chrome.storage.local.get('dayTrades')).dayTrades as DayTrade[];
    expect(trades[0]).toMatchObject({ status: 'closed', exitPrice: 166.9, exitReason: 'manual' });
    expect(titles().some((t) => /^MOTHERSON closed in Upstox: \+₹3\d\d$/.test(t))).toBe(true);
  });

  it('delivery buy in Upstox → trade with a sell-if-falls price, target, alerts and the GTT reminder', async () => {
    positions = [raw({ product: 'D', quantity: 100, day_buy_quantity: 100, day_buy_price: 163.1 })];
    expect(await syncPortfolio(now)).toMatchObject({ ok: true, changes: 1 });
    const st = await chrome.storage.local.get(['plans', 'alerts']);
    const p = (st.plans as TradePlan[])[0]!;
    expect(p).toMatchObject({ symbol: 'MOTHERSON', status: 'open', qty: 100, fillPrice: 163.1, auto: true, openedDate: DAY });
    expect(p.stop).toBeLessThan(163.1);
    expect(p.target).toBeGreaterThan(163.1);
    expect((st.alerts as Array<{ planId: string; kind: string }>).some((a) => a.planId === p.id && a.kind === 'stop')).toBe(true);
    const found = chrome.notifications.create.mock.calls.find((c) => String(c[1].title).startsWith('Found in Upstox: bought 100 MOTHERSON'));
    expect(String((found![1] as { message?: string }).message)).toMatch(/Create GTT → Sell 100, trigger ₹/);
    // sold next: the trade is closed here too
    positions = [raw({ product: 'D', quantity: 0, day_buy_quantity: 100, day_buy_price: 163.1, day_sell_quantity: 100, day_sell_price: 166.76 })];
    await syncPortfolio(now + 11_000);
    const after = ((await chrome.storage.local.get('plans')).plans as TradePlan[])[0]!;
    expect(after).toMatchObject({ status: 'closed', exitPrice: 166.76 });
    expect(titles().some((t) => t.startsWith('MOTHERSON sold in Upstox: +₹366'))).toBe(true);
  });

  it('not logged in / switched off → nothing is requested; an Upstox refusal is shown, not hidden', async () => {
    await chrome.storage.local.set({ auth: { status: 'logged_out' } });
    expect(await syncPortfolio(now)).toMatchObject({ skipped: 'not logged in' });
    await chrome.storage.local.set({ auth: { status: 'logged_in', accessToken: 'tok', expiresAt: Math.max(now, Date.now()) + 3600_000 } });
    const s = (await chrome.storage.local.get('settings')).settings as typeof DEFAULT_SETTINGS;
    s.portfolio.autoSync = false;
    await chrome.storage.local.set({ settings: s });
    expect(await syncPortfolio(now)).toMatchObject({ skipped: 'off' });
    expect(calls).toBe(0);
    s.portfolio.autoSync = true;
    await chrome.storage.local.set({ settings: s });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'error', errors: [{ error_code: 'UDAPI1154', message: 'Static IP is not whitelisted' }] }), { status: 403 })));
    expect(await syncPortfolio(now)).toMatchObject({ ok: false });
    expect((await chrome.storage.session.get('portfolioStatus')).portfolioStatus).toMatchObject({ ok: false, error: 'Static IP is not whitelisted' });
  });
});
