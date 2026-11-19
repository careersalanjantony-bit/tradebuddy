import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction, type StoreNames } from 'idb';
import type { LogLevel } from './schema';
import type { Instrument } from '../data/instrumentsParse';
import type { Candle } from '../indicators/types';
import type { CorporateAction } from '../indicators/adjust';
import type { AlertFiring } from '../alerts/rules';
import type { DayBars } from '../daytrade/types';
import type { HistoricalRequestState } from '../upstox/historicalQueue';

/**
 * IndexedDB (spec §17): instruments, candles (instrument_key + date), adjustments,
 * corporateActions, fundamentals, news, reports, journal, alertLog, logs.
 *
 * Every schema change bumps DB_VERSION and adds a step to `upgradeDb`. Never edit a released step.
 * Value types for stores used by later milestones are deliberately loose; each milestone tightens
 * its own store's type.
 */

export const DB_NAME = 'swing-assistant';
export const DB_VERSION = 3;

export type LogContext = 'background' | 'sidepanel' | 'popup' | 'offscreen' | 'test' | 'unknown';

export interface LogEntry {
  id?: number;
  /** epoch ms */
  ts: number;
  level: LogLevel;
  ctx: LogContext;
  module: string;
  msg: string;
  data?: unknown;
}

type Loose = Record<string, unknown>;

export type CandleRow = Candle & { instrument_key: string };

export interface CorpActionsRecord {
  isin: string;
  fetchedAt: number;
  actions: CorporateAction[];
  error?: string;
}

/** Owner's decisions about suspicious gaps (spec §7.5 step 4). */
export interface AdjustmentOverride {
  instrument_key: string;
  /** dates the owner confirmed as genuine moves */
  ignoredGapDates: string[];
  updatedAt: number;
}

export type AlertLogEntry = AlertFiring & { id?: number };

export interface HistoryRecord {
  id: string;
  daily?: { today: string; final: boolean; closingRecheck: boolean };
  intraday?: { from: string; to: string }[];
  requests?: HistoricalRequestState;
}

export interface SwingDB extends DBSchema {
  instruments: { key: string; value: Instrument; indexes: { by_symbol: string; by_isin: string } };
  candles: { key: [string, string]; value: CandleRow; indexes: { by_instrument: string } };
  adjustments: { key: string; value: AdjustmentOverride };
  corporateActions: { key: string; value: CorpActionsRecord };
  fundamentals: { key: [string, string]; value: Loose & { isin: string; kind: string } };
  news: { key: string; value: Loose & { id: string }; indexes: { by_instrument: string; by_published: number } };
  reports: { key: string; value: Loose & { id: string }; indexes: { by_symbol: string; by_created: number } };
  journal: { key: string; value: Loose & { id: string }; indexes: { by_status: string; by_symbol: string } };
  alertLog: { key: number; value: AlertLogEntry; indexes: { by_ts: number } };
  logs: { key: number; value: LogEntry; indexes: { by_ts: number } };
  /** 5-minute candles, one record per stock per day (day-trade mode, v0.11.0) */
  intraday: { key: [string, string]; value: DayBars };
  historyState: { key: string; value: HistoryRecord };
}

export type SwingStore = StoreNames<SwingDB>;

export const ALL_STORES: SwingStore[] = [
  'instruments',
  'candles',
  'adjustments',
  'corporateActions',
  'fundamentals',
  'news',
  'reports',
  'journal',
  'alertLog',
  'logs',
  'intraday',
  'historyState',
];

export function upgradeDb(
  db: IDBPDatabase<SwingDB>,
  oldVersion: number,
  _newVersion: number | null,
  _tx: IDBPTransaction<SwingDB, SwingStore[], 'versionchange'>,
): void {
  if (oldVersion < 1) {
    const instruments = db.createObjectStore('instruments', { keyPath: 'instrument_key' });
    instruments.createIndex('by_symbol', 'trading_symbol');
    instruments.createIndex('by_isin', 'isin');

    const candles = db.createObjectStore('candles', { keyPath: ['instrument_key', 'date'] });
    candles.createIndex('by_instrument', 'instrument_key');

    db.createObjectStore('adjustments', { keyPath: 'instrument_key' });
    db.createObjectStore('corporateActions', { keyPath: 'isin' });
    db.createObjectStore('fundamentals', { keyPath: ['isin', 'kind'] });

    const news = db.createObjectStore('news', { keyPath: 'id' });
    news.createIndex('by_instrument', 'instrument_key');
    news.createIndex('by_published', 'published_time');

    const reports = db.createObjectStore('reports', { keyPath: 'id' });
    reports.createIndex('by_symbol', 'symbol');
    reports.createIndex('by_created', 'created_at');

    const journal = db.createObjectStore('journal', { keyPath: 'id' });
    journal.createIndex('by_status', 'status');
    journal.createIndex('by_symbol', 'symbol');

    const alertLog = db.createObjectStore('alertLog', { keyPath: 'id', autoIncrement: true });
    alertLog.createIndex('by_ts', 'ts');

    const logs = db.createObjectStore('logs', { keyPath: 'id', autoIncrement: true });
    logs.createIndex('by_ts', 'ts');
  }
  if (oldVersion < 2) {
    db.createObjectStore('intraday', { keyPath: ['key', 'date'] });
  }
  if (oldVersion < 3) {
    db.createObjectStore('historyState', { keyPath: 'id' });
  }
}

let dbPromise: Promise<IDBPDatabase<SwingDB>> | null = null;
let provider: (() => Promise<IDBPDatabase<SwingDB>>) | null = null;

/**
 * The TradeBuddy server (Node, no IndexedDB) puts its own storage behind the same calls
 * (server/src/storage/idb.ts, SQLite). The app never calls this.
 */
export function __setDbProvider(p: (() => Promise<IDBPDatabase<SwingDB>>) | null): void {
  provider = p;
  dbPromise = null;
}

export function getDb(name = DB_NAME): Promise<IDBPDatabase<SwingDB>> {
  if (provider) return provider();
  if (!dbPromise) {
    dbPromise = openDB<SwingDB>(name, DB_VERSION, {
      upgrade: upgradeDb,
      // Another context (e.g. a newer service worker) wants to upgrade: let go of our connection.
      blocking() {
        void dbPromise?.then((db) => db.close());
        dbPromise = null;
      },
      terminated() {
        dbPromise = null;
      },
    }).catch((err: unknown) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

/** Tests only. */
export async function __resetDb(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise.catch(() => null);
    db?.close();
  }
  dbPromise = null;
}
