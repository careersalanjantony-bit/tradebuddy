import type { MarketCalendar } from '../data/calendar';
import type { AlertRule } from '../alerts/rules';
import type { UniverseState } from '../data/universe';
import type { DayTestReport } from '../daytrade/backtest';
import type { DayTrade } from '../daytrade/types';

/**
 * Storage schema (spec §17).
 *
 * chrome.storage.local keys: meta, settings, secrets, auth, watchlist, alerts, plans, scheduleState.
 * IndexedDB stores: see db.ts.
 *
 * Secrets live ONLY in chrome.storage.local (never storage.sync, never in code or git).
 */

export type ThemePref = 'system' | 'light' | 'dark';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type StopMethod = 'atr' | 'swingLow' | 'manual';
export type TargetMethod = 'history' | '2R' | '3R' | 'resistance' | 'manual';

export interface Settings {
  ui: {
    theme: ThemePref;
    /** 'simple' (default): amount only, suggestions on Today, fewer tabs. 'advanced': every screen and setting. */
    mode: 'simple' | 'advanced';
    /** price filter for picks and lists (₹); max null = no limit */
    priceMin: number;
    priceMax: number | null;
    /** the first-launch guide was finished or skipped (app v1.0) */
    guideSeen: boolean;
  };
  risk: {
    /** Trading capital in ₹. Entered by the owner; never hard-coded (§24). */
    capitalInr: number | null;
    /** Risk per trade as % of capital (default 1). */
    riskPerTradePct: number;
    /** Hard cap for risk per trade % (default 2). */
    riskPerTradeCapPct: number;
    /** Max open trades (default 3, up to 5). */
    maxOpenTrades: number;
    /** Max total open risk as % of capital (default 5). */
    maxTotalOpenRiskPct: number;
    /** Daily loss limit % (default 2) — BLOCKS new plans when hit. */
    dailyLossLimitPct: number;
    /** Weekly loss limit % (default 5) — BLOCKS new plans when hit. */
    weeklyLossLimitPct: number;
    /** Round-trip charges estimate as % of position value; null until the owner sets it. */
    chargesEstimatePct: number | null;
    /** Paper mode (default ON for the first 4–8 weeks). */
    paperMode: boolean;
    /** 'split': invest the whole amount, split equally into `splitInto` stocks (owner's choice, 9 Nov 2026).
     *  'risk': classic sizing — each trade loses at most riskPerTradePct at its stop. */
    sizing: 'split' | 'risk';
    splitInto: number;
  };
  indicators: {
    swingK: number;
    srLookbackSessions: number;
    srClusterAtr: number;
    breakoutVolumeRatio: number;
    pullbackAtrBand: number;
    pullbackRsiMin: number;
    pullbackRsiMax: number;
    stretchMax: number;
    rsiOverbought: number;
    rsiOversold: number;
    lowLiquidityCrorePerDay: number;
    /** One-day move beyond this % with no matching action → "possible unadjusted action". */
    gapDetectorPct: number;
    /** close[ex]/close[ex-1] within this % of the factor → data is unadjusted. */
    adjustmentTolerancePct: number;
  };
  planner: {
    stopMethod: StopMethod;
    stopAtrMultiple: number;
    swingLowBufferAtr: number;
    targetMethod: TargetMethod;
    minRewardToRisk: number;
    positionPctWarn: number;
    recheckAtrMove: number;
    resultsWindowDays: number;
    /** history study: forward window in sessions (typical swing hold) */
    exitHorizonSessions: number;
    /** history study: how far back to look (sessions, ≈ 1 year) */
    exitLookbackSessions: number;
    /** trailing stop = highest close − this × ATR */
    trailAtrMultiple: number;
    /** time stop: review after this many sessions without progress */
    timeStopSessions: number;
  };
  scanner: {
    eveningEnabled: boolean;
    morningEnabled: boolean;
    fundamentalFilter: boolean;
    /** which companies the extension studies by itself */
    /** what is studied: 'all' = Nifty 50, 100, Midcap 100, Smallcap 100 and Nifty 500 together (app v1.12; the only choice offered) */
    universe: 'all' | 'nifty50' | 'nifty100' | 'midcap100' | 'smallcap100' | 'nifty500' | 'watchlist';
    /** notify when a stock newly becomes a top pick during market hours */
    newPickAlerts: boolean;
    /** order of the top picks (v0.8.0): most often made money in similar past cases, or highest past average */
    rankBy: 'safety' | 'earning';
  };
  alerts: {
    cooldownMinutes: number;
    hysteresisPct: number;
    staleSeconds: number;
  };
  /** Upstox account sync (v0.12.0, read-only) */
  portfolio: {
    /** find trades made in Upstox by itself and watch them */
    autoSync: boolean;
  };
  /** Day-trade mode (v0.11.0): buy and sell on the same day */
  dayTrade: {
    /** turned on by the owner on the Day trade tab (downloads 5-minute history) */
    enabled: boolean;
    /** trading days of 5-minute history for the past test */
    testSessions: number;
    /** % of price assumed lost on each entry and exit in the past test */
    slippagePct: number;
    /** stop for the day after this many losing day trades */
    maxLossesPerDay: number;
    /** most you want to lose on one sell-first trade, ₹ (app v1.4) */
    shortRiskInr?: number;
    /** most you want to lose on one breakout (buy-first) trade, ₹ (app v1.9) */
    breakoutRiskInr?: number;
    /** app v1.15: Early Movers — capital and most total risk per trade (incl. all charges) */
    earlyCapitalInr?: number;
    earlyRiskInr?: number;
    /** app v1.11: what the three Day Trade scanners watch — all five indices, or only the Stocks-tab list */
    /** notification + sound for new signals */
    alerts: boolean;
  };
  claude: {
    reportModel: string;
    extractModel: string;
    /** USD per month; null = not set (Analyze stays blocked until set, §13.4). */
    monthlyBudgetUsd: number | null;
    includeTradeDetails: boolean;
  };
  telegram: {
    enabled: boolean;
  };
  notifications: {
    sounds: boolean;
    quietHours: { enabled: boolean; start: string; end: string };
    /** app v1.1: alert about stocks rising fast with strong buying (max 3 a day) */
    rising: boolean;
    /** app v1.1: keep checking about every 15 minutes when the app is closed */
    background: boolean;
    /** app v1.4: alert about strong sell-first (short) ideas, max 3 a day */
    shorts?: boolean;
    /** app v1.9: instant alerts for live breakouts and confirmed breakouts */
    breakouts?: boolean;
    /** app v1.15: Early Movers alerts (setup forming, live breakout, confirmed) */
    early?: boolean;
    /** app v1.13: an alert each time the auto-trader buys, sells or stops for the day (with the steps to copy it in Upstox) */
    bot?: boolean;
    /** app v1.9: the sound of every notification (also with the app closed) */
    tone?: import('../notify/toneList').ToneId;
  };
  data: {
    candleHistoryYears: number;
    fetchFullHistory: boolean;
    /** instant prices over the Upstox WebSocket feed (v0.12.0) */
    liveFeed: boolean;
    /** app v1.9: prices only on the live feed (much less mobile data); volume then comes every ~10 s */
    saveData?: boolean;
  };
  logging: {
    level: LogLevel;
  };
}

