import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAlertLog, recentAlertLog } from '../../src/alerts/engine';
import { getAdjustmentOverride, ignoreGap } from '../../src/data/corporateActions';
import { getRawCandles, getRecentCandles } from '../../src/data/candles';
import { countInstruments, findBySymbol, getInstrument } from '../../src/data/instruments';
import { countIntradayDays, getIntradayDays, pruneIntraday } from '../../src/data/intraday';
import { __setDbProvider } from '../../src/storage/db';
import { encodeKey, KeyRange, SqliteIdb } from '../src/storage/idb';
import { openStore, type Store } from '../src/storage/sqlite';
import { tempDir } from './helpers';

/**
 * Milestone 3: the app's IndexedDB on SQLite. First the store itself, then the app's own data code
 * (candles, 5-minute days, instruments, gaps, alert log) running on it unchanged.
 */

let store: Store;
let idb: SqliteIdb;
let cleanup: () => void;
const K = 'NSE_EQ|INE002A01018';

beforeEach(() => {
  const t = tempDir();
  cleanup = t.cleanup;
  store = openStore(t.dir);
  idb = new SqliteIdb(store.db);
  __setDbProvider(async () => idb as never);
});

afterEach(() => {
  __setDbProvider(null);
  store.close();
  cleanup();
});

const candle = (date: string, close: number) => ({ instrument_key: K, date, open: close, high: close + 1, low: close - 1, close, volume: 1000 });
const R = (lower: unknown, upper: unknown, lo = false, uo = false) => KeyRange.bound(lower, upper, lo, uo);

describe('keys sort like IndexedDB', () => {
  it('numbers < strings < arrays; numbers by value; arrays element by element', () => {
    const keys: unknown[] = [['b'], 'b', -5, 10, 2.5, ['a', 'z'], ['a'], 'a', 0, ['a', 'b'], 1e12];
    const sorted = [...keys].sort((x, y) => (encodeKey(x) < encodeKey(y) ? -1 : 1));
    expect(sorted).toEqual([-5, 0, 2.5, 10, 1e12, 'a', 'b', ['a'], ['a', 'b'], ['a', 'z'], ['b']]);
  });

  it('the app\'s "all days of one stock" range [key, ""] … [key, "\\uffff"]', () => {
    const r = R([K, ''], [K, '￿']);
    expect(r.includes([K, '2026-11-18'])).toBe(true);
    expect(r.includes(['NSE_EQ|OTHER', '2026-11-18'])).toBe(false);
  });

  it('encoded keys contain no NUL character (SQLite would cut the text there)', () => {
    expect(encodeKey([K, '2026-11-18'])).not.toContain('\u0000');
  });
});

