import { closeFeed, ensureFeed, feedFresh } from '../../src/background/feed';
import { ensureScanLists, priceKeys } from '../../src/background/scanList';
import { marketState } from '../../src/data/calendar';
import { getCalendar, refreshCalendarIfNeeded } from '../../src/data/calendarSync';
import { INDEX_KEYS } from '../../src/data/indices';
import { getQuotes, pollLtp, pollQuotes } from '../../src/data/quotes';
import { __setDbProvider } from '../../src/storage/db';
import { chromeLocalKV } from '../../src/storage/kv';
import { getAuth, setLocal, updateSettings } from '../../src/storage/local';
import { runLocalMigrations } from '../../src/storage/migrations';
import type { AuthState } from '../../src/storage/schema';
import { getSession, setSession } from '../../src/storage/session';
import { installChrome } from './adapters/chrome';
import { secretsOverlay } from './adapters/secrets';
import { createHeartbeatWebSocket } from './adapters/websocket';
import type { ServerConfig } from './config';
import { buildRouter } from './http/routes';
import { createHttpServer } from './http/server';
import { createLogger, setupLogging, type LineWriter } from './log';
import { FeedSupervisor } from './market/feedSupervisor';
import { QuotePoller } from './market/quotePoller';
import { AlarmScheduler } from './engine/alarms';
import type { Intelligence } from './engine/jobs';
import { acquireLock } from './engine/lock';
import { installKeyRange, SqliteIdb } from './storage/idb';
import { ChangeHub, SqliteKV } from './storage/kv';
import { openStore, type Store } from './storage/sqlite';
import { Ticker } from './util/ticker';

/**
 * Starts everything, in this order: logging → database → chrome.storage replacement → the app's own
 * storage migrations → HTTP (health first) → background tasks (holidays, NSE lists, live feed, price
 * polls). `close()` stops it in the reverse order and saves everything. Used by main.ts and by tests.
 *
 * Read-only: nothing here (or in the shared code it runs) places, changes or cancels an order or a GTT.
 */

export interface EngineOptions {
  write?: LineWriter;
  feed?: { everyMs?: number; staleMs?: number; pingMs?: number; pongTimeoutMs?: number; rewriteUrl?: (url: string) => string };
  poller?: { everyMs?: number; fullEveryMs?: number; lightEveryMs?: number };
  now?: () => number;
  /** tests only: false = create the background tasks but do not start them (the test drives them) */
  startTasks?: boolean;
}

export interface RunningServer {
  readonly port: number;
  readonly config: ServerConfig;
  readonly store: Store;
  readonly feed: FeedSupervisor | null;
  readonly poller: QuotePoller | null;
  readonly tasks: Ticker[];
  /** milestone 3: the app's scheduled jobs (chrome.alarms) */
  readonly scheduler: AlarmScheduler;
  /** milestone 3: the app's intelligence (null when TB_JOBS=off) */
  readonly intelligence: Intelligence | null;
  ready(): boolean;
  close(reason: string): Promise<void>;
}

const log = createLogger('server');