export interface Secrets {
  upstoxApiKey?: string;
  upstoxApiSecret?: string;
  /** Optional 1-year read-only Upstox Analytics Token (market data without the daily login). */
  upstoxAnalyticsToken?: string;
  claudeApiKey?: string;
  telegramBotToken?: string;
  /** milestone 4: this phone's own credential for the TradeBuddy server (tbd.…), from pairing */
  cloudDeviceCredential?: string;
  telegramChatId?: string;
}

export type AuthStatus = 'logged_out' | 'logged_in' | 'expired';

export interface AnalyticsTokenState {
  status: 'unchecked' | 'valid' | 'invalid';
  checkedAt?: number;
  error?: string;
}

export interface AuthState {
  status: AuthStatus;
  accessToken?: string;
  extendedToken?: string;
  /** epoch ms */
  issuedAt?: number;
  /** epoch ms (03:30 IST next day) */
  expiresAt?: number;
  userId?: string;
  userName?: string;
  /** when the session was marked expired, and why */
  expiredAt?: number;
  lastError?: string;
  /** validation state of the optional Analytics Token */
  analytics?: AnalyticsTokenState;
}

export interface Meta {
  /** chrome.storage.local schema version */
  schemaVersion: number;
  installedAt: number;
  lastMigratedAt: number;
}

