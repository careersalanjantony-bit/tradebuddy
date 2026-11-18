import { afterEach, describe, expect, it } from 'vitest';
import { secretsOverlay } from '../src/adapters/secrets';
import { ChangeHub, SqliteKV, type StorageChange } from '../src/storage/kv';
import { openStore, type Store } from '../src/storage/sqlite';
import { tempDir } from './helpers';

const open: Store[] = [];
const dirs: Array<() => void> = [];
function fresh(dir?: string): { store: Store; dir: string } {
  const t = dir ? { dir, cleanup: () => undefined } : tempDir();
  if (!dir) dirs.push(t.cleanup);
  const store = openStore(t.dir);
  open.push(store);
  return { store, dir: t.dir };
}

afterEach(() => {
  for (const s of open.splice(0)) s.close();
  for (const c of dirs.splice(0)) c();
});

describe('SQLite store', () => {
  it('creates the schema once, answers pings and keeps a small journal', () => {
    const { store, dir } = fresh();
    expect(store.schemaVersion).toBe(1);
    expect(store.ping()).toBe(true);
    store.event('start', { pid: 1 }, 1000);
    store.event('stop', undefined, 2000);
    expect(store.recentEvents(10).map((e) => [e.kind, e.ts, e.data])).toEqual([
      ['stop', 2000, null],
      ['start', 1000, { pid: 1 }],
    ]);
    store.close();
    expect(store.ping()).toBe(false);
    const again = fresh(dir).store;
    expect(again.schemaVersion).toBe(1);
    expect(again.recentEvents(10)).toHaveLength(2);
  });
});

describe('chrome.storage replacement (SqliteKV)', () => {
  it('answers get() in all of chrome.storage forms', async () => {
    const { store } = fresh();
    const kv = new SqliteKV(store.db, 'local');
    await kv.set({ a: 1, b: { x: [1, 2] }, skip: undefined });
    expect(await kv.get('a')).toEqual({ a: 1 });
    expect(await kv.get(['a', 'b', 'missing'])).toEqual({ a: 1, b: { x: [1, 2] } });
    expect(await kv.get({ a: 0, missing: 'fallback' })).toEqual({ a: 1, missing: 'fallback' });
    expect(await kv.get(null)).toEqual({ a: 1, b: { x: [1, 2] } });
    // a copy, like chrome.storage: changing it does not change what is stored
    const got = (await kv.get('b')).b as { x: number[] };
    got.x.push(3);
    expect(await kv.get('b')).toEqual({ b: { x: [1, 2] } });
    await kv.remove('a');
    expect(await kv.get('a')).toEqual({});
    await kv.clear();
    expect(await kv.get(null)).toEqual({});
  });

  it('local storage is saved at once; session storage on flush and on close — both survive a restart', async () => {
    const { store, dir } = fresh();
    const local = new SqliteKV(store.db, 'local');
    const session = new SqliteKV(store.db, 'session', { writeBehindMs: 60_000 });
    await local.set({ plans: [{ id: 'p1' }] });
    await session.set({ quotes: { K: { ltp: 10 } } });
    expect(session.pendingWrites).toBe(1);
    // a crash now would lose only the last few seconds of session data
    const peek = new SqliteKV(store.db, 'session');
    expect(await peek.get('quotes')).toEqual({});
    session.close();
    local.close();
    store.close();

    const next = fresh(dir).store;
    expect(await new SqliteKV(next.db, 'local').get('plans')).toEqual({ plans: [{ id: 'p1' }] });
    expect(await new SqliteKV(next.db, 'session').get('quotes')).toEqual({ quotes: { K: { ltp: 10 } } });
  });

  it('tells change listeners (chrome.storage.onChanged) with the area name', async () => {
    const { store } = fresh();
    const hub = new ChangeHub();
    const kv = new SqliteKV(store.db, 'session', { hub });
    const seen: Array<[Record<string, StorageChange>, string]> = [];
    hub.addListener((c, area) => seen.push([c, area]));
    await kv.set({ n: 1 });
    await kv.set({ n: 2 });
    await kv.remove('n');
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([
      [{ n: { oldValue: undefined, newValue: 1 } }, 'session'],
      [{ n: { oldValue: 1, newValue: 2 } }, 'session'],
      [{ n: { oldValue: 2 } }, 'session'],
    ]);
  });

  it('secrets come from the environment and never reach the database', async () => {
    const { store } = fresh();
    const kv = new SqliteKV(store.db, 'local', { overlay: secretsOverlay({ upstoxAnalyticsToken: 'env-token' }) });
    expect(await kv.get('secrets')).toEqual({ secrets: { upstoxAnalyticsToken: 'env-token' } });
    // the app's Settings screen code would save a token like this — on the server it is dropped
    await kv.set({ secrets: { upstoxAnalyticsToken: 'typed-token', upstoxApiSecret: 's3cret' } });
    expect(await kv.get('secrets')).toEqual({ secrets: { upstoxAnalyticsToken: 'env-token' } });
    const rows = store.db.prepare("SELECT value FROM kv WHERE key = 'secrets'").all() as Array<{ value: string }>;
    expect(rows.map((r) => r.value)).toEqual(['{}']);
    expect(JSON.stringify(store.db.prepare('SELECT * FROM kv').all())).not.toMatch(/env-token|typed-token|s3cret/);
    // without a token in the environment there is no token at all
    const none = new SqliteKV(store.db, 'local', { overlay: secretsOverlay({ upstoxAnalyticsToken: null }) });
    expect(await none.get('secrets')).toEqual({ secrets: {} });
  });

  it('after close, writes stay in memory and nothing throws', async () => {
    const { store } = fresh();
    const kv = new SqliteKV(store.db, 'local');
    kv.close();
    await expect(kv.set({ late: 1 })).resolves.toBeUndefined();
    expect(await kv.get('late')).toEqual({ late: 1 });
    expect(kv.writeErrors).toBe(0);
  });
});
