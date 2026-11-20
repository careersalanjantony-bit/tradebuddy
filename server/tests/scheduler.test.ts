import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AlarmScheduler, type Alarm } from '../src/engine/alarms';
import { acquireLock, LockedError, LOCK_STALE_MS } from '../src/engine/lock';
import { openStore, type Store } from '../src/storage/sqlite';
import { tempDir } from './helpers';

let store: Store;
let dir: string;
let cleanup: () => void;
let t = Date.parse('2026-11-19T03:00:00Z'); // 08:30 IST
const now = () => t;

beforeEach(() => {
  const x = tempDir();
  dir = x.dir;
  cleanup = x.cleanup;
  store = openStore(dir);
  t = Date.parse('2026-11-19T03:00:00Z');
});
afterEach(() => {
  store.close();
  cleanup();
});

describe('persistent chrome.alarms', () => {
  it('fires a one-off alarm once when due, and a repeating one in its rhythm', async () => {
    const s = new AlarmScheduler(store.db, now);
    const got: string[] = [];
    s.api.onAlarm.addListener((a: Alarm) => void got.push(a.name));
    await s.api.create('eod-candles', { when: t + 60_000 });
    await s.api.create('quotes-poll', { periodInMinutes: 0.5, delayInMinutes: 0.5 });
    expect(s.tick()).toEqual([]);
    t += 30_000;
    expect(s.tick()).toEqual(['quotes-poll']);
    await new Promise((r) => setImmediate(r)); // that run has finished
    t += 30_000;
    expect(s.tick().sort()).toEqual(['eod-candles', 'quotes-poll']);
    expect(s.get('eod-candles')).toBeUndefined(); // one-off: used up
    expect(s.get('quotes-poll')?.scheduledTime).toBe(t + 30_000);
    await s.stop();
    expect(got.sort()).toEqual(['eod-candles', 'quotes-poll', 'quotes-poll']);
  });

  it('survives a restart; what came due while off fires once (no burst of missed repeats)', async () => {
    const s1 = new AlarmScheduler(store.db, now);
    await s1.api.create('morning-recheck', { when: t + 50 * 60_000 });
    await s1.api.create('quotes-poll', { periodInMinutes: 0.5, delayInMinutes: 0.5 });
    store.close();
    t += 2 * 3_600_000; // the server was off for two hours
    store = openStore(dir);
    const s2 = new AlarmScheduler(store.db, now);
    expect(s2.getAll().map((a) => a.name).sort()).toEqual(['morning-recheck', 'quotes-poll']);
    expect(s2.tick().sort()).toEqual(['morning-recheck', 'quotes-poll']);
    expect(s2.tick()).toEqual([]);
    expect(s2.get('quotes-poll')!.scheduledTime).toBeGreaterThan(t);
    await s2.stop();
  });

  it('never runs the same job twice at once: a slow run makes the next tick skip it', async () => {
    const s = new AlarmScheduler(store.db, now);
    let release!: () => void;
    let runs = 0;
    s.api.onAlarm.addListener(() => {
      runs++;
      return new Promise<void>((r) => (release = r));
    });
    await s.api.create('quotes-poll', { periodInMinutes: 0.5, when: t });
    expect(s.tick()).toEqual(['quotes-poll']);
    t += 30_000;
    expect(s.tick()).toEqual([]);
    expect(s.skipped).toBe(1);
    expect(s.runningNames()).toEqual(['quotes-poll']);
    release();
    await s.stop();
    t += 30_000;
    expect(s.tick()).toEqual(['quotes-poll']);
    expect(runs).toBe(2);
    release();
  });

  it('create replaces an alarm of the same name (the app re-sets its jobs after each run)', async () => {
    const s = new AlarmScheduler(store.db, now);
    await s.api.create('eod-candles', { when: t + 1000 });
    await s.api.create('eod-candles', { when: t + 5000 });
    expect(s.getAll()).toEqual([{ name: 'eod-candles', scheduledTime: t + 5000 }]);
    expect(await s.api.clear('eod-candles')).toBe(true);
    expect(await s.api.getAll()).toEqual([]);
  });
});

describe('one server per database', () => {
  it('a second server on the same database is refused while the first one is alive', () => {
    const first = acquireLock(store.db, now, 1111);
    expect(() => acquireLock(store.db, now, 2222)).toThrow(LockedError);
    first.release();
    const second = acquireLock(store.db, now, 2222);
    second.release();
  });

  it('a crashed server (no heartbeat) is taken over after 30 seconds', () => {
    acquireLock(store.db, now, 1111); // never released: "crashed"
    t += LOCK_STALE_MS - 1000;
    expect(() => acquireLock(store.db, now, 2222)).toThrow(LockedError);
    t += 2000;
    expect(() => acquireLock(store.db, now, 2222).release()).not.toThrow();
  });
});
