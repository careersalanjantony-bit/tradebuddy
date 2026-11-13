import { initialLocalValues } from './defaults';
import type { KV } from './kv';
import type { Meta } from './schema';

/**
 * chrome.storage.local migrations. Each migration moves the schema to `to`.
 * Migrations must be idempotent: they may re-run if the worker dies mid-way.
 * Add new entries at the end; never edit a released migration.
 */
export interface LocalMigration {
  to: number;
  description: string;
  up(kv: KV): Promise<void>;
}

export const LOCAL_MIGRATIONS: LocalMigration[] = [
  {
    to: 1,
    description: 'initial schema: settings, secrets, auth, watchlist, alerts, plans, scheduleState',
    async up(kv) {
      const { marketCalendar: _later, universe: _later2, dayTrades: _later3, dayTest: _later4, ...initial } = initialLocalValues();
      const existing = await kv.get(Object.keys(initial));
      const missing: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(initial)) if (!(k in existing)) missing[k] = v;
      if (Object.keys(missing).length) await kv.set(missing);
    },
  },
  {
    to: 2,
    description: 'M1: add marketCalendar (NSE holidays)',
    async up(kv) {
      const { marketCalendar } = await kv.get(['marketCalendar']);
      if (marketCalendar === undefined) await kv.set({ marketCalendar: null });
    },
  },
  {
    to: 3,
    description: 'Owner choice (9 Nov 2026): history-based exit advice instead of a fixed 2R target',
    async up(kv) {
      const { settings } = (await kv.get(['settings'])) as { settings?: { planner?: { targetMethod?: string } } };
      if (settings?.planner?.targetMethod === '2R') {
        await kv.set({ settings: { ...settings, planner: { ...settings.planner, targetMethod: 'history' } } });
      }
    },
  },
  {
    to: 4,
    description: 'v0.7.0: universe (Nifty 50/100 list studied automatically)',
    async up(kv) {
      const { universe } = await kv.get(['universe']);
      if (universe === undefined) await kv.set({ universe: null });
    },
  },
  {
    to: 5,
    description: 'v0.11.0: day trades and the day-trade past test',
    async up(kv) {
      const { dayTrades, dayTest } = await kv.get(['dayTrades', 'dayTest']);
      const add: Record<string, unknown> = {};
      if (dayTrades === undefined) add.dayTrades = [];
      if (dayTest === undefined) add.dayTest = null;
      if (Object.keys(add).length) await kv.set(add);
    },
  },
  {
    to: 6,
    description: 'app v1.0: practice money wallet',
    async up(kv) {
      const { wallet } = await kv.get(['wallet']);
      if (wallet === undefined) await kv.set({ wallet: null });
      const { mlModel } = await kv.get(['mlModel']);
      if (mlModel === undefined) await kv.set({ mlModel: null });
      const { mlJournal } = await kv.get(['mlJournal']);
      if (mlJournal === undefined) await kv.set({ mlJournal: [] });
    },
  },
  {
    to: 7,
    description: 'app v1.1: day trading on (the owner focuses on day trades)',
    async up(kv) {
      const { settings } = (await kv.get(['settings'])) as { settings?: { dayTrade?: Record<string, unknown> } };
      if (settings?.dayTrade) await kv.set({ settings: { ...settings, dayTrade: { ...settings.dayTrade, enabled: true } } });
    },
  },
];

export const LOCAL_SCHEMA_VERSION = LOCAL_MIGRATIONS.reduce((m, x) => Math.max(m, x.to), 0);

export interface MigrationResult {
  from: number;
  to: number;
  applied: string[];
  /** Stored schema is newer than this code (downgrade) — nothing was changed. */
  newerThanCode: boolean;
}

export async function runLocalMigrations(kv: KV, now = Date.now()): Promise<MigrationResult> {
  const { meta } = (await kv.get(['meta'])) as { meta?: Meta };
  const from = meta?.schemaVersion ?? 0;
  if (from > LOCAL_SCHEMA_VERSION) {
    return { from, to: from, applied: [], newerThanCode: true };
  }
  const applied: string[] = [];
  let version = from;
  for (const m of [...LOCAL_MIGRATIONS].sort((a, b) => a.to - b.to)) {
    if (m.to <= version) continue;
    await m.up(kv);
    version = m.to;
    applied.push(`v${m.to}: ${m.description}`);
    const next: Meta = { schemaVersion: version, installedAt: meta?.installedAt ?? now, lastMigratedAt: now };
    await kv.set({ meta: next });
  }
  return { from, to: version, applied, newerThanCode: false };
}