/** Last run per scheduled job, for idempotency and catch-up (§17). */
export interface JobState {
  lastRunAt?: number;
  lastSuccessAt?: number;
  /** Reference time of the successful run, even if completion crossed a market session. */
  lastSuccessFor?: number;
  lastError?: string;
  /** for reminder-type jobs: when the owner was last notified */
  lastNotifiedAt?: number;
  /** next scheduled run (epoch ms), for Diagnostics */
  nextRunAt?: number;
}

export type ScheduleState = Record<string, JobState>;

export type PlanStatus = 'planned' | 'open' | 'closed' | 'cancelled';

/** A saved trade plan (spec §11, §14). The full journal (paper mode, stats) arrives in M8. */
export interface TradePlan {
  id: string;
  key: string;
  symbol: string;
  status: PlanStatus;
  createdAt: number;
  updatedAt: number;
  entry: number;
  stop: number;
  target: number;
  qty: number;
  riskRupees: number;
  rewardRupees: number;
  rr: number;
  setup: string | null;
  trend: string | null;
  ticket: string;
  /** 'history': no fixed target; `target` is the safe target and the extension advises hold/sell */
  targetMode?: 'fixed' | 'history';
  holdTarget?: number | null;
  /** chances from the history study (0–1) */
  safeChance?: number;
  holdChance?: number;
  studySamples?: number;
  /** IST date the buy filled (set by "I bought it") */
  openedDate?: string;
  /** last hold/sell advice sent (end of day) */
  lastAdvice?: { action: string; headline: string; at: number; moveStopTo: number | null };
  fillPrice?: number;
  exitPrice?: number;
  exitReason?: 'stop' | 'target' | 'trailing' | 'manual' | 'time';
  notes?: string;
  /**
   * Practice trade (v0.9.0): pretend money, no Upstox order. Bought at the live price (or at the next
   * opening price if the market is closed) and sold by the extension itself with the same rules as the
   * past-year test: sell price (at the open after a gap down), profit target, or after N sessions.
   */
  practice?: boolean;
  /** when the practice buy was filled (ms) — only prices after this count */
  openedAt?: number;
  /** IST date of the exit */
  exitDate?: string;
  /** estimated charges for the round trip (₹), stored when the trade is closed */
  exitCharges?: number;
  /** found automatically in the Upstox account (v0.12.0) */
  auto?: boolean;
  /** shares of this trade already seen as sold in Upstox on `date` (so a partial sale is counted once) */
  syncSold?: { date: string; qty: number };
}

