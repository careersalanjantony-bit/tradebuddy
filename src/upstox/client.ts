import { createLogger } from '../lib/log';
import { istDate } from '../lib/time';
import { getAuth, getSecrets } from '../storage/local';
import { getDb } from '../storage/db';
import { getSession, setSession, type ApiStatus } from '../storage/session';
import { errorFromResponse, UpstoxError } from './errors';
import { UPSTOX_API } from './oauth';
import { DEFAULT_HISTORICAL_REQUESTS_PER_MINUTE, RateLimiter, UPSTOX_LIMITS } from './rateLimiter';
import { HistoricalRequestQueue } from './historicalQueue';
import { markSessionExpired, setAnalyticsState } from './session';
import { hasLiveSession, isSessionExpiredByTime } from './token';
import { appFetch } from '../platform/http';

/**
 * Upstox REST client (spec §7.2, §7.8). READ-ONLY: this project never calls order/GTT write APIs.
 *
 * Token choice:
 *  - 'market'  : market data (quotes, candles, holidays, fundamentals, news, feed authorize).
 *                Uses the Analytics Token if one is saved and not rejected, else the daily token.
 *  - 'account' : profile, holdings, positions, logout. Daily token only (the Analytics Token needs a
 *                static IP for these).
 *  - 'none'    : the OAuth token exchange.
 */

const log = createLogger('upstox');

export type TokenKind = 'market' | 'account' | 'none';
type UsedToken = 'analytics' | 'access' | 'none' | 'explicit-analytics';
type ResolvedToken = { token: string | null; used: UsedToken };

export interface UpstoxRequest {
  method?: 'GET' | 'POST' | 'DELETE';
  query?: Record<string, string | number | undefined>;
  /** form-encoded body (token exchange) */
  form?: URLSearchParams;
  tokenKind: TokenKind;
  /** use this Analytics Token instead of the stored one (Settings → Test) */
  analyticsTokenOverride?: string;
  /** total attempts for retryable errors (default 3). Use 1 for non-idempotent calls. */
  attempts?: number;
  timeoutMs?: number;
  /** return the whole JSON body instead of body.data */
  raw?: boolean;
  /** extra headers (e.g. Api-Version for v3 user APIs) */
  headers?: Record<string, string>;
}

// ---------- rate limiter (history kept in chrome.storage.session to survive SW restarts) ----------

/**
 * Upstox's standard limits are per API per user. Quotes and current-session candles have their own
 * budgets so live traffic can proceed even when bulk history has a backlog or is cooling down.
 */
type LimiterGroup = 'main' | 'quotes' | 'today' | 'account';
const limiters: Record<LimiterGroup, RateLimiter | null> = { main: null, quotes: null, today: null, account: null };
const LIMITER_KEY = { main: 'rateLimiter', quotes: 'rateLimiterQuotes', today: 'rateLimiterToday', account: 'rateLimiterAccount' } as const;
const limiterLoads: Partial<Record<LimiterGroup, Promise<RateLimiter>>> = {};
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** market-quote APIs → 'quotes'; the Intraday Candle API (today's bars at 09:30) → 'today'; everything else → 'main'. */
const groupOf = (path: string): LimiterGroup =>
  path.includes('/market-quote/') ? 'quotes' : path.includes('/historical-candle/intraday/') ? 'today' : path.includes('/portfolio/') || path.includes('/feed/') || path.startsWith('/v2/news') ? 'account' : 'main';

function getLimiter(group: LimiterGroup = 'main'): Promise<RateLimiter> {
  return limiterLoads[group] ??= getSession(LIMITER_KEY[group]).then((stamps) => {
    return limiters[group] = new RateLimiter(UPSTOX_LIMITS, stamps ?? []);
  }).catch((err: unknown) => {
    delete limiterLoads[group];
    throw err;
  });
}

function persistLimiter(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    for (const group of Object.keys(LIMITER_KEY) as LimiterGroup[]) {
      const limiter = limiters[group];
      if (limiter) void setSession(LIMITER_KEY[group], limiter.snapshot()).catch(() => undefined);
    }
  }, 1000);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function acquireSlot(group: LimiterGroup): Promise<void> {
  const rl = await getLimiter(group);
  let warned = false;
  for (;;) {
    const wait = rl.tryAcquire(Date.now());
    if (wait === 0) break;
    if (!warned) {
      warned = true;
      log.warn(`Rate limit: waiting ${wait} ms before the next Upstox request`);
      await updateApiStatus({ rateLimitedUntil: Date.now() + wait });
    }
    await sleep(wait);
  }
  persistLimiter();
}

