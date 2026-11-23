import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock } from './chromeMock';
import { newBrain } from '../src/bot/brain';
import { botDigest, botView, canonicalJson, classifyCutover, parseCommand, summarizeBot, validateBotState, type BotSummary } from '../src/bot/cloud';
import { BotConflictError, BotElsewhereError, botReset, botSetAmount, botSetEnabled, botSetRules, newBot, runBot, setBotGate, setBotObserver, type BotRunInfo, type BotState, type BotTrade } from '../src/background/botJobs';
import { istEpoch } from '../src/lib/time';
import { DEFAULT_SETTINGS } from '../src/storage/defaults';
import { provenRecord } from './botHelpers';

/** App v1.22 — the cloud auto-trader's shared rules: the comparison, the checks, and the one-writer gate. */

const NOW = istEpoch('2026-11-23', '10:30');
const K = 'NSE_EQ|INE002A01018';

const trade = (id: string, status: 'open' | 'closed', over: Partial<BotTrade> = {}): BotTrade => ({ id, key: K, symbol: 'RELIANCE', strategy: 'day-buy', side: 'long', qty: 1, entry: 100, stop: 99, stop0: 99, target: 102, openedAt: 1, date: '2026-11-23', x: [], chance: 0.6, prior: 0.6, riskRupees: 1, explore: false, reasons: [], sizeWhy: '', status, ...over });

describe('the same auto-trader gives the same digest everywhere', () => {
  it('canonical JSON does not depend on key order; the digest ignores the save counters only', async () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }));
    const bot = newBot(1, newBrain(), 100_000);
    const d = await botDigest(bot);
    expect(await botDigest({ ...bot, rev: 99, updatedAt: 5 })).toBe(d);
    expect(await botDigest(JSON.parse(JSON.stringify(bot)))).toBe(d); // after the wire
    expect(await botDigest({ ...bot, wallet: { ...bot.wallet, cash: 99_999 } })).not.toBe(d);
  });
});

describe('the choice before the move — never a merge', () => {
  const s = (over: Partial<BotSummary> = {}): BotSummary => ({ createdAt: 1, rev: 1, updatedAt: 1, enabled: true, startCash: 100, cash: 100, openTrades: 0, closedTrades: 0, fills: 0, learnedFrom: 0, wins: 0, lastTradeAt: null, lastRun: 0, digest: 'x', ...over });
  it('nothing anywhere: just start on the server', () => {
    expect(classifyCutover(null, null)).toMatchObject({ kind: 'nothing', recommended: 'fresh', choices: ['fresh'] });
    expect(classifyCutover(s(), null)).toMatchObject({ kind: 'nothing', recommended: 'import' });
  });
  it('only the phone traded → move the phone’s; only the server → keep the server’s', () => {
    expect(classifyCutover(s({ closedTrades: 3, digest: 'p' }), s({ digest: 's' }))).toMatchObject({ kind: 'phone-only', recommended: 'import', choices: ['import', 'fresh'] });
    expect(classifyCutover(s({ digest: 'p' }), s({ learnedFrom: 2, digest: 's' }))).toMatchObject({ kind: 'server-only', recommended: 'keep-server' });
  });
  it('both traded separately: one of them, chosen by the owner; identical = the same one', () => {
    const c = classifyCutover(s({ fills: 4, digest: 'p' }), s({ cash: 90, digest: 's' }));
    expect(c.kind).toBe('conflict');
    expect(c.choices).toEqual(['import', 'keep-server', 'fresh']);
    expect(c.text).toMatch(/never mixed/);
    expect(classifyCutover(s({ fills: 4, digest: 'same' }), s({ fills: 4, digest: 'same' }))).toMatchObject({ kind: 'same', recommended: 'keep-server' });
  });
});

