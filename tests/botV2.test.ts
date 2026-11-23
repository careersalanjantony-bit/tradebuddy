import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock } from './chromeMock';
import { newBrain } from '../src/bot/brain';
import { botReset, botResume, botSetAmount, botSetPlaybook, brakedToday, newBot, runBot, samplesFromTrades, setBotGate, setBotObserver, type BotState, type BotTrade } from '../src/background/botJobs';
import type { RecordDay } from '../src/intraday/record';
import { istEpoch } from '../src/lib/time';
import { DEFAULT_SETTINGS } from '../src/storage/defaults';
import { provenRecord } from './botHelpers';

/**
 * App v1.23 — the auto-trader's loop with evidence first: shadow trades for kinds not proven yet, money
 * for proven ones (their result before charges becomes evidence), the market gate, the drawdown brake,
 * switching a kind off, and the Intraday scanner's BUY as a new source.
 */

const NOW = istEpoch('2026-11-23', '10:30');
const DAY = '2026-11-23';
const K = 'NSE_EQ|INE002A01018';
const NIFTY = 'NSE_INDEX|Nifty 50';

const quote = (key: string, ltp: number, over: Record<string, unknown> = {}) => ({ [key]: { key, ltp, open: 100, high: 101, low: 99, volume: 1000, prevClose: 100, fetchedAt: NOW, ...over } });
const daySignal = { date: DAY, signals: [{ id: 'S', key: K, symbol: 'RELIANCE', side: 'long', at: NOW - 20_000, barT: 629, entry: 100, stop: 99, target: 102, rvol: 2, orHigh: 100, orLow: 99, trusted: true, chance: 0.66 }] };

let chrome: ReturnType<typeof installChromeMock>;
const bot = async () => (await chrome.storage.local.get('bot')).bot as BotState;
const alertIds = () => (chrome.notifications.create.mock.calls as Array<[string, unknown]>).map((c) => c[0]);
/** alerts are sent without waiting for them (`void alertOpen(…)`): let them finish before looking */
const settled = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};
const seed = async (b: Partial<BotState> = {}) => chrome.storage.local.set({ bot: { ...newBot(NOW - 3_600_000, newBrain(), 1_000_000), lastRun: NOW - 60_000, rev: 5, ...b } });

beforeEach(async () => {
  chrome = installChromeMock();
  setBotGate(null);
  setBotObserver(null);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
  await chrome.storage.local.set({ settings: structuredClone(DEFAULT_SETTINGS), marketCalendar: null, watchlist: [], scanLists: null, auth: { status: 'logged_out' } });
  await chrome.storage.session.set({ quotes: quote(K, 100), daySignals: daySignal });
});

