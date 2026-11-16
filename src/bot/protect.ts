/**
 * App v1.13 — the auto-trader's money protection (owner: "it made ₹21k in the first 30 minutes, then
 * held too long and lost; sell when a stock turns down, keep the profit, limit the damage").
 *
 * Pure functions, used live (background/botJobs.ts) and in the past test (bot/protectTest.ts):
 *  - the day: once the day is up by `lockStartPct` of the money, it may give back at most `giveBack`
 *    of its best result — then everything bought today is sold and it stops for the day ("keep the
 *    profit"). At a loss of `dayLossPct` of the money it does the same ("daily loss limit").
 *  - each trade: the safety net moves to the buy price early (0.75× the risk in profit), then follows
 *    the best price; half is sold at 1× the risk; a same-day trade that goes nowhere for
 *    `quickExitMin` minutes is closed.
 *  - new trades: at most `maxOpenFor(money)` at once, each at most a fair share of the money; "hold a
 *    few days" picks at most `swingSharePct` of it; no buy on bad news, and none against a market that
 *    is clearly going the other way.
 * Without protection (`on: false`) the auto-trader works as before (app v1.8).
 */

export interface ProtectRules {
  on: boolean;
  /** day gain, in % of the money, from which the profit is kept */
  lockStartPct: number;
  /** share of the day's best result it may give back before selling everything bought today */
  giveBack: number;
  /** day loss, in % of the money, at which it sells everything bought today and stops */
  dayLossPct: number;
  /** most of the money in "hold a few days" picks, in % */
  swingSharePct: number;
  /** a same-day trade that has not moved after this many minutes is closed */
  quickExitMin: number;
}

export const DEFAULT_PROTECT: ProtectRules = { on: true, lockStartPct: 0.4, giveBack: 0.5, dayLossPct: 1, swingSharePct: 30, quickExitMin: 45 };

/** The choices offered on screen. */
export const PROTECT_CHOICES = {
  lockStartPct: [0.2, 0.4, 0.75, 1],
  dayLossPct: [0.5, 1, 1.5, 2],
  swingSharePct: [0, 30, 50, 100],
  quickExitMin: [30, 45, 60, 0],
} as const;

/** Same rules, filled in from what was saved (missing values from the defaults). */
export const protectRules = (r: Partial<ProtectRules> | undefined): ProtectRules => ({ ...DEFAULT_PROTECT, ...(r ?? {}) });

// ---------------------------------------------------------------- the day

export interface DayGuard {
  date: string;
  /** best result of the day so far, ₹ */
  best: number;
  /** why it stopped for the day (null = still trading) */
  halted: null | 'lock' | 'loss';
  haltedAt?: number;
  /** today's result when it stopped */
  pnlAtHalt?: number;
}

/**
 * Updates the day's best result and decides whether to stop for the day. `money` is what it had at the
 * start of the day. Returns `justHalted` once, the moment it stops.
 */
export function checkDay(g: DayGuard | undefined, today: string, todayPnl: number, money: number, rules: ProtectRules, now: number): { guard: DayGuard; justHalted: 'lock' | 'loss' | null } {
  const cur: DayGuard = g && g.date === today ? g : { date: today, best: 0, halted: null };
  const best = Math.max(cur.best, todayPnl);
  if (!rules.on || cur.halted || !(money > 0)) return { guard: { ...cur, best }, justHalted: null };
  if (todayPnl <= -(rules.dayLossPct / 100) * money) return { guard: { ...cur, best, halted: 'loss', haltedAt: now, pnlAtHalt: todayPnl }, justHalted: 'loss' };
  if (best >= (rules.lockStartPct / 100) * money && todayPnl <= best * (1 - rules.giveBack)) return { guard: { ...cur, best, halted: 'lock', haltedAt: now, pnlAtHalt: todayPnl }, justHalted: 'lock' };
  return { guard: { ...cur, best }, justHalted: null };
}

/** The level at which today's profit would be kept (null = not reached yet). */
export function keepLevel(g: DayGuard | undefined, money: number, rules: ProtectRules): number | null {
  if (!g || !rules.on || !(g.best >= (rules.lockStartPct / 100) * money)) return null;
  return g.best * (1 - rules.giveBack);
}

