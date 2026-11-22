import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { learnFrom, newBrain } from '../../src/bot/brain';
import { botDigest, summarizeBot, validateBotState } from '../../src/bot/cloud';
import { newBot, runBot, type BotState, type BotTrade } from '../../src/background/botJobs';
import { istEpoch } from '../../src/lib/time';
import { placeOrder } from '../../src/wallet/wallet';
import { startServer, type RunningServer } from '../src/engine';
import type { PushMessage, SendResult } from '../src/push/fcm';
import { API_TOKEN, tempDir, testConfig } from './helpers';

/**
 * App 1.22 — the cloud auto-trader, end to end on a real server (SQLite on disk, real HTTP, the app's
 * real runBot), through a synthetic market day: standby → preview → the move → trades opened, managed
 * and closed with the phones closed → stale prices → restart → controls from two phones → back to the
 * phone → the owner's admin controls. Firebase is a stand-in. No broker order is ever sent anywhere:
 * every request to the outside world is recorded and checked at the end.
 */

const DAY = '2026-11-23'; // a Monday
const at = (hhmm: string, s = 0, day = DAY) => istEpoch(day, hhmm, s);
let T = at('09:20');
const clock = () => T;

const AAA = 'NSE_EQ|INE000A01AAA';
const BBB = 'NSE_EQ|INE000B01BBB';
const CCC = 'NSE_EQ|INE000C01CCC';
const TOKEN_A = `fcm-a-${'a'.repeat(150)}:APA91b`;
const TOKEN_B = `fcm-b-${'b'.repeat(150)}:APA91b`;

const sent: PushMessage[] = [];
const fcm = {
  projectId: 'tb-test',
  send: async (m: PushMessage): Promise<SendResult> => {
    sent.push(m);
    return { ok: true, messageId: `projects/tb-test/messages/${sent.length}` };
  },
};

// every request that does not go to the test server itself (Upstox, NSE…): none may be an order
const outside: string[] = [];
const realFetch = globalThis.fetch;
vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith('http://127.0.0.1')) return realFetch(input, init);
  outside.push(url);
  return new Response('{"status":"error"}', { status: 404, headers: { 'Content-Type': 'application/json' } });
});

let tmp: ReturnType<typeof tempDir>;
let srv: RunningServer;
let base: string;

const start = async () => {
  srv = await startServer(testConfig(tmp.dir, { jobs: false }), { now: clock, startTasks: false, fcm, write: () => undefined, bot: { jobs: true, hasToken: true, analytics: async () => 'valid' } });
  base = `http://127.0.0.1:${srv.port}`;
};

