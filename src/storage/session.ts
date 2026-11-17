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
  feedStatus: { connected: boolean; lastTickAt: number; at: number; keys: number; full?: number; ltpc?: number; overflow?: number; error?: string };
  /** app v1.11: stocks whose price was missing or older than 15 s, checked over the price API */
  priceFill: { at: number; count: number };
  /** latest headlines for the stocks that matter today (owned, signalled, top picks) */
  news: { at: number; items: NewsItem[]; error?: string; targets?: Record<string, import('../background/newsJobs').NewsReason> };
  /** today's day-trade signals (v0.11.0) */
  daySignals: { date: string; signals: DaySignal[] };
  /** live day-trade engine: today's 5-minute bars per stock */
  dayLive: DayLive;
  /** 5-minute history download progress */
  intradayProgress: { done: number; total: number; running: boolean; at: number; error?: string };
  /** buyers meter + rising-now list (app v1.0) */
  /** app v1.15: Early Movers — the live list, the pre-market view, alerts sent */
  early: { at: number; date: string; rows: import('../background/risingJobs').EarlyRow[]; drive?: import('../background/risingJobs').DriveRow[]; driveOut?: number; expired: number; tooRisky: number; badNews: number; capital: number; maxRisk: number };
  premarket: { at: number; opened: boolean; rows: import('../background/earlyJobs').PremarketRow[]; newsAt: number | null; newsAsked: number; newsError: string | null };
  earlyAlerted: { date: string; sent: string[] };
  /** app v1.16: the pre-open rising candidates (9:00–9:15) and the final top 10 */
  preopen: import('../background/preopenJobs').PreopenState;
  /** app v1.14: the live Rising-now list and the reading of the stocks you hold */
  rise: { at: number; date: string; scanned: number; loaded: number; modelAt: number | null; rows: import('../background/risingJobs').RiseRow[]; held: import('../background/risingJobs').HeldRow[] };
  riseAlerted: { date: string; keys: string[]; held: Record<string, number> };
  flow: { at: number; stocks: Record<string, { buyQty: number; sellQty: number; vwap: number | null; pace: number | null }>; rising: import('../data/flow').RisingRow[]; error?: string };
  /** market breadth: Nifty 500 up vs down (app v1.4) */
  breadth: { at: number; list: string; advanced: number; declined: number; unchanged: number; total: number };
  /** "Falling now" sell-first ideas (app v1.4) */
  shortIdeas: { at: number; ideas: import('../background/shortJobs').ShortIdea[]; risk: number; scanned?: number; candidates?: number; checked?: number; scored?: number };
  shortAlerted: { date: string; keys: string[] };
  /** the Day Trade scan list in short (app v1.11) */
  scanUniverse: { at: number; count: number; added: Record<string, number> };
  /** "Breakout today" live ideas (app v1.9) */
  breakouts: { date: string; at: number; scanned: number; total?: number; signals: import('../background/breakoutJobs').BreakoutSignal[] };
  /** rising-fast alerts sent today (app v1.1) */
  risingAlerted: { date: string; keys: string[] };
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
