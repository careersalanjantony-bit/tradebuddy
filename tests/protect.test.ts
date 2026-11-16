import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock } from './chromeMock';
import { newBrain, type IdeaContext } from '../src/bot/brain';
import { BOT_START, decide, type Book, type Idea } from '../src/bot/policy';
import { DEFAULT_PROTECT, checkDay, keepLevel, manageTrade, maxOpenFor, maxPositionFor, protectRules, skipIdea, type TradeView } from '../src/bot/protect';
import { runProtectTest, type ProtectTestDay } from '../src/bot/protectTest';
import { copySteps } from '../src/bot/copy';
import { botSetAmount, newBot, runBot, type BotState, type BotTrade } from '../src/background/botJobs';
import { newWallet, placeOrder, walletSummary } from '../src/wallet/wallet';
import type { Bars } from '../src/daytrade/types';
import { istEpoch } from '../src/lib/time';
import { DEFAULT_SETTINGS } from '../src/storage/defaults';

const R = DEFAULT_PROTECT;

describe('keep the day’s profit, daily loss limit', () => {
  const money = 1_000_000;
  it('once the day is up 0.4 %, giving back half of the best result stops the day', () => {
    let g = checkDay(undefined, 'D', 2_000, money, R, 1).guard; // +0.2 %: not yet
    expect(keepLevel(g, money, R)).toBeNull();
    g = checkDay(g, 'D', 5_000, money, R, 2).guard; // +0.5 %: best 5,000 — keeps at least 2,500
    expect(keepLevel(g, money, R)).toBe(2_500);
    const a = checkDay(g, 'D', 3_000, money, R, 3);
    expect(a.justHalted).toBeNull();
    const b = checkDay(a.guard, 'D', 2_400, money, R, 4);
    expect(b.justHalted).toBe('lock');
    expect(b.guard).toMatchObject({ halted: 'lock', best: 5_000, pnlAtHalt: 2_400, haltedAt: 4 });
    // once stopped it stays stopped today (no second alert), and a new day starts fresh
    expect(checkDay(b.guard, 'D', -50_000, money, R, 5).justHalted).toBeNull();
    expect(checkDay(b.guard, 'E', 0, money, R, 6).guard).toEqual({ date: 'E', best: 0, halted: null });
  });
  it('the daily loss limit: −1 % of the money', () => {
    expect(checkDay(undefined, 'D', -9_999, money, R, 1).justHalted).toBeNull();
    expect(checkDay(undefined, 'D', -10_000, money, R, 1).justHalted).toBe('loss');
  });
  it('off = no day limits (as before)', () => {
    const off = { ...R, on: false };
    expect(checkDay(undefined, 'D', -500_000, money, off, 1).justHalted).toBeNull();
    expect(protectRules(undefined)).toEqual(DEFAULT_PROTECT);
    expect(protectRules({ dayLossPct: 2 }).dayLossPct).toBe(2);
  });
});