async function call(cred: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const res = await realFetch(`${base}${path}`, {
    method,
    headers: { ...(cred ? { Authorization: `Bearer ${cred}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function pair(name: string, token: string, categories: string[]): Promise<{ id: string; cred: string }> {
  const { code } = srv.devices.issuePairingCode();
  const r = await call(null, 'POST', '/v1/devices/pair', { code, name, platform: 'android', appVersion: '1.22.0' });
  expect(r.status).toBe(201);
  const cred = r.body.credential as string;
  expect((await call(cred, 'PUT', '/v1/device/fcm-token', { token })).status).toBe(200);
  expect((await call(cred, 'PUT', '/v1/device/preferences', { categories })).status).toBe(200);
  return { id: r.body.deviceId, cred };
}

/** The pushes sent so far whose alert id matches (alerts are queued a moment after the run that made them). */
async function pushed(id: RegExp): Promise<PushMessage[]> {
  let out: PushMessage[] = [];
  await vi.waitFor(async () => {
    await srv.push.processDue();
    out = sent.filter((m) => id.test(m.data.alertId!));
    expect(out.length).toBeGreaterThan(0);
  });
  return out;
}

const local = (k: string) => globalThis.chrome.storage.local.get(k).then((r) => r[k]);
const setLocal = (o: Record<string, unknown>) => globalThis.chrome.storage.local.set(o);
const setSession = (o: Record<string, unknown>) => globalThis.chrome.storage.session.set(o);

const quote = (key: string, ltp: number, fetchedAt = T, prevClose = 100) => ({ key, ltp, open: prevClose, high: Math.max(ltp, prevClose), low: Math.min(ltp, prevClose), volume: 100_000, prevClose, fetchedAt });
let prices: Record<string, number> = {};
async function setPrices(p: Record<string, number>, fetchedAt = T): Promise<void> {
  prices = { ...prices, ...p };
  await setSession({ quotes: Object.fromEntries(Object.entries(prices).map(([k, v]) => [k, quote(k, v, fetchedAt)])) });
}

/** A day-trade buy signal the auto-trader can take (the same session data the app's scanners write). */
async function signal(key: string, symbol: string, entry: number, stop: number, target: number): Promise<void> {
  await setSession({
    daySignals: {
      date: DAY,
      signals: [{ id: `S-${symbol}`, key, symbol, side: 'long', at: T - 20_000, barT: Math.floor(((T + 5.5 * 3_600_000) % 86_400_000) / 60_000) - 1, entry, stop, target, rvol: 2.2, orHigh: entry, orLow: stop, trusted: true, chance: 0.64 }],
    },
  });
}

/** The phone's own auto-trader, as an owner's phone holds it: ₹1 lakh, one finished trade it learned from, one open trade. */
function phoneBot(): BotState {
  const t0 = at('10:00', 0, '2026-11-20');
  let brain = newBrain();
  brain = learnFrom(brain, [0.6, 0.1, 0.2, 0, 0, 0, 0, 0, 0, 0], true, 1.4, 1_200, 'day-buy').brain;
  const bot = newBot(t0 - 86_400_000, brain, 100_000);
  const ctx = { now: t0, today: '2026-11-20', t: 600, open: true };
  const r = placeOrder(bot.wallet, { key: CCC, symbol: 'CCC', side: 'buy', qty: 10, type: 'market', stop: 900, target: 1_100, sellByClose: false, source: 'Auto-trader · Top picks' }, { ltp: 1_000, prevClose: 990, fetchedAt: t0 }, ctx);
  if (!r.ok || !r.fill) throw new Error('no fill');
  const open: BotTrade = { id: 'P-OPEN', key: CCC, symbol: 'CCC', strategy: 'swing', side: 'long', qty: 10, entry: r.fill.price, stop: 900, stop0: 900, target: 1_100, openedAt: t0, date: '2026-11-20', x: [], chance: 0.6, prior: 0.6, riskRupees: 1_000, explore: false, reasons: ['top pick'], sizeWhy: '', status: 'open', best: r.fill.price, worst: r.fill.price, product: 'delivery' };
  const done: BotTrade = { ...open, id: 'P-DONE', key: AAA, symbol: 'AAA', strategy: 'day-buy', status: 'closed', closedAt: t0 - 3_600_000, exitPrice: 1_012, pnl: 1_200, r: 1.4, exitWhy: 'target reached', lesson: 'Learned: …', product: 'intraday' };
  return { ...bot, wallet: r.wallet, trades: [done, open], log: [...bot.log, { at: t0, kind: 'open', text: 'Bought 10 CCC at ₹1,000.00' }], lastRun: t0 + 60_000, lastDecideAt: t0, rev: 7, updatedAt: t0 + 60_000 };
}

let A: { id: string; cred: string }; // the owner's phone (moves it, controls it)
let B: { id: string; cred: string }; // a second phone (reads only)
let preview: any;
let phone: BotState;
let cutoverBody: any;

beforeAll(async () => {
  tmp = tempDir();
  await start();
  A = await pair('Alan phone', TOKEN_A, ['rising', 'autotrader', 'system']);
  B = await pair('Tablet', TOKEN_B, ['rising', 'system']); // no auto-trader alerts on this one
});

afterAll(async () => {
  await srv?.close('test done');
  tmp.cleanup();
});

describe('the cloud auto-trader: one auto-trader, one writer', () => {
  it('before the move the server is on standby: it shows, but never trades or changes its own copy', async () => {
    // the copy the milestone 4 server made by itself (it ran the app's jobs): ₹50 lakh, one loss
    const aws = { ...newBot(at('09:00', 0, '2026-11-19')), lastRun: at('15:00', 0, '2026-11-19') };
    aws.wallet = { ...aws.wallet, cash: 4_990_000 };
    await setLocal({ bot: aws });
    T = at('09:31');
    await setPrices({ [AAA]: 100.1 });
    await signal(AAA, 'AAA', 100, 99, 102.2);
    expect(await runBot(T)).toBeNull(); // gated: standby
    expect(await local('bot')).toEqual(aws); // not a byte changed
    const s = await call(A.cred, 'GET', '/v1/bot');
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ api: 1, authority: { mode: 'standby', epoch: 0, controller: null }, you: { deviceId: A.id, canControl: false }, telemetry: { health: 'standby' } });
    const c = await call(A.cred, 'POST', '/v1/bot/commands', { requestId: 'cmd-standby-1', command: { type: 'enable', enabled: false } });
    expect(c).toMatchObject({ status: 409, body: { error: 'standby' } });
  });

  it('only paired phones may look, only JSON is accepted, and the admin token is not a phone credential', async () => {
    expect((await call(null, 'GET', '/v1/bot')).status).toBe(401);
    expect((await call(API_TOKEN, 'GET', '/v1/bot')).status).toBe(401);
    expect((await call('tbd.nope.nope', 'GET', '/v1/bot')).status).toBe(401);
    expect((await call(A.cred, 'GET', '/v1/bot/admin')).status).toBe(401);
    expect((await call(API_TOKEN, 'GET', '/v1/bot/admin')).status).toBe(200);
    const form = await call(A.cred, 'POST', '/v1/bot/commands', 'requestId=x&command=y', { 'Content-Type': 'application/x-www-form-urlencoded' });
    expect(form).toMatchObject({ status: 415, body: { error: 'json_only' } });
    const big = await call(A.cred, 'POST', '/v1/bot/commands', { requestId: 'cmd-big-0001', pad: 'x'.repeat(20_000) });
    expect(big.status).toBe(413);
  });

  it('the preview compares the phone’s and the server’s auto-traders: two separate histories = a choice, never a merge', async () => {
    const r = await call(A.cred, 'GET', '/v1/bot/preflight');
    expect(r.status).toBe(200);
    preview = r.body;
    expect(preview).toMatchObject({ ready: true, canMove: true, problems: [], authority: { mode: 'standby' } });
    expect(preview.server).toMatchObject({ startCash: 5_000_000, cash: 4_990_000, digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    phone = phoneBot();
    const p = (await summarizeBot(phone))!;
    expect(p).toMatchObject({ openTrades: 1, closedTrades: 1, learnedFrom: 1, wins: 1 });
    // both have history: the phone shows the choice (see classifyCutover tests)
    cutoverBody = { requestId: 'move-0001-abcdef', choice: 'import', serverId: preview.authority.serverId, expectServerDigest: preview.server.digest, phone, phoneDigest: p.digest };
  });

  it('a stale preview, another server or a changed phone copy is refused; nothing is changed', async () => {
    expect(await call(A.cred, 'POST', '/v1/bot/cutover', { ...cutoverBody, requestId: 'move-bad-0001', expectServerDigest: 'f'.repeat(64) })).toMatchObject({ status: 409, body: { error: 'server_changed' } });
    expect(await call(A.cred, 'POST', '/v1/bot/cutover', { ...cutoverBody, requestId: 'move-bad-0002', serverId: 'other' })).toMatchObject({ status: 409, body: { error: 'other_server' } });
    expect(await call(A.cred, 'POST', '/v1/bot/cutover', { ...cutoverBody, requestId: 'move-bad-0003', phoneDigest: '0'.repeat(64) })).toMatchObject({ status: 400, body: { error: 'phone_changed' } });
    expect(await call(A.cred, 'POST', '/v1/bot/cutover', { ...cutoverBody, requestId: 'move-bad-0004', phone: { v: 1, nonsense: true }, phoneDigest: null })).toMatchObject({ status: 400, body: { error: 'bad_state' } });
    expect((await call(A.cred, 'GET', '/v1/bot')).body.authority.mode).toBe('standby');
    expect(srv.bot.backups()).toHaveLength(0);
  });

  it('the move: the phone’s auto-trader goes to the server in one transaction, with both old copies backed up', async () => {
    const r = await call(A.cred, 'POST', '/v1/bot/cutover', cutoverBody);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, choice: 'import', epoch: 1, rev: 8 });
    const s = await call(A.cred, 'GET', '/v1/bot');
    expect(s.body).toMatchObject({ authority: { mode: 'cloud', epoch: 1, controller: { deviceId: A.id, name: 'Alan phone' } }, you: { canControl: true }, rev: 8 });
    const bot = (await local('bot')) as BotState;
    // exactly the phone's trades, money and learning — plus one log line about the move
    expect(bot.trades).toEqual(phone.trades);
    expect(bot.wallet).toEqual(phone.wallet);
    expect(bot.brain).toEqual(phone.brain);
    expect(bot.log.at(-1)!.text).toMatch(/Moved to the server from Alan phone/);
    // the backups: the server's own copy before the move, and the phone's
    const b = srv.bot.backups();
    expect(b.map((x) => x.source).sort()).toEqual(['phone', 'server']);
    expect(srv.bot.backupState(Number(b.find((x) => x.source === 'server')!.id))!.state!.wallet.cash).toBe(4_990_000);
    expect(await botDigest(srv.bot.backupState(Number(b.find((x) => x.source === 'phone')!.id))!.state!)).toBe(cutoverBody.phoneDigest);
  });

  it('the same move sent again (the answer got lost) is answered from the record — nothing done twice', async () => {
    const again = await call(A.cred, 'POST', '/v1/bot/cutover', cutoverBody);
    expect(again).toMatchObject({ status: 200, body: { ok: true, epoch: 1, rev: 8, repeated: true } });
    expect(srv.bot.backups()).toHaveLength(2);
    expect(srv.bot.auditLog().filter((x) => String(x.action).startsWith('cutover')).length).toBe(1);
    // a NEW move while it already runs on the server is refused
    expect(await call(B.cred, 'POST', '/v1/bot/cutover', { ...cutoverBody, requestId: 'move-0002-other' })).toMatchObject({ status: 409, body: { error: 'already_cloud' } });
  });

  it('market minutes with every phone closed: the server opens a trade, alerts the phone that wants it, both phones see it', async () => {
    T = at('09:32');
    await setPrices({ [AAA]: 100.1, [CCC]: 1_005 });
    await signal(AAA, 'AAA', 100, 99, 102.2);
    const bot = (await runBot(T))!;
    const open = bot.trades.filter((t) => t.status === 'open' && t.key === AAA);
    expect(open).toHaveLength(1);
    expect(bot.log.some((l) => /Bought .* AAA/.test(l.text))).toBe(true);
    // the alert went to the outbox for phone A (it wants auto-trader alerts) — not for phone B
    const opened = await pushed(/^alert:bot-open-/);
    expect(opened.map((m) => m.token)).toEqual([TOKEN_A]);
    expect(opened[0]!.data.category).toBe('autotrader');
    // both phones read the same state, B only reads
    const [a, b] = await Promise.all([call(A.cred, 'GET', '/v1/bot'), call(B.cred, 'GET', '/v1/bot')]);
    expect(a.body.rev).toBe(b.body.rev);
    expect(a.body.bot.trades).toEqual(b.body.bot.trades);
    expect(b.body.you).toEqual({ deviceId: B.id, canControl: false });
    expect(a.body.money).toMatchObject({ openCount: 2, startCash: 100_000 });
    expect(a.body.quotes[AAA]).toMatchObject({ ltp: 100.1 });
    expect(a.body.telemetry).toMatchObject({ health: 'ok', analytics: 'valid', jobs: true, marketPhase: 'open' });
  });

  it('no duplicates: many runs at the same moment (polls, the feed, a retry) open the trade once', async () => {
    T = at('09:33');
    await setPrices({ [AAA]: 100.15, [CCC]: 1_005 });
    await signal(AAA, 'AAA', 100, 99, 102.2);
    const before = ((await local('bot')) as BotState).trades.length;
    await Promise.all([runBot(T, true), runBot(T, true), runBot(T), runBot(T, true), runBot(T)]);
    const bot = (await local('bot')) as BotState;
    expect(bot.trades.length).toBe(before);
    expect(bot.trades.filter((t) => t.status === 'open' && t.key === AAA)).toHaveLength(1);
  });

  it('a winning trade: the target is reached, it is sold, the brain learns, the phone is told', async () => {
    const learned = ((await local('bot')) as BotState).brain.n;
    for (const [m, p] of [['09:40', 101.3], ['09:45', 102.4]] as const) {
      T = at(m);
      await setPrices({ [AAA]: p, [CCC]: 1_006 });
      await runBot(T);
    }
    const bot = (await local('bot')) as BotState;
    const t = bot.trades.find((x) => x.key === AAA && x.id !== 'P-DONE')!;
    expect(t).toMatchObject({ status: 'closed' });
    expect(t.pnl!).toBeGreaterThan(0);
    expect(bot.brain.n).toBe(learned + 1);
    expect((await pushed(/^alert:bot-close-/)).map((m) => m.token)).toEqual([TOKEN_A]);
  });

  it('stale prices (the token stopped, the feed went quiet): no new trades, a clear degraded state, one alert', async () => {
    T = at('10:00');
    await signal(BBB, 'BBB', 200, 198, 205);
    await setPrices({ [BBB]: 200.2, [CCC]: 1_006 }, at('09:55')); // the newest price is 5 minutes old
    const before = ((await local('bot')) as BotState).trades.length;
    const bot = (await runBot(T))!;
    expect(bot.trades.length).toBe(before);
    expect(bot.note).toMatch(/Prices are not up to date/);
    const t = await srv.bot.telemetry();
    expect(t).toMatchObject({ health: 'degraded', priceAgeSec: 300 });
    expect(t.text).toMatch(/Prices are 5 min old/);
    expect(await srv.bot.watch()).toMatch(/^degraded/);
    T += 61_000;
    await srv.bot.watch();
    T += 30_000;
    await srv.bot.watch(); // still bad: no second alert
    expect(await pushed(/^alert:bot-degraded-/)).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 50));
    await srv.push.processDue();
    expect(sent.filter((m) => /^alert:bot-degraded-/.test(m.data.alertId!))).toHaveLength(1);
  });

  it('fresh prices again: it trades again; a losing trade hits its safety net and it learns from that too', async () => {
    T = at('10:05');
    await setPrices({ [BBB]: 200.2, [CCC]: 1_006 });
    await signal(BBB, 'BBB', 200, 198, 205);
    await runBot(T);
    expect(await srv.bot.watch()).toBe('ok');
    let bot = (await local('bot')) as BotState;
    expect(bot.trades.filter((t) => t.key === BBB && t.status === 'open')).toHaveLength(1);
    T = at('10:10');
    await setPrices({ [BBB]: 197.5, [CCC]: 1_006 });
    await runBot(T);
    bot = (await local('bot')) as BotState;
    const t = bot.trades.find((x) => x.key === BBB)!;
    expect(t.status).toBe('closed');
    expect(t.pnl!).toBeLessThan(0);
    expect(await pushed(/^alert:bot-recovered-/)).toHaveLength(1);
  });

  it('a restart of the server (systemd, a deploy) keeps the owner, the version and every trade', async () => {
    const before = (await local('bot')) as BotState;
    await srv.close('restart');
    await start();
    const s = await call(A.cred, 'GET', '/v1/bot');
    expect(s.body).toMatchObject({ authority: { mode: 'cloud', epoch: 1, controller: { deviceId: A.id } }, rev: before.rev });
    expect(((await local('bot')) as BotState).trades).toEqual(before.trades);
    // the same move after the restart is still answered from the record
    expect((await call(A.cred, 'POST', '/v1/bot/cutover', cutoverBody)).body.repeated).toBe(true);
  });

  it('controls: only the controlling phone; each one is recorded; a repeated request is done once', async () => {
    const no = await call(B.cred, 'POST', '/v1/bot/commands', { requestId: 'cmd-b-0001', command: { type: 'enable', enabled: false } });
    expect(no).toMatchObject({ status: 403, body: { error: 'not_controller' } });
    const pause = { requestId: 'cmd-a-pause-01', command: { type: 'enable', enabled: false } };
    const r1 = await call(A.cred, 'POST', '/v1/bot/commands', pause);
    expect(r1).toMatchObject({ status: 200, body: { ok: true, type: 'enable' } });
    const r2 = await call(A.cred, 'POST', '/v1/bot/commands', pause);
    expect(r2.body).toMatchObject({ ok: true, repeated: true, rev: r1.body.rev });
    let bot = (await local('bot')) as BotState;
    expect(bot.enabled).toBe(false);
    expect(bot.log.filter((l) => /Paused \(from Alan phone\)/.test(l.text))).toHaveLength(1);
    // paused: a fresh signal opens nothing, even with the phone closed
    T = at('10:20');
    await setPrices({ [AAA]: 100.1, [CCC]: 1_006 });
    await signal(AAA, 'AAA', 100, 99, 102.2);
    const count = bot.trades.length;
    await runBot(T);
    expect(((await local('bot')) as BotState).trades.length).toBe(count);
    expect((await srv.bot.telemetry()).health).toBe('paused');
    // on again, a new amount and new protection levels
    expect((await call(A.cred, 'POST', '/v1/bot/commands', { requestId: 'cmd-a-on-0001', command: { type: 'enable', enabled: true } })).status).toBe(200);
    const amt = await call(A.cred, 'POST', '/v1/bot/commands', { requestId: 'cmd-a-amt-0001', command: { type: 'amount', amount: 150_000 } });
    expect(amt).toMatchObject({ status: 200, body: { result: { total: 150_000 } } });
    const rules = await call(A.cred, 'POST', '/v1/bot/commands', { requestId: 'cmd-a-rul-0001', command: { type: 'rules', rules: { dayLossPct: 2, quickExitMin: 60 } } });
    expect(rules.body.result).toMatchObject({ dayLossPct: 2, quickExitMin: 60, on: true });
    expect(await call(A.cred, 'POST', '/v1/bot/commands', { requestId: 'cmd-a-rul-0002', command: { type: 'rules', rules: { dayLossPct: 7 } } })).toMatchObject({ status: 400 });
    bot = (await local('bot')) as BotState;
    expect(bot.enabled).toBe(true);
    expect(bot.rules).toMatchObject({ dayLossPct: 2, quickExitMin: 60 });
    const audit = (await call(A.cred, 'GET', '/v1/bot/audit')).body.audit as Array<{ action: string; ok: boolean; device_id: string }>;
    expect(audit.filter((x) => x.action === 'command:enable' && x.ok)).toHaveLength(2);
    expect(audit.some((x) => x.device_id === B.id && x.ok)).toBe(false);
  });

  it('starting again needs the version you looked at; an outdated one is refused, the right one backs up first', async () => {
    const rev = ((await local('bot')) as BotState).rev!;
    expect(await call(A.cred, 'POST', '/v1/bot/commands', { requestId: 'cmd-a-rst-0001', command: { type: 'reset', forget: false, startCash: 100_000 } })).toMatchObject({ status: 400 });
    expect(await call(A.cred, 'POST', '/v1/bot/commands', { requestId: 'cmd-a-rst-0002', ifRev: rev - 1, command: { type: 'reset', forget: false, startCash: 100_000 } })).toMatchObject({ status: 409, body: { error: 'conflict', rev } });
    const brain = ((await local('bot')) as BotState).brain;
    const backups = srv.bot.backups().length;
    const ok = await call(A.cred, 'POST', '/v1/bot/commands', { requestId: 'cmd-a-rst-0003', ifRev: rev, command: { type: 'reset', forget: false, startCash: 120_000 } });
    expect(ok.status).toBe(200);
    expect(await call(A.cred, 'POST', '/v1/bot/commands', { requestId: 'cmd-a-rst-0003', ifRev: rev, command: { type: 'reset', forget: false, startCash: 120_000 } })).toMatchObject({ body: { repeated: true } });
    const bot = (await local('bot')) as BotState;
    expect(bot.wallet.startCash).toBe(120_000);
    expect(bot.brain).toEqual(brain); // kept what it learned
    expect(srv.bot.backups().length).toBe(backups + 1); // one backup, not two
  });

  it('too many controls in a minute are refused (429) and allowed again later', async () => {
    let last = 0;
    for (let i = 0; i < 25 && last !== 429; i++) last = (await call(A.cred, 'POST', '/v1/bot/commands', { requestId: `cmd-flood-${String(i).padStart(4, '0')}`, command: { type: 'enable', enabled: true } })).status;
    expect(last).toBe(429);
    T += 61_000;
    expect((await call(A.cred, 'POST', '/v1/bot/commands', { requestId: 'cmd-after-flood', command: { type: 'enable', enabled: true } })).status).toBe(200);
  });

  it('the end of the day: a same-day trade is closed by 3:10 pm with no phone open', async () => {
    T = at('11:00');
    await setPrices({ [AAA]: 100.1, [CCC]: 1_006 });
    await signal(AAA, 'AAA', 100, 99, 102.2);
    await runBot(T);
    const id = ((await local('bot')) as BotState).trades.find((t) => t.key === AAA && t.status === 'open')?.id;
    expect(id).toBeTruthy();
    T = at('15:11');
    await setPrices({ [AAA]: 100.3, [CCC]: 1_006 });
    await runBot(T);
    const t = ((await local('bot')) as BotState).trades.find((x) => x.id === id)!;
    expect(t.status).toBe('closed');
    expect(t.exitWhy).toMatch(/3:10 pm/);
  });

  it('back to the phone: only the controlling phone; the server hands over its full state and goes on standby', async () => {
    expect(await call(B.cred, 'POST', '/v1/bot/release', { requestId: 'rel-b-000001' })).toMatchObject({ status: 403 });
    const full = (await local('bot')) as BotState;
    const r = await call(A.cred, 'POST', '/v1/bot/release', { requestId: 'rel-a-000001' });
    expect(r.status).toBe(200);
    const state = validateBotState(r.body.state);
    expect(state.trades).toEqual(full.trades); // the FULL state, not the screen copy
    expect(state.wallet.fills).toEqual(full.wallet.fills);
    expect(state.log.at(-1)!.text).toMatch(/Moved back to Alan phone/);
    expect((await call(A.cred, 'GET', '/v1/bot')).body.authority).toMatchObject({ mode: 'standby', controller: null });
    T = at('15:20');
    expect(await runBot(T)).toBeNull(); // the server no longer trades it
    const again = await call(A.cred, 'POST', '/v1/bot/release', { requestId: 'rel-a-000001' });
    expect(again.body).toMatchObject({ repeated: true });
    expect(again.body.state).toEqual(r.body.state);
  });

  it('the owner (admin token): resume with a named phone, hand control to another, emergency stop, restore a backup', async () => {
    const adm = (m: string, p: string, b?: unknown) => call(API_TOKEN, m, p, b);
    expect(await adm('POST', '/v1/bot/admin/resume', {})).toMatchObject({ status: 400, body: { error: 'no_controller' } });
    expect(await adm('POST', '/v1/bot/admin/resume', { controllerId: A.id })).toMatchObject({ status: 200, body: { authority: { mode: 'cloud', epoch: 2, controller: { deviceId: A.id } } } });
    expect(await adm('POST', '/v1/bot/admin/controller', { deviceId: B.id })).toMatchObject({ status: 200, body: { authority: { controller: { deviceId: B.id, name: 'Tablet' } } } });
    expect((await call(B.cred, 'POST', '/v1/bot/commands', { requestId: 'cmd-b-0002', command: { type: 'enable', enabled: true } })).status).toBe(200);
    expect((await call(A.cred, 'POST', '/v1/bot/commands', { requestId: 'cmd-a-late-01', command: { type: 'enable', enabled: true } })).status).toBe(403);
    // a running auto-trader is never replaced by a backup
    const serverBackup = srv.bot.backups().find((x) => x.reason === 'before the move to the server')!;
    expect(await adm('POST', '/v1/bot/admin/restore', { backupId: serverBackup.id })).toMatchObject({ status: 409, body: { error: 'running' } });
    expect(await adm('POST', '/v1/bot/admin/standby', { reason: 'test' })).toMatchObject({ status: 200, body: { authority: { mode: 'standby' } } });
    const r = await adm('POST', '/v1/bot/admin/restore', { backupId: serverBackup.id });
    expect(r.status).toBe(200);
    expect(((await local('bot')) as BotState).wallet.cash).toBe(4_990_000); // the milestone 4 server's own copy is back
    const full = await adm('GET', `/v1/bot/admin/backups/${serverBackup.id}`);
    expect(full.body.state.wallet.startCash).toBe(5_000_000);
    // after the emergency stop the named phone (B) can still take the latest state back; A cannot
    expect(await call(A.cred, 'POST', '/v1/bot/release', { requestId: 'rel-a-000002' })).toMatchObject({ status: 403 });
    const back = await call(B.cred, 'POST', '/v1/bot/release', { requestId: 'rel-b-000002' });
    expect(back.status).toBe(200);
    expect(back.body.state.wallet.cash).toBe(4_990_000);
    expect((await call(B.cred, 'GET', '/v1/bot')).body.authority).toMatchObject({ mode: 'standby', controller: null });
    const status = await adm('GET', '/v1/bot/admin');
    expect(status.body).toMatchObject({ authority: { mode: 'standby' }, telemetry: { health: 'standby' } });
    expect(status.body.audit.some((x: { action: string }) => x.action === 'admin:restore')).toBe(true);
  });

  it('the health report shows the auto-trader (who runs it, how it is doing) and /healthz the contract version', async () => {
    const h = await call(API_TOKEN, 'GET', '/v1/health');
    expect(h.body.autoTrader).toMatchObject({ authority: { mode: 'standby' }, health: 'standby' });
    expect((await call(null, 'GET', '/healthz')).body).toMatchObject({ status: 'ok', botApi: 1 });
  });

  it('read-only towards the broker: not one request to an order or GTT address, ever', () => {
    expect(outside.filter((u) => /order|gtt/i.test(u))).toEqual([]);
  });

  it('every change is in the database itself (survives anything but losing the disk)', () => {
    const db = new DatabaseSync(join(tmp.dir, 'tradebuddy.db'), { readOnly: true });
    const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    expect(n("SELECT COUNT(*) AS n FROM bot_audit WHERE action LIKE 'cutover:%' AND ok = 1")).toBe(1);
    expect(n("SELECT COUNT(*) AS n FROM bot_audit WHERE action = 'release' AND ok = 1")).toBe(2); // A's, then B's after the emergency stop
    expect(n('SELECT COUNT(*) AS n FROM bot_backups')).toBeGreaterThanOrEqual(4);
    db.close();
  });
});
