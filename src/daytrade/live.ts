import type { Quote } from '../data/quotesParse';
import { IST_OFFSET_MS } from '../lib/time';
import { DAY_RULES_VERSION, DEFAULT_VARIANT, passes, targetMult, type DayTestReport, type Variant } from './backtest';
import { DEFAULT_RULES, findBreakout, stopFor, targetFor, type Breakout, type DayRules } from './rules';
import type { Bars, DaySignal, DayTrade, Side } from './types';

/**
 * Live side of the day-trade rules (v0.11.0). The same `findBreakout` as the past test runs on today's
 * 5-minute bars: bars up to "now" come from Upstox when the engine starts, later bars are added at
 * each 5-minute boundary from the latest price poll.
 */

export interface LiveStock {
  symbol: string;
  bars: Bars;
  /** opening volume vs this stock's usual; null = no history yet */
  rvol: number | null;
  /** today's first breakout was seen (or the stock is out for today) */
  done: boolean;
  /** day's cumulative volume at the last bar boundary */
  cumVol: number | null;
  shortAllowed: boolean;
  tick: number;
}

export interface DayLive {
  date: string;
  /** when today's bars were loaded from Upstox (null = not yet / reload needed) */
  loadedAt: number | null;
  /** start (minutes since midnight IST) of the bar now forming */
  lastSlotT: number;
  stocks: Record<string, LiveStock>;
}

export const minutesIST = (ts: number): number => {
  const d = new Date(ts + IST_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};
export const slotStart = (minute: number, barMinutes = DEFAULT_RULES.barMinutes): number => Math.floor(minute / barMinutes) * barMinutes;

/** Only the bars that had finished by `minute`. */
export function completedBars(b: Bars, minute: number, r: DayRules = DEFAULT_RULES): Bars {
  let n = 0;
  while (n < b.t.length && b.t[n]! + r.barMinutes <= minute) n++;
  return { t: b.t.slice(0, n), o: b.o.slice(0, n), h: b.h.slice(0, n), l: b.l.slice(0, n), c: b.c.slice(0, n), v: b.v.slice(0, n) };
}

/** Average move of the studied stocks from their open (the "market" for the direction filter). */
export function marketMove(quotes: Record<string, Quote>, keys: string[]): number | null {
  let sum = 0;
  let n = 0;
  for (const k of keys) {
    const q = quotes[k];
    if (!q || !(q.ltp > 0) || q.open === null || !(q.open > 0)) continue;
    sum += q.ltp / q.open - 1;
    n++;
  }
  return n >= Math.min(10, keys.length) && n > 0 ? sum / n : null;
}

/**
 * At a 5-minute boundary: adds the bar that just finished (`barT` = its start) from the latest price
 * and returns the breakout if this bar is the day's first one.
 */
export function appendBar(stock: LiveStock, barT: number, q: Quote | undefined, r: DayRules = DEFAULT_RULES): Breakout | null {
  if (stock.done || !q || !(q.ltp > 0)) return null;
  const n = stock.bars.t.length;
  if (n && stock.bars.t[n - 1]! >= barT) return null;
  const prev = n ? stock.bars.c[n - 1]! : q.ltp;
  const vol = q.volume !== null && stock.cumVol !== null ? Math.max(0, q.volume - stock.cumVol) : 0;
  if (q.volume !== null) stock.cumVol = q.volume;
  stock.bars.t.push(barT);
  stock.bars.o.push(prev);
  stock.bars.h.push(Math.max(prev, q.ltp));
  stock.bars.l.push(Math.min(prev, q.ltp));
  stock.bars.c.push(q.ltp);
  stock.bars.v.push(vol);
  const bo = findBreakout(stock.bars, r);
  if (!bo) return null;
  stock.done = true;
  return bo.idx === stock.bars.t.length - 1 ? bo : null;
}

export interface LiveConfig {
  variant: Variant;
  /** the past test passed with these settings */
  trusted: boolean;
  priceMin: number;
  priceMax: number | null;
  rules: DayRules;
}

/** Settings for live signals: the tested ones if a current test exists, else the defaults (untrusted). */
export function liveConfig(test: DayTestReport | null | undefined, priceMin: number, priceMax: number | null): LiveConfig {
  const ok = !!test && test.rulesVersion === DAY_RULES_VERSION;
  return { variant: ok ? test.chosen : DEFAULT_VARIANT, trusted: ok && test.passed, priceMin, priceMax, rules: DEFAULT_RULES };
}

/** A breakout becomes a signal only if the stock is busy enough, the market agrees and the price fits. */
export function signalFrom(date: string, key: string, stock: LiveStock, bo: Breakout, price: number, market: number | null, cfg: LiveConfig, now: number, late = false): DaySignal | null {
  if (stock.rvol === null || market === null) return null;
  if (!passes({ side: bo.side, rvol: stock.rvol, market }, cfg.variant)) return null;
  if (bo.side === 'short' && !stock.shortAllowed) return null;
  if (price < cfg.priceMin || (cfg.priceMax !== null && price > cfg.priceMax)) return null;
  const stop = stopFor(bo.side, price, bo.or, cfg.rules, stock.tick);
  return {
    id: `${date}:${stock.symbol}`,
    key,
    symbol: stock.symbol,
    side: bo.side,
    at: now,
    barT: bo.barCloseT,
    entry: price,
    stop,
    target: targetFor(bo.side, price, stop, targetMult(cfg.variant.target), stock.tick),
    rvol: stock.rvol,
    orHigh: bo.or.high,
    orLow: bo.or.low,
    trusted: cfg.trusted,
    ...(late ? { late: true } : {}),
  };
}

/** Is a signal still worth acting on? Not if it is old or the price has already run away / hit the stop. */
export function signalState(s: DaySignal, ltp: number | null, now: number): 'fresh' | 'moved' | 'old' {
  if (s.late || now - s.at > 10 * 60_000) return 'old';
  if (ltp === null) return 'fresh';
  const move = (ltp / s.entry - 1) * (s.side === 'long' ? 1 : -1);
  if (move > 0.004) return 'moved';
  if (s.side === 'long' ? ltp <= s.stop : ltp >= s.stop) return 'moved';
  return 'fresh';
}

export type DayExit = { price: number; reason: 'stop' | 'target' | 'time' } | null;

/** What the latest price means for an open day trade (stop first, then target, then the 3:10 pm exit). */
export function dayExitAt(t: Pick<DayTrade, 'side' | 'stop' | 'target'>, ltp: number, minute: number, r: DayRules = DEFAULT_RULES): DayExit {
  if (t.side === 'long' ? ltp <= t.stop : ltp >= t.stop) return { price: t.side === 'long' ? Math.min(t.stop, ltp) : Math.max(t.stop, ltp), reason: 'stop' };
  if (t.target !== null && (t.side === 'long' ? ltp >= t.target : ltp <= t.target)) return { price: t.target, reason: 'target' };
  if (minute >= r.exitT) return { price: ltp, reason: 'time' };
  return null;
}

export const sideWord = (s: Side): string => (s === 'long' ? 'BUY' : 'SELL (short)');