describe('each trade: safety net follows the price, half at 1× the risk, quick exit', () => {
  const at = (min: number) => min * 60_000;
  const long = (over: Partial<TradeView> = {}): TradeView => ({ side: 'long', entry: 100, stop: 98, stop0: 98, target: 104, best: 100, sameDay: true, openedAt: 0, ...over });
  it('same day: the buy price at 0.75× the risk, then it follows the best price at 0.75× the risk', () => {
    expect(manageTrade(long(), 101.4, at(5), R).stop).toBe(98);
    expect(manageTrade(long(), 101.5, at(5), R).stop).toBe(100); // +0.75 R → buy price
    expect(manageTrade(long(), 103, at(5), R).stop).toBe(101.5); // best 103 − 1.5
    // never moves back down
    expect(manageTrade(long({ stop: 101.5, best: 103 }), 101.8, at(6), R).stop).toBe(101.5);
  });
  it('sells half at 1× the risk when the target is further away', () => {
    expect(manageTrade(long(), 102, at(5), R).sellHalf).toBe(true);
    expect(manageTrade(long({ halfDone: true }), 102, at(5), R).sellHalf).toBe(false);
    expect(manageTrade(long({ target: 102.2 }), 102, at(5), R).sellHalf).toBe(false); // the target sells all
  });
  it('a same-day trade that went nowhere for 45 minutes is closed; not a few-days pick', () => {
    expect(manageTrade(long(), 100.1, at(44), R).exit).toBeNull();
    expect(manageTrade(long(), 100.1, at(45), R).exit).toBe('quick');
    expect(manageTrade(long({ best: 100.8 }), 100.1, at(60), R).exit).toBeNull(); // it did move
    expect(manageTrade(long({ sameDay: false }), 100.1, at(600), R).exit).toBeNull();
    expect(manageTrade(long(), 100.1, at(600), { ...R, quickExitMin: 0 }).exit).toBeNull();
  });
  it('few-days picks: the buy price at 1× the risk, then 1× the risk behind the best price', () => {
    const sw = long({ sameDay: false, stop: 92, stop0: 92, target: 115 });
    expect(manageTrade(sw, 106, at(5), R).stop).toBe(92);
    expect(manageTrade(sw, 108, at(5), R).stop).toBe(100);
    expect(manageTrade(sw, 117, at(5), R).stop).toBe(109);
  });
  it('sell first: the same, mirrored', () => {
    const sh: TradeView = { side: 'short', entry: 100, stop: 102, stop0: 102, target: 96, best: 100, sameDay: true, openedAt: 0 };
    expect(manageTrade(sh, 98.5, at(5), R).stop).toBe(100);
    expect(manageTrade(sh, 97, at(5), R).stop).toBe(98.5);
    expect(manageTrade(sh, 98, at(5), R).sellHalf).toBe(false); // sell-first buys back half at its own target 1
  });
  it('off: only the old rule (buy price at 1× the risk)', () => {
    const off = { ...R, on: false };
    expect(manageTrade(long(), 101.5, at(5), off)).toEqual({ stop: 98, sellHalf: false, exit: null });
    expect(manageTrade(long(), 102, at(500), off)).toEqual({ stop: 100, sellHalf: false, exit: null });
  });
});

