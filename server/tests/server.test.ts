import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../src/engine';
import { getJson, logCapture, tempDir, testConfig, API_TOKEN } from './helpers';

let running: RunningServer | null = null;
const cleanups: Array<() => void> = [];

afterEach(async () => {
  await running?.close('test end');
  running = null;
  for (const c of cleanups.splice(0)) c();
});

function dir(): string {
  const t = tempDir();
  cleanups.push(t.cleanup);
  return t.dir;
}

describe('milestone 1: a server with health checks that keeps its data', () => {
  it('answers health checks without a token and the API only with the right token', async () => {
    const logs = logCapture();
    running = await startServer(testConfig(dir()), { write: logs.write });
    const { port } = running;

    const live = await getJson(port, '/healthz', null);
    expect(live.status).toBe(200);
    expect(live.body).toMatchObject({ status: 'ok', version: 'test' });
    expect(live.headers.get('cache-control')).toBe('no-store');
    expect((await getJson(port, '/readyz', null)).body).toEqual({ status: 'ready', checks: { database: true, started: true } });

    expect((await getJson(port, '/v1/health', null)).status).toBe(401);
    expect((await getJson(port, '/v1/health', 'wrong-token')).status).toBe(401);
    const h = await getJson(port, '/v1/health');
    expect(h.status).toBe(200);
    expect(h.body).toMatchObject({ status: 'ok', readOnly: true, database: { ok: true, schemaVersion: 4 }, upstox: { analyticsToken: { configured: false, status: 'missing' } }, feed: null });

    expect((await getJson(port, '/nope')).status).toBe(404);
    const wrongMethod = await fetch(`http://127.0.0.1:${port}/healthz`, { method: 'POST' });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toBe('GET, HEAD');

    // structured logs, and the API token never appears in them
    const lines = logs.lines.map((l) => JSON.parse(l) as { level: string; module: string; msg: string });
    expect(lines.some((l) => l.module === 'server' && l.msg.startsWith('Listening on'))).toBe(true);
    expect(logs.text()).not.toContain(API_TOKEN);
  });

  it('turns the API off (503) when no API token is configured, but health checks still work', async () => {
    running = await startServer(testConfig(dir(), { apiToken: null }), { write: () => undefined });
    expect((await getJson(running.port, '/healthz', null)).status).toBe(200);
    const r = await getJson(running.port, '/v1/quotes', null);
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('api_disabled');
  });

  it('serves prices from storage, by key or for a list of keys', async () => {
    running = await startServer(testConfig(dir()), { write: () => undefined });
    const quote = (key: string, ltp: number) => ({ key, ltp, open: ltp, high: ltp, low: ltp, volume: 10, prevClose: ltp - 1, fetchedAt: 1000 + ltp });
    await chrome.storage.session.set({ quotes: { 'NSE_EQ|A': quote('NSE_EQ|A', 10), 'NSE_INDEX|Nifty 50': quote('NSE_INDEX|Nifty 50', 25000) } });

    const all = await getJson(running.port, '/v1/quotes');
    expect(all.body.count).toBe(2);
    expect(all.body.at).toBe(26000);
    const some = await getJson(running.port, `/v1/quotes?keys=${encodeURIComponent('NSE_INDEX|Nifty 50,NSE_EQ|missing')}`);
    expect(Object.keys(some.body.quotes)).toEqual(['NSE_INDEX|Nifty 50']);
    const one = await getJson(running.port, `/v1/quotes/${encodeURIComponent('NSE_INDEX|Nifty 50')}`);
    expect(one.body.ltp).toBe(25000);
    expect((await getJson(running.port, `/v1/quotes/${encodeURIComponent('NSE_EQ|nope')}`)).status).toBe(404);
    expect((await getJson(running.port, '/v1/quotes?keys=')).status).toBe(400);
  });

  it('market status uses the IST market calendar', async () => {
    // Tuesday 17 Nov 2026, 10:00 IST
    const t = Date.parse('2026-11-17T04:30:00Z');
    running = await startServer(testConfig(dir()), { write: () => undefined, now: () => t });
    const s = await getJson(running.port, '/v1/market/status');
    expect(s.body).toMatchObject({ now: t, phase: 'open', session: { date: '2026-11-17', trading: true } });
    expect(s.body.session.openAt).toBe(Date.parse('2026-11-17T03:45:00Z')); // 09:15 IST
    expect(s.body.session.closeAt).toBe(Date.parse('2026-11-17T10:00:00Z')); // 15:30 IST
  });

  it('a graceful stop saves everything, and a restarted server finds it again (failure recovery)', async () => {
    const d = dir();
    running = await startServer(testConfig(d), { write: () => undefined });
    await chrome.storage.local.set({ watchlist: ['NSE_EQ|KEEP'] });
    await chrome.storage.session.set({ lastPoll: { at: 123, ok: true, count: 1 } });
    await running.close('test restart');
    expect(running.ready()).toBe(false);
    expect(running.store.closed).toBe(true);

    running = await startServer(testConfig(d), { write: () => undefined });
    expect((await chrome.storage.local.get('watchlist')).watchlist).toEqual(['NSE_EQ|KEEP']);
    expect((await chrome.storage.session.get('lastPoll')).lastPoll).toEqual({ at: 123, ok: true, count: 1 });
    const events = await getJson(running.port, '/v1/events?limit=5');
    expect(events.body.events.map((e: { kind: string }) => e.kind)).toEqual(['start', 'stop', 'start']);
  });

  it('runs the app’s own storage migrations on first start', async () => {
    running = await startServer(testConfig(dir()), { write: () => undefined });
    const meta = (await chrome.storage.local.get('meta')).meta as { schemaVersion: number } | undefined;
    expect(meta?.schemaVersion).toBeGreaterThan(0);
    const settings = (await chrome.storage.local.get('settings')).settings as { data: { liveFeed: boolean } };
    expect(settings.data.liveFeed).toBe(false); // follows TB_LIVE_FEED
  });

  it('refuses to start on a port that is taken, and leaves nothing open', async () => {
    running = await startServer(testConfig(dir()), { write: () => undefined });
    await expect(startServer(testConfig(dir(), { port: running.port }), { write: () => undefined })).rejects.toThrow(/EADDRINUSE/);
    expect((await getJson(running.port, '/healthz', null)).status).toBe(200);
  });
});
