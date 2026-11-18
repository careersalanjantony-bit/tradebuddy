import { describe, expect, it, vi } from 'vitest';
import { FeedSupervisor, type FeedStatusRecord } from '../src/market/feedSupervisor';
import { NOT_LOGGED_IN_WAIT_MS, QuotePoller } from '../src/market/quotePoller';
import { UpstoxError } from '../../src/upstox/errors';

const OPEN = Date.parse('2026-11-17T04:30:00Z'); // Tue 10:00 IST
const EVENING = Date.parse('2026-11-17T13:30:00Z'); // Tue 19:00 IST
const noSockets = () => ({ created: 0, opened: 0, closed: 0, open: 0, messages: 0, lastMessageAt: null, pings: 0, pongs: 0, heartbeatFailures: 0, lastRttMs: null, lastCloseCode: null });

describe('feed supervisor', () => {
  function setup(states: string[]) {
    let t = OPEN;
    let status: FeedStatusRecord | undefined;
    const closeFeed = vi.fn();
    const sup = new FeedSupervisor(
      {
        ensureFeed: vi.fn(async () => states.shift() ?? 'connected'),
        closeFeed,
        readStatus: async () => status,
        socketStats: noSockets,
        now: () => t,
      },
      60_000,
    );
    return { sup, closeFeed, setTime: (ms: number) => void (t = ms), setStatus: (s: FeedStatusRecord) => void (status = s) };
  }

  it('counts connections and reports the subscription', async () => {
    const s = setup(['connecting', 'connected', 'connected']);
    expect(await s.sup.check()).toBe('connecting');
    s.setStatus({ connected: true, lastTickAt: OPEN + 1000, at: OPEN, keys: 537, full: 537, ltpc: 0, overflow: 0 });
    s.setTime(OPEN + 5_000);
    expect(await s.sup.check()).toBe('connected');
    s.setTime(OPEN + 10_000);
    await s.sup.check();
    expect(s.sup.health()).toMatchObject({ state: 'connected', connected: true, connects: 1, keys: 537, full: 537, lastTickAgeMs: 9_000, staleRestarts: 0 });
  });

  it('reconnects when a connected feed sends no prices for too long', async () => {
    const s = setup(['connected', 'connected', 'connected']);
    s.setStatus({ connected: true, lastTickAt: OPEN, at: OPEN, keys: 2 });
    await s.sup.check();
    s.setTime(OPEN + 59_000);
    expect(await s.sup.check()).toBe('connected');
    s.setTime(OPEN + 61_000);
    expect(await s.sup.check()).toBe('reconnecting');
    expect(s.closeFeed).toHaveBeenCalledWith('no prices');
    expect(s.sup.health().staleRestarts).toBe(1);
  });

  it('a feed that just connected is not called silent before staleMs has passed', async () => {
    const s = setup(['connected', 'connected']);
    s.setStatus({ connected: true, lastTickAt: 0, at: OPEN, keys: 2 }); // no price yet
    await s.sup.check();
    s.setTime(OPEN + 30_000);
    expect(await s.sup.check()).toBe('connected');
    expect(s.closeFeed).not.toHaveBeenCalled();
  });

  it('reports errors and survives a failing connect', async () => {
    const sup = new FeedSupervisor({ ensureFeed: async () => Promise.reject(new Error('authorize failed')), closeFeed: () => undefined, readStatus: async () => undefined, socketStats: noSockets, now: () => OPEN });
    expect(await sup.check()).toBe('failed');
    expect(sup.health().lastError).toBe('authorize failed');
  });
});

describe('REST price poller', () => {
  function setup(opts: { now: number; fresh?: boolean; keys?: string[] }) {
    let t = opts.now;
    const pollFull = vi.fn(async () => undefined);
    const pollLight = vi.fn(async () => undefined);
    const p = new QuotePoller({ calendar: async () => null, lastPoll: async () => undefined, keys: async () => opts.keys ?? ['NSE_EQ|A'], feedFresh: () => !!opts.fresh, pollFull, pollLight, now: () => t }, 30_000, 5_000);
    return { p, pollFull, pollLight, setTime: (ms: number) => void (t = ms) };
  }

  it('market open + feed silent: a full poll every 30 s and light polls every 5 s between them', async () => {
    const s = setup({ now: OPEN });
    expect(await s.p.check()).toBe('full');
    s.setTime(OPEN + 2_500);
    expect(await s.p.check()).toBe('light');
    s.setTime(OPEN + 5_000);
    expect(await s.p.check()).toBe('feed'); // light poll not due yet
    s.setTime(OPEN + 7_600);
    expect(await s.p.check()).toBe('light');
    s.setTime(OPEN + 30_000);
    expect(await s.p.check()).toBe('full');
    expect([s.pollFull.mock.calls.length, s.pollLight.mock.calls.length]).toEqual([2, 2]);
  });

  it('market open + feed delivering: only the 30-second full poll', async () => {
    const s = setup({ now: OPEN, fresh: true });
    expect(await s.p.check()).toBe('full');
    s.setTime(OPEN + 10_000);
    expect(await s.p.check()).toBe('feed');
    expect(s.pollLight).not.toHaveBeenCalled();
  });

  it('market closed: one poll for the closing prices, then nothing', async () => {
    let last: { at: number; ok: boolean } | undefined;
    const pollFull = vi.fn(async (_k: string[], now: number) => void (last = { at: now, ok: true }));
    const p = new QuotePoller({ calendar: async () => null, lastPoll: async () => last, keys: async () => ['K'], feedFresh: () => false, pollFull, pollLight: vi.fn(), now: () => EVENING }, 30_000, 5_000);
    expect(await p.check()).toBe('full');
    expect(await p.check()).toBe('closed');
    expect(pollFull).toHaveBeenCalledTimes(1);
  });

  it('without a valid Analytics Token it waits 5 minutes instead of asking every few seconds', async () => {
    const s = setup({ now: OPEN });
    s.pollFull.mockRejectedValue(new UpstoxError('Not logged in', 'not_logged_in'));
    expect(await s.p.check()).toBe('waiting');
    s.setTime(OPEN + NOT_LOGGED_IN_WAIT_MS - 1);
    expect(await s.p.check()).toBe('waiting');
    expect(s.pollFull).toHaveBeenCalledTimes(1);
    s.pollFull.mockResolvedValue(undefined);
    s.setTime(OPEN + NOT_LOGGED_IN_WAIT_MS);
    expect(await s.p.check()).toBe('full');
  });

  it('other errors are thrown (the task records them) without breaking the cadence', async () => {
    const s = setup({ now: OPEN });
    s.pollFull.mockRejectedValueOnce(new Error('HTTP 500'));
    await expect(s.p.check()).rejects.toThrow('HTTP 500');
    s.setTime(OPEN + 1_000);
    expect(await s.p.check()).toBe('light'); // the next full poll waits its 30 s
    expect(s.p.health()).toMatchObject({ failures: 1, fullPolls: 0, lightPolls: 1 });
  });
});
