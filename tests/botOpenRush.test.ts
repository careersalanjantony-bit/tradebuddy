import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock } from './chromeMock';
import { newBrain } from '../src/bot/brain';
import { lostToday, newBot, runBot, setBotGate, setBotObserver, type BotState, type BotTrade } from '../src/background/botJobs';
import { EXIT_STYLES, type ExitStyle, type RushStyleResult } from '../src/bot/openRush';
import { istEpoch } from '../src/lib/time';
import { DEFAULT_SETTINGS } from '../src/storage/defaults';

/**
 * App v1.25 — the Opening rush in the auto-trader's loop (owner, 25 Nov 2026: "fast buy when the market
 * opens"): at 9:16 it buys a stock holding its opening jump at its high; the other kinds wait until 9:30;
 * no second try in a stock that lost today; a stale shared price no longer blocks a fresh idea.
 */

const DAY = '2026-11-23';
const AT = istEpoch(DAY, '09:16');
const K = 'NSE_EQ|INE002A01018';
const K2 = 'NSE_EQ|INE040A01034';

/** opened +1.2 % (100.2 vs 99), at its high since the open (101), above its average price (100.6) */
const quote = (key: string, ltp: number, at = AT, over: Record<string, unknown> = {}) => ({ [key]: { key, ltp, open: 100.2, high: 101, low: 100.1, volume: 50_000, prevClose: 99, vwap: 100.6, fetchedAt: at, ...over } });
const driveRow = {
  key: K,
  symbol: 'RELIANCE',
  name: 'Reliance Industries',
  state: 'holding',
  since: AT - 20_000,
  price: 101,
  open: 100.2,
  prevClose: 99,
  gapPct: 1.21,
  changePct: 2.02,
  fromOpenPct: 0.8,
  pace: 2.1,
  vwap: 100.6,
  buyShare: 0.65,
  plan: { breakout: 101.05, entry: 101.05, stop: 100.55, t1: 101.55, t2: 102.05 },
  size: { ok: true, qty: 99, value: 10_000, risk: 50, charges: 10, reward: 60 },
  score: 72,
  reasons: ['holding above its opening price ₹100.20', '2.1× usual volume'],
  warnings: [],
  missing: [],
  catalyst: null,
  preRank: 2,
  preScore: 64,
};
const early = (at = AT - 2_000, rows: unknown[] = [driveRow]) => ({ at, date: DAY, rows: [], drive: rows, driveOut: 0, expired: 0, tooRisky: 0, badNews: 0, capital: 10_000, maxRisk: 50 });

let chrome: ReturnType<typeof installChromeMock>;
const seed = async (b: Partial<BotState> = {}, now = AT) => chrome.storage.local.set({ bot: { ...newBot(now - 3_600_000, newBrain(), 100_000), lastRun: now - 60_000, rev: 5, ...b } });

beforeEach(async () => {
  chrome = installChromeMock();
  setBotGate(null);
  setBotObserver(null);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
  await chrome.storage.local.set({ settings: structuredClone(DEFAULT_SETTINGS), marketCalendar: null, watchlist: [], scanLists: null, auth: { status: 'logged_out' } });
  await chrome.storage.session.set({ quotes: quote(K, 101), early: early() });
});

const group = (trades: number, avg: number) => ({ trades, wins: Math.round(trades * 0.55), grossR: trades * avg, netR: trades * (avg - 0.15), pnl: trades * avg * 100 });
const rushTest = (best: ExitStyle) => ({
  days: 60,
  gapDays: 400,
  from: '2026-08-20',
  to: '2026-11-20',
  money: 100_000,
  riskShare: 0.0025,
  styles: Object.fromEntries(EXIT_STYLES.map((s) => [s, { all: group(40, 0.6), older: group(20, 0.6), newer: group(20, 0.6) }])) as Record<ExitStyle, RushStyleResult>,
  best,
  bestWhy: 'test',
});

