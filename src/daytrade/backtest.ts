import type { DayBars, Side } from './types';
import { featureVector, prevDayOf, type PrevDay } from '../ml/features';
import { DEFAULT_RULES, OPEN_T, dayTradePnl, findBreakout, openingRange, relativeVolume, simulateExit, stopFor, targetFor, type DayRules } from './rules';

/**
 * Past test of the day-trade rules (v0.11.0) on months of real 5-minute candles.
 *
 * Honest by construction:
 *  - A signal is taken at the OPEN of the NEXT 5-minute bar (you see the close, then you act), with
 *    slippage against you on both the entry and the exit, and Upstox's intraday charges.
 *  - The amount is split into `slots` trades a day (no borrowed money); after `maxLosses` losing trades
 *    the day is over. The first signals of the day are taken (busiest stocks first if at the same time).
 *  - The few settings the rules have (target size, how busy the stock must be, buy / short / both) are
 *    chosen on the OLDER two thirds of the days only. The verdict comes from the NEWEST third, which
 *    the choice never saw ("fresh-data check"). The rules pass only if they made money there.
 */

export const DAY_RULES_VERSION = 'orb-v1';
/** position of the market feature in the feature vector (src/ml/features.ts) */
const MARKET_FEATURE = 12;

export interface DayStockRef {
  key: string;
  symbol: string;
  /** may be sold short (large, liquid Nifty 100 stocks only) */
  shortAllowed: boolean;
  tick: number;
}

export type TargetKey = '1' | '1.5' | '2' | 'eod';
export const TARGETS: Array<{ key: TargetKey; mult: number | null }> = [
  { key: '1', mult: 1 },
  { key: '1.5', mult: 1.5 },
  { key: '2', mult: 2 },
  { key: 'eod', mult: null },
];
export const RVOLS = [1, 1.5, 2];
export type SideMode = 'both' | 'long' | 'short';

export interface Variant {
  target: TargetKey;
  minRvol: number;
  sides: SideMode;
}
export const DEFAULT_VARIANT: Variant = { target: '1.5', minRvol: 1.5, sides: 'both' };
export const VARIANTS: Variant[] = (['both', 'long', 'short'] as SideMode[]).flatMap((sides) => RVOLS.flatMap((minRvol) => TARGETS.map((t) => ({ target: t.key, minRvol, sides }))));
export const targetMult = (k: TargetKey): number | null => TARGETS.find((t) => t.key === k)!.mult;

export interface Candidate {
  key: string;
  symbol: string;
  date: string;
  side: Side;
  /** minute the signal bar closed */
  signalT: number;
  /** 5-minute slot of the signal bar (0 = 09:15) */
  slot: number;
  rvol: number;
  entry: number;
  stop: number;
  /** exit price (after slippage), time and reason for each target option */
  outcomes: Record<TargetKey, { price: number; t: number; reason: 'stop' | 'target' | 'time' }>;
  /** average move of all studied stocks from their open at the signal bar (filled after all stocks are read) */
  market: number;
  /** what the self-learning sees at the signal (src/ml/features.ts) */
  f?: number[];
}

export interface DayTestTrade {
  date: string;
  key: string;
  symbol: string;
  side: Side;
  entryT: number;
  entry: number;
  exitT: number;
  exit: number;
  reason: 'stop' | 'target' | 'time';
  qty: number;
  pnl: number;
  pnlPct: number;
  /** app v1.23: the safety net (so the auto-trader can read the result in R); missing in older reports */
  stop?: number;
}

export interface DayTestResult {
  days: number;
  daysTraded: number;
  trades: number;
  wins: number;
  losses: number;
  /** ₹ after charges and slippage */
  pnl: number;
  /** % of the amount */
  pnlPct: number;
  avgPerDay: number;
  greenDays: number;
  redDays: number;
  bestDay: number;
  worstDay: number;
  /** deepest fall from an earlier high (₹, ≤ 0) */
  maxDrawdown: number;
  long: { trades: number; wins: number; pnl: number };
  short: { trades: number; wins: number; pnl: number };
}

