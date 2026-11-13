import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/storage/defaults';
import { MemoryKV } from '../src/storage/kv';
import { LOCAL_SCHEMA_VERSION, runLocalMigrations } from '../src/storage/migrations';
import type { Meta } from '../src/storage/schema';

describe('local storage migrations', () => {
  it('initialises a fresh install', async () => {
    const kv = new MemoryKV();
    const r = await runLocalMigrations(kv, 1000);
    expect(r).toMatchObject({ from: 0, to: LOCAL_SCHEMA_VERSION, newerThanCode: false });
    expect(r.applied.length).toBe(LOCAL_SCHEMA_VERSION);
    const all = await kv.get(['meta', 'settings', 'secrets', 'auth', 'watchlist', 'alerts', 'plans', 'scheduleState']);
    expect(all.settings).toEqual(DEFAULT_SETTINGS);
    expect(all.secrets).toEqual({});
    expect(all.auth).toEqual({ status: 'logged_out' });
    expect(all.watchlist).toEqual([]);
    expect((await kv.get(['marketCalendar'])).marketCalendar).toBeNull();
    expect(all.meta).toEqual({ schemaVersion: LOCAL_SCHEMA_VERSION, installedAt: 1000, lastMigratedAt: 1000 });
  });

  it('is idempotent and keeps existing data', async () => {
    const kv = new MemoryKV();
    await kv.set({ watchlist: ['NSE_EQ|INE002A01018'], secrets: { claudeApiKey: 'sk-ant-x' } });
    await runLocalMigrations(kv, 1000);
    const again = await runLocalMigrations(kv, 2000);
    expect(again.applied).toEqual([]);
    const { watchlist, secrets, meta } = await kv.get(['watchlist', 'secrets', 'meta']);
    expect(watchlist).toEqual(['NSE_EQ|INE002A01018']);
    expect(secrets).toEqual({ claudeApiKey: 'sk-ant-x' });
    expect((meta as Meta).installedAt).toBe(1000);
  });

  it('upgrades a v1 install (adds marketCalendar) without touching other data', async () => {
    const kv = new MemoryKV();
    await kv.set({ meta: { schemaVersion: 1, installedAt: 5, lastMigratedAt: 5 }, watchlist: ['A'], settings: { ui: { theme: 'dark' } } });
    const r = await runLocalMigrations(kv, 9);
    expect(r).toMatchObject({ from: 1, to: LOCAL_SCHEMA_VERSION });
    const all = await kv.get(['marketCalendar', 'watchlist', 'settings', 'meta']);
    expect(all.marketCalendar).toBeNull();
    expect(all.watchlist).toEqual(['A']);
    expect(all.settings).toEqual({ ui: { theme: 'dark' } });
    expect((all.meta as Meta).installedAt).toBe(5);
  });

  it('v3 switches the old 2R default to history-based exits, but keeps a deliberate other choice', async () => {
    const kv = new MemoryKV();
    await kv.set({ meta: { schemaVersion: 2, installedAt: 1, lastMigratedAt: 1 }, settings: { planner: { targetMethod: '2R', stopMethod: 'atr' } } });
    await runLocalMigrations(kv, 5);
    expect(((await kv.get(['settings'])).settings as { planner: { targetMethod: string; stopMethod: string } }).planner).toEqual({ targetMethod: 'history', stopMethod: 'atr' });
    const kv2 = new MemoryKV();
    await kv2.set({ meta: { schemaVersion: 2, installedAt: 1, lastMigratedAt: 1 }, settings: { planner: { targetMethod: '3R' } } });
    await runLocalMigrations(kv2, 5);
    expect(((await kv2.get(['settings'])).settings as { planner: { targetMethod: string } }).planner.targetMethod).toBe('3R');
  });

  it('does not touch data written by a newer version', async () => {
    const kv = new MemoryKV();
    await kv.set({ meta: { schemaVersion: LOCAL_SCHEMA_VERSION + 5, installedAt: 1, lastMigratedAt: 1 } });
    const r = await runLocalMigrations(kv);
    expect(r.newerThanCode).toBe(true);
    expect(await kv.get(['settings'])).toEqual({});
  });
});
