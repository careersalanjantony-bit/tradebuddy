import { createLogger } from '../lib/log';
import { istDate } from '../lib/time';
import { getAuth, getSecrets } from '../storage/local';
import { getSession, setSession, type ApiStatus } from '../storage/session';
import { errorFromResponse, UpstoxError } from './errors';
import { UPSTOX_API } from './oauth';
import { RateLimiter, UPSTOX_LIMITS } from './rateLimiter';
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
 * Two limiters (v0.11.0): Upstox's limits are per API, so the price polls (market-quote APIs) do not
 * compete with history downloads. Each group still stays under one API's limits.
 */
type LimiterGroup = 'main' | 'quotes' | 'today' | 'account';
const limiters: Record<LimiterGroup, RateLimiter | null> = { main: null, quotes: null, today: null, account: null };
const LIMITER_KEY = { main: 'rateLimiter', quotes: 'rateLimiterQuotes', today: 'rateLimiterToday', account: 'rateLimiterAccount' } as const;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** market-quote APIs → 'quotes'; the Intraday Candle API (today's bars at 09:30) → 'today'; everything else → 'main'. */
const groupOf = (path: string): LimiterGroup =>
  path.includes('/market-quote/') ? 'quotes' : path.includes('/historical-candle/intraday/') ? 'today' : path.includes('/portfolio/') || path.includes('/feed/') || path.startsWith('/v2/news') ? 'account' : 'main';

async function getLimiter(group: LimiterGroup = 'main'): Promise<RateLimiter> {
  limiters[group] ??= new RateLimiter(UPSTOX_LIMITS, (await getSession(LIMITER_KEY[group])) ?? []);
  return limiters[group]!;
}

function persistLimiter(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (limiters.main) void setSession('rateLimiter', limiters.main.snapshot());
    if (limiters.quotes) void setSession('rateLimiterQuotes', limiters.quotes.snapshot());
    if (limiters.today) void setSession('rateLimiterToday', limiters.today.snapshot());
    if (limiters.account) void setSession('rateLimiterAccount', limiters.account.snapshot());
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
  return [...(await getLimiter('main')).usage(now), { label: 'price requests per 30 min', used: last.used, max: last.max }];
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

async function resolveToken(req: UpstoxRequest): Promise<{ token: string | null; used: UsedToken }> {
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
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await requestOnce<T>(path, req);
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
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  await updateApiStatus({ lastErrorAt: Date.now(), lastError: `${path}: ${msg}` });
  throw lastErr;
}

async function requestOnce<T>(path: string, req: UpstoxRequest): Promise<T> {
  const { token, used } = await resolveToken(req);
  const url = new URL(path, UPSTOX_API);
  for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));

  const headers: Record<string, string> = { Accept: 'application/json', ...(req.headers ?? {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (req.form) headers['Content-Type'] = 'application/x-www-form-urlencoded';

  await acquireSlot(groupOf(path));
  const method = req.method ?? 'GET';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), req.timeoutMs ?? 15_000);
  const started = Date.now();
  let res: Response;
  try {
    res = await appFetch(url, { method, headers, body: req.form ?? null, signal: ctrl.signal, timeoutMs: req.timeoutMs ?? 15_000 });
  } catch (err) {
    const timedOut = ctrl.signal.aborted;
    throw new UpstoxError(timedOut ? 'Request timed out' : `Network error: ${err instanceof Error ? err.message : String(err)}`, timedOut ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
    void countRequest();
  }

  let body: unknown = null;
  const text = await res.text();
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
