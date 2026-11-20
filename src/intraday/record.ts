import { intradayCharges } from '../daytrade/rules';

/**
 * Review fix (app 1.20.2) — the Intraday scanner's own record. Every BUY / SELL alert is already
 * followed until its target, stop-loss, invalidation or 3:15 pm; its result is now written down (20
 * market days kept) and shown on the list. The SELL side (new in 1.20, no past test: the app keeps no
 * 1-minute or NIFTY history for past days) is marked "practice only" until this record shows it works.
 * Pure.
 */

export type SignalOutcome = 'target' | 'stop' | 'invalid' | 'close';

export interface SignalResult {
  key: string;
  symbol: string;
  side: 'buy' | 'sell';
  /** when the signal was sent (ms) */
  at: number;
  entry: number;
  /** the live price when the outcome was seen */
  exit: number;
  outcome: SignalOutcome;
  /** SELL: target 1 was reached first (half bought back there) */
  t1Hit: boolean;
  qty: number;
  /** ₹ after every Upstox Intraday charge */
  pnl: number;
}

export interface RecordDay {
  date: string;
  items: SignalResult[];
}

/** The ₹ result of a followed signal closed at `exit` (SELL: half at target 1 when it was reached). */
export function signalPnl(s: { side: 'buy' | 'sell'; entry: number; qty: number; t1: number | null }, exit: number, t1Hit: boolean): number {
  const q = Math.max(0, Math.floor(s.qty));
  if (!q) return 0;
  if (s.side === 'buy') {
    const buy = q * s.entry;
    const sell = q * exit;
    return round2(sell - buy - intradayCharges(buy, sell));
  }
  const sold = q * s.entry;
  const half = t1Hit && s.t1 !== null ? Math.floor(q / 2) : 0;
  const buyBack = half * (s.t1 ?? exit) + (q - half) * exit;
  return round2(sold - buyBack - intradayCharges(buyBack, sold));
}

/** Adds a result to the record (one per stock, side and day; the newest 20 days kept). */
export function addResult(rec: RecordDay[] | null | undefined, date: string, r: SignalResult): RecordDay[] {
  const days = (rec ?? []).map((d) => ({ ...d, items: [...d.items] }));
  let day = days.find((d) => d.date === date);
  if (!day) {
    day = { date, items: [] };
    days.push(day);
  }
  if (!day.items.some((i) => i.key === r.key && i.side === r.side && i.at === r.at)) day.items.push(r);
  return days.sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-20);
}

/** A side is "proven" only after 20 finished signals that made money in total and won more often than they lost. */
export const PROVEN_MIN = 20;

export interface SideStats {
  finished: number;
  wins: number;
  losses: number;
  pnl: number;
  proven: boolean;
}

export function sideStats(rec: RecordDay[] | null | undefined, side: 'buy' | 'sell'): SideStats {
  const items = (rec ?? []).flatMap((d) => d.items.filter((i) => i.side === side));
  const wins = items.filter((i) => i.pnl > 0).length;
  const losses = items.filter((i) => i.pnl < 0).length;
  const pnl = round2(items.reduce((s, i) => s + i.pnl, 0));
  return { finished: items.length, wins, losses, pnl, proven: items.length >= PROVEN_MIN && wins > losses && pnl > 0 };
}

const round2 = (x: number) => Math.round(x * 100) / 100;
