import { DEFAULT_RULES, findBreakout, intradayCharges, stopFor, targetFor } from '../daytrade/rules';
import type { Bars } from '../daytrade/types';
import { checkDay, manageTrade, maxOpenFor, maxPositionFor, type DayGuard, type ProtectRules } from './protect';

/**
 * App v1.13 — the past test of the money protection: the same same-day trades handled the old way
 * (safety net, target at 2× the risk, safety net to the buy price at 1× the risk, close at 3:10 pm, no
 * day limits) and the new way (bot/protect.ts: earlier breakeven, a safety net that follows the price,
 * half at 1× the risk, quick exit, keep the day's profit, daily loss limit). Same entries for both, so
 * only the protection differs. Pure.
 *
 * Entries: each stock's first close outside its first 15 minutes' range on the right side of VWAP
 * (the day-trade rule), bought at the next 5-minute open; at most `maxOpenFor(money)` a day, earliest
 * first; each risks 0.5 % of the money, at most a fair share of it. Inside a 5-minute candle the worse
 * price comes first (the stop before the target). Charges: Upstox Intraday.
 */

export interface ProtectTestDay {
  date: string;
  stocks: Array<{ key: string; bars: Bars }>;
}

export interface ProtectTestSide {
  /** result after charges, ₹ */
  pnl: number;
  winDays: number;
  lossDays: number;
  worstDay: number;
  bestDay: number;
  /** days that were up by `lockStartPct` at some point but ended lower than half of that */
  gaveBackDays: number;
}

export interface ProtectTestResult {
  money: number;
  days: number;
  trades: number;
  old: ProtectTestSide;
  protected: ProtectTestSide;
  /** days the new way stopped early: profit kept / loss limit */
  keptDays: number;
  limitDays: number;
}

const EXIT_T = DEFAULT_RULES.exitT;
const BAR = DEFAULT_RULES.barMinutes;
const RISK_SHARE = 0.005;

interface SimTrade {
  side: 'long' | 'short';
  entryIdx: number;
  entryT: number;
  entry: number;
  stop0: number;
  target: number;
  qty: number;
  bars: Bars;
}

interface Open {
  t: SimTrade;
  stop: number;
  best: number;
  qty: number;
  halfDone: boolean;
  /** money received / paid so far for the closed part (sign: + = cash in) */
  realized: number;
  sellValue: number;
  orders: number;
  done: boolean;
  /** last price seen (for the day's running result) */
  last: number;
}

/** Entries of one day (same for both ways). */
function entriesOf(day: ProtectTestDay, money: number): SimTrade[] {
  const out: SimTrade[] = [];
  for (const s of day.stocks) {
    const b = s.bars;
    const bo = findBreakout(b, DEFAULT_RULES);
    if (!bo) continue;
    const i = bo.idx + 1;
    if (i >= b.t.length || b.t[i]! >= EXIT_T - 30) continue;
    const entry = b.o[i]!;
    if (!(entry > 0)) continue;
    const stop0 = stopFor(bo.side, entry, bo.or, DEFAULT_RULES);
    const target = targetFor(bo.side, entry, stop0, 2) ?? entry;
    const R = Math.abs(entry - stop0);
    if (!(R > 0)) continue;
    const qty = Math.floor(Math.min((money * RISK_SHARE) / R, maxPositionFor(money) / entry));
    if (qty < 1) continue;
    out.push({ side: bo.side, entryIdx: i, entryT: b.t[i]!, entry, stop0, target, qty, bars: b });
  }
  return out.sort((a, b) => a.entryT - b.entryT).slice(0, maxOpenFor(money));
}

const pnlOf = (o: Open, price: number): number => {
  const dir = o.t.side === 'long' ? 1 : -1;
  return o.realized + (o.qty > 0 ? (price - o.t.entry) * o.qty * dir : 0);
};

function chargesOf(o: Open): number {
  const buy = o.t.entry * o.t.qty;
  const base = intradayCharges(o.t.side === 'long' ? buy : o.sellValue, o.t.side === 'long' ? o.sellValue : buy);
  // one more order for the half: brokerage (₹20 or 0.1 %) + GST
  return base + (o.orders > 1 ? Math.min(20, (o.sellValue / o.orders) * 0.001) * 1.18 * (o.orders - 1) : 0);
}

function close(o: Open, price: number, qty = o.qty): void {
  const dir = o.t.side === 'long' ? 1 : -1;
  o.realized += (price - o.t.entry) * qty * dir;
  o.sellValue += price * qty;
  o.orders++;
  o.qty -= qty;
  if (o.qty <= 0) o.done = true;
}

