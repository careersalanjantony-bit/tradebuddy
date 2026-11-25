import { intradayCharges } from '../daytrade/rules';
import type { Bars } from '../daytrade/types';
import { upTick } from '../early/early';
import { DRIVE, drivePlan, openDriveEntry, PRE, type OpenTestDay } from '../early/preopen';
import { DEFAULT_PROTECT, manageTrade, maxPositionFor, type ProtectRules } from './protect';

/**
 * App v1.25 — "Opening rush": the auto-trader trades the opening drive.
 *
 * The owner (25 Nov 2026): "fast buy when the market opens and sudden sell if we got profit". The
 * auto-trader's own learning said the same about timing: "a big move already today means it is late" —
 * until now it waited until 9:30 and bought stocks that had already risen.
 *
 * What it buys (the Early Movers opening drive, app v1.16, rules fixed then and never tuned):
 *  - a stock from the final pre-open list, or one that opened 1 %+ up, that HOLDS its opening jump: above
 *    its opening price and the day's average price, volume 1.5×+ the usual pace, buyers ahead of sellers;
 *  - bought only as it makes a new high since the open (within OPEN_RUSH.nearHighPct of it), never after
 *    it fell back and never after it ran 2.5 % from the open; from 9:15 until 9:35.
 * The safety net sits under the day's average price (or the morning low), 0.3–1.2 % below the buy price:
 * a wrong trade is a small loss, and because the safety net is close, the size in shares can be large
 * while the money at risk stays the same.
 *
 * How it sells — tested, not guessed. Three ways, each replayed on the stored 5-minute days with the
 * auto-trader's own live rules (bot/protect.ts manageTrade: the safety net moves to the buy price at
 * 0.75× the risk, then follows the best price; a trade that goes nowhere for 45 minutes is closed;
 * everything by 3:10 pm) and Upstox's Intraday charges:
 *  - quick:    everything at the first target (1× the risk) — the owner's "sudden sell";
 *  - standard: half at 1× the risk, the rest at 2× (the rule fixed in advance);
 *  - runner:   half at 1× the risk, the rest stays while the safety net follows the price up.
 * The live trades use "standard" unless another way did better after charges on BOTH the older and the
 * newer half of the days (with at least OPEN_RUSH.minTrades trades): one lucky stretch cannot choose it.
 * Pure: no storage, no network.
 */

export const OPEN_RUSH = {
  /** first buys from 9:15 (the drive itself waits for 30 seconds of trading) */
  fromT: PRE.openT,
  /** last buy: when the opening drive ends (9:35) */
  untilT: DRIVE.untilT,
  /** bought only within this much (%) of the high since the open — as it makes a new high */
  nearHighPct: 0.15,
  /** how often it looks for new trades in the window (instead of once a minute) */
  decideEveryMs: 15_000,
  /** another way of selling replaces "standard" only with at least this many test trades */
  minTrades: 20,
  /** "runner": the target is this far (× the risk) — in practice the safety net that follows the price decides */
  runnerTargetR: 6,
} as const;

export type ExitStyle = 'quick' | 'standard' | 'runner';
export const EXIT_STYLES: readonly ExitStyle[] = ['quick', 'standard', 'runner'];

export const EXIT_STYLE_LABEL: Record<ExitStyle, string> = {
  quick: 'sell everything at the first target (1× the risk)',
  standard: 'half at 1× the risk, the rest at 2×',
  runner: 'half at 1× the risk, the rest stays while the price keeps rising',
};

export const EXIT_STYLE_SHORT: Record<ExitStyle, string> = {
  quick: 'Quick profit',
  standard: 'Half and half',
  runner: 'Let it run',
};

/** The target a trade gets for a way of selling (the half at 1× the risk is sold by manageTrade). */
export function rushTarget(entry: number, stop: number, style: ExitStyle, tick = 0.05): number {
  const r = entry - stop;
  const k = style === 'quick' ? 1 : style === 'standard' ? 2 : OPEN_RUSH.runnerTargetR;
  return upTick(entry + k * r, tick);
}

export interface RushIn {
  price: number;
  open: number;
  /** high / low since the open (the live price included) */
  high: number;
  low: number;
  vwap: number | null;
}