// ---------------------------------------------------------------- size of the book

/** Most trades open at once for this much money: one per ₹25,000, between 1 and 10. */
export const maxOpenFor = (money: number): number => Math.max(1, Math.min(10, Math.floor(money / 25_000)));

/** Most money in one trade: a fair share (1.5 × money / trades), never more than 35 % of it. */
export const maxPositionFor = (money: number): number => Math.min(money * 0.35, (money * 1.5) / maxOpenFor(money));

// ---------------------------------------------------------------- each trade

export interface TradeView {
  side: 'long' | 'short';
  entry: number;
  /** current safety net */
  stop: number;
  /** safety net when opened (defines the risk) */
  stop0: number;
  target: number;
  /** best price since it was opened */
  best: number;
  /** closed the same day (not a "hold a few days" pick) */
  sameDay: boolean;
  openedAt: number;
  /** half already sold */
  halfDone?: boolean;
}

export interface TradeAction {
  stop: number;
  /** sell (or buy back) half now */
  sellHalf: boolean;
  /** close all now: the trade went nowhere */
  exit: null | 'quick';
}

/** Breakeven at this much profit (× the risk); then the safety net follows the best price at `trail` × the risk. */
const RULE = {
  sameDay: { breakeven: 0.75, trailFrom: 1.25, trail: 0.75 },
  swing: { breakeven: 1, trailFrom: 2, trail: 1 },
};

/** What to do with one open trade at `price` (pure; the safety net only ever moves in the trade's favour). */
export function manageTrade(t: TradeView, price: number, now: number, rules: ProtectRules): TradeAction {
  const dir = t.side === 'long' ? 1 : -1;
  const R = Math.abs(t.entry - t.stop0);
  const none: TradeAction = { stop: t.stop, sellHalf: false, exit: null };
  if (!(R > 0) || !(price > 0)) return none;
  const best = dir > 0 ? Math.max(t.best, price) : Math.min(t.best, price);
  const bestR = ((best - t.entry) * dir) / R;
  const gainR = ((price - t.entry) * dir) / R;
  const better = (a: number, b: number) => (dir > 0 ? Math.max(a, b) : Math.min(a, b));
  if (!rules.on) {
    // the old rule (app v1.6–1.12): the buy price once 1× the risk up
    return { ...none, stop: bestR >= 1 ? better(t.stop, t.entry) : t.stop };
  }
  const k = t.sameDay ? RULE.sameDay : RULE.swing;
  let stop = t.stop;
  if (bestR >= k.breakeven) stop = better(stop, t.entry);
  if (bestR >= k.trailFrom) stop = better(stop, round05(best - dir * k.trail * R, dir));
  // half at 1× the risk (sell-first trades already buy back half at their first target)
  const roomToTarget = ((t.target - t.entry) * dir) / R;
  const sellHalf = t.sameDay && t.side === 'long' && !t.halfDone && gainR >= 1 && roomToTarget > 1.2;
  const minutes = (now - t.openedAt) / 60_000;
  const exit = t.sameDay && rules.quickExitMin > 0 && minutes >= rules.quickExitMin && bestR < 0.3 && gainR <= 0.1 ? 'quick' : null;
  return { stop, sellHalf, exit };
}

/** 5-paise ticks, rounded so the safety net never moves past the price it was meant for. */
const round05 = (x: number, dir: 1 | -1) => Math.round((dir > 0 ? Math.floor(x * 20 + 1e-9) : Math.ceil(x * 20 - 1e-9))) / 20;

// ---------------------------------------------------------------- new trades

/** Market strongly against the trade (breadth in the trade's direction, −1…1). */
export const AGAINST_MARKET = -0.35;

/** Why an idea is skipped by the protection (null = fine). `news` and `breadth` are in the trade's direction. */
export function skipIdea(ctx: { news: number; breadth: number }, rules: ProtectRules): string | null {
  if (!rules.on) return null;
  if (ctx.news < 0) return 'news against it today';
  if (ctx.breadth <= AGAINST_MARKET) return 'the whole market is going the other way';
  return null;
}
