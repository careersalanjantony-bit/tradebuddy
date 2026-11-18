import { intradayCharges } from '../daytrade/rules';
import type { Bars, DayBars } from '../daytrade/types';
import { classifyIntraday, INTRADAY } from './scanner';

/**
 * App v1.19 — the Intraday scanner's past test on the stored 5-minute history. Every stock-day is
 * replayed candle by candle with the SAME `classifyIntraday` the live list uses (at each candle's close,
 * only the candles finished by then). The first BUY of a stock on a day is taken at the NEXT candle's
 * open plus slippage, then exits at the stop-loss, the target, or the 3:15 pm close — whichever comes
 * first (stop first when one candle touches both). Charges are Upstox Intraday's. What the history
 * cannot show: the waiting buy / sell quantities (that check counts as unknown) and the market gate.
 */

export const INTRADAY_TEST_VERSION = 1;

export interface IntradayTrade {
  key: string;
  date: string;
  entryT: number;
  entry: number;
  exit: number;
  why: 'target' | 'stop' | 'time';
  r: number;
  pnl: number;
}

export interface IntradayTestReport {
  version: number;
  at: number;
  from: string | null;
  to: string | null;
  days: number;
  stocks: number;
  /** stock-days that reached +1 % at some point (could have been a BUY) */
  movers: number;
  trades: number;
  wins: number;
  winRate: number | null;
  avgR: number | null;
  totalR: number;
  /** ₹ after charges, for the trade sizes your capital and risk limit allow */
  netPnl: number;
  profitFactor: number | null;
  byExit: { target: number; stop: number; time: number };
  /** a few of the latest trades, to look at */
  sample: IntradayTrade[];
}

export interface IntradayTestStock {
  key: string;
  symbol: string;
  tick: number;
  /** stored 5-minute days, any order */
  days: DayBars[];
}

const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
const slice = (b: Bars, n: number): Bars => ({ t: b.t.slice(0, n), o: b.o.slice(0, n), h: b.h.slice(0, n), l: b.l.slice(0, n), c: b.c.slice(0, n), v: b.v.slice(0, n) });
const dayStartMs = (date: string) => Date.parse(`${date}T00:00:00+05:30`);

export function backtestIntraday(stocks: IntradayTestStock[], opts: { capital: number; maxRisk: number; slippagePct: number; now: number }): IntradayTestReport {
  const trades: IntradayTrade[] = [];
  const dates = new Set<string>();
  let movers = 0;
  let stocksUsed = 0;
  for (const s of stocks) {
    const days = [...s.days].filter((d) => d.t.length > 3).sort((a, b) => (a.date < b.date ? -1 : 1));
    if (days.length < 6) continue;
    stocksUsed++;
    for (let d = 5; d < days.length; d++) {
      const day = days[d]!;
      const prev = days[d - 1]!;
      const prevClose = prev.c[prev.c.length - 1]!;
      const hist = days.slice(Math.max(0, d - 20), d).map((x) => sum(x.v));
      const avgDailyVol = hist.length >= 5 ? sum(hist) / hist.length : null;
      dates.add(day.date);
      // skip quickly a day that never reached +1 %
      if (!(prevClose > 0) || Math.max(...day.c) < prevClose * (1 + INTRADAY.buyPct / 100)) continue;
      movers++;
      const start = dayStartMs(day.date);
      for (let i = 0; i < day.t.length - 1; i++) {
        const closeT = day.t[i]! + 5;
        if (closeT < INTRADAY.orEndT || closeT > INTRADAY.buyUntilT) continue;
        const bars = slice(day, i + 1);
        const now = start + closeT * 60_000;
        const row = classifyIntraday({
          key: s.key,
          symbol: s.symbol,
          tick: s.tick,
          now,
          t: closeT,
          ltp: day.c[i]!,
          prevClose,
          volume: sum(bars.v),
          vwap: null,
          buyQty: null,
          sellQty: null,
          bars,
          avgDailyVol,
          fetchedAt: now,
          marketWeak: false,
          capital: opts.capital,
          maxRisk: opts.maxRisk,
        });
        if (row?.call !== 'BUY' || !row.plan || !row.size?.ok) continue;
        const qty = row.size.qty;
        const entry = day.o[i + 1]! * (1 + opts.slippagePct / 100);
        const { stop, target } = row.plan;
        if (entry <= stop) break; // opened below the stop: no trade
        let exit = day.c[day.c.length - 1]!;
        let why: IntradayTrade['why'] = 'time';
        for (let j = i + 1; j < day.t.length; j++) {
          if (day.t[j]! >= INTRADAY.lastT) {
            exit = day.o[j]!;
            break;
          }
          if (day.l[j]! <= stop) {
            exit = Math.min(stop, day.o[j]!) * (1 - opts.slippagePct / 100);
            why = 'stop';
            break;
          }
          if (day.h[j]! >= target) {
            exit = Math.max(target, day.o[j]!);
            why = 'target';
            break;
          }
          exit = day.c[j]!;
        }
        const pnl = (exit - entry) * qty - intradayCharges(entry * qty, exit * qty);
        trades.push({ key: s.key, date: day.date, entryT: closeT, entry: round(entry), exit: round(exit), why, r: round((exit - entry) / (entry - stop)), pnl: round(pnl) });
        break; // one trade per stock per day
      }
    }
  }
  const sorted = [...dates].sort();
  const wins = trades.filter((t) => t.pnl > 0);
  const gain = sum(wins.map((t) => t.pnl));
  const loss = -sum(trades.filter((t) => t.pnl <= 0).map((t) => t.pnl));
  return {
    version: INTRADAY_TEST_VERSION,
    at: opts.now,
    from: sorted[0] ?? null,
    to: sorted[sorted.length - 1] ?? null,
    days: sorted.length,
    stocks: stocksUsed,
    movers,
    trades: trades.length,
    wins: wins.length,
    winRate: trades.length ? round(wins.length / trades.length) : null,
    avgR: trades.length ? round(sum(trades.map((t) => t.r)) / trades.length) : null,
    totalR: round(sum(trades.map((t) => t.r))),
    netPnl: round(sum(trades.map((t) => t.pnl))),
    profitFactor: loss > 0 ? round(gain / loss) : null,
    byExit: { target: trades.filter((t) => t.why === 'target').length, stop: trades.filter((t) => t.why === 'stop').length, time: trades.filter((t) => t.why === 'time').length },
    sample: trades.slice(-8),
  };
}

const round = (x: number) => Math.round(x * 100) / 100;