/**
 * The live Opening rush trade for a stock that is holding its opening jump (the Early Movers drive row says
 * "holding"), or null while it is not at its high since the open. Same plan as the drive's alerts and the
 * past test: the safety net under the day's average price (or the morning low), 0.3–1.2 % below.
 */
export function rushPlan(x: RushIn, style: ExitStyle, tick = 0.05): { stop: number; target: number } | null {
  if (!(x.price > 0) || !(x.open > 0) || !(x.high > 0)) return null;
  if (x.price < x.high * (1 - OPEN_RUSH.nearHighPct / 100)) return null;
  if ((x.price / x.open - 1) * 100 >= DRIVE.maxFromOpenPct) return null;
  const plan = drivePlan(x, tick);
  if (!(plan.stop > 0) || !(plan.stop < x.price)) return null;
  return { stop: plan.stop, target: rushTarget(x.price, plan.stop, style, tick) };
}

// ---------------------------------------------------------------- the past test

export interface RushGroup {
  trades: number;
  /** made money after charges */
  wins: number;
  /** sums of the results in R (gross = before charges, net = after) */
  grossR: number;
  netR: number;
  /** ₹ after charges */
  pnl: number;
}

export interface RushStyleResult {
  all: RushGroup;
  older: RushGroup;
  newer: RushGroup;
}

export interface RushTestResult {
  days: number;
  /** stock-days that opened 1 %+ up */
  gapDays: number;
  from: string;
  to: string;
  /** the money and the share of it at risk per trade the test was sized with */
  money: number;
  riskShare: number;
  styles: Record<ExitStyle, RushStyleResult>;
  /** the way of selling the live trades use, and why */
  best: ExitStyle;
  bestWhy: string;
}

const EXIT_T = 15 * 60 + 10;
const BAR = 5;

const emptyGroup = (): RushGroup => ({ trades: 0, wins: 0, grossR: 0, netR: 0, pnl: 0 });
const addTo = (g: RushGroup, x: { grossR: number; netR: number; pnl: number }) => {
  g.trades++;
  if (x.pnl > 0) g.wins++;
  g.grossR += x.grossR;
  g.netR += x.netR;
  g.pnl += x.pnl;
};

/** Average result per trade after charges (R); null without trades. */
export const avgNetR = (g: RushGroup): number | null => (g.trades ? g.netR / g.trades : null);
/** Average result per trade before charges (R); null without trades. */
export const avgGrossR = (g: RushGroup): number | null => (g.trades ? g.grossR / g.trades : null);

/**
 * One trade replayed on 5-minute candles with the auto-trader's live rules (the same steps as the
 * protection test): inside a candle the worse price comes first (the safety net before the half and the
 * target); a candle opening below the safety net sells at that open; the safety net sells one tick under it.
 */
export function replayRush(b: Bars, j: number, fill: number, stop0: number, target: number, qty: number, rules: ProtectRules = DEFAULT_PROTECT, tick = 0.05): { grossR: number; netR: number; pnl: number } {
  const R = fill - stop0;
  let stop = stop0;
  let best = fill;
  let left = qty;
  let halfDone = false;
  let sold = 0;
  let orders = 0;
  const sell = (price: number, n: number) => {
    sold += price * n;
    left -= n;
    orders++;
  };
  const openedAt = b.t[j]! * 60_000;
  for (let k = j; k < b.t.length && left > 0; k++) {
    const T = b.t[k]!;
    if (T >= EXIT_T) {
      sell(b.o[k]!, left);
      break;
    }
    if (k > j && b.o[k]! <= stop) {
      sell(b.o[k]! - tick, left);
      break;
    }
    if (b.l[k]! <= stop) {
      sell(stop - tick, left);
      break;
    }
    const hi = b.h[k]!;
    if (!halfDone && left >= 2 && hi - fill >= R && (target - fill) / R > 1.2) {
      sell(fill + R, Math.floor(left / 2));
      halfDone = true;
    }
    if (hi >= target) {
      sell(target, left);
      break;
    }
    best = Math.max(best, hi);
    const a = manageTrade({ side: 'long', entry: fill, stop, stop0, target, best, sameDay: true, openedAt, halfDone }, b.c[k]!, (T + BAR) * 60_000, rules);
    stop = a.stop;
    if (a.exit === 'quick') {
      sell(b.c[k]!, left);
      break;
    }
  }
  if (left > 0) sell(b.c[b.c.length - 1]!, left);
  const cost = qty * fill;
  // Upstox Intraday: one buy order and one sell order, plus brokerage (₹20 or 0.1 %, + GST) for each extra sell order
  const charges = intradayCharges(cost, sold) + (orders > 1 ? Math.min(20, (sold / orders) * 0.001) * 1.18 * (orders - 1) : 0);
  const gross = sold - cost;
  const riskRs = qty * R;
  return { grossR: gross / riskRs, netR: (gross - charges) / riskRs, pnl: gross - charges };
}

