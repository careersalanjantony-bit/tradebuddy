/**
 * Typed request/response messages between UI pages and the service worker.
 * Add a line to ApiMap for each new background operation.
 */

export interface BackgroundStatus {
  version: string;
  extensionId: string;
  /** when this service-worker instance started (epoch ms) — changes after every SW restart */
  startedAt: number;
  localSchemaVersion: number;
  dbVersion: number;
  ready: boolean;
  startupError?: string;
}

export interface ApiUsageRow {
  label: string;
  used: number;
  max: number;
}

import type { AlertRule } from '../alerts/rules';
import type { TradePlan } from '../storage/schema';

export type NewPlanMsg = Omit<TradePlan, 'id' | 'createdAt' | 'updatedAt' | 'status'>;
export type PlanPatch = Partial<Pick<TradePlan, 'status' | 'fillPrice' | 'exitPrice' | 'exitReason' | 'notes' | 'qty' | 'riskRupees' | 'rewardRupees'>>;

export interface ApiMap {
  ping: { req: undefined; res: { now: number; startedAt: number } };
  /** Upstox login step 1: returns the authorize URL (page then runs launchWebAuthFlow) */
  'auth:begin': { req: undefined; res: { url: string; redirectUri: string } };
  /** Upstox login step 3: page passes the URL Upstox redirected to */
  'auth:complete': { req: { redirectUrl: string }; res: { userName?: string; userId?: string; expiresAt: number } };
  'auth:logout': { req: undefined; res: { done: true } };
  /** GET /v2/user/profile with the daily token */
  'auth:test': { req: undefined; res: { userId?: string; userName?: string } };
  /** checks the given (or saved) Analytics Token by fetching the holiday list */
  'analytics:test': { req: { token?: string }; res: { year: number; holidays: number } };
  'calendar:refresh': { req: undefined; res: { year: number; holidays: number } };
  'diag:api': { req: undefined; res: { usage: ApiUsageRow[] } };
  /** cash available to trade (GET /v3/user/get-funds-and-margin, daily login needed) */
  'funds:get': { req: undefined; res: { cash: number; total: number; fetchedAt: number } };
  /** test notification + sound (Diagnostics) */
  'diag:testAlert': { req: { sound: 'stop' | 'target' | 'info' }; res: { played: boolean } };
  'instruments:refresh': { req: undefined; res: { count: number } };
  /** reload the studied list (Nifty 50/100) and download history for new stocks in the background */
  'universe:refresh': { req: { force?: boolean }; res: { index: string; count: number; source: string } };
  /** candles + corporate actions for one stock */
  'stock:sync': { req: { key: string }; res: { fetched: number; lastDate: string | null } };
  'stocks:syncAll': { req: undefined; res: { ok: number; failed: string[] } };
  /** poll prices now, whatever the market state */
  'quotes:auto': { req: undefined; res: { polled: number; skipped?: string } };
  /** fast refresh (every 5 s while the side panel is open, market hours only) */
  'quotes:fast': { req: undefined; res: { polled: number; skipped?: string } };
  'quotes:refresh': { req: undefined; res: { polled: number; skipped?: string } };
  'eod:run': { req: undefined; res: { synced: number; failed: number; shortlist: string[] } };
  /** run the "new top pick" check now (Diagnostics / tests) */
  'picks:check': { req: undefined; res: { announced: string[] } };
  'plans:save': { req: { plan: NewPlanMsg }; res: { id: string; ticket: string } };
  'plans:update': { req: { id: string; patch: PlanPatch }; res: { done: true } };
  'plans:delete': { req: { id: string }; res: { done: true } };
  /** practice trades (pretend money, v0.9.0) */
  'practice:buy': { req: { plan: NewPlanMsg }; res: { id: string; status: 'open' | 'planned'; price: number | null } };
  'practice:sell': { req: { id: string }; res: { price: number; pnl: number } };
  'practice:reset': { req: undefined; res: { removed: number } };
  /** self-learning: learn now from the stored 5-minute history */
  'ml:learn': { req: undefined; res: { samples: number; passed: boolean } };
  /** practice money (app v1.0) */
  'wallet:order': { req: import('../wallet/wallet').OrderRequest; res: { order: import('../wallet/wallet').PaperOrder; filledAt?: number; cashAfter?: number; free: number } };
  /** Upstox-style convert of today's position (app v1.10) */
  'wallet:convert': { req: { key: string; from: import('../wallet/wallet').Product; to: import('../wallet/wallet').Product }; res: { done: true } };
  'wallet:cancel': { req: { id: string }; res: { done: true } };
  /** practice sell-first (app v1.4) */
  'wallet:short': { req: import('../wallet/wallet').ShortRequest; res: { price: number } };
  'wallet:cover': { req: { key: string }; res: { pnl: number } };
  'shorts:scan': { req: undefined; res: { ideas: number } };
  'breakouts:scan': { req: undefined; res: { found: number } };
  /** app v1.14: read the Rising-now list now / learn the model again */
  'rise:scan': { req: undefined; res: { listed: number } };
  /** app v1.15: Early Movers — refresh catalysts and NSE files now / run the past test now */
  'early:refresh': { req: undefined; res: { catalysts: number; nse: boolean } };
  'early:test': { req: undefined; res: { ok: boolean; days: number } };
  /** app v1.16: read the pre-open now (9:00–9:15) */
  'preopen:refresh': { req: undefined; res: { listed: number } };
  'rise:train': { req: undefined; res: { ok: boolean; days: number } };
  'breakouts:test': { req: undefined; res: { done: boolean } };
  'update:check': { req: undefined; res: import('../update/update').UpdateState };
  'bot:run': { req: undefined; res: { ok: boolean } };
  'ideas:suggest': { req: { side: 'buy' | 'sell' }; res: { at: number; marketOpen: boolean; items: import('../background/botJobs').Suggestion[] } };
  'shorts:analyze': { req: { key: string }; res: import('../background/shortJobs').LiveShortAnalysis | null };
  'shorts:model': { req: undefined; res: { trained: boolean } };
  'bot:enable': { req: { enabled: boolean }; res: { ok: boolean } };
  'bot:reset': { req: { forget: boolean; startCash?: number }; res: { ok: boolean } };
  /** app v1.13: the money it trades with (keeps open trades and learning) */
  'bot:amount': { req: { amount: number }; res: { total: number; free: number } };
  /** app v1.13: the money protection */
  'bot:rules': { req: { rules: Partial<import('../bot/protect').ProtectRules> }; res: import('../bot/protect').ProtectRules };
  /** app v1.13: run the protection's past test now */
  'bot:test': { req: undefined; res: { ok: boolean; days: number } };
  'wallet:update': { req: { key: string; patch: Partial<Pick<import('../wallet/wallet').Holding, 'stop' | 'target' | 'sellByClose'>>; product?: import('../wallet/wallet').Product }; res: { done: true } };
  'wallet:reset': { req: { startCash?: number }; res: { done: true } };
  'practice:check': { req: undefined; res: { filled: number; skipped: number; closed: number } };
  /** day-trade mode (v0.11.0): buy and sell the same day */
  'daytrade:enable': { req: { enabled: boolean }; res: { enabled: boolean } };
  /** download missing 5-minute history for the watched stocks */
  'daytrade:sync': { req: undefined; res: { ok: number; failed: number } };
  'daytrade:take': { req: import('../background/dayJobs').DayTakeRequest; res: { id: string; entry: number } };
  'daytrade:close': { req: { id: string; price?: number }; res: { price: number; pnl: number } };
  'daytrade:reset': { req: undefined; res: { removed: number } };
  /** read the Upstox positions now and bring the trades in line (read-only) */
  'portfolio:sync': { req: undefined; res: { ok: boolean; changes: number; skipped?: string } };
  /** connect the instant price feed now (Diagnostics test; works outside market hours too) */
  'feed:connect': { req: undefined; res: { state: string } };
  /** refresh the headlines now */
  'news:refresh': { req: undefined; res: { count: number } };
  /** run the live engine now (tests may pass a simulated time) */
  'daytrade:tick': { req: { now?: number }; res: { signals: number; state: string } };
  'alerts:add': { req: { rule: Pick<AlertRule, 'key' | 'symbol' | 'kind' | 'level' | 'repeat'> & { note?: string } }; res: { id: string } };
  'alerts:update': { req: { id: string; patch: Partial<Pick<AlertRule, 'active' | 'level' | 'repeat' | 'note'>> }; res: { done: true } };
  'alerts:delete': { req: { id: string }; res: { done: true } };
  'alerts:seen': { req: undefined; res: { done: true } };
  'alerts:log': { req: { limit?: number }; res: { entries: Array<import('../storage/db').AlertLogEntry> } };
  /** app v1.18: Alerts tab "Clear all" — history, price-alert log, unread count and the phone's notification list */
  'alerts:clear': { req: undefined; res: { done: true } };
  /** app v1.18: an alert banner was swiped away or closed — not shown again, its phone notification removed */
  'alerts:dismiss': { req: { id: string }; res: { done: true } };
  /** owner confirms a big one-day move is genuine */
  'gaps:ignore': { req: { key: string; date: string }; res: { done: true } };
  'status:get': { req: undefined; res: BackgroundStatus };
  /** writes sample log entries from the service worker (one per level + a redaction demo) */
  'diag:selfTest': { req: undefined; res: { written: number } };
}

export type ApiType = keyof ApiMap;
export type ApiRequest = { [K in ApiType]: { __swing: true; type: K; payload: ApiMap[K]['req'] } }[ApiType];
export type ApiResponse<T> = { ok: true; data: T } | { ok: false; error: string };

export function isApiRequest(msg: unknown): msg is ApiRequest {
  return typeof msg === 'object' && msg !== null && (msg as { __swing?: unknown }).__swing === true;
}

export async function callBackground<K extends ApiType>(type: K, payload?: ApiMap[K]['req']): Promise<ApiMap[K]['res']> {
  const req = { __swing: true, type, payload } as ApiRequest;
  const res = (await chrome.runtime.sendMessage(req)) as ApiResponse<ApiMap[K]['res']> | undefined;
  if (!res) throw new Error(`No response from background for "${type}"`);
  if (!res.ok) throw new Error(res.error);
  return res.data;
}