export interface LocalStore {
  meta: Meta;
  settings: Settings;
  secrets: Secrets;
  auth: AuthState;
  /** ordered instrument keys */
  watchlist: string[];
  alerts: AlertRule[];
  plans: TradePlan[];
  scheduleState: ScheduleState;
  dailyHistoryCheckpoint?: import('../background/historicalJobs').HistoryCheckpoint;
  intradayHistoryCheckpoint?: import('../background/historicalJobs').HistoryCheckpoint;
  /** NSE holidays for the current year (from Upstox), null until first fetched */
  marketCalendar: MarketCalendar | null;
  /** Nifty 50/100 members the extension studies (from NSE, weekly) */
  universe: UniverseState | null;
  /** day trades, real and practice (v0.11.0) */
  dayTrades: DayTrade[];
  /** latest past test of the day-trade rules, with the inputs it was computed for */
  dayTest: { key: string; report: DayTestReport } | null;
  /** self-learning: the latest learned model and its check (app v1.0) */
  mlModel: import('../ml/learn').MlReport | null;
  /** live signals with the clues only known live (buyers meter, pace, news mood), for future learning */
  mlJournal: Array<{ date: string; key: string; symbol: string; side: 'long' | 'short'; barT: number; entry: number; stop: number; target: number | null; chance: number | null; buyers: string | null; pace: number | null; news: string | null; late: boolean }>;
  /** per-stock short-selling chance model, trained once a day on the list's daily candles (app v1.7) */
  shortModel: import('../advisor/shortModel').ShortModel | null;
  /** the latest headlines, kept across app restarts so the News tab is never empty (app v1.7) */
  newsCache: { at: number; items: import('../data/news').NewsItem[]; targets?: Record<string, import('../background/newsJobs').NewsReason> } | null;
  /** the auto-trader: ₹50 lakh of pretend money that trades and learns by itself (app v1.6); null until it first runs */
  bot: import('../background/botJobs').BotState | null;
  /** in-app updates: the newest published version (app v1.5) */
  appUpdate: import('../update/update').UpdateState | null;
  /** past test of the sell-first (short) rules (app v1.4) */
  shortTest: (import('../daytrade/shortScan').ShortTestReport & { at: number }) | null;
  /** past test of the confirmed-breakout rule on the 5-minute history (app v1.9) */
  breakoutTest: (import('../daytrade/breakout').BreakoutTestReport & { at: number }) | null;
  /** app v1.15: Early Movers — NSE end-of-day files, one catalyst per stock, the past test */
  nseFiles: import('../background/earlyJobs').NseFiles | null;
  catalysts: import('../background/earlyJobs').CatalystStore | null;
  earlyTest: (import('../early/earlyTest').EarlyTestResult & { at: number; open?: import('../early/preopen').OpenTestResult | null }) | null;
  /** app v1.16: each day's final pre-open top 10 and how they did in the first 30 minutes (last 60 days) */
  preopenRecord: import('../background/preopenJobs').PreopenDay[] | null;
  /** app v1.16.2: each "likely to keep rising" suggestion and its price 15 / 30 minutes later (last 20 days) */
  riseRecord: Array<{ date: string; items: import('../early/early').SuggestionCheck[] }> | null;
  /** review fix (1.20.2): each Intraday BUY / SELL signal's result (target, stop-loss, invalidated, 3:15), 20 days.
   * No migration step on purpose: like intradayTest, a missing value reads as "no record yet". */
  intradayRecord: import('../intraday/record').RecordDay[] | null;
  /** app v1.14: the learned Rising-now model and its test on unseen days */
  riseModel: import('../rising/momentum').RiseModel | null;
  /** app v1.13: the auto-trader's money protection on past days (old way vs protected) */
  botProtectTest: (import('../bot/protectTest').ProtectTestResult & { at: number; rulesKey: string }) | null;
  /** breakout alerts already sent today (kept across app restarts: never the same alert twice) */
  breakoutAlerted: { date: string; ids: string[] } | null;
  /** app v1.11: Nifty 50 / 100 / Midcap 100 / Smallcap 100 / 500 lists for the Day Trade scanners */
  scanLists: import('../data/scanUniverse').ScanLists | null;
  /** app v1.11: today's idea alerts of all three scanners (one alert per stock and direction) */
  ideaAlerts: { date: string; items: Array<{ key: string; side: 'buy' | 'sell'; src: string; at: number }> } | null;
  /** the app's own profile and lock (app v1.3); null until set up */
  account: import('../account/account').AccountState | null;
  /** practice money (app v1.0); null until first used */
  wallet: import('../wallet/wallet').WalletState | null;
  /** app v1.18: every notification shown (Alerts tab history), what was seen, dismissed and cleared */
  alertHistory: import('../alerts/history').AlertHistory;
  /** app v1.19: the Intraday scanner's past test on the stored 5-minute history (once a day) */
  intradayTest: import('../intraday/backtest').IntradayTestReport | null;
  /** milestone 4: pairing with the TradeBuddy server for push notifications; null = not paired */
  cloud: import('../notify/cloudMode').CloudState | null;
  /** app v1.22: the auto-trader runs on the server; this phone shows it (and may control it). null = the phone runs its own */
  botCloud: import('../background/cloudBotJobs').BotCloudLink | null;
  /** app v1.22: this phone's own auto-trader, kept every time it stopped running here (moved to the server, viewer) — newest last */
  botArchive: import('../background/cloudBotJobs').BotArchiveEntry[] | null;
}

export type LocalKey = keyof LocalStore;
