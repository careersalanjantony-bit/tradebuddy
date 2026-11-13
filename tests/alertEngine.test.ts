import { beforeEach, describe, expect, it } from 'vitest';
import { installChromeMock } from './chromeMock';
import { defaultPlanAlerts } from '../src/alerts/rules';
import { evaluateEndOfDay, evaluateIntraday } from '../src/alerts/engine';
import { getDb } from '../src/storage/db';
import { istEpoch } from '../src/lib/time';
import type { Quote } from '../src/data/quotesParse';

const K = 'NSE_EQ|INE000TEST01';
const plan = { planId: 'P1', key: K, symbol: 'TEST', entry: 1000, stop: 960, target: 1080 };
const quote = (ltp: number, fetchedAt: number): Record<string, Quote> => ({ [K]: { key: K, ltp, open: 990, high: 1001, low: 955, volume: 1, prevClose: 995, fetchedAt } });

let chrome: ReturnType<typeof installChromeMock>;
beforeEach(async () => {
  chrome = installChromeMock();
  await chrome.storage.local.set({ alerts: defaultPlanAlerts(plan, 15, 0) });
  await (await getDb()).clear('alertLog');
});

describe('alert engine (service-worker glue)', () => {
  const open = istEpoch('2026-11-10', '10:00'); // Tuesday, market open

  it('fires stop + near-stop on a fresh price in market hours: log, notification, badge', async () => {
    const f = await evaluateIntraday(quote(959, open - 5_000), null, 0.1, open);
    expect(f.map((x) => x.kind).sort()).toEqual(['nearStop', 'stop']);
    const stopCall = chrome.notifications.create.mock.calls.find((c) => String(c[1].title).includes('STOP HIT'));
    expect(stopCall?.[1]).toMatchObject({ requireInteraction: true, priority: 2 });
    expect(await (await getDb()).count('alertLog')).toBe(2);
    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: '2' });
    const rules = (await chrome.storage.local.get('alerts')).alerts as Array<{ kind: string; active: boolean }>;
    expect(rules.find((r) => r.kind === 'stop')!.active).toBe(false);
    // second evaluation: one-shot rules do not fire again
    expect(await evaluateIntraday(quote(950, open + 25_000), null, 0.1, open + 30_000)).toEqual([]);
  });

  it('never fires on a stale price (older than 90 s)', async () => {
    expect(await evaluateIntraday(quote(900, open - 120_000), null, 0.1, open)).toEqual([]);
    expect(chrome.notifications.create).not.toHaveBeenCalled();
  });

  it('does nothing outside market hours', async () => {
    const evening = istEpoch('2026-11-10', '16:00');
    expect(await evaluateIntraday(quote(900, evening), null, 0.1, evening)).toEqual([]);
    const sunday = istEpoch('2026-11-15', '11:00');
    expect(await evaluateIntraday(quote(900, sunday), null, 0.1, sunday)).toEqual([]);
  });

  it('target fires as critical; end-of-day close below SMA20 fires once', async () => {
    const t = await evaluateIntraday(quote(1081, open), null, 0.1, open);
    expect(t.map((x) => x.kind).sort()).toEqual(['oneR', 'target']);
    const e1 = await evaluateEndOfDay(new Map([[K, { close: 990, sma20: 1000 }]]), open);
    expect(e1).toHaveLength(1);
    const e2 = await evaluateEndOfDay(new Map([[K, { close: 985, sma20: 1000 }]]), open + 86_400_000);
    expect(e2).toHaveLength(0);
  });
});
