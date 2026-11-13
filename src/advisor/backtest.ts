import { computeSnapshot } from '../indicators/snapshot';
import type { Candle } from '../indicators/types';
import { inPriceRange } from '../data/universeParse';
import type { Settings } from '../storage/schema';
import { compareSuggestions, evaluateCandidate, type BuySuggestion } from './suggest';

/**
 * "Past record" test (v0.8.0, owner: "how can I trust the #1 pick?").
 *
 * Replays the last `sessions` trading days (≈ 1 year) with the SAME rules as Today's top picks
 * (evaluateCandidate → verdict, history study, plan, past edge) and follows every pick exactly:
 *  - on each day, using ONLY candles up to that day (no look-ahead; the history study inside also only
 *    uses cases whose 20 sessions had finished by then), the stocks are ranked and free slots are filled;
 *  - buy at that day's close with the amount split equally into `slots` (no compounding);
 *  - sell: at the open if it opens below the sell-if-falls price (gap — a bigger loss than planned),
 *    else at that price if the day's low touches it; at the open / the target if it reaches the profit
 *    target; otherwise at the close after `horizon` sessions. If the sell price and the target are both
 *    touched on one day, the sell price is assumed (cautious);
 *  - charges: settings.risk.chargesEstimatePct (default 0.25%) of the money in the trade.
 * Both orders ('safety' and 'earning') are replayed, plus a simple comparison: buy every studied company
 * on the first day and hold.
 *
 * Limits (shown to the owner): today's index list is used (companies that dropped out are missing),
 * daily candles only, the close is assumed to be a price you could buy at.
 */

export interface BacktestStock {
  key: string;
  symbol: string;
  /** adjusted, completed daily candles, oldest first */
  candles: Candle[];
  tick: number;
}

export type ExitReason = 'target' | 'stop' | 'gap' | 'time' | 'open';

export interface BacktestTrade {
  key: string;
  symbol: string;
  buyDate: string;
  buyPrice: number;
  qty: number;
  stop: number;
  target: number;
  sellDate: string;
  sellPrice: number;
  reason: ExitReason;
  sessions: number;
  /** ₹ after charges */
  pnl: number;
  /** % of the money in the trade, after charges */
  pnlPct: number;
}

export interface BacktestResult {
  rankBy: 'safety' | 'earning';
  trades: BacktestTrade[];
  closed: number;
  stillOpen: number;
  wins: number;
  losses: number;
  /** ₹ after charges, closed trades + open ones at the last close */
  totalPnl: number;
  /** totalPnl as % of the amount */
  totalPct: number;
  /** average closed trade, % of the money in it */
  avgPct: number;
  worstPct: number;
  bestPct: number;
  /** deepest fall of the account value from an earlier high (₹, negative or 0) */
  maxDrawdown: number;
  /** share of days with money in at least one trade */
  investedDays: number;
}

export interface BacktestReport {
  from: string;
  to: string;
  sessions: number;
  amount: number;
  slots: number;
  stocks: number;
  results: BacktestResult[];
  /** equal-weight buy-and-hold of every studied company over the same days, % */
  holdAllPct: number | null;
  chargesPct: number;
  computedMs: number;
}

export interface BacktestOptions {
  sessions?: number;
  rankBys?: Array<'safety' | 'earning'>;
  priceMin?: number;
  priceMax?: number | null;
  onProgress?: (done: number, total: number) => void;
  /** yield to the page every ~this many ms so it stays responsive */
  yieldMs?: number;
}

/** History bars handed to the indicators for each day: enough for the 200-day average + a 250-day study. */
const WINDOW = 560;
/** Minimum bars before a day can be evaluated (200-day average, its slope, a year of study cases). */
const MIN_BARS = 300;

interface Position {
  s: BacktestStock;
  /** index of the stock in `usable` */
  k: number;
  buyIdx: number;
  buyDate: string;
  buyPrice: number;
  qty: number;
  stop: number;
  target: number;
  charges: number;
}

interface Sim {
  rankBy: 'safety' | 'earning';
  open: Position[];
  trades: BacktestTrade[];
  realised: number;
  peak: number;
  maxDrawdown: number;
  investedDays: number;
}