export interface DayTestReport {
  rulesVersion: string;
  from: string;
  to: string;
  sessions: number;
  stocks: number;
  amount: number;
  slots: number;
  maxLosses: number;
  slippagePct: number;
  candidates: number;
  trainFrom: string;
  trainTo: string;
  checkFrom: string;
  checkTo: string;
  chosen: Variant;
  /** chosen settings on the older days they were chosen on */
  train: DayTestResult;
  /** the same settings on the newest days (never used for choosing) — the verdict */
  check: DayTestResult;
  passed: boolean;
  /** which sides the live signals may use: those of the chosen settings when passed */
  reason: string;
  months: Array<{ month: string; pnl: number; trades: number; unseen: boolean }>;
  checkTrades: DayTestTrade[];
  variants: Array<{ v: Variant; trainPnl: number; trainTrades: number; checkPnl: number; checkTrades: number }>;
  computedMs: number;
}

export interface DayTestConfig {
  amount: number;
  slots: number;
  maxLosses: number;
  /** % of price lost on each entry and exit */
  slippagePct: number;
  priceMin?: number;
  priceMax?: number | null;
  rules?: DayRules;
  onProgress?: (done: number, total: number) => void;
  yieldMs?: number;
}

const sleep = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Reads every stock's days once and returns every breakout with its outcome for each target option.
 * `loadDays` loads one stock at a time (memory stays small even for 500 stocks).
 */
export async function buildCandidates(
  stocks: DayStockRef[],
  loadDays: (key: string) => Promise<DayBars[]>,
  cfg: Pick<DayTestConfig, 'slippagePct' | 'priceMin' | 'priceMax' | 'rules' | 'onProgress' | 'yieldMs'>,
): Promise<{ candidates: Candidate[]; dates: string[]; stocksWithData: number }> {
  const r = cfg.rules ?? DEFAULT_RULES;
  const slip = cfg.slippagePct / 100;
  const candidates: Candidate[] = [];
  const mktSum = new Map<string, Float64Array>();
  const mktCnt = new Map<string, Uint16Array>();
  const SLOTS = 80;
  let stocksWithData = 0;
  let lastYield = Date.now();

  for (let si = 0; si < stocks.length; si++) {
    const s = stocks[si]!;
    const days = (await loadDays(s.key)).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
    if (days.length) stocksWithData++;
    const prevVols: number[] = [];
    const prevDays: PrevDay[] = [];
    for (const d of days) {
      const pd = prevDayOf(d);
      const before = prevDays.slice(-10);
      if (pd) prevDays.push(pd);
      const or = openingRange(d, r);
      if (!or) continue;
      // market average: this stock's move from its open, at every 5-minute slot
      let sum = mktSum.get(d.date);
      let cnt = mktCnt.get(d.date);
      if (!sum || !cnt) {
        sum = new Float64Array(SLOTS);
        cnt = new Uint16Array(SLOTS);
        mktSum.set(d.date, sum);
        mktCnt.set(d.date, cnt);
      }
      for (let i = 0; i < d.t.length; i++) {
        const slot = Math.floor((d.t[i]! - OPEN_T) / r.barMinutes);
        if (slot < 0 || slot >= SLOTS) continue;
        sum[slot]! += d.c[i]! / or.open - 1;
        cnt[slot]!++;
      }

      const rvol = relativeVolume(or.vol, prevVols, r);
      prevVols.push(or.vol);
      if (rvol === null) continue;
      const bo = findBreakout(d, r);
      if (!bo) continue;
      if (bo.side === 'short' && !s.shortAllowed) continue;
      const entryIdx = bo.idx + 1;
      if (entryIdx >= d.t.length || d.t[entryIdx]! >= r.exitT) continue;
      const raw = d.o[entryIdx]!;
      if (!(raw > 0)) continue;
      if (raw < (cfg.priceMin ?? 0) || (cfg.priceMax !== null && cfg.priceMax !== undefined && raw > cfg.priceMax)) continue;
      // slippage against us: buy a little higher, sell a little lower
      const entry = bo.side === 'long' ? raw * (1 + slip) : raw * (1 - slip);
      const stop = stopFor(bo.side, raw, or, r, s.tick);
      const outcomes = {} as Candidate['outcomes'];
      for (const t of TARGETS) {
        const ex = simulateExit(d, entryIdx, bo.side, stop, targetFor(bo.side, raw, stop, t.mult, s.tick), r);
        outcomes[t.key] = { price: bo.side === 'long' ? ex.price * (1 - slip) : ex.price * (1 + slip), t: ex.t, reason: ex.reason };
      }
      candidates.push({ key: s.key, symbol: s.symbol, date: d.date, side: bo.side, signalT: bo.barCloseT, slot: Math.floor((d.t[bo.idx]! - OPEN_T) / r.barMinutes), rvol, entry, stop, outcomes, market: 0, f: featureVector(d, bo.idx, bo.side, or, before, 0, rvol) });
    }
    cfg.onProgress?.(si + 1, stocks.length);
    if (Date.now() - lastYield > (cfg.yieldMs ?? 40)) {
      await sleep();
      lastYield = Date.now();
    }
  }
  for (const c of candidates) {
    const n = mktCnt.get(c.date)?.[c.slot] ?? 0;
    c.market = n ? mktSum.get(c.date)![c.slot]! / n : 0;
    if (c.f) c.f[MARKET_FEATURE] = Math.max(-10, Math.min(10, (c.side === 'long' ? 1 : -1) * c.market * 100));
  }
  const dates = [...mktSum.keys()].sort();
  return { candidates, dates, stocksWithData };
}

