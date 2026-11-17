import { intradayCharges } from '../daytrade/rules';
import type { Bars } from '../daytrade/types';
import { running, usualFrom } from '../rising/momentum';
import type { PrevDay } from '../ml/features';
import { EARLY, lookAt, planFor, setupCheck, sizeTrade, type EarlyPlan, type Look } from './early';

/**
 * App v1.15 — the past test of Early Movers on the stored 5-minute history. Only price and volume
 * rules can be tested (the app has no stored history of news, deals or the order book). The rules are
 * the fixed ones in early.ts; nothing here searches for better numbers. Four groups, the same trade
 * handling and the same ₹ sizing (your capital and risk, after Upstox Intraday charges):
 *   - early (live breakout): the setup, then a buy when a later candle crosses the breakout price
 *     with ≥ 1.5× usual volume (as the live tick-level signal would);
 *   - early (confirmed): the same, but bought at the next candle's open after a close above;
 *   - late chasers: the same rules for stocks ALREADY up 4 % or more today (what "buying after the
 *     rally" would have done);
 *   - plain baseline: any stock above its day's average price and rising for 15 minutes.
 * Trades: half sold at target 1 (then the stop moves to the buy price), the rest at target 2, the stop,
 * or 3:10 pm. Inside a candle the stop counts first. One trade per stock per day and group.
 */

export interface TestDay {
  key: string;
  date: string;
  bars: Bars;
  prevClose: number | null;
  prevHigh: number | null;
  prev: PrevDay[];
}

export interface GroupResult {
  trades: number;
  /** trades that made money after charges */
  wins: number;
  /** reached target 1 before the stop */
  t1: number;
  pnl: number;
  avg: number;
  /** setups the ₹ risk limit could not respect (not traded) */
  tooRisky: number;
}

export interface EarlyTestResult {
  days: number;
  stockDays: number;
  capital: number;
  maxRisk: number;
  live: GroupResult;
  confirmed: GroupResult;
  late: GroupResult;
  baseline: GroupResult;
  /** early (live) on the older and the newer half of the days — does it hold up over time? */
  older: GroupResult;
  newer: GroupResult;
}

const EXIT_T = 15 * 60 + 10;

const empty = (): GroupResult => ({ trades: 0, wins: 0, t1: 0, pnl: 0, avg: 0, tooRisky: 0 });

function add(g: GroupResult, pnl: number, hitT1: boolean): void {
  g.trades++;
  if (pnl > 0) g.wins++;
  if (hitT1) g.t1++;
  g.pnl += pnl;
  g.avg = g.pnl / g.trades;
}

/** Plays one trade bought at `fill` during candle `j` (stop first inside a candle). */
export function playTrade(b: Bars, j: number, fill: number, plan: EarlyPlan, qty: number, tick = 0.05): { pnl: number; hitT1: boolean } {
  let left = qty;
  let stop = plan.stop;
  let sold = 0;
  let hitT1 = false;
  const h1 = Math.floor(qty / 2);
  for (let k = j; k < b.t.length && left > 0; k++) {
    if (b.t[k]! >= EXIT_T) {
      sold += left * b.o[k]!;
      left = 0;
      break;
    }
    const o = k === j ? fill : b.o[k]!;
    if (k > j && o <= stop) {
      sold += left * (o - tick);
      left = 0;
      break;
    }
    if (b.l[k]! <= stop) {
      sold += left * (stop - tick);
      left = 0;
      break;
    }
    if (!hitT1 && b.h[k]! >= plan.t1) {
      hitT1 = true;
      if (h1 >= 1) {
        sold += h1 * plan.t1;
        left -= h1;
      }
      stop = Math.max(stop, plan.entry);
    }
    if (left > 0 && b.h[k]! >= plan.t2) {
      sold += left * plan.t2;
      left = 0;
    }
  }
  if (left > 0) sold += left * b.c[b.c.length - 1]!;
  const cost = qty * fill;
  return { pnl: sold - cost - intradayCharges(cost, sold), hitT1 };
}

/** The setup rules with the "has not run yet" condition turned around (for the late chasers). */
function lateCheck(l: Look): boolean {
  if (l.changePct < EARLY.maxDayPct) return false;
  const c = setupCheck({ ...l, changePct: 0, fromOpenPct: 0 });
  return c.ok;
}

