import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { DB_SCHEMA_VERSION, MIGRATIONS, openStore } from '../src/storage/sqlite';
import { tempDir } from './helpers';

/**
 * Milestone 4 review — the production database goes from schema 2 (milestone 3, running on AWS) to
 * schema 3 (three new tables). Built here exactly like a milestone 3 server leaves it, filled with the
 * kinds of data it holds (settings, watchlist, alert history, learned models, signals, candle history,
 * alarms, journal, server lock), then opened by this version: everything must be byte-for-byte the same,
 * the new tables empty; a migration that fails must leave schema 2 and every row as they were.
 */

let tmp: ReturnType<typeof tempDir>;
afterEach(() => tmp?.cleanup());

/** A database exactly as a milestone 3 server leaves it (schema 2), with sample data. */
function milestone3Db(dir: string): string {
  const path = join(dir, 'tradebuddy.db');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
  for (let v = 0; v < 2; v++) {
    db.exec(MIGRATIONS[v]!);
    db.prepare('UPDATE schema_version SET version = ?').run(v + 1);
  }
  const kv = db.prepare('INSERT INTO kv (area, key, value, updated_at) VALUES (?, ?, ?, ?)');
  kv.run('local', 'watchlist', JSON.stringify(['NSE_EQ|INE002A01018', 'NSE_EQ|INE040A01034']), 1);
  kv.run('local', 'settings', JSON.stringify({ ui: { theme: 'dark' }, dayTrade: { enabled: true, earlyCapitalInr: 20000, earlyRiskInr: 100 } }), 2);
  kv.run('local', 'alertHistory', JSON.stringify({ items: [{ id: 'alert:bo-X-1', title: 'Breakout: X', message: 'm', at: 3 }], clearedAt: null, seen: { 'alert:bo-X-1': 3 }, dismissed: {} }), 3);
  kv.run('local', 'riseModel', JSON.stringify({ version: 'rise-v2', weights: Array.from({ length: 40 }, (_, i) => i / 40), trainedAt: 4 }), 4);
  kv.run('local', 'wallet', JSON.stringify({ cash: 1_000_000, holdings: [{ key: 'NSE_EQ|INE002A01018', qty: 3 }] }), 5);
  kv.run('session', 'intraday', JSON.stringify({ date: '2026-11-18', rows: [{ symbol: 'URBANCO', call: 'BUY' }] }), 6);
  const idb = db.prepare('INSERT INTO idb_rows (store, k, kj, v, i1, i2) VALUES (?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < 300; i++) idb.run('candles', `NSE_EQ|INE002A01018\u00012026-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}#${i}`, `["k",${i}]`, JSON.stringify({ o: 100 + i, h: 101 + i, l: 99 + i, c: 100.5 + i, v: 1000 * i }), 'NSE_EQ|INE002A01018', null);
  idb.run('signals', 'sig-1', '"sig-1"', JSON.stringify({ key: 'NSE_EQ|INE040A01034', side: 'buy', score: 72 }), 'NSE_EQ|INE040A01034', '2026-11-18');
  idb.run('alertLog', 'log-1', '"log-1"', JSON.stringify({ kind: 'stop', at: 7 }), null, null);
  db.prepare('INSERT INTO alarms (name, scheduled_time, period_minutes) VALUES (?, ?, ?)').run('poll', 1_763_520_000_000, 0.5);
  db.prepare('INSERT INTO server_events (ts, kind, data) VALUES (?, ?, ?)').run(8, 'start', JSON.stringify({ version: '0.3.0' }));
  db.prepare('INSERT INTO server_lock (id, pid, host, started_at, heartbeat_at) VALUES (1, 4242, ?, 9, 10)').run('ip-172-31-0-1');
  db.close();
  return path;
}

/** Every row of every table the milestone 3 database has, in a fixed order. */
function dump(path: string): Record<string, unknown[]> {
  const db = new DatabaseSync(path, { readOnly: true });
  const out: Record<string, unknown[]> = {};
  for (const [table, order] of [
    ['kv', 'area, key'],
    ['idb_rows', 'store, k'],
    ['alarms', 'name'],
    ['server_events', 'id'],
    ['server_lock', 'id'],
  ] as const)
    out[table] = db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();
  db.close();
  return out;
}

const tables = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true });
  const t = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
  db.close();
  return t;
};