describe('the Opening rush at 9:16 (app v1.25)', () => {
  it('buys a stock holding its opening jump at its high — a close safety net, "half and half" until the past test chooses', async () => {
    await seed();
    const b = (await runBot(AT, true))!;
    expect(b.trades).toHaveLength(1);
    const t = b.trades[0]!;
    expect(t).toMatchObject({ key: K, playbook: 'open-drive', strategy: 'breakout', side: 'long', state: 'watch', stop: 100.55, target: 101.9, status: 'open', product: 'intraday' });
    expect(t.reasons[0]).toMatch(/^Opening rush: opened \+1\.2% and holding it, at its high since the open/);
    expect(t.reasons).toContain('#2 on the pre-open list (score 64)');
    expect(t.reasons.at(-1)).toBe('sold: half and half');
    // learning size: 0.2 % of ₹1 lakh at risk at most — yet a big position, because the safety net is close
    expect(t.riskRupees).toBeLessThanOrEqual(200 + 5);
    expect(t.qty * t.entry).toBeGreaterThan(30_000);
    expect(b.log.at(-1)?.text).toMatch(/opening rush \(buy at the open\)/);
  });

  it('the other kinds still wait until 9:30', async () => {
    await seed();
    await chrome.storage.session.set({
      quotes: { ...quote(K, 101), ...quote(K2, 50, AT, { open: 50, high: 50.2, low: 49.8, prevClose: 50 }) },
      early: early(AT - 2_000, []),
      daySignals: { date: DAY, signals: [{ id: 'S', key: K2, symbol: 'HDFCBANK', side: 'long', at: AT - 20_000, barT: 555, entry: 50, stop: 49.5, target: 51, rvol: 2, orHigh: 50, orLow: 49.5, trusted: true, chance: 0.66 }] },
    });
    const b = (await runBot(AT, true))!;
    expect(b.trades).toHaveLength(0);
    expect(b.note).toMatch(/Opening rush \(9:15–9:35\).*The other kinds start at 9:30/);
  });

  it('not when it has fallen back under its high since the open', async () => {
    await seed();
    await chrome.storage.session.set({ quotes: quote(K, 100.7) });
    expect((await runBot(AT, true))!.trades).toHaveLength(0);
  });

  it('with a past test of 20+ good trades: the trial size, and the way of selling the test chose', async () => {
    await seed();
    await chrome.storage.local.set({ earlyTest: { rush: rushTest('quick') } });
    const b = (await runBot(AT, true))!;
    const t = b.trades[0]!;
    expect(t).toMatchObject({ playbook: 'open-drive', state: 'trial', target: 101.45 }); // quick profit: 1× the risk
    expect(t.reasons.at(-1)).toBe('sold: quick profit');
    expect(t.sizeWhy).toMatch(/^Trial kind \(small size\)/);
    const e = b.evidence!.list.find((x) => x.id === 'open-drive')!;
    expect(e.prior).toMatchObject({ trades: 40 });
    expect(e.prior!.label).toMatch(/^Opening rush past test \("Quick profit"\), 2026-08-20–2026-11-20/);
    expect(e.why).toMatch(/its past test \(40 trades, \+0\.60 R\)/);
    // the screen gets the ways of selling in short (the phone shows the server's state)
    expect(b.rush).toMatchObject({ best: 'quick', from: '2026-08-20', to: '2026-11-20', why: 'test' });
    expect(b.rush!.styles.runner).toEqual({ trades: 40, wins: 22, avgNetR: 0.45 });
  });

  it('looks every 15 seconds in the Opening rush window (once a minute after)', async () => {
    await seed({ lastDecideAt: AT - 20_000 });
    await chrome.storage.session.set({ early: early(AT - 2_000) });
    expect((await runBot(AT))!.trades).toHaveLength(1);
  });
});

describe('no second try in a stock that lost money today (BAJAJHCARE, 25 Nov)', () => {
  const NOW = istEpoch(DAY, '11:06');
  const lost = { id: 'T1', key: K, symbol: 'RELIANCE', strategy: 'breakout', playbook: 'intraday-buy', side: 'long', qty: 10, entry: 100, stop: 99, stop0: 99, target: 102, openedAt: NOW - 3_600_000, closedAt: NOW - 2_400_000, date: DAY, x: [], chance: 0.5, prior: 0.5, riskRupees: 10, explore: false, reasons: ['Intraday scanner: BUY'], status: 'closed', r: -1.4, pnl: -14 } as unknown as BotTrade;
  const intraday = (at: number, price = 100) => ({
    date: DAY,
    at,
    universe: 2000,
    priced: 1900,
    candidates: 40,
    rows: [{ key: K, symbol: 'RELIANCE', call: 'BUY', score: 85, why: 'broke the opening range with volume', checks: [], price, changePct: 1.2, fromOpenPct: 1, rvol: 2, vwap: 99.5, buyers: 0.6, ema9: 99.8, ema21: 99.4, orHigh: 99.9, breakoutT: 600, plan: { entry: 100, stop: 99, target: 102, rr: 2 }, size: null, valueCr: 50, at }],
    counts: { buy: 1, wait: 0, noTrade: 0 },
    gate: null,
  });

  it('the list of stocks that lost today', () => {
    expect(lostToday([lost, { ...lost, id: 'T2', key: K2, r: 0.8 }, { ...lost, id: 'T3', date: '2026-11-20' }], DAY)).toEqual([K]);
  });

  it('skipped, and said so', async () => {
    await seed({ trades: [lost] }, NOW);
    await chrome.storage.session.set({ quotes: quote(K, 100, NOW, { open: 99, high: 100.2, low: 98.8, prevClose: 98.8 }), early: null, intraday: intraday(NOW - 5_000) });
    const b = (await runBot(NOW, true))!;
    expect(b.trades.filter((t) => t.status === 'open')).toHaveLength(0);
    expect(b.note).toMatch(/already lost money today/);
  });

  it('a stale shared price no longer blocks a fresh idea: the fresher price is used', async () => {
    await seed({}, NOW);
    // the shared price of K is 5 minutes old; the Intraday scanner read it 5 seconds ago; another stock is fresh
    await chrome.storage.session.set({ quotes: { ...quote(K, 100, NOW - 300_000, { open: 99, high: 100.2, low: 98.8, prevClose: 98.8 }), ...quote(K2, 50, NOW, { open: 50, high: 50.2, low: 49.8, prevClose: 50 }) }, early: null, intraday: intraday(NOW - 5_000) });
    const b = (await runBot(NOW, true))!;
    expect(b.log.filter((l) => /not up to date/.test(l.text))).toHaveLength(0);
    expect(b.trades[0]).toMatchObject({ key: K, playbook: 'intraday-buy', status: 'open' });
  });
});