describe('what the server accepts from a phone', () => {
  it('a real auto-trader passes; broken ones are refused in plain words', async () => {
    const bot = newBot(1, newBrain(), 100_000);
    expect(validateBotState(JSON.parse(JSON.stringify(bot)))).toBeTruthy();
    expect(() => validateBotState(null)).toThrow(/not an object/);
    expect(() => validateBotState({ ...bot, wallet: { ...bot.wallet, cash: 'lots' } })).toThrow(/wallet/);
    expect(() => validateBotState({ ...bot, brain: { ...bot.brain, w: ['x'] } })).toThrow(/brain/);
    expect(() => validateBotState({ ...bot, trades: [trade('A', 'open'), trade('A', 'closed')] })).toThrow(/same id/);
    expect(() => validateBotState({ ...bot, trades: Array.from({ length: 2_001 }, (_, i) => trade(`T${i}`, 'closed')) })).toThrow(/too many/);
  });
  it('controls: only known ones, only the levels the screen offers', () => {
    expect(parseCommand({ type: 'enable', enabled: false })).toEqual({ type: 'enable', enabled: false });
    expect(parseCommand({ type: 'amount', amount: 150_000.4 })).toEqual({ type: 'amount', amount: 150_000 });
    expect(parseCommand({ type: 'rules', rules: { dayLossPct: 1.5, on: true } })).toEqual({ type: 'rules', rules: { dayLossPct: 1.5, on: true } });
    expect(() => parseCommand({ type: 'amount', amount: 500 })).toThrow(/10,000/);
    expect(() => parseCommand({ type: 'rules', rules: { dayLossPct: 9 } })).toThrow(/one of/);
    expect(() => parseCommand({ type: 'rules', rules: { giveBack: 0.9 } })).toThrow(/Unknown protection/);
    expect(() => parseCommand({ type: 'order', side: 'buy' })).toThrow(/Unknown control/); // nothing like an order exists
    expect(() => parseCommand({ type: 'reset', forget: 'yes', startCash: 100_000 })).toThrow();
    // app v1.23: switch a kind of trade off / on, resume after the drawdown stop
    expect(parseCommand({ type: 'playbook', playbook: 'rise-flow', off: true })).toEqual({ type: 'playbook', playbook: 'rise-flow', off: true });
    expect(parseCommand({ type: 'resume', extra: 1 })).toEqual({ type: 'resume' });
    // app v1.24: prove each kind first (shadow trades) or buy small while it learns
    expect(parseCommand({ type: 'rules', rules: { proveFirst: true } })).toEqual({ type: 'rules', rules: { proveFirst: true } });
    expect(() => parseCommand({ type: 'rules', rules: { proveFirst: 'yes' } })).toThrow(/proveFirst must be true or false/);
    expect(() => parseCommand({ type: 'playbook', playbook: 'options', off: true })).toThrow(/Unknown kind of trade/);
    expect(() => parseCommand({ type: 'playbook', playbook: 'day-buy', off: 'yes' })).toThrow(/true or false/);
  });
  it('the screen copy keeps every open trade, the latest finished ones, today’s fills and the latest log', () => {
    const bot = newBot(1, newBrain(), 100_000);
    const trades = [trade('OPEN', 'open'), ...Array.from({ length: 100 }, (_, i) => trade(`C${i}`, 'closed'))];
    const fills = Array.from({ length: 300 }, (_, i) => ({ key: K, symbol: 'X', side: 'sell', qty: 1, price: 1, at: i, date: i < 10 ? '2026-11-23' : '2026-11-20', reason: 'manual' }));
    const v = botView({ ...bot, trades, wallet: { ...bot.wallet, fills: fills as never }, log: Array.from({ length: 150 }, (_, i) => ({ at: i, kind: 'info' as const, text: String(i) })) }, '2026-11-23');
    expect(v.trades.filter((t) => t.status === 'open').map((t) => t.id)).toEqual(['OPEN']);
    expect(v.trades.filter((t) => t.status === 'closed')).toHaveLength(60);
    expect(v.trades.at(-1)!.id).toBe('C99');
    expect(v.wallet.fills).toHaveLength(130); // today's 10 + the latest 120
    expect(v.log).toHaveLength(60);
    expect(v.brain).toBe(bot.brain);
  });
});