describe('schema 2 → 3 (milestone 3 → milestone 4), now ending at schema 4', () => {
  it('keeps every existing record exactly — settings, watchlist, alert history, models, wallet, signals, candles, alarms, journal', () => {
    tmp = tempDir();
    const path = milestone3Db(tmp.dir);
    const before = dump(path);
    expect(before.idb_rows).toHaveLength(302);
    const store = openStore(tmp.dir);
    expect(store.schemaVersion).toBe(DB_SCHEMA_VERSION); // 2 → 3 → 4 in one start (app 1.22 adds the auto-trader tables)
    expect(DB_SCHEMA_VERSION).toBe(4);
    store.close();
    expect(dump(path)).toEqual(before); // nothing changed, nothing lost
    expect(tables(path)).toEqual(expect.arrayContaining(['devices', 'pairing_codes', 'push_outbox', 'kv', 'idb_rows', 'alarms', 'server_events', 'server_lock']));
    const db = new DatabaseSync(path, { readOnly: true });
    for (const t of ['devices', 'pairing_codes', 'push_outbox']) expect((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n).toBe(0);
    db.close();
  });

  it('opening again changes nothing (the migration runs once)', () => {
    tmp = tempDir();
    milestone3Db(tmp.dir);
    openStore(tmp.dir).close();
    const after1 = dump(join(tmp.dir, 'tradebuddy.db'));
    const s = openStore(tmp.dir);
    expect(s.schemaVersion).toBe(DB_SCHEMA_VERSION);
    s.close();
    expect(dump(join(tmp.dir, 'tradebuddy.db'))).toEqual(after1);
  });

  it('a migration that fails leaves schema 2 and every row untouched (one transaction)', () => {
    tmp = tempDir();
    const path = milestone3Db(tmp.dir);
    // something in the way of migration 3 (a table with its name already there)
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE push_outbox (x INTEGER)');
    db.close();
    const before = dump(path);
    expect(() => openStore(tmp.dir)).toThrow();
    const check = new DatabaseSync(path, { readOnly: true });
    expect((check.prepare('SELECT version FROM schema_version').get() as { version: number }).version).toBe(2);
    expect(check.prepare("SELECT name FROM sqlite_master WHERE name IN ('devices', 'pairing_codes')").all()).toEqual([]);
    check.close();
    expect(dump(path)).toEqual(before);
  });

  it('the backup copy taken before the update opens as the old schema (the rollback path)', () => {
    tmp = tempDir();
    const path = milestone3Db(tmp.dir);
    // the deploy checklist: stop the service, then copy the database file (and -wal / -shm if present)
    const backup = join(tmp.dir, 'backup.db');
    copyFileSync(path, backup);
    for (const ext of ['-wal', '-shm']) if (existsSync(path + ext)) copyFileSync(path + ext, backup + ext);
    openStore(tmp.dir).close(); // the update
    const b = new DatabaseSync(backup, { readOnly: true });
    expect((b.prepare('SELECT version FROM schema_version').get() as { version: number }).version).toBe(2);
    expect((b.prepare('SELECT COUNT(*) AS n FROM idb_rows').get() as { n: number }).n).toBe(302);
    b.close();
  });

  it('a database newer than the code is refused, never changed (an older build cannot damage it)', () => {
    tmp = tempDir();
    milestone3Db(tmp.dir);
    openStore(tmp.dir).close();
    const db = new DatabaseSync(join(tmp.dir, 'tradebuddy.db'));
    db.prepare('UPDATE schema_version SET version = ?').run(DB_SCHEMA_VERSION + 1);
    db.close();
    expect(() => openStore(tmp.dir)).toThrow(/newer than this server/);
  });
});

/** A database exactly as a milestone 4 server leaves it (schema 3, on AWS today): with its own auto-trader, paired phones, pushes. */
function milestone4Db(dir: string): string {
  const path = milestone3Db(dir);
  const db = new DatabaseSync(path);
  db.exec(MIGRATIONS[2]!);
  db.prepare('UPDATE schema_version SET version = 3').run();
  const kv = db.prepare('INSERT INTO kv (area, key, value, updated_at) VALUES (?, ?, ?, ?)');
  // the auto-trader the milestone 4 server ran by itself (TB_JOBS=on): it must be kept exactly
  kv.run('local', 'bot', JSON.stringify({ v: 1, enabled: true, createdAt: 11, wallet: { v: 1, cash: 4_990_000, startCash: 5_000_000, createdAt: 11, holdings: [], orders: [], fills: [{ key: 'K', pnl: -10_000 }] }, brain: { v: 1, n: 1, wins: 0 }, trades: [{ id: 'B1', status: 'closed' }], log: [], day: { date: '2026-11-19', opened: 1 }, lastRun: 12, lastDecideAt: 12, note: null, looked: 3, equity: [] }), 12);
  db.prepare("INSERT INTO devices (id, name, platform, app_version, secret_hash, token_state, categories, created_at) VALUES ('d1', 'Alan RC2', 'android', '1.21.0', 'h', 'active', '[]', 13)").run();
  db.prepare("INSERT INTO push_outbox (alert_id, device_id, payload, status, next_at, created_at) VALUES ('test-push-d1', 'd1', '{}', 'sent', 14, 14)").run();
  db.close();
  return path;
}

describe('schema 3 → 4 (milestone 4 → app 1.22, the cloud auto-trader)', () => {
  const all = (path: string) => {
    const out = dump(path);
    const db = new DatabaseSync(path, { readOnly: true });
    for (const t of ['devices', 'push_outbox', 'pairing_codes']) out[t] = db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all();
    db.close();
    return out;
  };

  it('keeps every row — the server’s own auto-trader too — and starts on standby with empty audit and backups', () => {
    tmp = tempDir();
    const path = milestone4Db(tmp.dir);
    const before = all(path);
    openStore(tmp.dir).close();
    expect(all(path)).toEqual(before);
    const db = new DatabaseSync(path, { readOnly: true });
    const a = db.prepare('SELECT * FROM bot_authority').all() as Array<{ id: number; server_id: string; mode: string; epoch: number; controller_id: string | null }>;
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ id: 1, mode: 'standby', epoch: 0, controller_id: null });
    expect(a[0]!.server_id).toMatch(/^[0-9a-f]{32}$/);
    for (const t of ['bot_audit', 'bot_backups']) expect((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT version FROM schema_version').get() as { version: number }).version).toBe(4);
    db.close();
  });

  it('a failed migration 4 leaves schema 3 and every row untouched', () => {
    tmp = tempDir();
    const path = milestone4Db(tmp.dir);
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE bot_backups (x INTEGER)'); // in the way of migration 4
    db.close();
    const before = all(path);
    expect(() => openStore(tmp.dir)).toThrow();
    const check = new DatabaseSync(path, { readOnly: true });
    expect((check.prepare('SELECT version FROM schema_version').get() as { version: number }).version).toBe(3);
    expect(check.prepare("SELECT name FROM sqlite_master WHERE name IN ('bot_authority', 'bot_audit')").all()).toEqual([]);
    check.close();
    expect(all(path)).toEqual(before);
  });

  it('the server id stays the same on every start (the phone recognises its server)', () => {
    tmp = tempDir();
    milestone4Db(tmp.dir);
    const id = () => {
      const s = openStore(tmp.dir);
      const r = s.db.prepare('SELECT server_id FROM bot_authority').get() as { server_id: string };
      s.close();
      return r.server_id;
    };
    expect(id()).toBe(id());
  });
});