export function runEarlyTest(days: TestDay[], capital: number, maxRisk: number, tick = 0.05): EarlyTestResult | null {
  const dates = [...new Set(days.map((d) => d.date))].sort();
  if (dates.length < 5) return null;
  const mid = dates[Math.floor(dates.length / 2)]!;
  const r: EarlyTestResult = { days: dates.length, stockDays: days.length, capital, maxRisk, live: empty(), confirmed: empty(), late: empty(), baseline: empty(), older: empty(), newer: empty() };
  for (const d of days) {
    const b = d.bars;
    if (b.t.length < 10) continue;
    const run = running(b);
    const usual = usualFrom(d.prev);
    let doneLive = false;
    let doneConf = false;
    let doneLate = false;
    let doneBase = false;
    for (let i = 1; i < b.t.length - 1; i++) {
      const l = lookAt({ b, run, i, price: b.c[i]!, prevClose: d.prevClose, prevHigh: d.prevHigh, usual });
      if (!l) continue;
      // the plain baseline: above the day's average price and up over the last 15 minutes
      if (!doneBase && l.t >= EARLY.firstT && l.t <= EARLY.lastT && l.price > l.vwap && i >= 3 && l.price > b.c[i - 3]!) {
        doneBase = true;
        const plan = planFor({ ...l, resistance: l.price }, tick);
        const fill = b.o[i + 1]!;
        const s = sizeTrade({ ...plan, entry: fill }, capital, maxRisk, tick);
        if (!s.ok) r.baseline.tooRisky++;
        else {
          const t = playTrade(b, i + 1, fill, { ...plan, entry: fill }, s.qty, tick);
          add(r.baseline, t.pnl, t.hitT1);
        }
      }
      const isSetup = setupCheck(l).ok;
      const isLate = !isSetup && !doneLate && lateCheck(l);
      if (!isSetup && !isLate) continue;
      const plan = planFor(l, tick);
      // wait up to 30 minutes for a candle to cross the breakout price with volume
      let j = -1;
      for (let k = i + 1; k <= Math.min(b.t.length - 1, i + 6); k++) {
        if (b.t[k]! >= EXIT_T - 15) break;
        if (b.l[k]! <= plan.stop) break;
        const ub = usual(b.t[k]!).bar;
        if (b.h[k]! >= plan.breakout && (!ub || b.v[k]! >= EARLY.breakoutVol * ub)) {
          j = k;
          break;
        }
      }
      if (j < 0) continue;
      const fill = Math.max(plan.entry, b.o[j]!);
      const size = sizeTrade({ ...plan, entry: fill }, capital, maxRisk, tick);
      if (isLate) {
        doneLate = true;
        if (!size.ok) r.late.tooRisky++;
        else {
          const t = playTrade(b, j, fill, { ...plan, entry: fill }, size.qty, tick);
          add(r.late, t.pnl, t.hitT1);
        }
        continue;
      }
      if (!doneLive) {
        doneLive = true;
        if (!size.ok) {
          r.live.tooRisky++;
        } else {
          const t = playTrade(b, j, fill, { ...plan, entry: fill }, size.qty, tick);
          add(r.live, t.pnl, t.hitT1);
          add(d.date < mid ? r.older : r.newer, t.pnl, t.hitT1);
        }
      }
      // confirmed: the breakout candle closes above the resistance → buy at the next open
      if (!doneConf && b.c[j]! > l.resistance && j + 1 < b.t.length && b.t[j + 1]! < EXIT_T) {
        doneConf = true;
        const f2 = b.o[j + 1]!;
        const p2 = { ...plan, entry: f2 };
        const s2 = sizeTrade(p2, capital, maxRisk, tick);
        if (!s2.ok || f2 <= plan.stop) r.confirmed.tooRisky += s2.ok ? 0 : 1;
        else {
          const t = playTrade(b, j + 1, f2, p2, s2.qty, tick);
          add(r.confirmed, t.pnl, t.hitT1);
        }
      }
      if (doneLive && doneConf && doneLate && doneBase) break;
    }
  }
  return r;
}
