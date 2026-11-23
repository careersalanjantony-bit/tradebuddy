import type { MarketCalendar, MarketState } from '../../../src/data/calendar';
import type { Quote } from '../../../src/data/quotesParse';
import type { ApiStatus } from '../../../src/storage/session';
import type { historyJobProgress } from '../../../src/background/historicalJobs';
import type { historicalRequestDiagnostics } from '../../../src/upstox/client';
import type { FeedHealth } from '../market/feedSupervisor';
import type { QuotePollerHealth } from '../market/quotePoller';
import type { ServerEvent } from '../storage/sqlite';
import type { TickerStatus } from '../util/ticker';
import { BadRequest, Router } from './router';
import { BOT_API_VERSION } from '../../../src/bot/cloud';
import { APP_COMMIT } from '../config';

/**
 * The REST API (version 1). Health checks need no token; everything under /v1 does.
 *   GET /healthz            the process is alive (for systemd / load balancers)
 *   GET /readyz             database open and start-up finished (503 otherwise)
 *   GET /v1/health          everything the server knows about itself
 *   GET /v1/market/status   market phase, today's session, holidays, feed and last price poll
 *   GET /v1/quotes          latest prices (?keys=NSE_EQ|INE…,NSE_INDEX|Nifty 50 for some only)
 *   GET /v1/quotes/:key     one instrument's latest price
 *   GET /v1/events          the server's recent journal (starts, stops, feed restarts)
 */

export interface ApiDeps {
  version: string;
  startedAt: number;
  ready(): boolean;
  dbOk(): boolean;
  dbInfo(): { path: string; schemaVersion: number };
  storageInfo(): { localKeys: number; sessionKeys: number; pendingWrites: number; writeErrors: number };
  feedHealth(): FeedHealth | null;
  pollerHealth(): QuotePollerHealth | null;
  tasks(): TickerStatus[];
  marketState(now: number): Promise<MarketState>;
  calendar(): Promise<MarketCalendar | null>;
  quotes(): Promise<Record<string, Quote>>;
  lastPoll(): Promise<{ at: number; ok: boolean; count: number; error?: string } | undefined>;
  apiStatus(): Promise<ApiStatus | undefined>;
  historical?(): Promise<Awaited<ReturnType<typeof historyJobProgress>> & { rateLimit: Awaited<ReturnType<typeof historicalRequestDiagnostics>> }>;
  analytics(): Promise<{ configured: boolean; status: string; checkedAt: number | null; error: string | null }>;
  events(limit: number): ServerEvent[];
  /** milestone 3: the app's stored data, exactly as the app keeps it (chrome.storage.local / session) */
  readLocal?(key: string): Promise<unknown>;
  readSession?(key: string): Promise<unknown>;
  /** milestone 3: the app's scheduled jobs */
  jobs?(): { scheduled: Array<{ name: string; scheduledTime: number; periodInMinutes?: number }>; running: string[]; fired: number; skipped: number } | null;
  /** app 1.22: the cloud auto-trader — who runs it and how it is doing */
  autoTrader?(): Promise<unknown>;
  now?: () => number;
}

const MAX_KEYS = 1000;

