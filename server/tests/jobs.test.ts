import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { JOBS, POLL_ALARM } from '../../src/background/scheduler';
import { notify } from '../../src/notify/chrome';
import { startServer, type RunningServer } from '../src/engine';
import { getJson, logCapture, tempDir, testConfig } from './helpers';

/**
 * Milestone 3, end to end: the server runs the app's own jobs — its alarm schedule, catch-up and the
 * 30-second price poll with every check after it — on SQLite, and serves what they store over the API.
 * No network in this test: every call to Upstox or NSE fails, as on a server without a token.
 */

const tmp = tempDir();
const logs = logCapture();
const outside: string[] = [];
let server: RunningServer;

beforeAll(async () => {
  const realFetch = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.startsWith('http://127.0.0.1')) return realFetch(u, init);
      outside.push(u);
      throw new TypeError('fetch failed (no network in tests)');
    }),
  );
  server = await startServer(testConfig(tmp.dir, { jobs: true }), { write: logs.write, startTasks: false });
});

afterAll(async () => {
  await server?.close('test end');
  vi.unstubAllGlobals();
  tmp.cleanup();
});

describe('the app’s intelligence on the server', () => {
  it('sets the app’s own schedule: every daily job and the 30-second price poll, once each', async () => {
    const names = server.scheduler.getAll().map((a) => a.name);
    expect(names.sort()).toEqual([...JOBS, POLL_ALARM].sort());
    expect(server.scheduler.get(POLL_ALARM)?.periodInMinutes).toBe(0.5);
    const h = await getJson(server.port, '/v1/health');
    expect(h.body.jobs.scheduled).toHaveLength(JOBS.length + 1);
    expect(server.intelligence?.tasks.map((t) => t.status().name)).toEqual(['daily-history', 'intraday-history', 'fast-prices', 'early-movers', 'pre-open', 'news', 'learning', 'rising-model', 'short-model', 'breakout-test', 'protect-test']);
  });

  it('runs the price-poll alarm through the app’s scheduler without a token, and never twice at once', async () => {
    const before = server.scheduler.fired;
    await chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.5, when: Date.now() - 1 });
    expect(server.scheduler.tick()).toContain(POLL_ALARM);
    expect(server.scheduler.tick()).not.toContain(POLL_ALARM);
    await vi.waitFor(() => expect(server.scheduler.runningNames()).toEqual([]), { timeout: 10_000 });
    expect(server.scheduler.fired).toBe(before + 1);
  });

  it('every task runs once without breaking (no token: they skip or fail softly)', async () => {
    for (const t of server.intelligence!.tasks) await t.runNow();
    const st = server.intelligence!.tasks.map((t) => t.status());
    expect(st.every((s) => s.runs === 1)).toBe(true);
    const h = await getJson(server.port, '/readyz', null);
    expect(h.status).toBe(200);
  });

  it('serves what the jobs store, in the app’s own data structures', async () => {
    const idea = { key: 'NSE_EQ|INE155A01022', symbol: 'TMPV', score: 72, reasons: [{ id: 'vwap', text: 'below VWAP' }], plan: { entry: 252.55, stop: 255, t1: 250.1, t2: 247.65, qty: 40, risk: 98, charges: 40 }, changePct: -1.2, candleT: 600, at: 1 };
    await chrome.storage.session.set({
      shortIdeas: { at: 1, ideas: [idea], risk: 100 },
      rise: { at: 2, date: '2026-11-19', scanned: 535, loaded: 535, modelAt: null, rows: [{ key: 'K', symbol: 'URBANCO' }], held: [] },
      breakouts: { date: '2026-11-19', at: 3, scanned: 535, signals: [{ id: 'b1', symbol: 'SUNTV' }] },
      daySignals: { date: '2026-11-19', signals: [{ id: 'd1', symbol: 'TRENT', entry: 4500, stop: 4480, target: 4550 }] },
      quotes: { 'NSE_EQ|INE002A01018': { key: 'NSE_EQ|INE002A01018', ltp: 1500, open: 1490, high: 1510, low: 1480, volume: 1, prevClose: 1495, fetchedAt: 5 } },
    });
    await chrome.storage.local.set({
      watchlist: ['NSE_EQ|INE002A01018'],
      plans: [{ id: 'p1', key: 'NSE_EQ|INE002A01018', symbol: 'RELIANCE', entry: 1500, stop: 1470, target: 1560, qty: 3, status: 'planned' }],
    });
    await notify('alert:short-NSE_EQ|INE155A01022-2026-11-19', { title: '▼ SELL first TMPV at ₹252.55 · score 72', message: 'Buy back if it rises to ₹255.00' });

    const falling = await getJson(server.port, '/v1/falling');
    expect(falling.body.shortIdeas.ideas[0]).toEqual(idea);
    expect((await getJson(server.port, '/v1/rising')).body.rise.rows[0].symbol).toBe('URBANCO');
    const bo = await getJson(server.port, '/v1/breakouts');
    expect([bo.body.breakouts.signals[0].symbol, bo.body.daySignals.signals[0].symbol]).toEqual(['SUNTV', 'TRENT']);
    const wl = await getJson(server.port, '/v1/watchlist');
    expect(wl.body.watchlist).toEqual(['NSE_EQ|INE002A01018']);
    expect(wl.body.quotes['NSE_EQ|INE002A01018'].ltp).toBe(1500);
    expect((await getJson(server.port, '/v1/plans')).body.plans[0]).toMatchObject({ symbol: 'RELIANCE', entry: 1500, stop: 1470, target: 1560 });
    const alerts = await getJson(server.port, '/v1/alerts');
    expect(alerts.body.history.some((h: { title: string }) => h.title.includes('TMPV'))).toBe(true);
    const learning = await getJson(server.port, '/v1/learning');
    expect(Object.keys(learning.body)).toEqual(expect.arrayContaining(['mlModel', 'riseModel', 'shortModel', 'dayTest', 'breakoutTest', 'earlyTest', 'botProtectTest', 'progress']));
    for (const p of ['/v1/rising', '/v1/falling', '/v1/breakouts', '/v1/watchlist', '/v1/plans', '/v1/learning', '/v1/alerts']) expect((await getJson(server.port, p, null)).status).toBe(401);
  });

  it('read-only towards Upstox: no order or GTT address was ever called', () => {
    expect(outside.filter((u) => /\/order|\/gtt/i.test(u))).toEqual([]);
  });

  it('after a restart the schedule, plans and alerts are still there — and nothing is scheduled twice', async () => {
    const d = tmp.dir;
    await server.close('restart test');
    server = await startServer(testConfig(d, { jobs: true }), { write: logs.write, startTasks: false });
    expect(server.scheduler.getAll().map((a) => a.name).sort()).toEqual([...JOBS, POLL_ALARM].sort());
    expect((await getJson(server.port, '/v1/plans')).body.plans).toHaveLength(1);
    expect((await getJson(server.port, '/v1/alerts')).body.history.some((h: { title: string }) => h.title.includes('TMPV'))).toBe(true);
  });
});
