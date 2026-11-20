import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorFromResponse, UpstoxError } from '../src/upstox/errors';
import { HistoricalRequestQueue, type HistoricalRequestState } from '../src/upstox/historicalQueue';

const start = Date.parse('2026-11-19T03:45:00Z');

function storage(initial?: HistoricalRequestState) {
  let state = initial;
  return {
    load: vi.fn(async () => state),
    save: vi.fn(async (next: HistoricalRequestState) => { state = structuredClone(next); }),
  };
}

function enqueue<T>(queue: HistoricalRequestQueue, request: (signal: AbortSignal) => Promise<T>, attempts: number) {
  return queue.enqueue(async () => request, attempts);
}

describe('historical request queue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('loads the budget once under concurrent calls and paces all callers at 30/min', async () => {
    const store = storage();
    const queue = new HistoricalRequestQueue(30, store);
    const started: Array<[number, number]> = [];
    const calls = Array.from({ length: 31 }, (_, i) => enqueue(queue, async () => {
      started.push([i, Date.now() - start]);
    }, 1));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.load).toHaveBeenCalledTimes(1);
    expect(started).toEqual([[0, 0]]);
    expect(await queue.diagnostics()).toMatchObject({ queued: 30, requestsPerMinute: 30 });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(started).toEqual(Array.from({ length: 30 }, (_, i) => [i, i * 2000]));
    await vi.advanceTimersByTimeAsync(2);
    await Promise.all(calls);
    expect(started.at(-1)).toEqual([30, 60_001]);
  });

  it('still enforces the 30-minute safety window when the minute budget is raised', async () => {
    const first = start - 1_799_500;
    const timestamps = Array.from({ length: 1800 }, (_, i) => first + i * 1000);
    const store = storage({ timestamps, cooldownUntil: 0, consecutive429s: 0, total429s: 0, last429At: null, lastRetryAfterMs: null });
    const queue = new HistoricalRequestQueue(450, store);
    const fetch = vi.fn(async () => undefined);
    const done = enqueue(queue, fetch, 1);
    await vi.advanceTimersByTimeAsync(500);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('applies Retry-After plus jitter globally, persists final 429s and restores pacing across restart', async () => {
    const store = storage();
    const queue = new HistoricalRequestQueue(30, store);
    const send = vi.fn().mockRejectedValueOnce(errorFromResponse(429, null, '10'))
      .mockRejectedValueOnce(new UpstoxError('limited', 'rate_limit', 429));
    const first = enqueue(queue, send, 2).catch((err: unknown) => err);
    const competing = vi.fn(async () => undefined);
    const pending = enqueue(queue, competing, 1).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(10_499);
    expect(send).toHaveBeenCalledTimes(1);
    expect(competing).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await first).toMatchObject({ kind: 'rate_limit' });
    expect(await queue.diagnostics()).toMatchObject({
      cooldownUntil: start + 21_500, last429At: start + 10_500, total429s: 2, consecutive429s: 2,
    });
    await queue.stop();
    expect(await pending).toMatchObject({ kind: 'cancelled' });
    const restarted = new HistoricalRequestQueue(30, store);
    const done = enqueue(restarted, competing, 1);
    await vi.advanceTimersByTimeAsync(10_999);
    expect(competing).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(competing).toHaveBeenCalledOnce();
    expect(await restarted.diagnostics()).toMatchObject({ cooldownUntil: null, consecutive429s: 0, total429s: 2 });
    const again = new HistoricalRequestQueue(30, store);
    expect(await again.diagnostics()).toMatchObject({ nextRequestAt: start + 23_500 });
  });

  it('does not retry permanent errors and retries transient errors through the same pacing budget', async () => {
    const queue = new HistoricalRequestQueue(30, storage());
    const badRequest = vi.fn().mockRejectedValue(new UpstoxError('bad request', 'client', 400));
    const net = vi.fn().mockRejectedValueOnce(new UpstoxError('network', 'network')).mockResolvedValueOnce('ok');
    const first = enqueue(queue, badRequest, 3).catch((err: unknown) => err);
    const second = enqueue(queue, net, 3);
    await vi.advanceTimersByTimeAsync(3999);
    expect(await first).toMatchObject({ kind: 'client' });
    expect(badRequest).toHaveBeenCalledOnce();
    expect(net).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await second).toBe('ok');
    expect(net).toHaveBeenCalledTimes(2);
    expect(await queue.diagnostics()).toMatchObject({ total429s: 0 });
  });

  it('fails closed when the reservation cannot be saved', async () => {
    const store = storage();
    store.save.mockRejectedValueOnce(new Error('disk unavailable'));
    const queue = new HistoricalRequestQueue(30, store);
    const send = vi.fn(async () => undefined);
    await expect(enqueue(queue, send, 3)).rejects.toThrow('disk unavailable');
    expect(send).not.toHaveBeenCalled();
  });

  it('aborts the active request and rejects queued and future requests on shutdown', async () => {
    const queue = new HistoricalRequestQueue(30, storage());
    const request = vi.fn((signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const active = enqueue(queue, request, 3).catch((err: unknown) => err);
    const pending = enqueue(queue, request, 3).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(0);
    expect(await queue.diagnostics()).toMatchObject({ inFlight: 1, queued: 1 });
    await queue.stop();
    expect(await active).toMatchObject({ kind: 'cancelled' });
    expect(await pending).toMatchObject({ kind: 'cancelled' });
    await expect(enqueue(queue, request, 3)).rejects.toMatchObject({ kind: 'cancelled' });
    expect(request).toHaveBeenCalledOnce();
  });
});
