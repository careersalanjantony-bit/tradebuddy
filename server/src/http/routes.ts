import type { MarketCalendar, MarketState } from '../../../src/data/calendar';
import type { Quote } from '../../../src/data/quotesParse';
import type { ApiStatus } from '../../../src/storage/session';
import type { FeedHealth } from '../market/feedSupervisor';
import type { QuotePollerHealth } from '../market/quotePoller';
import type { ServerEvent } from '../storage/sqlite';
import type { TickerStatus } from '../util/ticker';
import { BadRequest, Router } from './router';

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
  analytics(): Promise<{ configured: boolean; status: string; checkedAt: number | null; error: string | null }>;
  events(limit: number): ServerEvent[];
  now?: () => number;
}

const MAX_KEYS = 1000;

export function buildRouter(d: ApiDeps): Router {
  const now = () => (d.now ? d.now() : Date.now());
  const uptime = () => Math.round((now() - d.startedAt) / 1000);
  const r = new Router();

  r.add('GET', '/healthz', () => ({ body: { status: 'ok', version: d.version, uptimeSeconds: uptime() } }), { auth: false, quiet: true });

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
    const [market, analytics, apiStatus, lastPoll] = await Promise.all([d.marketState(t), d.analytics(), d.apiStatus(), d.lastPoll()]);
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
        upstox: { analyticsToken: analytics, api: apiStatus ?? null, lastPoll: lastPoll ?? null },
        feed: d.feedHealth(),
        poller: d.pollerHealth(),
        tasks: d.tasks(),
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

  return r;
}