describe('a kind of trade that has not proven itself, with "Prove each kind first" on: shadow trades only', () => {
  it('no money, no alert, no new version — and its result becomes evidence', async () => {
    await seed({ rules: { proveFirst: true } });
    const b = (await runBot(NOW, true))!;
    expect(b.trades).toHaveLength(0);
    expect(b.shadow?.trades).toHaveLength(1);
    const sh = b.shadow!.trades[0]!;
    expect(sh).toMatchObject({ key: K, playbook: 'day-buy', shadow: true, status: 'open' });
    expect(sh.sizeWhy).toMatch(/^Shadow trade \(no money\)/);
    expect(b.wallet.cash).toBe(1_000_000); // the real money is untouched
    expect(b.rev).toBe(5); // a shadow trade never makes a phone's control "outdated"
    expect(b.note).toMatch(/not proven yet \(followed as shadow trades, no money\)/);
    expect(b.evidence?.list.find((e) => e.id === 'day-buy')?.state).toBe('watch');
    await settled();
    expect(alertIds().filter((id) => id.startsWith('alert:bot-'))).toEqual([]);

    // the target is reached: the shadow trade closes and counts as evidence (before charges)
    await chrome.storage.session.set({ quotes: quote(K, 102.1, { fetchedAt: NOW + 60_000 }) });
    const c = (await runBot(NOW + 60_000, true))!;
    const done = c.shadow!.trades[0]!;
    expect(done.status).toBe('closed');
    expect(done.grossR!).toBeGreaterThan(done.r!);
    expect(c.samples?.['day-buy']).toHaveLength(1);
    expect(c.samples?.['day-buy']?.[0]).toMatchObject({ shadow: true });
    const e = c.evidence!.list.find((x) => x.id === 'day-buy')!;
    expect(e).toMatchObject({ n: 1, shadow: 1 });
    await settled();
    expect(alertIds().filter((id) => id.startsWith('alert:bot-'))).toEqual([]);
    expect(c.wallet.cash).toBe(1_000_000);
  });

  it('switched off: no trades, not even shadow ones', async () => {
    await seed();
    await botSetPlaybook('day-buy', true, NOW - 1_000);
    expect((await bot()).evidence?.list.find((e) => e.id === 'day-buy')?.state).toBe('off');
    const b = (await runBot(NOW, true))!;
    expect(b.trades).toHaveLength(0);
    expect(b.shadow?.trades ?? []).toHaveLength(0);
    await botSetPlaybook('day-buy', false, NOW + 1_000);
    expect((await bot()).playbooks?.['day-buy']).toBeUndefined();
  });
});

describe('buy now (the default, app 1.24): a kind not proven yet buys with the small size while it learns', () => {
  it('a fresh auto-trader buys — no shadow trade — alerts it, and the result becomes evidence', async () => {
    await seed();
    const b = (await runBot(NOW, true))!;
    expect(b.trades).toHaveLength(1);
    const t = b.trades[0]!;
    expect(t).toMatchObject({ key: K, playbook: 'day-buy', state: 'learning' });
    expect(t.riskRupees).toBeLessThanOrEqual(1_000_000 * 0.0025 + 50);
    expect(t.sizeWhy).toMatch(/^Learning \(kind not proven yet, small size\)/);
    expect(b.shadow?.trades ?? []).toHaveLength(0);
    expect(b.rev).toBe(6);
    await settled();
    expect(alertIds()).toContain(`alert:bot-open-${t.id}`);
    const msg = (chrome.notifications.create.mock.calls as Array<[string, { message?: string }]>).find((c) => c[0] === `alert:bot-open-${t.id}`)?.[1]?.message ?? '';
    expect(msg).toMatch(/Learning: kind not proven yet \(small size\)/);
    await chrome.storage.session.set({ quotes: quote(K, 102.1, { fetchedAt: NOW + 60_000 }) });
    const c = (await runBot(NOW + 60_000, true))!;
    expect(c.trades[0]!.status).toBe('closed');
    expect(c.samples?.['day-buy']).toHaveLength(1);
    expect(c.samples?.['day-buy']?.[0]?.shadow).toBeUndefined();
  });
});

describe('a proven kind of trade: money, sized by its state, its result counted before charges', () => {
  it('opens with money, alerts, and the finished trade joins the evidence', async () => {
    await seed({ samples: provenRecord('day-buy') });
    const b = (await runBot(NOW, true))!;
    expect(b.trades).toHaveLength(1);
    const t = b.trades[0]!;
    expect(t).toMatchObject({ playbook: 'day-buy', state: 'proven', explore: false });
    expect(t.chargesR!).toBeGreaterThan(0);
    expect(t.chargesR!).toBeLessThanOrEqual(0.25);
    expect(t.riskRupees).toBeLessThanOrEqual(1_000_000 * 0.005 + 50);
    expect(b.rev).toBe(6);
    await settled();
    expect(alertIds()).toContain(`alert:bot-open-${t.id}`);
    await chrome.storage.session.set({ quotes: quote(K, 102.1, { fetchedAt: NOW + 60_000 }) });
    const c = (await runBot(NOW + 60_000, true))!;
    const done = c.trades[0]!;
    expect(done.status).toBe('closed');
    expect(done.grossR!).toBeGreaterThan(done.r!);
    expect(c.samples?.['day-buy']).toHaveLength(31);
  });

  it('no new buys while the market falls (the same gate as the alerts) — not even shadow ones', async () => {
    await seed({ samples: provenRecord('day-buy') });
    await chrome.storage.session.set({ quotes: { ...quote(K, 100), ...quote(NIFTY, 99.3, { open: 99.5 }) } });
    const b = (await runBot(NOW, true))!;
    expect(b.trades).toHaveLength(0);
    expect(b.shadow?.trades ?? []).toHaveLength(0);
    expect(b.note).toMatch(/the market is falling \(NIFTY 50 −0\.70% today\)/);
  });
});

