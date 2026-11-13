import type { BacktestReport } from '../advisor/backtest';
import type { Quote } from '../data/quotesParse';
import type { DayLive } from '../daytrade/live';
import type { DaySignal } from '../daytrade/types';
import type { NewsItem } from '../data/news';

/**
 * chrome.storage.session: survives service-worker restarts, cleared when Chrome closes.
 * Used for short-lived state that must not live in SW globals: the pending OAuth `state`,
 * rate-limiter history and API status.
 */

export interface PendingLogin {
  state: string;
  redirectUri: string;
  createdAt: number;
}

export interface ApiStatus {
  lastOkAt?: number;
  lastErrorAt?: number;
  lastError?: string;
  /** set while requests are being delayed by the client-side limiter or a 429 */
  rateLimitedUntil?: number;
  requestsToday?: number;
  day?: string;
}

export interface SessionStore {
  pendingLogin: PendingLogin;
  rateLimiter: number[];
  /** request times of the price polls (their own limiter, v0.11.0) */
  rateLimiterQuotes: number[];
  /** request times of the "today's 5-minute bars" API */
  rateLimiterToday: number[];
  /** request times of the account APIs (positions, news, feed authorisation) */
  rateLimiterAccount: number[];
  apiStatus: ApiStatus;
  /** latest quotes by instrument key */
  quotes: Record<string, Quote>;
  /** last price poll: when, and whether it worked */
  lastPoll: { at: number; ok: boolean; count: number; error?: string };
  /** alert firings not yet seen in the Alerts screen (badge count) */
  alertsUnread: number;
  /** background history download progress */
  syncProgress: { done: number; total: number; running: boolean; at: number };
  /** top picks already announced today (new-pick alerts) */
  announcedPicks: { day: string; keys: string[] };
  /** last time the service worker looked for new top picks */
  lastPickCheck: number;
  /** last read of the Upstox positions (v0.12.0) */
  portfolioStatus: { at: number; ok: boolean; positions: number; error?: string };
  /** instant price feed (WebSocket) state */
  feedStatus: { connected: boolean; lastTickAt: number; at: number; keys: number; error?: string };
  /** latest headlines for the stocks that matter today (owned, signalled, top picks) */
  news: { at: number; items: NewsItem[]; error?: string };
  /** today's day-trade signals (v0.11.0) */
  daySignals: { date: string; signals: DaySignal[] };
  /** live day-trade engine: today's 5-minute bars per stock */
  dayLive: DayLive;
  /** 5-minute history download progress */
  intradayProgress: { done: number; total: number; running: boolean; at: number; error?: string };
  /** buyers meter + rising-now list (app v1.0) */
  flow: { at: number; stocks: Record<string, { buyQty: number; sellQty: number; vwap: number | null; pace: number | null }>; rising: import('../data/flow').RisingRow[]; error?: string };
  /** self-learning in progress (app v1.0) */
  mlProgress: { done: number; total: number; running: boolean; at: number };
  /** last time the 5-minute history was checked for missing days */
  intradayCheckedAt: number;
  /** result of the past-year test of the picks (v0.8.0), with the inputs it was computed for */
  pastRecord: { key: string; report: BacktestReport };
}

export type SessionKey = keyof SessionStore;

export async function getSession<K extends SessionKey>(key: K): Promise<SessionStore[K] | undefined> {
  const res = (await chrome.storage.session.get(key)) as Record<string, unknown>;
  return res[key] as SessionStore[K] | undefined;
}

export async function setSession<K extends SessionKey>(key: K, value: SessionStore[K]): Promise<void> {
  await chrome.storage.session.set({ [key]: value });
}

export async function removeSession(key: SessionKey): Promise<void> {
  await chrome.storage.session.remove(key);
}

export function onSessionChanged<K extends SessionKey>(key: K, cb: (v: SessionStore[K] | undefined) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'session' && changes[key]) cb(changes[key].newValue as SessionStore[K] | undefined);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
