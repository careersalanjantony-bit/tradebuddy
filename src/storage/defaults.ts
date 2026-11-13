import type { AuthState, LocalStore, Settings } from './schema';

/** Defaults from the spec (§9, §11, §12, §13, §15.1). */
export const DEFAULT_SETTINGS: Settings = {
  ui: { theme: 'dark', mode: 'simple', priceMin: 0, priceMax: null, guideSeen: false },
  risk: {
    capitalInr: null,
    riskPerTradePct: 1,
    riskPerTradeCapPct: 2,
    maxOpenTrades: 3,
    maxTotalOpenRiskPct: 5,
    dailyLossLimitPct: 2,
    weeklyLossLimitPct: 5,
    chargesEstimatePct: null,
    paperMode: true,
    sizing: 'split',
    splitInto: 3,
  },
  indicators: {
    swingK: 3,
    srLookbackSessions: 120,
    srClusterAtr: 0.5,
    breakoutVolumeRatio: 1.5,
    pullbackAtrBand: 1,
    pullbackRsiMin: 40,
    pullbackRsiMax: 55,
    stretchMax: 2,
    rsiOverbought: 70,
    rsiOversold: 30,
    lowLiquidityCrorePerDay: 10,
    gapDetectorPct: 18,
    adjustmentTolerancePct: 10,
  },
  planner: {
    stopMethod: 'atr',
    stopAtrMultiple: 2,
    swingLowBufferAtr: 0.1,
    targetMethod: 'history',
    minRewardToRisk: 2,
    positionPctWarn: 25,
    recheckAtrMove: 1,
    resultsWindowDays: 7,
    exitHorizonSessions: 20,
    exitLookbackSessions: 250,
    trailAtrMultiple: 2,
    timeStopSessions: 15,
  },
  scanner: { eveningEnabled: true, morningEnabled: true, fundamentalFilter: false, universe: 'nifty100', newPickAlerts: true, rankBy: 'safety' },
  alerts: { cooldownMinutes: 15, hysteresisPct: 0.1, staleSeconds: 60 },
  portfolio: { autoSync: true },
  dayTrade: { enabled: true, testSessions: 120, slippagePct: 0.02, maxLossesPerDay: 2, alerts: true },
  claude: {
    reportModel: 'claude-opus-5-5',
    extractModel: 'claude-haiku-5-5',
    monthlyBudgetUsd: null,
    includeTradeDetails: false,
  },
  telegram: { enabled: false },
  notifications: { sounds: true, quietHours: { enabled: false, start: '22:00', end: '07:00' }, rising: true, background: true },
  data: { candleHistoryYears: 3, fetchFullHistory: false, liveFeed: true },
  logging: { level: 'info' },
};

export const DEFAULT_AUTH: AuthState = { status: 'logged_out' };

/** Initial values for every chrome.storage.local key (except meta, written by migrations). */
export function initialLocalValues(): Omit<LocalStore, 'meta'> {
  return {
    settings: structuredClone(DEFAULT_SETTINGS),
    secrets: {},
    auth: { ...DEFAULT_AUTH },
    watchlist: [],
    alerts: [],
    plans: [],
    scheduleState: {},
    marketCalendar: null,
    universe: null,
    dayTrades: [],
    dayTest: null,
    wallet: null,
    mlModel: null,
    mlJournal: [],
  };
}