/**
 * How a held trade ends on one daily bar, or null if it continues. Cautious order: a gap below the
 * sell price sells at the open; the sell price is checked before the target on the same day.
 */
export function exitOnBar(bar: Candle, stop: number, target: number, sessionsHeld: number, horizon: number): { price: number; reason: ExitReason } | null {
  if (bar.open <= stop) return { price: bar.open, reason: 'gap' };
  if (bar.low <= stop) return { price: stop, reason: 'stop' };
  if (bar.open >= target) return { price: bar.open, reason: 'target' };
  if (bar.high >= target) return { price: target, reason: 'target' };
  if (sessionsHeld >= horizon) return { price: bar.close, reason: 'time' };
  return null;
}

const sleep = () => new Promise<void>((r) => setTimeout(r, 0));

export async function backtestPicks(stocks: BacktestStock[], settings: Settings, amount: number, opts: BacktestOptions = {}): Promise<BacktestReport | null> {
  const t0 = Date.now();
  const sessions = opts.sessions ?? 250;
  const rankBys = opts.rankBys ?? ['safety', 'earning'];
  const slots = Math.max(1, Math.min(5, Math.round(settings.risk.sizing === 'split' ? settings.risk.splitInto : settings.risk.maxOpenTrades)));
  const allocation = amount / slots;
  const chargesPct = settings.risk.chargesEstimatePct ?? 0.25;
  const horizon = settings.planner.exitHorizonSessions;
  const testSettings: Settings = { ...settings, risk: { ...settings.risk, capitalInr: amount, chargesEstimatePct: chargesPct } };
  const priceMin = opts.priceMin ?? 0;
  const priceMax = opts.priceMax ?? null;

  // Trading days = union of all dates; index of each date per stock.
  const usable = stocks.filter((s) => s.candles.length > MIN_BARS);
  const dateSet = new Set<string>();
  for (const s of usable) for (const c of s.candles) dateSet.add(c.date);
  const dates = [...dateSet].sort();
  if (dates.length < MIN_BARS || !usable.length) return null;
  const startAt = Math.max(0, dates.length - sessions);
  const days = dates.slice(startAt);
  const idx = usable.map((s) => {
    const m = new Map<string, number>();
    s.candles.forEach((c, i) => m.set(c.date, i));
    return m;
  });

  const keyIdx = new Map(usable.map((s, k) => [s.key, k]));
  const sims: Sim[] = rankBys.map((rankBy) => ({ rankBy, open: [], trades: [], realised: 0, peak: 0, maxDrawdown: 0, investedDays: 0 }));
  const closeTrade = (sim: Sim, p: Position, i: number, price: number, reason: ExitReason) => {
    const pnl = (price - p.buyPrice) * p.qty - p.charges;
    sim.trades.push({
      key: p.s.key,
      symbol: p.s.symbol,
      buyDate: p.buyDate,
      buyPrice: p.buyPrice,
      qty: p.qty,
      stop: p.stop,
      target: p.target,
      sellDate: p.s.candles[i]!.date,
      sellPrice: price,
      reason,
      sessions: i - p.buyIdx,
      pnl,
      pnlPct: (pnl / (p.buyPrice * p.qty)) * 100,
    });
    if (reason !== 'open') sim.realised += pnl;
  };

  let lastYield = Date.now();
  for (let d = 0; d < days.length; d++) {
    const date = days[d]!;

    // 1) exits on this day's bar
    for (const sim of sims) {
      sim.open = sim.open.filter((p) => {
        const i = idx[p.k]!.get(date);
        if (i === undefined || i <= p.buyIdx) return true;
        const exit = exitOnBar(p.s.candles[i]!, p.stop, p.target, i - p.buyIdx, horizon);
        if (!exit) return true;
        closeTrade(sim, p, i, exit.price, exit.reason);
        return false;
      });
    }

    // 2) new picks at this day's close (not on the last day: no way to follow them yet)
    if (d < days.length - 1 && sims.some((s) => s.open.length < slots)) {
      const picks: BuySuggestion[] = [];
      for (let k = 0; k < usable.length; k++) {
        const s = usable[k]!;
        const i = idx[k]!.get(date);
        if (i === undefined || i < MIN_BARS) continue;
        if (!inPriceRange(s.candles[i]!.close, priceMin, priceMax)) continue;
        const win = s.candles.slice(Math.max(0, i + 1 - WINDOW), i + 1);
        const snap = computeSnapshot(win, { settings: settings.indicators });
        if (!snap) continue;
        const r = evaluateCandidate({ key: s.key, symbol: s.symbol, name: s.symbol, snap, candles: win, tick: s.tick }, testSettings, allocation, [], date);
        if (r.ok) picks.push(r.suggestion);
      }
      for (const sim of sims) {
        if (sim.open.length >= slots || !picks.length) continue;
        const held = new Set(sim.open.map((p) => p.s.key));
        const ranked = picks.filter((p) => !held.has(p.key)).sort(compareSuggestions(sim.rankBy, true));
        for (const p of ranked) {
          if (sim.open.length >= slots) break;
          const k = keyIdx.get(p.key)!;
          const s = usable[k]!;
          const i = idx[k]!.get(date)!;
          sim.open.push({
            s,
            k,
            buyIdx: i,
            buyDate: date,
            buyPrice: p.plan.entry,
            qty: p.plan.qty,
            stop: p.plan.stop,
            target: p.plan.target,
            charges: p.plan.charges ?? (p.plan.positionValue * chargesPct) / 100,
          });
        }
      }
    }

    // 3) account value at the close (closed results + open trades at today's close)
    for (const sim of sims) {
      let value = sim.realised;
      for (const p of sim.open) {
        const i = idx[p.k]!.get(date);
        const close = i !== undefined ? p.s.candles[i]!.close : p.buyPrice;
        value += (close - p.buyPrice) * p.qty - p.charges;
      }
      if (sim.open.length) sim.investedDays++;
      sim.peak = Math.max(sim.peak, value);
      sim.maxDrawdown = Math.min(sim.maxDrawdown, value - sim.peak);
    }

    opts.onProgress?.(d + 1, days.length);
    if (Date.now() - lastYield > (opts.yieldMs ?? 40)) {
      await sleep();
      lastYield = Date.now();
    }
  }

  // trades still running at the end: valued at their last close
  const lastDate = days[days.length - 1]!;
  for (const sim of sims) {
    for (const p of sim.open) {
      let i = idx[p.k]!.get(lastDate);
      if (i === undefined) i = p.s.candles.length - 1;
      closeTrade(sim, p, i, p.s.candles[i]!.close, 'open');
    }
  }

  // buy every studied company on the first test day and hold
  const holds: number[] = [];
  for (let k = 0; k < usable.length; k++) {
    const a = idx[k]!.get(days[0]!);
    const b = idx[k]!.get(lastDate);
    if (a !== undefined && b !== undefined) holds.push(usable[k]!.candles[b]!.close / usable[k]!.candles[a]!.close - 1);
  }

  const results: BacktestResult[] = sims.map((sim) => {
    const closed = sim.trades.filter((t) => t.reason !== 'open');
    const pcts = closed.map((t) => t.pnlPct);
    const totalPnl = sim.trades.reduce((a, t) => a + t.pnl, 0);
    return {
      rankBy: sim.rankBy,
      trades: sim.trades,
      closed: closed.length,
      stillOpen: sim.trades.length - closed.length,
      wins: closed.filter((t) => t.pnl > 0).length,
      losses: closed.filter((t) => t.pnl <= 0).length,
      totalPnl,
      totalPct: (totalPnl / amount) * 100,
      avgPct: pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : 0,
      worstPct: pcts.length ? Math.min(...pcts) : 0,
      bestPct: pcts.length ? Math.max(...pcts) : 0,
      maxDrawdown: sim.maxDrawdown,
      investedDays: sim.investedDays / days.length,
    };
  });

  return {
    from: days[0]!,
    to: lastDate,
    sessions: days.length,
    amount,
    slots,
    stocks: usable.length,
    results,
    holdAllPct: holds.length ? (holds.reduce((a, b) => a + b, 0) / holds.length) * 100 : null,
    chargesPct,
    computedMs: Date.now() - t0,
  };
}