describe('the store answers the idb calls the app makes', () => {
  it('put / get / getAll(range) / count(range) / delete(range) / clear', async () => {
    for (const d of ['2026-11-16', '2026-11-17', '2026-11-18']) await idb.put('candles', candle(d, 100));
    await idb.put('candles', { ...candle('2026-11-18', 5), instrument_key: 'NSE_EQ|OTHER' });
    expect(await idb.get('candles', [K, '2026-11-17'])).toMatchObject({ date: '2026-11-17' });
    expect(await idb.count('candles', R([K, ''], [K, '￿']))).toBe(3);
    expect((await idb.getAll('candles', R([K, ''], [K, '￿']))).map((c) => (c as { date: string }).date)).toEqual(['2026-11-16', '2026-11-17', '2026-11-18']);
    await idb.delete('candles', R([K, ''], [K, '2026-11-17']));
    expect(await idb.count('candles')).toBe(2);
    await idb.clear('candles');
    expect(await idb.count('candles')).toBe(0);
  });

  it('cursors walk forwards and backwards inside a range; key cursors give the primary key', async () => {
    for (let i = 1; i <= 5; i++) await idb.put('candles', candle(`2026-11-1${i}`, i));
    const tx = idb.transaction('candles');
    let cur = await tx.store.openCursor(R([K, ''], [K, '￿']), 'prev');
    const seen: string[] = [];
    while (cur) {
      seen.push(cur.value.date);
      cur = await cur.continue();
    }
    expect(seen).toEqual(['2026-11-15', '2026-11-14', '2026-11-13', '2026-11-12', '2026-11-11']);
    const kc = await idb.transaction('candles').store.openKeyCursor();
    expect(kc?.primaryKey).toEqual([K, '2026-11-11']);
    expect(kc?.value).toBeUndefined();
  });

  it('auto-increment ids (alert log) and duplicate keys on add', async () => {
    const a = await idb.add('alertLog', { ts: 1, message: 'one' });
    const b = await idb.add('alertLog', { ts: 2, message: 'two' });
    expect([a, b]).toEqual([1, 2]);
    expect(await idb.get('alertLog', 2)).toEqual({ ts: 2, message: 'two', id: 2 });
    await expect(idb.add('alertLog', { id: 1, ts: 3, message: 'x' })).rejects.toThrow(/ConstraintError/);
  });

  it('a readwrite transaction groups its writes and `done` resolves after them', async () => {
    const tx = idb.transaction('intraday', 'readwrite');
    for (let i = 0; i < 300; i++) void tx.store.put({ key: K, date: `2026-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`, t: [], o: [] });
    await tx.done;
    expect(await idb.count('intraday')).toBe(300);
  });

  it('everything survives closing and opening the database again', async () => {
    await idb.put('instruments', { instrument_key: K, trading_symbol: 'RELIANCE', isin: 'INE002A01018' });
    const dir = store.path.replace(/[\\/]tradebuddy\.db$/, '');
    store.close();
    store = openStore(dir);
    idb = new SqliteIdb(store.db);
    expect(await idb.getAllFromIndex('instruments', 'by_symbol', 'RELIANCE')).toHaveLength(1);
  });
});

describe("the app's own data code runs on it unchanged", () => {
  it('candles: all of one stock, and the newest n (a backwards cursor)', async () => {
    const tx = idb.transaction('candles', 'readwrite');
    for (let i = 10; i <= 20; i++) void tx.store.put(candle(`2026-11-${i}`, i));
    void tx.store.put({ ...candle('2026-11-20', 1), instrument_key: 'NSE_EQ|OTHER' });
    await tx.done;
    expect((await getRawCandles(K)).map((c) => c.date)).toHaveLength(11);
    expect((await getRecentCandles(K, 3)).map((c) => c.close)).toEqual([18, 19, 20]);
  });

  it('5-minute days: list, count and prune (a ranged delete)', async () => {
    for (const d of ['2026-10-01', '2026-11-17', '2026-11-18']) await idb.put('intraday', { key: K, date: d, t: [555], o: [1], h: [1], l: [1], c: [1], v: [1] });
    expect(await countIntradayDays(K)).toBe(3);
    expect((await getIntradayDays(K)).map((x) => x.date)).toEqual(['2026-10-01', '2026-11-17', '2026-11-18']);
    await pruneIntraday(K, 5, Date.parse('2026-11-18T10:00:00Z'));
    expect((await getIntradayDays(K)).map((x) => x.date)).toEqual(['2026-11-17', '2026-11-18']);
  });

  it('instruments by key and by symbol (an index); gap decisions; the alert log', async () => {
    await idb.put('instruments', { instrument_key: K, trading_symbol: 'RELIANCE', isin: 'INE002A01018', instrument_type: 'EQ' });
    expect(await countInstruments()).toBe(1);
    expect((await getInstrument(K))?.trading_symbol).toBe('RELIANCE');
    expect((await findBySymbol('RELIANCE'))?.instrument_key).toBe(K);
    await ignoreGap(K, '2026-03-02', 1000);
    expect((await getAdjustmentOverride(K))?.ignoredGapDates).toEqual(['2026-03-02']);
    await idb.add('alertLog', { ruleId: 'r1', ts: 5, message: 'older' });
    await idb.add('alertLog', { ruleId: 'r2', ts: 9, message: 'newer' });
    expect((await recentAlertLog(10)).map((e) => e.message)).toEqual(['newer', 'older']);
    await clearAlertLog();
    expect(await recentAlertLog(10)).toEqual([]);
  });
});
