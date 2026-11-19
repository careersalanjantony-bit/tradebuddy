import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { upstoxRequest } from '../../src/upstox/client';
import { startServer, type RunningServer } from '../src/engine';
import { getJson, logCapture, tempDir, testConfig } from './helpers';

const historical = '/v3/historical-candle/NSE_EQ%7Ctest/days/1/2026-11-19/2026-11-01';
const live = '/v3/market-quote/ltp';
const market = { tokenKind: 'market', attempts: 1 } as const;

let tmp: ReturnType<typeof tempDir>;
let server: RunningServer;

function start() {
  return startServer(testConfig(tmp.dir, { upstoxAnalyticsToken: 'test-analytics-token' }), {
    startTasks: false, write: logCapture().write,
  });
}

beforeEach(async () => {
  tmp = tempDir();
  server = await start();
});

afterEach(async () => {
  await server.close('test end');
  vi.unstubAllGlobals();
  tmp.cleanup();
});

it('restores the historical 429 cooldown from SQLite without delaying live traffic', async () => {
  const fetchLocal = globalThis.fetch;
  const mockedUpstox = vi.fn(async (path: string, method: string | undefined) => {
    expect(method).toBe('GET');
    if (path === historical) return Response.json({ status: 'error' }, {
      status: 429,
      headers: { 'Retry-After': '600' },
    });
    return Response.json({ status: 'success', data: { price: 10 } });
  });
  vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => {
    const url = new URL(input);
    return url.hostname === '127.0.0.1' ? fetchLocal(input, init) : mockedUpstox(url.pathname, init?.method);
  });

  const started = Date.now();
  await expect(upstoxRequest(historical, market)).rejects.toMatchObject({ kind: 'rate_limit', retryAfterMs: 600_000 });
  const before = (await getJson(server.port, '/v1/health')).body.upstox.historical.rateLimit;
  expect(before).toMatchObject({ consecutive429s: 1, total429s: 1, lastRetryAfterMs: 600_000 });
  expect(before.cooldownUntil).toBeGreaterThanOrEqual(started + 600_000);

  await server.close('restart test');
  server = await start();
  const after = (await getJson(server.port, '/v1/health')).body.upstox.historical.rateLimit;
  expect(after).toMatchObject({ total429s: 1, cooldownUntil: before.cooldownUntil });
  const bulk = upstoxRequest(historical, market).catch((err: unknown) => err);
  await expect(upstoxRequest(live, market)).resolves.toEqual({ price: 10 });
  expect(mockedUpstox.mock.calls).toEqual([[historical, 'GET'], [live, 'GET']]);
  await server.close('cancel pending history');
  expect(await bulk).toMatchObject({ kind: 'cancelled' });
});
