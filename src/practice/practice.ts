import { exitOnBar, type ExitReason } from '../advisor/backtest';
import type { Candle } from '../indicators/types';
import type { TradePlan } from '../storage/schema';

/**
 * Practice trades (v0.9.0, owner: "dummy trades in our extension"). Pure rules, shared with the
 * past-year test so practice results and the test can be compared:
 *  - buy: during market hours at the live price; when the market is closed, at the next session's
 *    opening price — skipped if it opens more than 1% above the planned buy price (as the Upstox steps say);
 *  - sell: at the sell-if-falls price (at the opening price after a gap down), at the profit target
 *    (at the opening price after a gap up), or at the close after `horizon` sessions.
 * On the buy day only prices seen after the buy count (the last price, every 30 s).
 */

export interface LiveDay {
  /** IST date of the session the quote belongs to */
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  ltp: number;
  /** quote fetched after that session closed (its prices are final) */
  final: boolean;
  /** when the quote was fetched (ms) */
  at: number;
}

export interface PracticeExit {
  price: number;
  reason: Exclude<ExitReason, 'open'>;
  date: string;
}

/**
 * How an open practice trade ends, or null if it continues. `bars` are completed daily candles
 * (ascending; only those after the buy day are used), `live` the latest quote's session.
 */
export function practiceExit(
  plan: Pick<TradePlan, 'stop' | 'target' | 'openedDate' | 'openedAt'>,
  bars: Candle[],
  live: LiveDay | null,
  horizon: number,
): PracticeExit | null {
  const from = plan.openedDate;
  if (!from) return null;
  let held = 0;
  let lastDate = from;
  for (const b of bars) {
    if (b.partial || b.date <= from) continue;
    held++;
    lastDate = b.date;
    const e = exitOnBar(b, plan.stop, plan.target, held, horizon);
    if (e) return { price: e.price, reason: e.reason as PracticeExit['reason'], date: b.date };
  }
  if (!live || !(live.ltp > 0) || live.date < lastDate || (live.date === lastDate && live.date !== from)) return null;
  if (live.date === from) {
    // bought today: only the last price after the buy counts
    if (plan.openedAt !== undefined && live.at <= plan.openedAt) return null;
    if (live.ltp <= plan.stop) return { price: plan.stop, reason: 'stop', date: live.date };
    if (live.ltp >= plan.target) return { price: plan.target, reason: 'target', date: live.date };
    return null;
  }
  // a later session: its whole day counts (the trade was held from the open)
  held++;
  const open = live.open !== null && live.open > 0 ? live.open : live.ltp;
  const bar: Candle = {
    date: live.date,
    open,
    high: Math.max(live.high ?? live.ltp, live.ltp, open),
    low: Math.min(live.low !== null && live.low > 0 ? live.low : live.ltp, live.ltp, open),
    close: live.ltp,
    volume: 0,
  };
  // the "after N sessions" sale happens at the close, so only once that session's prices are final
  const e = exitOnBar(bar, plan.stop, plan.target, live.final ? held : 0, horizon);
  return e ? { price: e.price, reason: e.reason as PracticeExit['reason'], date: live.date } : null;
}

export type FillDecision = { fill: number } | { skip: string } | null;

/**
 * A practice order placed while the market was closed fills at the next session's opening price,
 * unless it opens more than 1% above the planned buy price. `live` must be a quote of a session that
 * opened after the order was placed.
 */
export function practiceFill(plan: Pick<TradePlan, 'entry' | 'createdAt'>, live: LiveDay | null, sessionOpenAt: number | null): FillDecision {
  if (!live || sessionOpenAt === null || sessionOpenAt <= plan.createdAt || live.at < sessionOpenAt) return null;
  const open = live.open !== null && live.open > 0 ? live.open : null;
  if (open === null) return null;
  if (open > plan.entry * 1.01) return { skip: `opened at ₹${open.toFixed(2)}, more than 1% above the buy price ₹${plan.entry.toFixed(2)} — skipped, as the steps say` };
  return { fill: open };
}

/** Round-trip charges estimate (₹) for a trade of `value` rupees. */
export function practiceCharges(value: number, chargesPct: number | null): number {
  return (value * (chargesPct ?? 0.25)) / 100;
}

export interface PracticeSummary {
  closed: number;
  wins: number;
  losses: number;
  /** ₹ after charges, closed trades */
  realised: number;
  /** ₹ after estimated charges, open trades at the latest price */
  openPnl: number;
  open: number;
  waiting: number;
  skipped: number;
  /** per exit day (newest first): ₹ after charges and number of trades */
  days: Array<{ date: string; pnl: number; trades: number }>;
  greenDays: number;
  redDays: number;
  best: number | null;
  worst: number | null;
}

export function closedPnl(p: TradePlan): number {
  if (p.exitPrice === undefined || p.fillPrice === undefined) return 0;
  return (p.exitPrice - p.fillPrice) * p.qty - (p.exitCharges ?? 0);
}

export function summarisePractice(plans: TradePlan[], ltpOf: (key: string) => number | null, chargesPct: number | null): PracticeSummary {
  const practice = plans.filter((p) => p.practice);
  const closed = practice.filter((p) => p.status === 'closed' && p.exitPrice !== undefined && p.fillPrice !== undefined);
  const pnls = closed.map(closedPnl);
  const byDay = new Map<string, { pnl: number; trades: number }>();
  closed.forEach((p, i) => {
    const d = p.exitDate ?? '—';
    const cur = byDay.get(d) ?? { pnl: 0, trades: 0 };
    byDay.set(d, { pnl: cur.pnl + pnls[i]!, trades: cur.trades + 1 });
  });
  const days = [...byDay.entries()].map(([date, v]) => ({ date, ...v })).sort((a, b) => (a.date < b.date ? 1 : -1));
  let openPnl = 0;
  const open = practice.filter((p) => p.status === 'open' && p.fillPrice !== undefined);
  for (const p of open) {
    const ltp = ltpOf(p.key);
    if (ltp !== null) openPnl += (ltp - p.fillPrice!) * p.qty - practiceCharges(p.fillPrice! * p.qty, chargesPct);
  }
  return {
    closed: closed.length,
    wins: pnls.filter((x) => x > 0).length,
    losses: pnls.filter((x) => x <= 0).length,
    realised: pnls.reduce((a, b) => a + b, 0),
    openPnl,
    open: open.length,
    waiting: practice.filter((p) => p.status === 'planned').length,
    skipped: practice.filter((p) => p.status === 'cancelled').length,
    days,
    greenDays: days.filter((d) => d.pnl > 0).length,
    redDays: days.filter((d) => d.pnl <= 0).length,
    best: pnls.length ? Math.max(...pnls) : null,
    worst: pnls.length ? Math.min(...pnls) : null,
  };
}
