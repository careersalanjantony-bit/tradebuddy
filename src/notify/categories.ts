/**
 * Milestone 4 — what kind of alert a notification is, from its stable id (the same id on the phone and
 * on the server, because both run the same code). Used for the phone's choices of which alerts the
 * server pushes, and so the phone never shows its own copy of an alert the server already pushes.
 */

export type AlertCategory = 'rising' | 'falling' | 'breakout' | 'daytrade' | 'intraday' | 'early' | 'picks' | 'price' | 'practice' | 'autotrader' | 'system';

export const ALL_CATEGORIES: readonly AlertCategory[] = ['rising', 'falling', 'breakout', 'daytrade', 'intraday', 'early', 'picks', 'price', 'practice', 'autotrader', 'system'];

/**
 * Market-wide signals: the phone and the server find them the same way. In cloud mode the server pushes
 * these and the phone does not show its own copy. (Practice money, price alerts, plans and the
 * auto-trader are each device's own data — the server's copies differ from the phone's until
 * milestone 5 — so those stay local.)
 */
export const MARKET_CATEGORIES: readonly AlertCategory[] = ['rising', 'falling', 'breakout', 'daytrade', 'intraday', 'early', 'picks'];

/** What a newly paired phone asks the server for: the market signals and the server's own messages. */
export const DEFAULT_CLOUD_CATEGORIES: readonly AlertCategory[] = [...MARKET_CATEGORIES, 'system'];

export const CATEGORY_LABEL: Record<AlertCategory, string> = {
  rising: 'Rising now',
  falling: 'Falling now (sell first)',
  breakout: 'Breakouts',
  daytrade: 'Day-trade signals',
  intraday: 'Intraday scanner',
  early: 'Early Movers and pre-open',
  picks: 'New top picks',
  price: 'Price alerts, stop-loss and targets',
  practice: 'Practice money and plans',
  autotrader: 'Auto-trader',
  system: 'Server messages (token, updates)',
};

export function categoryOf(id: string): AlertCategory {
  if (!id.startsWith('alert:')) return 'system';
  const s = id.slice(6);
  if (s.startsWith('intraday-')) return 'intraday';
  if (s.startsWith('short-')) return 'falling';
  if (s.startsWith('bo-')) return 'breakout';
  if (/^day-(long|short)-/.test(s)) return 'daytrade';
  if (/^(early|preopen)-/.test(s)) return 'early';
  if (s.startsWith('rise-held-')) return 'practice';
  if (/^(rise|rising)-/.test(s)) return 'rising';
  if (s.startsWith('pick-')) return 'picks';
  if (s.startsWith('bot-')) return 'autotrader';
  if (/^(wallet|practice|daypractice|sold|closed|found|advice|day)-/.test(s)) return 'practice';
  if (/^(update|test)-/.test(s)) return 'system';
  // price-alert rules: alert:<rule id>:<time> — stop-loss, target, crosses above / below
  return 'price';
}

export const isCategory = (v: unknown): v is AlertCategory => typeof v === 'string' && (ALL_CATEGORIES as readonly string[]).includes(v);