export async function startServer(config: ServerConfig, opts: EngineOptions = {}): Promise<RunningServer> {
  setupLogging({ level: config.logLevel, secrets: [config.apiToken, config.upstoxAnalyticsToken], ...(opts.write ? { write: opts.write } : {}) });
  const now = opts.now ?? Date.now;
  const startedAt = now();
  log.info(`TradeBuddy server ${config.version} starting (Node ${process.version}, pid ${process.pid})`, { dataDir: config.dataDir, liveFeed: config.liveFeed, backgroundTasks: config.backgroundTasks });

  const store = openStore(config.dataDir);
  let lock;
  try {
    lock = acquireLock(store.db, now);
  } catch (err) {
    store.close();
    throw err;
  }
  // the app's IndexedDB, on SQLite (milestone 3)
  const idb = new SqliteIdb(store.db);
  installKeyRange();
  __setDbProvider(async () => idb as never);
  const scheduler = new AlarmScheduler(store.db, now);
  const hub = new ChangeHub();
  const local = new SqliteKV(store.db, 'local', { hub, overlay: secretsOverlay(config) });
  const session = new SqliteKV(store.db, 'session', { hub, writeBehindMs: 2_000 });
  const uninstallChrome = installChrome({
    local,
    session,
    hub,
    version: config.version,
    alarms: scheduler.api,
    notify: (id, o) => {
      log.info(`Alert: ${o.title ?? id}`, { id, message: o.message });
      store.event('alert', { id, title: o.title ?? null });
    },
  });

  const sockets = createHeartbeatWebSocket({ pingMs: opts.feed?.pingMs ?? 20_000, pongTimeoutMs: opts.feed?.pongTimeoutMs ?? 10_000, ...(opts.feed?.rewriteUrl ? { rewriteUrl: opts.feed.rewriteUrl } : {}) });
  const g = globalThis as { WebSocket?: unknown };
  const previousWebSocket = g.WebSocket;
  g.WebSocket = sockets.WebSocket;

  const tasks: Ticker[] = [];
  let feed: FeedSupervisor | null = null;
  let poller: QuotePoller | null = null;
  let isReady = false;
  const hasToken = !!config.upstoxAnalyticsToken;

  let intelligence: Intelligence | null = null;
  const undo = () => {
    uninstallChrome();
    g.WebSocket = previousWebSocket;
    __setDbProvider(null);
  };

  let port: number;
  let http: ReturnType<typeof createHttpServer> | undefined;
  try {
    const mig = await runLocalMigrations(chromeLocalKV, now());
    if (mig.newerThanCode) log.warn(`Stored data schema v${mig.from} is newer than this build — nothing migrated`);
    else if (mig.applied.length) log.info(`App storage migrated v${mig.from} → v${mig.to}`);

    // a token that Upstox rejected before a restart may have been replaced since: check it again
    if (hasToken) {
      const auth = await getAuth();
      if (auth.analytics) {
        const { analytics: _old, ...rest } = auth;
        await setLocal('auth', rest as AuthState);
      }
    } else {
      log.warn('UPSTOX_ANALYTICS_TOKEN is not set: no market data until it is');
    }
    if (!config.apiToken) log.warn('TB_API_TOKEN is not set: the REST API is off (health checks still answer)');
    await updateSettings({ data: { liveFeed: config.liveFeed } });
    // the feed state saved before a restart is not true any more
    const fs = await getSession('feedStatus');
    if (fs?.connected) await setSession('feedStatus', { ...fs, connected: false, at: now() });

    if (config.liveFeed && hasToken) {
      feed = new FeedSupervisor(
        {
          ensureFeed: (t, force) => ensureFeed(t, force),
          closeFeed,
          readStatus: () => getSession('feedStatus'),
          socketStats: sockets.stats,
          now,
        },
        opts.feed?.staleMs ?? 90_000,
      );
      tasks.push(new Ticker('live-feed', opts.feed?.everyMs ?? 5_000, () => feed!.check(), 3_000));
    }
    // milestone 2 price polls — with the app's jobs running (TB_JOBS=on) their own 30-second poll and
    // fast checks do this, with every analysis after it, so this simple poller is not started then
    if (config.backgroundTasks && hasToken && !config.jobs) {
      poller = new QuotePoller(
        {
          calendar: getCalendar,
          lastPoll: () => getSession('lastPoll'),
          keys: async () => [...(await priceKeys()), ...INDEX_KEYS],
          feedFresh: (t) => feedFresh(t),
          pollFull: (keys, t) => pollQuotes(keys, t),
          pollLight: (keys, t) => pollLtp(keys, t),
          now,
        },
        opts.poller?.fullEveryMs ?? 30_000,
        opts.poller?.lightEveryMs ?? 5_000,
      );
      tasks.push(new Ticker('prices', opts.poller?.everyMs ?? 2_500, () => poller!.check(), 2_000));
      tasks.push(new Ticker('holidays', 3_600_000, async () => (await refreshCalendarIfNeeded(now()), 'checked'), 1_000));
    }
    if (config.backgroundTasks) {
      // the five NSE index lists the app studies (weekly from NSE, bundled copy as fallback)
      tasks.push(new Ticker('index-lists', 6 * 3_600_000, async () => `${Object.keys((await ensureScanLists(false, now())).lists).length} lists`, 10_000));
    }

    const router = buildRouter({
      version: config.version,
      startedAt,
      ready: () => isReady,
      dbOk: () => store.ping(),
      dbInfo: () => ({ path: store.path, schemaVersion: store.schemaVersion }),
      storageInfo: () => ({ localKeys: local.size, sessionKeys: session.size, pendingWrites: session.pendingWrites, writeErrors: local.writeErrors + session.writeErrors }),
      feedHealth: () => feed?.health() ?? null,
      pollerHealth: () => poller?.health() ?? null,
      tasks: () => [...tasks, ...(intelligence?.tasks ?? [])].map((t) => t.status()),
      marketState: async (t) => marketState(t, await getCalendar()),
      calendar: getCalendar,
      quotes: getQuotes,
      lastPoll: () => getSession('lastPoll'),
      apiStatus: () => getSession('apiStatus'),
      analytics: async () => {
        const a = (await getAuth()).analytics;
        return { configured: hasToken, status: hasToken ? (a?.status ?? 'unchecked') : 'missing', checkedAt: a?.checkedAt ?? null, error: a?.error ?? null };
      },
      events: (limit) => store.recentEvents(limit),
      readLocal: async (k) => (await local.get(k))[k],
      readSession: async (k) => (await session.get(k))[k],
      jobs: () => (config.jobs ? { scheduled: scheduler.getAll(), running: scheduler.runningNames(), fired: scheduler.fired, skipped: scheduler.skipped } : null),
      now,
    });
    http = createHttpServer({ host: config.host, port: config.port, apiToken: config.apiToken, router });
    port = await http.listen();
    if (config.jobs) {
      // milestone 3: the app's own jobs and timers (loaded only when on)
      const { startIntelligence } = await import('./engine/jobs');
      intelligence = startIntelligence({ scheduler, now, ...(opts.startTasks === false ? { startTasks: false } : {}) });
      await intelligence.ready;
    }
  } catch (err) {
    log.error('Start-up failed', { error: err });
    await intelligence?.stop().catch(() => undefined);
    await http?.close(1_000).catch(() => undefined);
    session.close();
    local.close();
    lock.release();
    store.close();
    undo();
    throw err;
  }

  if (opts.startTasks !== false) for (const t of tasks) t.start();
  isReady = true;
  store.event('start', { version: config.version, pid: process.pid, port });
  log.info(`Listening on http://${config.host}:${port} — tasks: ${tasks.map((t) => t.status().name).join(', ') || 'none'}`);

  let closing: Promise<void> | null = null;
  return {
    port,
    config,
    store,
    feed,
    poller,
    tasks,
    scheduler,
    intelligence,
    ready: () => isReady,
    close(reason: string) {
      closing ??= (async () => {
        isReady = false;
        log.info(`Stopping (${reason})`);
        store.event('stop', { reason });
        await http!.close(5_000);
        // no new job starts; jobs still running may finish (their writes are kept)
        await intelligence?.stop();
        await Promise.all(tasks.map((t) => t.stop()));
        feed?.stop('server stopping');
        await new Promise((r) => setImmediate(r)); // let a last group of IndexedDB writes commit
        session.close();
        local.close();
        log.info('Stopped: everything saved');
        lock.release();
        store.close();
        undo();
      })();
      return closing;
    },
  };
}