export async function apiUsage(now = Date.now()) {
  const prices = (await getLimiter('quotes')).usage(now);
  const last = prices[prices.length - 1]!;
  const history = await historicalRequestDiagnostics(now);
  return [...history.usage, { label: 'price requests per 30 min', used: last.used, max: last.max }];
}

// Corporate actions are a bulk history dependency. Current-session candles stay on the live path.
const isHistorical = (path: string): boolean =>
  /^\/v[23]\/historical-candle\/(?!intraday\/)/.test(path) ||
  /^\/v2\/fundamentals\/[^/]+\/corporate-actions$/.test(path);
const HISTORY_REQUEST_STATE = 'request-budget';

function makeHistoricalRequests(requestsPerMinute: number): HistoricalRequestQueue {
  return new HistoricalRequestQueue(requestsPerMinute, {
    load: async () => (await (await getDb()).get('historyState', HISTORY_REQUEST_STATE))?.requests,
    async save(requests) {
      const tx = (await getDb()).transaction('historyState', 'readwrite');
      await Promise.all([tx.store.put({ id: HISTORY_REQUEST_STATE, requests }), tx.done]);
    },
  }, (until, err) => {
    log.warn(`Upstox historical queue paused for ${Math.max(0, until - Date.now())} ms after a rate-limit response`,
      { status: err.httpStatus, retryAfterMs: err.retryAfterMs });
    void changeApiStatus((prev) => ({ ...prev, rateLimitedUntil: Math.max(prev.rateLimitedUntil ?? 0, until) }));
  });
}

let historicalRequests = makeHistoricalRequests(DEFAULT_HISTORICAL_REQUESTS_PER_MINUTE);

/** Server startup sets the rate before jobs begin. Android uses the conservative default. */
export function configureHistoricalRequests(requestsPerMinute: number): void {
  historicalRequests = makeHistoricalRequests(requestsPerMinute);
}

export function historicalRequestDiagnostics(now = Date.now()) {
  return historicalRequests.diagnostics(now);
}

export function stopHistoricalRequests(): Promise<void> {
  return historicalRequests.stop();
}

// ---------- status ----------

// Read-modify-write of apiStatus is queued so parallel requests do not overwrite each other's updates.
let statusQueue: Promise<void> = Promise.resolve();

function changeApiStatus(fn: (prev: ApiStatus) => ApiStatus): Promise<void> {
  statusQueue = statusQueue
    .then(async () => setSession('apiStatus', fn((await getSession('apiStatus')) ?? {})))
    .catch(() => undefined);
  return statusQueue;
}

function updateApiStatus(patch: Partial<ApiStatus>): Promise<void> {
  return changeApiStatus((prev) => ({ ...prev, ...patch }));
}

function countRequest(): Promise<void> {
  const day = istDate(Date.now());
  return changeApiStatus((prev) => ({ ...prev, day, requestsToday: prev.day === day ? (prev.requestsToday ?? 0) + 1 : 1 }));
}

// ---------- token selection ----------

async function resolveToken(req: UpstoxRequest): Promise<ResolvedToken> {
  if (req.tokenKind === 'none') return { token: null, used: 'none' };
  if (req.analyticsTokenOverride) return { token: req.analyticsTokenOverride, used: 'explicit-analytics' };

  const now = Date.now();
  const auth = await getAuth();
  if (isSessionExpiredByTime(auth, now)) await markSessionExpired('Daily expiry (03:30 IST)', { notifyOwner: false, now });

  if (req.tokenKind === 'market') {
    const { upstoxAnalyticsToken } = await getSecrets();
    if (upstoxAnalyticsToken && auth.analytics?.status !== 'invalid') return { token: upstoxAnalyticsToken, used: 'analytics' };
  }
  const fresh = await getAuth();
  if (hasLiveSession(fresh, now)) return { token: fresh.accessToken!, used: 'access' };
  throw new UpstoxError('Not logged in to Upstox. Click "Log in to Upstox" first.', 'not_logged_in');
}