describe('the drawdown brake', () => {
  it('8 % below its best: no new trades until Resume (one alert); Resume counts its best from now', async () => {
    await seed({ samples: provenRecord('day-buy'), peak: 1_100_000 });
    const b = (await runBot(NOW, true))!;
    expect(b.trades).toHaveLength(0);
    expect(b.ddStop).toMatchObject({ peak: 1_100_000, total: 1_000_000 });
    expect(b.note).toMatch(/^Stopped: its money fell 8% below its best/);
    await settled();
    expect(alertIds().filter((id) => id.startsWith('alert:bot-drawdown-'))).toHaveLength(1);
    await runBot(NOW + 1_000, true);
    await settled();
    expect(alertIds().filter((id) => id.startsWith('alert:bot-drawdown-'))).toHaveLength(1);

    await botResume(NOW + 2_000);
    const r = await bot();
    expect(r.ddStop).toBeNull();
    expect(r.peak).toBe(1_000_000);
    expect(r.log.at(-1)!.text).toMatch(/^Resumed after the drawdown stop: it trades again/);
    expect((await runBot(NOW + 3_000, true))!.trades).toHaveLength(1);
  });

  it('half size from 4 % below its best; a new amount is a new best (adding money is not a gain)', async () => {
    await seed({ samples: provenRecord('day-buy'), peak: 1_050_000 });
    const b = (await runBot(NOW, true))!;
    expect(b.trades[0]!.sizeWhy).toMatch(/halved by the drawdown brake/);
    await botSetAmount(2_000_000, NOW + 1_000);
    const a = await bot();
    expect(a.peak).toBe(2_000_000);
    expect(a.ddStop).toBeNull();
  });
});

describe('two losing trades today stop that kind for the day', () => {
  it('counts only today’s finished losing trades, per kind', () => {
    const t = (id: string, r: number, over: Partial<BotTrade> = {}): BotTrade => ({ id, key: id, symbol: id, strategy: 'day-buy', side: 'long', qty: 1, entry: 100, stop: 99, stop0: 99, target: 102, openedAt: 1, date: DAY, x: [], chance: 0.5, prior: 0.5, riskRupees: 1, explore: false, reasons: [], sizeWhy: '', status: 'closed', r, ...over });
    expect([...brakedToday([t('a', -1), t('b', -0.5)], DAY)]).toEqual(['day-buy']);
    expect([...brakedToday([t('a', -1), t('b', 0.5)], DAY)]).toEqual([]);
    expect([...brakedToday([t('a', -1), t('b', -1, { date: '2026-11-20' })], DAY)]).toEqual([]);
    expect([...brakedToday([t('a', -1), t('b', -1, { strategy: 'swing' })], DAY)]).toEqual([]);
  });
});