/** Which way of selling the live trades use: "standard" unless another did better after charges on both halves. */
export function chooseStyle(styles: Record<ExitStyle, RushStyleResult>): { best: ExitStyle; why: string } {
  const fmt = (x: number | null) => (x === null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2)} R`);
  const base = styles.standard;
  let best: ExitStyle = 'standard';
  for (const s of ['quick', 'runner'] as const) {
    const x = styles[s];
    if (x.all.trades < OPEN_RUSH.minTrades) continue;
    const o = avgNetR(x.older);
    const n = avgNetR(x.newer);
    const bo = avgNetR(base.older);
    const bn = avgNetR(base.newer);
    if (o === null || n === null || bo === null || bn === null) continue;
    if (o > bo && n > bn && (avgNetR(x.all) ?? -Infinity) > (avgNetR(styles[best].all) ?? -Infinity)) best = s;
  }
  if (base.all.trades < OPEN_RUSH.minTrades && best === 'standard') return { best, why: `"${EXIT_STYLE_SHORT.standard}" (the rule fixed in advance): fewer than ${OPEN_RUSH.minTrades} past-test trades to compare the ways of selling.` };
  if (best === 'standard') return { best, why: `"${EXIT_STYLE_SHORT.standard}" (the rule fixed in advance): ${fmt(avgNetR(base.all))} a trade after charges; no other way did better on both the older and the newer days.` };
  return { best, why: `"${EXIT_STYLE_SHORT[best]}": ${fmt(avgNetR(styles[best].all))} a trade after charges, better than "${EXIT_STYLE_SHORT.standard}" (${fmt(avgNetR(base.all))}) on both the older and the newer days.` };
}

/**
 * The Opening rush on stored 5-minute days: the opening-drive entries (early/preopen.ts openDriveEntry,
 * the rule fixed in app v1.16), each sized like the auto-trader (`riskShare` of `money` at risk, at most
 * a fair share of the money — protect.maxPositionFor) and replayed with each way of selling. Nothing is
 * tuned: the entries are the same for all three ways. Null with fewer than 5 market days.
 */
export function runRushTest(days: OpenTestDay[], money: number, riskShare: number, tick = 0.05): RushTestResult | null {
  const dates = [...new Set(days.map((d) => d.date))].sort();
  if (dates.length < 5 || !(money > 0) || !(riskShare > 0)) return null;
  const mid = dates[Math.floor(dates.length / 2)]!;
  const styles = Object.fromEntries(EXIT_STYLES.map((s) => [s, { all: emptyGroup(), older: emptyGroup(), newer: emptyGroup() }])) as Record<ExitStyle, RushStyleResult>;
  let gapDays = 0;
  const cap = maxPositionFor(money);
  for (const d of days) {
    const b = d.bars;
    if (b.t.length >= 10 && b.t[0] === PRE.openT && d.prevClose && (b.o[0]! / d.prevClose - 1) * 100 >= DRIVE.minOpenGapPct) gapDays++;
    const e = openDriveEntry(d, tick);
    if (!e) continue;
    const perShare = e.fill - e.plan.stop;
    if (!(perShare > 0)) continue;
    const qty = Math.min(Math.floor((money * riskShare) / perShare), Math.floor(cap / e.fill));
    if (qty < 1) continue;
    for (const s of EXIT_STYLES) {
      const x = replayRush(b, e.j, e.fill, e.plan.stop, rushTarget(e.fill, e.plan.stop, s, tick), qty, DEFAULT_PROTECT, tick);
      addTo(styles[s].all, x);
      addTo(d.date < mid ? styles[s].older : styles[s].newer, x);
    }
  }
  const pick = chooseStyle(styles);
  return { days: dates.length, gapDays, from: dates[0]!, to: dates[dates.length - 1]!, money: Math.round(money), riskShare, styles, best: pick.best, bestWhy: pick.why };
}