/** Does this candidate pass a variant's filters? The market must agree with the trade's direction. */
export function passes(c: Pick<Candidate, 'side' | 'rvol' | 'market'>, v: Variant): boolean {
  if (v.sides !== 'both' && v.sides !== c.side) return false;
  if (c.rvol < v.minRvol) return false;
  return c.side === 'long' ? c.market > 0 : c.market < 0;
}

/** Follows one variant day by day: first signals first, `slots` trades a day, stop after `maxLosses` losses. */
export function simulateVariant(byDate: Map<string, Candidate[]>, dates: string[], v: Variant, cfg: Pick<DayTestConfig, 'amount' | 'slots' | 'maxLosses'>): { result: DayTestResult; trades: DayTestTrade[]; dayPnl: Map<string, number> } {
  return simulatePolicy(byDate, dates, (c) => passes(c, v), v.target, cfg, (a, b) => b.rvol - a.rvol);
}

/**
 * Any trading policy, day by day, in the order signals appear: `accept` decides which signals to
 * take (the rules, or the self-learning's chance), `tie` orders signals of the same 5 minutes.
 */
export function simulatePolicy(
  byDate: Map<string, Candidate[]>,
  dates: string[],
  accept: (c: Candidate) => boolean,
  target: TargetKey,
  cfg: Pick<DayTestConfig, 'amount' | 'slots' | 'maxLosses'>,
  tie: (a: Candidate, b: Candidate) => number,
): { result: DayTestResult; trades: DayTestTrade[]; dayPnl: Map<string, number> } {
  const v = { target };
  const alloc = cfg.amount / cfg.slots;
  const trades: DayTestTrade[] = [];
  const dayPnl = new Map<string, number>();
  for (const date of dates) {
    const list = (byDate.get(date) ?? []).filter(accept).sort((a, b) => a.signalT - b.signalT || tie(a, b));
    const taken: DayTestTrade[] = [];
    for (const c of list) {
      if (taken.length >= cfg.slots) break;
      if (taken.filter((t) => t.exitT <= c.signalT && t.pnl < 0).length >= cfg.maxLosses) break;
      if (taken.some((t) => t.key === c.key)) continue;
      const qty = Math.floor(alloc / c.entry);
      if (qty < 1) continue;
      const out = c.outcomes[v.target];
      const { pnl } = dayTradePnl(c.side, qty, c.entry, out.price);
      taken.push({ date, key: c.key, symbol: c.symbol, side: c.side, entryT: c.signalT, entry: c.entry, exitT: out.t, exit: out.price, reason: out.reason, qty, pnl, pnlPct: (pnl / (qty * c.entry)) * 100, stop: c.stop });
    }
    if (taken.length) {
      trades.push(...taken);
      dayPnl.set(date, taken.reduce((a, t) => a + t.pnl, 0));
    }
  }
  return { result: summarise(trades, dayPnl, dates, cfg.amount), trades, dayPnl };
}

function summarise(trades: DayTestTrade[], dayPnl: Map<string, number>, dates: string[], amount: number): DayTestResult {
  const pnl = trades.reduce((a, t) => a + t.pnl, 0);
  const days = [...dayPnl.values()];
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const d of dates) {
    equity += dayPnl.get(d) ?? 0;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity - peak);
  }
  const side = (s: Side) => {
    const x = trades.filter((t) => t.side === s);
    return { trades: x.length, wins: x.filter((t) => t.pnl > 0).length, pnl: x.reduce((a, t) => a + t.pnl, 0) };
  };
  return {
    days: dates.length,
    daysTraded: days.length,
    trades: trades.length,
    wins: trades.filter((t) => t.pnl > 0).length,
    losses: trades.filter((t) => t.pnl <= 0).length,
    pnl,
    pnlPct: (pnl / amount) * 100,
    avgPerDay: dates.length ? pnl / dates.length : 0,
    greenDays: days.filter((x) => x > 0).length,
    redDays: days.filter((x) => x <= 0).length,
    bestDay: days.length ? Math.max(...days) : 0,
    worstDay: days.length ? Math.min(...days) : 0,
    maxDrawdown,
    long: side('long'),
    short: side('short'),
  };
}