describe('app v1.23: shadow trades and evidence in the shared state', () => {
  const shadowOf = (trades: BotTrade[]) => ({ wallet: newBot(1).wallet, trades, day: { date: '2026-11-23', opened: trades.length } });
  it('the state check accepts shadow trades and evidence, and refuses broken ones', () => {
    const bot = { ...newBot(1, newBrain(), 100_000), shadow: shadowOf([trade('S1', 'open', { shadow: true })]), samples: { 'day-buy': [{ at: 1, grossR: 1, netR: 0.9 }] } };
    expect(validateBotState(JSON.parse(JSON.stringify(bot)))).toBeTruthy();
    expect(() => validateBotState({ ...bot, shadow: { ...bot.shadow, wallet: { v: 2 } } })).toThrow(/shadow wallet/);
    expect(() => validateBotState({ ...bot, shadow: { ...bot.shadow, trades: [trade('X', 'open'), trade('X', 'closed')] } })).toThrow(/same id \(shadow trades\)/);
    expect(() => validateBotState({ ...bot, samples: { options: [] } })).toThrow(/Unknown kind of trade/);
    expect(() => validateBotState({ ...bot, samples: { 'day-buy': [{ at: 1, grossR: 'big', netR: 1 }] } })).toThrow(/evidence of day-buy/);
    expect(() => validateBotState({ ...bot, samples: { 'day-buy': Array.from({ length: 61 }, () => ({ at: 1, grossR: 1, netR: 1 })) } })).toThrow(/too many/);
  });
  it('the screen copy keeps open shadow trades and the latest 30 finished, without their fills', () => {
    const sh = shadowOf([trade('SO', 'open', { shadow: true }), ...Array.from({ length: 50 }, (_, i) => trade(`SC${i}`, 'closed', { shadow: true }))]);
    const fills = Array.from({ length: 40 }, (_, i) => ({ key: K, symbol: 'X', side: 'sell', qty: 1, price: 1, at: i, date: '2026-11-23', reason: 'manual' }));
    const v = botView({ ...newBot(1), shadow: { ...sh, wallet: { ...sh.wallet, fills: fills as never } } }, '2026-11-23');
    expect(v.shadow!.trades.filter((t) => t.status === 'open').map((t) => t.id)).toEqual(['SO']);
    expect(v.shadow!.trades.filter((t) => t.status === 'closed')).toHaveLength(30);
    expect(v.shadow!.wallet.fills).toEqual([]);
    expect(botView(newBot(1), '2026-11-23').shadow).toBeUndefined();
  });
});

