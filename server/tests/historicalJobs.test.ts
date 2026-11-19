import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as dailyJobs from '../../src/background/dataJobs';
import * as learning from '../../src/background/mlJobs';
import { intradayHistoryWindow } from '../../src/background/dayJobs';
import { historyNeedsResume, runHistoryBatch, withHistoryJob } from '../../src/background/historicalJobs';
import { retryDailyHistory, runJob } from '../../src/background/scheduler';
import * as candles from '../../src/data/candles';
import * as quotes from '../../src/data/quotes';
import { istEpoch } from '../../src/lib/time';
import { updateSettings } from '../../src/storage/local';
import { UpstoxError } from '../../src/upstox/errors';
import { startServer, type RunningServer } from '../src/engine';
import { getJson, logCapture, tempDir, testConfig } from './helpers';

describe('historical job checkpoints', () => {
  const stocks = ['A', 'B', 'C'].map((key) => ({ key, parameter: 25 }));
  const window = '2026-11-19';
  let tmp: ReturnType<typeof tempDir>;
  let server: RunningServer;
  const start = () => startServer(testConfig(tmp.dir, { historicalRequestsPerMinute: 42 }), { startTasks: false, write: logCapture().write });

  beforeEach(async () => {
    tmp = tempDir();
    server = await start();
  });

  afterEach(async () => {
    await server.close('test end');
    tmp.cleanup();
  });

  function run(download: Parameters<typeof runHistoryBatch>[3], target = window) {
    return withHistoryJob('intraday', target, () => runHistoryBatch('intraday', target, stocks, download, () => undefined));
  }

  it('reports active stock progress, then reopens SQLite and resumes unfinished work only', async () => {
    let reached!: () => void;
    let release!: () => void;
    const downloadingB = new Promise<void>((resolve) => { reached = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const interrupted = run(async ({ key }) => {
      if (key === 'B') {
        reached();
        await held;
        throw new UpstoxError('stopping', 'cancelled');
      }
    });
    await downloadingB;
    const health = (await getJson(server.port, '/v1/health')).body.upstox.historical;
    expect(health.intraday).toMatchObject({ window, ok: 1, failed: 0, pending: 2, total: 3, running: true });
    expect(health.rateLimit).toMatchObject({ requestsPerMinute: 42, total429s: 0 });
    release();
    await expect(interrupted).rejects.toMatchObject({ kind: 'cancelled' });

    await server.close('restart test');
    server = await start();
    expect((await getJson(server.port, '/v1/health')).body.upstox.historical.intraday).toMatchObject({ ok: 1, pending: 2, running: false });
    expect(await historyNeedsResume('intraday')).toBe(true);
    const fetched: string[] = [];
    await expect(run(async ({ key }) => { fetched.push(key); })).resolves.toEqual({ ok: 3, failed: [], pending: [] });
    expect(fetched).toEqual(['B', 'C']);
    expect(await historyNeedsResume('intraday')).toBe(false);
  });

  it('joins an overlapping batch, while a newer window runs after the old one', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const first = vi.fn(async () => { await held; });
    const duplicate = vi.fn(async () => {});
    const newer = vi.fn(async () => {});
    const runs = [run(first), run(duplicate), run(newer, '2026-11-20')];
    await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1));
    expect(duplicate).not.toHaveBeenCalled();
    expect(newer).not.toHaveBeenCalled();
    release();
    await Promise.all(runs);
    expect(first).toHaveBeenCalledTimes(3);
    expect(duplicate).not.toHaveBeenCalled();
    expect(newer).toHaveBeenCalledTimes(3);
  });

  it('uses one intraday refresh window across closed days', async () => {
    const saturday = await intradayHistoryWindow(istEpoch('2026-11-21', '10:00'));
    const monday = await intradayHistoryWindow(istEpoch('2026-11-23', '10:00'));
    const tuesday = await intradayHistoryWindow(istEpoch('2026-11-24', '10:00'));
    expect([saturday, monday, tuesday]).toEqual(['2026-11-20', '2026-11-20', '2026-11-23']);
  });

  it('the scheduler rolls an unfinished prior daily window forward after a restart', async () => {
    await updateSettings({ data: { candleHistoryYears: 2 }, dayTrade: { enabled: false } });
    const old = '2026-11-19:close:2';
    await expect(withHistoryJob('daily', old, () => runHistoryBatch('daily', old, stocks, async ({ key }) => {
      if (key === 'B') throw new UpstoxError('stopping', 'cancelled');
    }, () => undefined))).rejects.toMatchObject({ kind: 'cancelled' });
    await server.close('roll-forward test');
    server = await start();

    const tracked = vi.spyOn(quotes, 'trackedKeys').mockResolvedValue(stocks.map((s) => s.key));
    const sync = vi.spyOn(candles, 'syncCandles').mockImplementation(async (key) => ({ key, fetched: 0, lastDate: '2026-11-20' }));
    try {
      const reference = istEpoch('2026-11-21', '10:00');
      await retryDailyHistory(reference);
      expect(sync.mock.calls.map(([key, , at]) => [key, at])).toEqual(stocks.map(({ key }) => [key, reference]));
      expect((await getJson(server.port, '/v1/health')).body.upstox.historical.daily).toMatchObject({
        window: '2026-11-21:close:2', ok: 3, pending: 0, running: false,
      });
    } finally {
      tracked.mockRestore();
      sync.mockRestore();
    }
  });

  it('picks up a missed 18:00 publication recheck even if the 16:00 phase completed', async () => {
    const eod = vi.spyOn(dailyJobs, 'runEndOfDay').mockResolvedValue({ synced: 3, failed: 0, shortlist: [] });
    const learn = vi.spyOn(learning, 'learnIfDue').mockImplementation(async () => undefined);
    try {
      const first = istEpoch('2026-11-19', '16:00');
      const recheck = istEpoch('2026-11-19', '18:00');
      await runJob('eod-candles', first);
      await retryDailyHistory(first + 60_000);
      expect(eod.mock.calls).toEqual([[first, true]]);
      await retryDailyHistory(recheck);
      await retryDailyHistory(recheck + 60_000);
      await runJob('eod-candles', recheck + 120_000);
      expect(eod.mock.calls).toEqual([[first, true], [recheck, true]]);
    } finally {
      eod.mockRestore();
      learn.mockRestore();
    }
  });

  it('pauses a shared configuration failure without marking the remaining stocks failed', async () => {
    const download = vi.fn(async () => { throw new UpstoxError('invalid app settings', 'config', 400); });
    await expect(run(download)).resolves.toEqual({ ok: 0, failed: [], pending: ['A', 'B', 'C'] });
    expect(download).toHaveBeenCalledTimes(1);
    const progress = (await getJson(server.port, '/v1/health')).body.upstox.historical.intraday;
    expect(progress).toMatchObject({ pending: 3, lastError: { kind: 'config', status: 400 } });
    expect(await historyNeedsResume('intraday')).toBe(false);
    expect(await historyNeedsResume('intraday', Date.now(), '2026-11-20')).toBe(true);
  });

  it('separates permanent errors from delayed retries and counts only completed stocks as done', async () => {
    await expect(run(async ({ key }) => {
      if (key === 'A') throw new UpstoxError('unknown instrument', 'client', 404);
      if (key === 'B') throw new UpstoxError('unavailable', 'network');
    })).resolves.toEqual({ ok: 1, failed: ['A'], pending: ['B'] });
    const progress = (await getJson(server.port, '/v1/health')).body.upstox.historical.intraday;
    expect(progress).toMatchObject({ ok: 1, failed: 1, pending: 1, running: false, lastError: { kind: 'network', status: null } });
    expect(await historyNeedsResume('intraday', progress.resumeAt - 1)).toBe(false);
    expect(await historyNeedsResume('intraday', progress.resumeAt)).toBe(true);
    const download = vi.fn(async () => {});
    await run(download);
    expect(download).not.toHaveBeenCalled();
  });
});