/** One day, one way. Returns the day's result after charges, its best moment, and why it stopped early. */
function simulateDay(trades: SimTrade[], money: number, rules: ProtectRules | null): { pnl: number; best: number; halted: DayGuard['halted'] } {
  const open: Open[] = [];
  let guard: DayGuard | undefined;
  let halted: DayGuard['halted'] = null;
  let best = 0;
  const times = [...new Set(trades.flatMap((t) => t.bars.t.filter((x) => x >= t.entryT)))].sort((a, b) => a - b);
  for (const T of times) {
    for (const t of trades) if (t.entryT === T) open.push({ t, stop: t.stop0, best: t.entry, qty: t.qty, halfDone: false, realized: 0, sellValue: 0, orders: 0, done: false, last: t.entry });
    let mark = 0;
    for (const o of open) {
      const b = o.t.bars;
      const i = b.t.indexOf(T);
      if (o.done || i < 0) {
        mark += o.done ? o.realized : pnlOf(o, o.last);
        continue;
      }
      const dir = o.t.side === 'long' ? 1 : -1;
      const op = b.o[i]!;
      const adverse = dir > 0 ? b.l[i]! : b.h[i]!;
      const favour = dir > 0 ? b.h[i]! : b.l[i]!;
      const c = b.c[i]!;
      const R = Math.abs(o.t.entry - o.t.stop0);
      if (T >= EXIT_T) close(o, op);
      else if (i > o.t.entryIdx && (op - o.stop) * dir <= 0) close(o, op);
      else if ((adverse - o.stop) * dir <= 0) close(o, o.stop);
      else {
        // the good side of the candle: the half, then the target
        if (rules && o.t.side === 'long' && !o.halfDone && o.qty >= 2 && (favour - o.t.entry) * dir >= R && ((o.t.target - o.t.entry) * dir) / R > 1.2) {
          close(o, o.t.entry + dir * R, Math.floor(o.qty / 2));
          o.halfDone = true;
        }
        if (!o.done && (favour - o.t.target) * dir >= 0) close(o, o.t.target);
        if (!o.done) {
          o.best = dir > 0 ? Math.max(o.best, favour) : Math.min(o.best, favour);
          const a = manageTrade({ side: o.t.side, entry: o.t.entry, stop: o.stop, stop0: o.t.stop0, target: o.t.target, best: o.best, sameDay: true, openedAt: o.t.entryT * 60_000, halfDone: o.halfDone }, c, (T + BAR) * 60_000, rules ?? { on: false } as ProtectRules);
          o.stop = a.stop;
          if (a.exit === 'quick') close(o, c);
        }
      }
      o.last = c;
      mark += o.done ? o.realized : pnlOf(o, c);
    }
    best = Math.max(best, mark);
    if (rules && !halted) {
      const r = checkDay(guard, 'd', mark, money, rules, T);
      guard = r.guard;
      if (r.justHalted) {
        halted = r.justHalted;
        for (const o of open) if (!o.done) close(o, o.last);
        break;
      }
    }
    if (open.length === trades.length && open.every((o) => o.done)) break;
  }
  for (const o of open) if (!o.done) close(o, o.last);
  const pnl = open.reduce((s, o) => s + o.realized - chargesOf(o), 0);
  return { pnl, best, halted };
}

function side(days: Array<{ pnl: number; best: number }>, money: number, lockStartPct: number): ProtectTestSide {
  const lock = (lockStartPct / 100) * money;
  return {
    pnl: Math.round(days.reduce((s, d) => s + d.pnl, 0)),
    winDays: days.filter((d) => d.pnl > 0).length,
    lossDays: days.filter((d) => d.pnl < 0).length,
    worstDay: Math.round(Math.min(0, ...days.map((d) => d.pnl))),
    bestDay: Math.round(Math.max(0, ...days.map((d) => d.pnl))),
    gaveBackDays: days.filter((d) => d.best >= lock && d.pnl < d.best * 0.5).length,
  };
}

/** Runs both ways over the stored days. Null when there are too few days with trades to say anything. */
export function runProtectTest(days: ProtectTestDay[], money: number, rules: ProtectRules): ProtectTestResult | null {
  const oldDays: Array<{ pnl: number; best: number }> = [];
  const newDays: Array<{ pnl: number; best: number }> = [];
  let trades = 0;
  let keptDays = 0;
  let limitDays = 0;
  for (const d of days) {
    const entries = entriesOf(d, money);
    if (!entries.length) continue;
    trades += entries.length;
    oldDays.push(simulateDay(entries, money, null));
    const n = simulateDay(entries, money, { ...rules, on: true });
    newDays.push(n);
    if (n.halted === 'lock') keptDays++;
    if (n.halted === 'loss') limitDays++;
  }
  if (oldDays.length < 10) return null;
  return { money, days: oldDays.length, trades, old: side(oldDays, money, rules.lockStartPct), protected: side(newDays, money, rules.lockStartPct), keptDays, limitDays };
}