describe('one writer: the gate, the versions, the old prices', () => {
  let chrome: ReturnType<typeof installChromeMock>;
  const quote = (ltp: number, fetchedAt = NOW) => ({ [K]: { key: K, ltp, open: 100, high: 101, low: 99, volume: 1000, prevClose: 100, fetchedAt } });
  beforeEach(async () => {
    chrome = installChromeMock();
    setBotGate(null);
    setBotObserver(null);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    await chrome.storage.local.set({ settings: structuredClone(DEFAULT_SETTINGS), marketCalendar: null, watchlist: [], scanLists: null, auth: { status: 'logged_out' }, bot: { ...newBot(NOW - 3_600_000, newBrain(), 100_000), samples: provenRecord('day-buy'), lastRun: NOW - 60_000, rev: 5 } });
    await chrome.storage.session.set({ quotes: quote(100) });
  });
  const bot = async () => (await chrome.storage.local.get('bot')).bot as BotState;

  it('a closed gate: no run, no change — and the reason is reported', async () => {
    const skipped: string[] = [];
    setBotGate({ check: () => ({ run: false, write: false, reason: 'runs on the server' }) });
    setBotObserver({ onSkip: (r) => void skipped.push(r) });
    const before = await bot();
    expect(await runBot(NOW, true)).toBeNull();
    await expect(botSetEnabled(false, NOW)).rejects.toBeInstanceOf(BotElsewhereError);
    await expect(botSetAmount(200_000, NOW)).rejects.toThrow(/runs on the server/);
    await expect(botSetRules({ on: false }, NOW)).rejects.toBeInstanceOf(BotElsewhereError);
    await expect(botReset(false, 100_000, NOW)).rejects.toBeInstanceOf(BotElsewhereError);
    expect(await bot()).toEqual(before);
    expect(skipped).toEqual(['runs on the server']);
    setBotGate(null);
  });

  it('a new version for every change that matters, not for the every-30-seconds "still running" saves', async () => {
    await runBot(NOW, false); // nothing happened: saved (30 s passed) but the same version
    expect((await bot()).rev).toBe(5);
    expect((await bot()).updatedAt).toBe(NOW);
    await botSetEnabled(false, NOW + 1_000);
    expect((await bot()).rev).toBe(6);
    await botSetRules({ dayLossPct: 2 }, NOW + 2_000);
    expect((await bot()).rev).toBe(7);
  });

  it('a change made on a version nobody looked at is refused; the backup hook sees the state just before', async () => {
    await expect(botReset(false, 100_000, NOW, { ifRev: 4 })).rejects.toBeInstanceOf(BotConflictError);
    const seen: Array<BotState | null> = [];
    await botReset(true, 200_000, NOW, { ifRev: 5, by: { name: 'Pixel' }, backup: (b) => void seen.push(b) });
    expect(seen[0]!.rev).toBe(5);
    const b = await bot();
    expect(b).toMatchObject({ rev: 6, wallet: { startCash: 200_000 } });
    expect(b.log.at(-1)!.text).toMatch(/\(from Pixel\)/);
  });

  it('old prices: no new trades, says why, and reports itself as stale (open trades are only managed on fresh prices)', async () => {
    const runs: BotRunInfo[] = [];
    setBotObserver({ onRun: (i) => void runs.push(i) });
    await chrome.storage.session.set({ quotes: quote(100, NOW - 5 * 60_000), daySignals: { date: '2026-11-23', signals: [{ id: 'S', key: K, symbol: 'RELIANCE', side: 'long', at: NOW - 20_000, barT: 629, entry: 100, stop: 99, target: 102, rvol: 2, orHigh: 100, orLow: 99, trusted: true, chance: 0.66 }] } });
    const b = (await runBot(NOW, true))!;
    expect(b.trades).toHaveLength(0);
    expect(b.note).toMatch(/Prices are not up to date \(the newest is from 10:25\)/);
    expect(runs.at(-1)).toMatchObject({ stale: true, decided: false, opened: 0, priceAt: NOW - 5 * 60_000 });
    // the same idea with a fresh price is taken
    await chrome.storage.session.set({ quotes: quote(100.05) });
    const c = (await runBot(NOW + 1_000, true))!;
    expect(c.trades).toHaveLength(1);
    expect(runs.at(-1)).toMatchObject({ stale: false, decided: true, opened: 1 });
    expect(c.rev).toBe(6);
  });

  it('an error in a run is reported (the server shows it) and still reaches the caller', async () => {
    const errors: string[] = [];
    setBotObserver({ onError: (e) => void errors.push(String(e)) });
    await chrome.storage.local.set({ bot: { enabled: true, broken: true } });
    await expect(runBot(NOW, true)).rejects.toThrow();
    expect(errors).toHaveLength(1);
  });

  it('summaries count what matters', async () => {
    const s = (await summarizeBot({ ...(await bot()), trades: [trade('A', 'open'), trade('B', 'closed', { closedAt: 50 })] }))!;
    expect(s).toMatchObject({ openTrades: 1, closedTrades: 1, rev: 5, startCash: 100_000, lastTradeAt: 50 });
  });
});