describe('starting again and older auto-traders', () => {
  it('Start again keeps the evidence unless it forgets; your off switches always stay', async () => {
    await seed({ samples: provenRecord('day-buy'), playbooks: { breakout: { off: true }, 'short-scan': { paused: true } } });
    await botReset(false, 500_000, NOW);
    const kept = await bot();
    expect(kept.samples?.['day-buy']).toHaveLength(30);
    expect(kept.playbooks).toEqual({ breakout: { off: true }, 'short-scan': { paused: true } });
    await botReset(true, 500_000, NOW + 1_000);
    const fresh = await bot();
    expect(fresh.samples).toBeUndefined();
    expect(fresh.playbooks).toEqual({ breakout: { off: true } });
  });

  it('an auto-trader saved before app 1.23 gets its evidence from its finished trades', () => {
    const closed = (id: string, r: number, reasons: string[], strategy: BotTrade['strategy'] = 'rising'): BotTrade => ({ id, key: id, symbol: id, strategy, side: 'long', qty: 1, entry: 100, stop: 99, stop0: 99, target: 102, openedAt: 1, closedAt: 2, date: DAY, x: [], chance: 0.5, prior: 0.5, riskRupees: 100, explore: false, reasons, sizeWhy: '', status: 'closed', r });
    const old = { ...newBot(1), trades: [closed('a', 1.2, ['Rising now: likely to keep rising']), closed('b', -1, ['up 2.0% since the open']), closed('c', 0.5, ['x'], 'day-buy')] };
    const s = samplesFromTrades(old);
    expect(s['rise-strong']).toEqual([{ at: 2, grossR: 1.2, netR: 1.2 }]);
    expect(s['rise-flow']).toHaveLength(1);
    expect(s['day-buy']).toHaveLength(1);
  });
});

describe('the Intraday scanner’s BUY as a new source', () => {
  const intraday = (at = NOW - 5_000) => ({
    date: DAY,
    at,
    universe: 2000,
    priced: 1900,
    candidates: 40,
    rows: [{ key: K, symbol: 'RELIANCE', call: 'BUY', score: 85, why: 'broke the opening range with volume', checks: [], price: 100, changePct: 1.2, fromOpenPct: 1, rvol: 2, vwap: 99.5, buyers: 0.6, ema9: 99.8, ema21: 99.4, orHigh: 99.9, breakoutT: 600, plan: { entry: 100, stop: 99, target: 102, rr: 2 }, size: null, valueCr: 50, at }],
    counts: { buy: 1, wait: 0, noTrade: 0 },
    gate: null,
  });
  const proven: RecordDay[] = [{ date: '2026-11-20', items: Array.from({ length: 22 }, (_, i) => ({ key: `K${i}`, symbol: `S${i}`, side: 'buy' as const, at: i, entry: 100, exit: 101, outcome: 'target' as const, t1Hit: false, qty: 10, pnl: 9 })) }];

  it('proving first: shadow only until the scanner’s own record is proven, whatever its other results', async () => {
    await seed({ samples: provenRecord('intraday-buy'), rules: { proveFirst: true } });
    await chrome.storage.session.set({ daySignals: null, intraday: intraday() });
    const b = (await runBot(NOW, true))!;
    expect(b.trades).toHaveLength(0);
    expect(b.shadow?.trades[0]).toMatchObject({ playbook: 'intraday-buy', strategy: 'breakout', shadow: true });
    expect(b.evidence?.list.find((e) => e.id === 'intraday-buy')?.why).toMatch(/own record is not proven yet/);
  });

  it('with money once the record is proven and its results allow; never chased', async () => {
    await seed({ samples: provenRecord('intraday-buy') });
    await chrome.storage.local.set({ intradayRecord: proven });
    await chrome.storage.session.set({ daySignals: null, intraday: intraday() });
    const b = (await runBot(NOW, true))!;
    expect(b.trades[0]).toMatchObject({ playbook: 'intraday-buy', state: 'proven' });
    // 0.5 % above the scanner's entry: too late, not chased
    await seed({ samples: provenRecord('intraday-buy') });
    await chrome.storage.session.set({ quotes: quote(K, 100.5) });
    expect((await runBot(NOW + 1_000, true))!.trades).toHaveLength(0);
  });
});