export function buildRouter(d: ApiDeps): Router {
  const now = () => (d.now ? d.now() : Date.now());
  const uptime = () => Math.round((now() - d.startedAt) / 1000);
  const r = new Router();

  // app 1.22: `botApi` — the cloud auto-trader contract this server speaks (the phone checks it)
  // the release pipeline: `commit` = the exact build (checked after every deploy)
  r.add('GET', '/healthz', () => ({ body: { status: 'ok', version: d.version, commit: APP_COMMIT, uptimeSeconds: uptime(), botApi: BOT_API_VERSION } }), { auth: false, quiet: true });

  r.add(
    'GET',
    '/readyz',
    () => {
      const checks = { database: d.dbOk(), started: d.ready() };
      const ok = checks.database && checks.started;
      return { status: ok ? 200 : 503, body: { status: ok ? 'ready' : 'not_ready', checks } };
    },
    { auth: false, quiet: true },
  );

  r.add('GET', '/v1/health', async () => {
    const t = now();
    const mem = process.memoryUsage();
    const [market, analytics, apiStatus, lastPoll, historical, autoTrader] = await Promise.all([
      d.marketState(t), d.analytics(), d.apiStatus(), d.lastPoll(), d.historical?.(), d.autoTrader?.(),
    ]);
    return {
      body: {
        status: d.ready() && d.dbOk() ? 'ok' : 'degraded',
        version: d.version,
        node: process.version,
        pid: process.pid,
        startedAt: d.startedAt,
        uptimeSeconds: uptime(),
        memoryMb: { rss: Math.round(mem.rss / 1048576), heapUsed: Math.round(mem.heapUsed / 1048576) },
        database: { ok: d.dbOk(), ...d.dbInfo(), ...d.storageInfo() },
        market: { phase: market.phase, label: market.label },
        upstox: { analyticsToken: analytics, api: apiStatus ?? null, lastPoll: lastPoll ?? null, historical: historical ?? null },
        feed: d.feedHealth(),
        poller: d.pollerHealth(),
        tasks: d.tasks(),
        jobs: d.jobs?.() ?? null,
        autoTrader: autoTrader ?? null,
        readOnly: true,
      },
    };
  });

  r.add('GET', '/v1/market/status', async () => {
    const t = now();
    const [m, cal, lastPoll] = await Promise.all([d.marketState(t), d.calendar(), d.lastPoll()]);
    const feed = d.feedHealth();
    return {
      body: {
        now: t,
        phase: m.phase,
        label: m.label,
        session: m.session,
        nextOpenAt: m.nextOpenAt,
        calendar: cal ? { year: cal.year, fetchedAt: cal.fetchedAt, holidays: cal.holidays.length } : null,
        feed: feed ? { state: feed.state, connected: feed.connected, lastTickAt: feed.lastTickAt, keys: feed.keys } : null,
        lastPoll: lastPoll ?? null,
      },
    };
  });

  r.add('GET', '/v1/quotes', async ({ query }) => {
    const all = await d.quotes();
    const raw = query.get('keys');
    let quotes = all;
    if (raw !== null) {
      const keys = [...new Set(raw.split(',').map((k) => k.trim()).filter(Boolean))];
      if (!keys.length) throw new BadRequest('keys is empty: give instrument keys separated by commas.');
      if (keys.length > MAX_KEYS) throw new BadRequest(`At most ${MAX_KEYS} keys per request.`);
      quotes = {};
      for (const k of keys) if (all[k]) quotes[k] = all[k];
    }
    const times = Object.values(quotes).map((q) => q.fetchedAt);
    return { body: { at: times.length ? Math.max(...times) : null, count: Object.keys(quotes).length, quotes } };
  });

  r.add('GET', '/v1/quotes/:key', async ({ params }) => {
    const q = (await d.quotes())[params.key!];
    return q ? { body: q } : { status: 404, body: { error: 'not_found', message: `No price for ${params.key} yet.` } };
  });

  r.add('GET', '/v1/events', ({ query }) => {
    const limit = Math.min(500, Math.max(1, Number(query.get('limit') ?? 50) || 50));
    return { body: { events: d.events(limit) } };
  });

  // ---------- milestone 3: what the app's own jobs found and keep, in the app's own data structures
  const local = async (k: string) => (d.readLocal ? ((await d.readLocal(k)) ?? null) : null);
  const session = async (k: string) => (d.readSession ? ((await d.readSession(k)) ?? null) : null);
  const answer = (o: Record<string, unknown>) => ({ body: { at: now(), ...o } });

  /** Rising now (with the learned keep/sell tag), Early Movers, the pre-open list and flow risers */
  r.add('GET', '/v1/rising', async () => {
    const [rise, early, preopen, flow] = await Promise.all([session('rise'), session('early'), session('preopen'), session('flow')]);
    const f = flow as { at?: number; rising?: unknown } | null;
    return answer({ rise, early, preopen, flow: f ? { at: f.at ?? null, rising: f.rising ?? [] } : null });
  });

  /** app v1.19: the Intraday scanner's latest round (BUY / WAIT / NO TRADE with plans) and its past test */
  r.add('GET', '/v1/intraday', async () => {
    const [intraday, alerted, test] = await Promise.all([session('intraday'), session('intradayAlerted'), local('intradayTest')]);
    return answer({ intraday, alerted, test });
  });

  /** "Falling now" sell-first ideas with their plans (entry, buy-back stop, targets, quantity, risk) */
  r.add('GET', '/v1/falling', async () => {
    const [shortIdeas, breadth] = await Promise.all([session('shortIdeas'), session('breadth')]);
    return answer({ shortIdeas, breadth });
  });

  /** Breakout ideas of today and the day-trade signals (entry, stop-loss, targets) */
  r.add('GET', '/v1/breakouts', async () => {
    const [breakouts, daySignals] = await Promise.all([session('breakouts'), session('daySignals')]);
    return answer({ breakouts, daySignals });
  });

  /** Your stocks with their latest prices, and what the scanners study */
  r.add('GET', '/v1/watchlist', async () => {
    const [watchlist, quotes, scanUniverse] = await Promise.all([local('watchlist'), d.quotes(), session('scanUniverse')]);
    const keys = Array.isArray(watchlist) ? (watchlist as string[]) : [];
    return answer({ watchlist: keys, quotes: Object.fromEntries(keys.filter((k) => quotes[k]).map((k) => [k, quotes[k]])), scanUniverse });
  });

  /** Trade plans (entry, stop-loss, target, quantity), day trades and the auto-trader's trades (app v1.23: and its kinds of trade) */
  r.add('GET', '/v1/plans', async () => {
    const [plans, dayTrades, bot] = await Promise.all([local('plans'), local('dayTrades'), local('bot')]);
    // app v1.23: each kind of trade's state (app v1.24: kinds not proven yet trade at a learning size), the drawdown stop and the shadow trades
    const b = bot as { enabled?: boolean; trades?: unknown[]; evidence?: { at: number; list: unknown[] }; ddStop?: unknown; shadow?: { trades?: unknown[] } } | null;
    return answer({
      plans: plans ?? [],
      dayTrades: dayTrades ?? [],
      autoTrader: b ? { enabled: b.enabled ?? false, trades: b.trades ?? [], playbooks: b.evidence ?? null, drawdownStop: b.ddStop ?? null, shadowTrades: b.shadow?.trades ?? [] } : null,
    });
  });

  /** Self-learning: the models, their unseen-days tests and the past tests of each scanner */
  r.add('GET', '/v1/learning', async () => {
    const keys = ['mlModel', 'riseModel', 'shortModel', 'dayTest', 'breakoutTest', 'earlyTest', 'shortTest', 'botProtectTest'];
    const values = await Promise.all(keys.map((k) => local(k)));
    return answer({ ...Object.fromEntries(keys.map((k, i) => [k, values[i]])), progress: await session('mlProgress') });
  });

  /** Every notification (trade alerts and app messages), the price-alert rules and the unread count */
  r.add('GET', '/v1/alerts', async ({ query }) => {
    const [history, rules, unread] = await Promise.all([local('alertHistory'), local('alerts'), session('alertsUnread')]);
    const limit = Math.min(300, Math.max(1, Number(query.get('limit') ?? 100) || 100));
    const items = ((history as { items?: unknown[] } | null)?.items ?? []).slice(0, limit);
    return answer({ history: items, clearedAt: (history as { clearedAt?: number | null } | null)?.clearedAt ?? null, rules: rules ?? [], unread: unread ?? 0 });
  });

  return r;
}
