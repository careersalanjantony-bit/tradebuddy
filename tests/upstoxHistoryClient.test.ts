import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getDb } from '../src/storage/db';
import { configureHistoricalRequests, historicalRequestDiagnostics, stopHistoricalRequests, upstoxRequest } from '../src/upstox/client';
import { installChromeMock } from './chromeMock';

beforeEach(async () => {
  installChromeMock();
  await (await getDb()).clear('historyState');
  configureHistoricalRequests(30);
});

afterEach(async () => {
  await stopHistoricalRequests();
  vi.unstubAllGlobals();
});

it('puts daily, 5-minute history and corporate actions in one cooldown while live market data proceeds', async () => {
  const daily = '/v3/historical-candle/NSE_EQ%7Ctest/days/1/2026-11-19/2026-11-01';
  const fiveMinute = '/v3/historical-candle/NSE_EQ%7Ctest/minutes/5/2026-11-19/2026-11-01';
  const corporateActions = '/v2/fundamentals/test/corporate-actions';
  const live = '/v3/historical-candle/intraday/NSE_EQ%7Ctest/minutes/5';
  const quote = '/v3/market-quote/ltp';
  const request = { tokenKind: 'market', analyticsTokenOverride: 'test-token', attempts: 1 } as const;
  const earliestRetry = new Date(Date.now() + 600_000).toUTCString();
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    expect(init.method).toBe('GET');
    if (new URL(url).pathname === daily) return Response.json({ errors: [null] }, {
      status: 429, headers: { 'Retry-After': earliestRetry },
    });
    return Response.json({ status: 'success', data: { candles: [] } });
  });
  vi.stubGlobal('fetch', fetch);

  await expect(upstoxRequest(daily, request)).rejects.toMatchObject({ kind: 'rate_limit' });
  const queued = [fiveMinute, corporateActions].map((path) => upstoxRequest(path, request).catch((err: unknown) => err));
  await Promise.all([upstoxRequest(live, request), upstoxRequest(quote, request)]);
  expect(fetch.mock.calls.map(([url]) => new URL(url).pathname).sort()).toEqual([daily, live, quote].sort());
  const diagnostics = await historicalRequestDiagnostics();
  expect(diagnostics).toMatchObject({ total429s: 1, queued: 2, inFlight: 0 });
  expect(diagnostics.cooldownUntil).toBeGreaterThanOrEqual(Date.parse(earliestRetry));
  await stopHistoricalRequests();
  for (const result of await Promise.all(queued)) expect(result).toMatchObject({ kind: 'cancelled' });
  configureHistoricalRequests(30);
  expect(await historicalRequestDiagnostics()).toMatchObject({ cooldownUntil: diagnostics.cooldownUntil, total429s: 1 });
});
