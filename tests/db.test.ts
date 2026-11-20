import { beforeEach, describe, expect, it } from 'vitest';
import { ALL_STORES, DB_NAME, DB_VERSION, __resetDb, getDb, type LogEntry } from '../src/storage/db';
import { addLog, clearLogs, countLogs, listLogs, trimLogs } from '../src/storage/logStore';

const entry = (i: number, over: Partial<LogEntry> = {}): LogEntry => ({
  ts: 1_700_000_000_000 + i,
  level: 'info',
  ctx: 'test',
  module: 'm',
  msg: `entry ${i}`,
  ...over,
});

beforeEach(async () => {
  await clearLogs();
});

describe('IndexedDB schema', () => {
  it('creates every store from the spec at version 1', async () => {
    const db = await getDb();
    expect(db.version).toBe(DB_VERSION);
    expect([...db.objectStoreNames].sort()).toEqual([...ALL_STORES].sort());
  });

  it('keys candles by instrument_key + date and supports per-instrument range reads', async () => {
    const db = await getDb();
    const k = 'NSE_EQ|INE849A01020';
    const c0 = { open: 1, high: 1, low: 1, volume: 1 };
    await db.put('candles', { ...c0, instrument_key: k, date: '2026-06-03', close: 1 });
    await db.put('candles', { ...c0, instrument_key: k, date: '2026-06-02', close: 2 });
    await db.put('candles', { ...c0, instrument_key: 'NSE_EQ|OTHER', date: '2026-06-02', close: 3 });
    const rows = await db.getAll('candles', IDBKeyRange.bound([k, ''], [k, '￿']));
    expect(rows.map((r) => r.date)).toEqual(['2026-06-02', '2026-06-03']);
    // re-putting the same key overwrites (idempotent daily sync)
    await db.put('candles', { ...c0, instrument_key: k, date: '2026-06-03', close: 9 });
    expect((await db.get('candles', [k, '2026-06-03']))?.close).toBe(9);
  });
});

describe('log ring buffer', () => {
  it('trims to the newest N entries', async () => {
    for (let i = 0; i < 25; i++) await addLog(entry(i));
    expect(await trimLogs(10)).toBe(15);
    expect(await countLogs()).toBe(10);
    const rows = await listLogs({ limit: 100 });
    expect(rows[0]?.msg).toBe('entry 24'); // newest first
    expect(rows.at(-1)?.msg).toBe('entry 15');
  });

  it('does nothing when under the limit', async () => {
    for (let i = 0; i < 3; i++) await addLog(entry(i));
    expect(await trimLogs(10)).toBe(0);
    expect(await countLogs()).toBe(3);
  });

  it('trims exactly one when one over', async () => {
    for (let i = 0; i < 11; i++) await addLog(entry(i));
    expect(await trimLogs(10)).toBe(1);
    expect((await listLogs({ limit: 100 })).at(-1)?.msg).toBe('entry 1');
  });

  it('filters by level, context and text, and pages back', async () => {
    await addLog(entry(1, { level: 'debug' }));
    await addLog(entry(2, { level: 'warn', ctx: 'background', msg: 'Feed stale' }));
    await addLog(entry(3, { level: 'error', ctx: 'sidepanel', data: { symbol: 'TRENT' } }));
    await addLog(entry(4));
    expect((await listLogs({ minLevel: 'warn' })).map((e) => e.msg)).toEqual(['entry 3', 'Feed stale']);
    expect((await listLogs({ ctx: 'background' })).map((e) => e.msg)).toEqual(['Feed stale']);
    expect((await listLogs({ text: 'trent' })).map((e) => e.msg)).toEqual(['entry 3']);
    const first = await listLogs({ limit: 2 });
    expect(first.map((e) => e.msg)).toEqual(['entry 4', 'entry 3']);
    const next = await listLogs({ limit: 2, beforeId: first.at(-1)!.id });
    expect(next.map((e) => e.msg)).toEqual(['Feed stale', 'entry 1']);
  });
});

describe('upgrade of a phone on app 1.20.1 (database version 2) to version 3', () => {
  it('keeps the stored 5-minute history and instruments, and adds the empty download-state store', async () => {
    const { openDB, deleteDB } = await import('idb');
    const name = DB_NAME;
    await __resetDb();
    await deleteDB(name);
    // the database exactly as app 1.20.1 left it: version 2, with data in it
    const old = await openDB(name, 2, {
      upgrade(db) {
        db.createObjectStore('instruments', { keyPath: 'instrument_key' });
        db.createObjectStore('candles', { keyPath: ['instrument_key', 'date'] });
        db.createObjectStore('intraday', { keyPath: ['key', 'date'] });
      },
    });
    await old.put('instruments', { instrument_key: 'NSE_EQ|INE002A01018', trading_symbol: 'RELIANCE' });
    await old.put('intraday', { key: 'NSE_EQ|INE002A01018', date: '2026-11-19', t: [555], o: [1], h: [1], l: [1], c: [1], v: [10] });
    old.close();
    // the new app opens it
    const db = await getDb();
    expect(db.version).toBe(DB_VERSION);
    expect(db.objectStoreNames.contains('historyState')).toBe(true);
    expect(await db.get('instruments', 'NSE_EQ|INE002A01018')).toMatchObject({ trading_symbol: 'RELIANCE' });
    expect(await db.get('intraday', ['NSE_EQ|INE002A01018', '2026-11-19'])).toMatchObject({ v: [10] });
    expect(await db.get('historyState', 'intraday:NSE_EQ|INE002A01018')).toBeUndefined();
    // leave a full, fresh database for the other tests
    await __resetDb();
    await deleteDB(name);
  });
});