// ---------- request ----------

export async function upstoxRequest<T = unknown>(path: string, req: UpstoxRequest): Promise<T> {
  const attempts = req.attempts ?? 3;
  let lastErr: unknown;
  if (isHistorical(path)) {
    try {
      return await historicalRequests.enqueue(async () => {
        const token = await resolveToken(req);
        return (signal) => requestOnce<T>(path, req, token, signal);
      }, attempts);
    } catch (err) {
      lastErr = err;
    }
  } else for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await requestOnce<T>(path, req, await resolveToken(req));
    } catch (err) {
      lastErr = err;
      const retryable = err instanceof UpstoxError && err.retryable;
      if (!retryable || attempt === attempts) break;
      const backoff = (err as UpstoxError).retryAfterMs ?? Math.min(1000 * 2 ** (attempt - 1), 60_000);
      log.warn(`Upstox ${path} failed (${(err as UpstoxError).kind}); retry ${attempt}/${attempts - 1} in ${backoff} ms`);
      if ((err as UpstoxError).kind === 'rate_limit') await updateApiStatus({ rateLimitedUntil: Date.now() + backoff });
      await sleep(backoff);
    }
  }
  if (!(lastErr instanceof UpstoxError && lastErr.kind === 'cancelled')) {
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    await updateApiStatus({ lastErrorAt: Date.now(), lastError: `${path}: ${msg}` });
  }
  throw lastErr;
}

async function requestOnce<T>(path: string, req: UpstoxRequest, { token, used }: ResolvedToken, signal?: AbortSignal): Promise<T> {
  const url = new URL(path, UPSTOX_API);
  for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));

  const headers: Record<string, string> = { Accept: 'application/json', ...(req.headers ?? {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (req.form) headers['Content-Type'] = 'application/x-www-form-urlencoded';

  if (!signal) await acquireSlot(groupOf(path));
  signal?.throwIfAborted();
  const method = req.method ?? 'GET';
  const ctrl = new AbortController();
  const abort = () => ctrl.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), req.timeoutMs ?? 15_000);
  const started = Date.now();
  let res: Response;
  let text: string;
  try {
    res = await appFetch(url, { method, headers, body: req.form ?? null, signal: ctrl.signal, timeoutMs: req.timeoutMs ?? 15_000 });
    // Preserve the status and Retry-After even when an upstream error body can't be read.
    text = await res.text().catch((err: unknown) => {
      if (res.ok) throw err;
      return '';
    });
  } catch (err) {
    signal?.throwIfAborted();
    const timedOut = ctrl.signal.aborted;
    throw new UpstoxError(timedOut ? 'Request timed out' : `Network error: ${err instanceof Error ? err.message : String(err)}`, timedOut ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    void countRequest();
  }

  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  log.debug(`${method} ${url.pathname} → ${res.status} (${Date.now() - started} ms, token: ${used})`);

  const isError = !res.ok || (body as { status?: string } | null)?.status === 'error';
  if (isError) {
    const err = errorFromResponse(res.status, body, res.headers.get('retry-after'));
    log.warn(`Upstox ${method} ${url.pathname} failed: ${err.message}`, { status: res.status, code: err.code, token: used });
    if (err.kind === 'auth') {
      if (used === 'analytics' || used === 'explicit-analytics') {
        if (used === 'analytics') await setAnalyticsState({ status: 'invalid', checkedAt: Date.now(), error: err.message });
      } else if (used === 'access') {
        await markSessionExpired(`Upstox rejected the session (${err.code ?? res.status})`, { notifyOwner: true });
      }
    }
    throw err;
  }
  if (body === null) throw new UpstoxError(`Upstox returned an unreadable response (HTTP ${res.status})`, 'bad_response', res.status);

  await updateApiStatus({ lastOkAt: Date.now() });
  if (req.raw) return body as T;
  const data = (body as { data?: unknown }).data;
  return (data === undefined ? body : data) as T;
}