/** Minimum trades for a setting to be chosen / for the fresh-data check to count. */
export const MIN_TRAIN_TRADES = 20;
export const MIN_CHECK_TRADES = 15;
export const MIN_SESSIONS = 45;

export function evaluate(candidates: Candidate[], dates: string[], stocks: number, cfg: DayTestConfig, startedAt = Date.now()): DayTestReport | null {
  if (dates.length < MIN_SESSIONS) return null;
  const byDate = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const l = byDate.get(c.date);
    if (l) l.push(c);
    else byDate.set(c.date, [c]);
  }
  const split = Math.floor((dates.length * 2) / 3);
  const trainDates = dates.slice(0, split);
  const checkDates = dates.slice(split);

  const rows = VARIANTS.map((v) => {
    const tr = simulateVariant(byDate, trainDates, v, cfg);
    const ck = simulateVariant(byDate, checkDates, v, cfg);
    return { v, tr, ck };
  });
  // the choice uses the OLDER days only
  const eligible = rows.filter((x) => x.tr.result.trades >= MIN_TRAIN_TRADES);
  const best = eligible.length ? eligible.reduce((a, b) => (b.tr.result.pnl > a.tr.result.pnl ? b : a)) : rows.find((x) => x.v.target === DEFAULT_VARIANT.target && x.v.minRvol === DEFAULT_VARIANT.minRvol && x.v.sides === DEFAULT_VARIANT.sides)!;

  const train = best.tr.result;
  const check = best.ck.result;
  let passed = false;
  let reason: string;
  if (!eligible.length) reason = 'Too few signals in the test period to judge the rules.';
  else if (train.pnl <= 0) reason = 'No setting of the rules made money even on the older days.';
  else if (check.trades < MIN_CHECK_TRADES) reason = `Only ${check.trades} trades in the fresh-data check — too few to judge.`;
  else if (check.pnl <= 0) reason = 'The rules made money on the older days but LOST money on the newest days they had not seen.';
  else {
    passed = true;
    reason = 'The rules made money on the older days AND on the newest days they had not seen.';
  }

  const all = [...best.tr.trades, ...best.ck.trades];
  const monthMap = new Map<string, { pnl: number; trades: number }>();
  for (const t of all) {
    const m = t.date.slice(0, 7);
    const cur = monthMap.get(m) ?? { pnl: 0, trades: 0 };
    monthMap.set(m, { pnl: cur.pnl + t.pnl, trades: cur.trades + 1 });
  }
  const firstCheckMonth = checkDates[0]!.slice(0, 7);
  return {
    rulesVersion: DAY_RULES_VERSION,
    from: dates[0]!,
    to: dates[dates.length - 1]!,
    sessions: dates.length,
    stocks,
    amount: cfg.amount,
    slots: cfg.slots,
    maxLosses: cfg.maxLosses,
    slippagePct: cfg.slippagePct,
    candidates: candidates.length,
    trainFrom: trainDates[0]!,
    trainTo: trainDates[trainDates.length - 1]!,
    checkFrom: checkDates[0]!,
    checkTo: checkDates[checkDates.length - 1]!,
    chosen: best.v,
    train,
    check,
    passed,
    reason,
    months: [...monthMap.entries()].sort().map(([month, x]) => ({ month, ...x, unseen: month >= firstCheckMonth })),
    checkTrades: best.ck.trades.slice(-300),
    variants: rows.map((x) => ({ v: x.v, trainPnl: x.tr.result.pnl, trainTrades: x.tr.result.trades, checkPnl: x.ck.result.pnl, checkTrades: x.ck.result.trades })),
    computedMs: Date.now() - startedAt,
  };
}

export async function runDayTest(stocks: DayStockRef[], loadDays: (key: string) => Promise<DayBars[]>, cfg: DayTestConfig): Promise<DayTestReport | null> {
  const t0 = Date.now();
  const { candidates, dates, stocksWithData } = await buildCandidates(stocks, loadDays, cfg);
  return evaluate(candidates, dates, stocksWithData, cfg, t0);
}
