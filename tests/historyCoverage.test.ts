import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getRawCandles, syncCandles } from '../src/data/candles';
import { getIntradayDays, syncIntraday } from '../src/data/intraday';
import { __resetDb, getDb } from '../src/storage/db';
import { upstoxRequest } from '../src/upstox/client';
import { installChromeMock } from './chromeMock';

vi.mock('../src/upstox/client', () => ({ upstoxRequest: vi.fn() }));
const request = vi.mocked(upstoxRequest);
const now = Date.parse('2026-11-19T06:00:00Z');
const key = 'NSE_EQ|sample';
const body = (date: string) => ({ candles: [[`${date}T09:15:00+05:30`, 10, 11, 9, 10, 100, 0]] });

beforeEach(async () => {
  installChromeMock();
  request.mockReset();
  const db = await getDb();
  await Promise.all([db.clear('historyState'), db.clear('intraday'), db.clear('candles')]);
});

describe('historical cache', () => {
  it('deduplicates overlapping daily jobs and still downloads the closing candle', async () => {
    request.mockResolvedValue(body('2026-11-19'));
    await Promise.all([syncCandles(key, null, now), syncCandles(key, null, now)]);
    expect(request).toHaveBeenCalledOnce();
    expect(await getRawCandles(key)).toHaveLength(0);
    const afterClose = Date.parse('2026-11-19T11:00:00Z');
    await syncCandles(key, null, afterClose);
    await __resetDb();
    await syncCandles(key, null, afterClose);
    await syncCandles(key, null, Date.parse('2026-11-19T13:00:00Z'));
    expect(request).toHaveBeenCalledTimes(2);
    expect((await getRawCandles(key)).map((c) => c.date)).toEqual(['2026-11-19']);
  });

  it('rechecks a missing closing candle at 18:00 once', async () => {
    const firstClose = Date.parse('2026-11-19T11:00:00Z');
    const recheck = Date.parse('2026-11-19T12:30:00Z');
    request.mockResolvedValueOnce(body('2026-11-18')).mockResolvedValueOnce(body('2026-11-19'));
    await syncCandles(key, null, firstClose);
    await syncCandles(key, null, firstClose);
    await syncCandles(key, null, recheck);
    await syncCandles(key, null, recheck);
    expect(request).toHaveBeenCalledTimes(2);
    expect((await getRawCandles(key)).map((c) => c.date)).toEqual(['2026-11-18', '2026-11-19']);
  });

  it('resumes at the first unfinished 5-minute chunk and persists successfully checked empty ranges', async () => {
    request.mockResolvedValueOnce(body('2026-10-12')).mockRejectedValueOnce(new Error('interrupted'));
    await expect(syncIntraday(key, 25, now)).rejects.toThrow('interrupted');
    expect(await getIntradayDays(key)).toHaveLength(1);
    const firstPath = request.mock.calls[0]![0];
    const interruptedPath = request.mock.calls[1]![0];
    expect(interruptedPath).not.toBe(firstPath);
    await __resetDb();
    request.mockResolvedValue({ candles: [] });
    await Promise.all([syncIntraday(key, 25, now), syncIntraday(key, 25, now)]);
    expect(request.mock.calls.map(([path]) => path)).toEqual([firstPath, interruptedPath, interruptedPath]);
    expect(await getIntradayDays(key)).toHaveLength(1);
    await __resetDb();
    await syncIntraday(key, 25, now);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('does not checkpoint a malformed response', async () => {
    request.mockResolvedValueOnce({});
    await expect(syncCandles(key, null, now)).rejects.toThrow('not an array');
    request.mockResolvedValueOnce(body('2026-11-18'));
    await syncCandles(key, null, now);
    expect(request).toHaveBeenCalledTimes(2);
    expect(await getRawCandles(key)).toHaveLength(1);
  });
});