describe('new trades with the protection', () => {
  const ctx = (o: Partial<IdeaContext>): IdeaContext => ({ strategy: 'day-buy', prior: 0.6, movePct: 0, pressure: 0, breadth: 0, t: 630, news: 0, vwapPct: 0, riskPct: 1, ...o });
  const idea = (key: string, over: Partial<Idea> = {}): Idea => ({ key, symbol: key, strategy: 'day-buy', side: 'long', price: 1000, stop: 990, target: 1030, ctx: ctx({}), reasons: ['t'], ...over });
  const book = (over: Partial<Book> = {}): Book => ({ equity: 100_000, free: 100_000, openKeys: [], openCount: 0, newToday: 0, todayPnl: 0, t: 630, rules: R, halted: null, swingValue: 0, ...over });
  it('one stock per ₹25,000 (1–10), each at most a fair share of the money', () => {
    expect([maxOpenFor(10_000), maxOpenFor(100_000), maxOpenFor(5_000_000)]).toEqual([1, 4, 10]);
    expect(maxPositionFor(100_000)).toBe(35_000);
    expect(maxPositionFor(5_000_000)).toBe(750_000);
    const ideas = ['A', 'B', 'C', 'D', 'E', 'F'].map((k) => idea(k));
    const plan = decide(newBrain(), ideas, book(), 'no-explore-seed-1');
    expect(plan.decisions.length).toBeLessThanOrEqual(4);
    for (const d of plan.decisions) expect(d.qty * d.idea.price).toBeLessThanOrEqual(35_000);
    expect(decide(newBrain(), ideas, book({ openCount: 4, openKeys: ['X1', 'X2', 'X3', 'X4'] }), 's').note).toMatch(/Holding 4 trades — the most for ₹1,00,000/);
  });
  it('stopped for the day = nothing new', () => {
    expect(decide(newBrain(), [idea('A')], book({ halted: 'lock' }), 's').note).toMatch(/kept today's profit/);
    expect(decide(newBrain(), [idea('A')], book({ halted: 'loss' }), 's').decisions).toHaveLength(0);
  });
  it('few-days picks only up to their share (30 %)', () => {
    const sw = idea('S', { strategy: 'swing', stop: 920, target: 1150, ctx: ctx({ strategy: 'swing', prior: 0.7 }) });
    const d = decide(newBrain(), [sw], book(), 'no-explore-seed-1').decisions[0]!;
    expect(d.qty * 1000).toBeLessThanOrEqual(30_000);
    expect(decide(newBrain(), [sw], book({ swingValue: 30_000 }), 'no-explore-seed-1').decisions).toHaveLength(0);
  });
  it('skips bad news and trades against the whole market', () => {
    expect(skipIdea({ news: -1, breadth: 0 }, R)).toMatch(/news/);
    expect(skipIdea({ news: 0, breadth: -0.5 }, R)).toMatch(/market/);
    expect(skipIdea({ news: -1, breadth: -1 }, { ...R, on: false })).toBeNull();
    const plan = decide(newBrain(), [idea('A', { ctx: ctx({ news: -1 }) }), idea('B', { ctx: ctx({ breadth: -0.6 }) })], book(), 's');
    expect(plan.decisions).toHaveLength(0);
    expect(plan.note).toMatch(/Skipped 2 ideas/);
  });
});

describe('copy in Upstox', () => {
  it('gives the exact order steps (the app never places them)', () => {
    const buy = copySteps({ symbol: 'TATASTEEL', side: 'long', qty: 25, entry: 150.2, stop: 148.5, target: 153, swing: false });
    expect(buy[0]).toBe('Upstox → TATASTEEL → Buy → Intraday → 25 shares → Limit ₹150.20.');
    expect(buy[1]).toMatch(/Sell → Intraday → Stop-loss: trigger ₹148.50/);
    expect(buy[2]).toMatch(/by 3:10 pm/);
    expect(copySteps({ symbol: 'X', side: 'long', qty: 3, entry: 10, stop: 9, target: 12, swing: true })[0]).toMatch(/Delivery/);
    expect(copySteps({ symbol: 'Y', side: 'short', qty: 4, entry: 10, stop: 10.5, target: 9, t1: 9.5, swing: false })[0]).toMatch(/Sell → Intraday → 4 shares/);
  });
});

// ---------------------------------------------------------------- the past test

/** A 5-minute day: 9:15 … 15:25, flat at 100 for the first 15 minutes, then `path` (one close per bar). */
function day(path: number[], vol = 1000): Bars {
  const t: number[] = [];
  const o: number[] = [];
  const h: number[] = [];
  const l: number[] = [];
  const c: number[] = [];
  const v: number[] = [];
  const closes = [100, 100.2, 100.1, ...path];
  let prev = 100;
  for (let i = 0; i < 75; i++) {
    const x = closes[Math.min(i, closes.length - 1)]!;
    t.push(555 + i * 5);
    o.push(prev);
    h.push(Math.max(prev, x) + 0.05);
    l.push(Math.min(prev, x) - 0.05);
    c.push(x);
    v.push(vol);
    prev = x;
  }
  return { t, o, h, l, c, v };
}

describe('past test: old way vs protected (same trades)', () => {
  it('a good start that turns around: the protection keeps part of it; a bad day loses less', () => {
    // breaks out at 9:30 to 101, runs to 102.5, then falls back below the start by the afternoon
    const turn = [101, 101.5, 102, 102.5, 102.4, 102.2, 101.8, 101.2, 100.6, 100.2, 99.9, 99.8];
    // breaks out, then drifts and does nothing (the old way waits until 3:10)
    const flat = [101, 101.1, 100.9, 101, 100.95, 101.05, 100.9, 100.6];
    const days: ProtectTestDay[] = Array.from({ length: 12 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, '0')}`, stocks: [{ key: 'A', bars: day(i % 2 ? turn : flat) }, { key: 'B', bars: day(turn) }] }));
    const r = runProtectTest(days, 100_000, R)!;
    expect(r.days).toBe(12);
    expect(r.trades).toBe(24);
    expect(r.protected.pnl).toBeGreaterThan(r.old.pnl);
    expect(r.protected.worstDay).toBeGreaterThanOrEqual(r.old.worstDay);
    expect(r.old.gaveBackDays).toBeGreaterThanOrEqual(r.protected.gaveBackDays);
  });
  it('needs at least 10 days with trades', () => {
    expect(runProtectTest([{ date: 'd', stocks: [{ key: 'A', bars: day([101, 102]) }] }], 100_000, R)).toBeNull();
  });
});

// ---------------------------------------------------------------- live: amount and the day's stop

describe('the auto-trader with your amount and the day’s stop', () => {
  const NOW = istEpoch('2026-11-16', '10:30');
  const K = 'NSE_EQ|INE002A01018';
  let chrome: ReturnType<typeof installChromeMock>;
  const quote = (ltp: number) => ({ [K]: { key: K, ltp, open: 1000, high: 1000, low: ltp, volume: 1000, prevClose: 1000, fetchedAt: NOW } });
  const withTrade = (minutesAgo = 20): BotState => {
    const bot = newBot(NOW - 3600_000, newBrain(), 100_000);
    const ctx = { now: NOW - minutesAgo * 60_000, today: '2026-11-16', t: 10 * 60 + 30 - minutesAgo, open: true };
    const r = placeOrder(bot.wallet, { key: K, symbol: 'RELIANCE', side: 'buy', qty: 30, type: 'market', stop: 950, target: 1100, sellByClose: true, product: 'intraday', marginPct: 1 }, { ltp: 1000, prevClose: 1000, fetchedAt: ctx.now }, ctx);
    if (!r.ok || !r.fill) throw new Error('no fill');
    const trade: BotTrade = { id: 'T1', key: K, symbol: 'RELIANCE', strategy: 'day-buy', side: 'long', qty: 30, entry: r.fill.price, stop: 950, stop0: 950, target: 1100, openedAt: ctx.now, date: '2026-11-16', x: [], chance: 0.6, prior: 0.6, riskRupees: 1500, explore: false, reasons: [], sizeWhy: '', status: 'open', best: r.fill.price, worst: r.fill.price, product: 'intraday' };
    return { ...bot, wallet: r.wallet, trades: [trade], lastRun: NOW - 60_000, lastDecideAt: 0 };
  };
  beforeEach(async () => {
    chrome = installChromeMock();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    const settings = structuredClone(DEFAULT_SETTINGS);
    await chrome.storage.local.set({ settings, marketCalendar: null, watchlist: [], scanLists: null, auth: { status: 'logged_out' } });
  });

  it('set the amount: adds or takes out cash, keeps open trades; not below what is in trades', async () => {
    await chrome.storage.local.set({ bot: withTrade() });
    await chrome.storage.session.set({ quotes: quote(1000) });
    const r = await botSetAmount(150_000, NOW);
    expect(Math.round(r.total)).toBe(150_000);
    let bot = (await chrome.storage.local.get('bot')).bot as BotState;
    expect(bot.trades).toHaveLength(1);
    expect(Math.round(walletSummary(bot.wallet, { [K]: { ltp: 1000, prevClose: 1000, fetchedAt: NOW } }, '2026-11-16').total)).toBe(150_000);
    await botSetAmount(40_000, NOW);
    bot = (await chrome.storage.local.get('bot')).bot as BotState;
    expect(Math.round(walletSummary(bot.wallet, { [K]: { ltp: 1000, prevClose: 1000, fetchedAt: NOW } }, '2026-11-16').total)).toBe(40_000);
    await expect(botSetAmount(20_000, NOW)).rejects.toThrow(/in open trades right now/);
    await expect(botSetAmount(5_000, NOW)).rejects.toThrow(/at least ₹10,000/);
  });

  it('a −1 % day: sells what it bought today, stops for the day, and says so', async () => {
    await chrome.storage.local.set({ bot: withTrade() });
    await chrome.storage.session.set({ quotes: quote(960) }); // 30 × −40 = −1,200 + charges > 1 % of ₹1 lakh
    const bot = (await runBot(NOW, false))!;
    expect(bot.guard).toMatchObject({ date: '2026-11-16', halted: 'loss' });
    expect(bot.trades[0]).toMatchObject({ status: 'closed', exitWhy: 'sold at the daily loss limit' });
    expect(bot.log.some((l) => /Stopped for today: daily loss limit/.test(l.text))).toBe(true);
    expect(bot.note).toMatch(/daily loss limit/);
  });

  it('a good start: the safety net follows the price, half is sold at 1× the risk', async () => {
    await chrome.storage.local.set({ bot: withTrade() });
    await chrome.storage.session.set({ quotes: quote(1052) }); // just over +1× the risk
    const bot = (await runBot(NOW, false))!;
    const t = bot.trades[0]!;
    expect(t.halfDone).toBe(true);
    expect(t.left).toBe(15);
    expect(t.stop).toBeGreaterThanOrEqual(t.entry);
    expect(bot.wallet.holdings[0]!.qty).toBe(15);
  });

  it('a trade not working after 45 minutes is closed early, in plain words', async () => {
    await chrome.storage.local.set({ bot: withTrade(50) });
    await chrome.storage.session.set({ quotes: quote(990) }); // −0.2× the risk, never up
    const bot = (await runBot(NOW, false))!;
    expect(bot.trades[0]).toMatchObject({ status: 'closed', exitWhy: 'not working after 45 minutes — closed early to cut the loss' });
    expect(bot.guard?.halted ?? null).toBeNull();
  });
});
