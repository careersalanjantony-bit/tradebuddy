import { computePlan, type PlanResult } from '../planner/plan';
import { chanceOf, expectancyAt, studyExits, type ExitStudy } from './exitStudy';
import { explainSnapshot } from './explain';
import type { StockData } from '../data/stockData';
import { inPriceRange } from '../data/universeParse';
import type { TechSnapshot } from '../indicators/snapshot';
import type { Candle } from '../indicators/types';
import type { Settings, TradePlan } from '../storage/schema';

/**
 * Today's top picks (v0.7.0). The extension studies a list of companies by itself (Nifty 50/100, plus
 * your own stocks) and ranks the ones that pass every check.
 *
 * A stock qualifies only if ALL hold:
 *  - its price is inside your price range;
 *  - plain-words verdict "Good setup" (playbook setup, above the 200-day average, not stretched, data OK);
 *  - no planned/open trade on it already;
 *  - about a year of history to study, and the plan fits your money;
 *  - history favours it: in similar situations over the last year, buying and following the exit plan
 *    (profit target / sell-if-falls price / sell after 20 days) made money on average AFTER charges.
 *
 * Ranking (settings.scanner.rankBy):
 *  - 'safety' (default from v0.8.0, owner: "stocks suitable for safe investments based on the past"):
 *    the stocks that most often MADE MONEY (after charges) in similar past cases, counted cautiously
 *    (a lower confidence bound, so 9 of 10 does not beat 45 of 55); ties → the smaller possible loss;
 *  - 'earning' (v0.7.0): by the past average result in % of the money invested, after charges.
 * Sizing:
 *  - 'split' (default): the whole amount is split equally into `splitInto` stocks;
 *  - 'risk': each trade loses at most riskPerTradePct of the amount at its sell-if-falls price.
 */

export interface StockInput {
  key: string;
  symbol: string;
  data: StockData | undefined;
}

export interface BuySuggestion {
  key: string;
  symbol: string;
  name: string;
  summary: string;
  snap: TechSnapshot;
  plan: PlanResult;
  study: ExitStudy | null;
  /** 0–1: share of similar past cases that reached the profit target before the sell-if-falls price */
  safeChance: number | null;
  holdChance: number | null;
  /** past average result per trade after charges, in units of the possible loss (R) */
  edge: number;
  /** past average result per trade after charges, in % of the money invested */
  expectedPct: number;
  /** expectedPct applied to this plan's money (₹) */
  expectedRupees: number;
  /** ₹ if the profit target is reached / if the "can go up to" level is reached */
  targetEarning: number;
  maxEarning: number;
  tick: number;
  isin?: string;
  /** what happened in the similar past cases with this exact plan (profit target / sell price / 20 days) */
  record: PastRecord;
  /** cautious share (0–1) of past cases that made money after charges — the 'safety' ranking key */
  safetyScore: number;
}

export interface PastRecord {
  samples: number;
  /** reached the profit target before the sell-if-falls price */
  reached: number;
  /** hit the sell-if-falls price first */
  stopped: number;
  /** neither within the horizon — sold at the close after `horizon` sessions */
  timed: number;
  /** ended with a profit after charges */
  profitable: number;
  /** profitable / samples */
  profitChance: number;
}

/** Outcome of every similar past case for a target `atr` ATRs above entry, after charges (in R). */
export function pastRecord(study: ExitStudy, atr: number, chargesR: number): PastRecord {
  let reached = 0;
  let stopped = 0;
  let timed = 0;
  let profitable = 0;
  for (const c of study.cases) {
    let r: number;
    if (c.mfeAtr >= atr - 1e-9) {
      reached++;
      r = atr / study.stopAtr;
    } else if (c.stopped) {
      stopped++;
      r = -1;
    } else {
      timed++;
      r = c.endR;
    }
    if (r - chargesR > 0) profitable++;
  }
  const samples = study.cases.length;
  return { samples, reached, stopped, timed, profitable, profitChance: samples ? profitable / samples : 0 };
}

/** Lower bound of a success rate (Wilson score, z = 1.28 ≈ 80% one-sided): cautious with few cases. */
export function cautiousRate(successes: number, n: number, z = 1.28): number {
  if (n <= 0) return 0;
  const p = successes / n;
  const z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
}

/** Sort order of the candidates for the chosen ranking. */
export function compareSuggestions(rankBy: 'safety' | 'earning', split: boolean) {
  return (a: BuySuggestion, b: BuySuggestion): number => {
    if (rankBy === 'safety') {
      const d = b.safetyScore - a.safetyScore;
      if (Math.abs(d) > 1e-9) return d;
      const la = a.plan.riskPerShare / a.plan.entry;
      const lb = b.plan.riskPerShare / b.plan.entry;
      if (Math.abs(la - lb) > 1e-9) return la - lb;
      return b.expectedPct - a.expectedPct;
    }
    return split ? b.expectedPct - a.expectedPct : b.edge - a.edge;
  };
}

export interface SkippedStock {
  key: string;
  symbol: string;
  reason: string;
}

export interface Suggestions {
  blockedReason: string | null;
  freeSlots: number;
  /** what to buy now (fills the free slots) */
  suggestions: BuySuggestion[];
  /** other qualifying stocks, ranked (shown as "next best") */
  more: BuySuggestion[];
  skipped: SkippedStock[];
  /** stocks hidden by the price range */
  outsideRange: number;
  studied: number;
}

export interface SuggestOptions {
  priceMin?: number;
  priceMax?: number | null;
}

export interface CandidateInput {
  key: string;
  symbol: string;
  name: string;
  snap: TechSnapshot;
  /** adjusted candles (a trailing live candle is ignored by the study) */
  candles: Candle[];
  tick: number;
  isin?: string;
}

export type CandidateResult = { ok: true; suggestion: BuySuggestion } | { ok: false; reason: string };

/**
 * Every check for ONE stock, given its snapshot and candles: verdict, history study, plan, past
 * edge. Shared by the live picks and the past-year test (backtest.ts), so both use the same rules.
 */
export function evaluateCandidate(c: CandidateInput, settings: Settings, allocation: number | null, otherRisks: number[], today: string): CandidateResult {
  const { snap } = c;
  const e = explainSnapshot(c.symbol, snap);
  if (e.verdict !== 'Good setup') {
    return { ok: false, reason: e.verdict === 'Wait' && e.entryHint ? `${e.verdict}: ${e.entryHint}` : `${e.verdict}: ${e.summary}` };
  }
  const study = studyExits(c.candles, {
    trend: snap.trend,
    stopAtr: settings.planner.stopAtrMultiple,
    horizon: settings.planner.exitHorizonSessions,
    lookback: settings.planner.exitLookbackSessions,
  });
  if (!study) return { ok: false, reason: 'Not enough price history (about a year is needed) to judge how this stock usually moves.' };
  const plan = computePlan({
    symbol: c.symbol,
    entry: snap.price,
    tick: c.tick,
    stopMethod: 'atr',
    targetMethod: 'history',
    atr: snap.atr14,
    lastSwingLow: snap.lastSwingLow,
    resistances: snap.resistances.map((l) => l.price),
    history: { safeAtr: study.safeAtr, holdAtr: study.holdAtr },
    allocation,
    settings: { ...settings.risk, ...settings.planner },
    snapshot: { flags: snap.flags, setup: snap.setup, trend: snap.trend },
    otherOpenRisks: otherRisks,
    today,
  });
  if (!plan.ok) return { ok: false, reason: plan.errors[0] ?? 'Could not build a plan.' };
  if (plan.rr < 0.5) return { ok: false, reason: 'The usual move is too small compared with the possible loss.' };
  const atr = snap.atr14!;
  const targetAtr = (plan.target - plan.entry) / atr;
  const safeChance = chanceOf(study, targetAtr);
  const holdChance = plan.holdTarget !== null ? chanceOf(study, (plan.holdTarget - plan.entry) / atr) : null;
  const chargesR = plan.charges !== null && plan.riskRupees > 0 ? plan.charges / plan.riskRupees : 0;
  const edge = expectancyAt(study, targetAtr) - chargesR;
  if (edge <= 0.05) return { ok: false, reason: 'In similar situations over the last year, buying here did not make money on average (after charges).' };
  const expectedPct = (edge * plan.riskPerShare * 100) / plan.entry;
  const record = pastRecord(study, targetAtr, chargesR);
  return {
    ok: true,
    suggestion: {
      key: c.key,
      symbol: c.symbol,
      name: c.name,
      summary: e.summary,
      snap,
      plan,
      study,
      safeChance,
      holdChance,
      edge,
      expectedPct,
      expectedRupees: (expectedPct / 100) * plan.positionValue,
      targetEarning: plan.rewardRupees,
      maxEarning: ((plan.holdTarget ?? plan.target) - plan.entry) * plan.qty,
      tick: c.tick,
      ...(c.isin ? { isin: c.isin } : {}),
      record,
      safetyScore: cautiousRate(record.profitable, record.samples),
    },
  };
}

export function suggestBuys(stocks: StockInput[], settings: Settings, plans: TradePlan[], today: string, opts: SuggestOptions = {}): Suggestions {
  const active = plans.filter((p) => p.status === 'planned' || p.status === 'open');
  const split = settings.risk.sizing === 'split';
  const maxTrades = split ? Math.max(1, Math.min(5, Math.round(settings.risk.splitInto))) : settings.risk.maxOpenTrades;
  const freeSlots = Math.max(0, maxTrades - active.length);
  const out: Suggestions = { blockedReason: null, freeSlots, suggestions: [], more: [], skipped: [], outsideRange: 0, studied: 0 };
  const capital = settings.risk.capitalInr;
  if (!capital) {
    out.blockedReason = 'Enter the amount you want to invest in Settings.';
    return out;
  }
  const allocation = split ? capital / maxTrades : null;
  const priceMin = opts.priceMin ?? settings.ui.priceMin ?? 0;
  const priceMax = opts.priceMax === undefined ? (settings.ui.priceMax ?? null) : opts.priceMax;

  const activeKeys = new Set(active.map((p) => p.key));
  const otherRisks = active.map((p) => p.riskRupees);
  const candidates: BuySuggestion[] = [];
  const seen = new Set<string>();

  for (const s of stocks) {
    if (seen.has(s.key)) continue;
    seen.add(s.key);
    const skip = (reason: string) => out.skipped.push({ key: s.key, symbol: s.symbol, reason });
    const snap = s.data?.snapshot;
    if (!s.data || !snap) {
      skip('No price history yet.');
      continue;
    }
    if (!inPriceRange(snap.price, priceMin, priceMax)) {
      out.outsideRange++;
      continue;
    }
    out.studied++;
    if (activeKeys.has(s.key)) {
      skip('You already have a trade in this stock.');
      continue;
    }
    const r = evaluateCandidate(
      {
        key: s.key,
        symbol: s.symbol,
        name: s.data.instrument?.short_name ?? s.data.instrument?.name ?? s.symbol,
        snap,
        candles: s.data.candles,
        tick: s.data.instrument?.tick ?? 0.05,
        ...(s.data.instrument?.isin ? { isin: s.data.instrument.isin } : {}),
      },
      settings,
      allocation,
      otherRisks,
      today,
    );
    if (r.ok) candidates.push(r.suggestion);
    else skip(r.reason);
  }

  candidates.sort(compareSuggestions(settings.scanner.rankBy ?? 'safety', split));

  if (freeSlots === 0) {
    out.blockedReason = `You already have ${active.length} trade(s) — your amount is in use. New picks appear when one is finished.`;
    out.more = candidates;
    return out;
  }

  const moneyInTrades = active.reduce((a, p) => a + (p.fillPrice ?? p.entry) * p.qty, 0);
  let riskUsed = otherRisks.reduce((a, b) => a + b, 0);
  let moneyUsed = moneyInTrades;
  for (const c of candidates) {
    if (out.suggestions.length >= freeSlots) {
      out.more.push(c);
      continue;
    }
    if (!split && ((riskUsed + c.plan.riskRupees) / capital) * 100 > settings.risk.maxTotalOpenRiskPct) {
      out.skipped.push({ key: c.key, symbol: c.symbol, reason: 'Good setup, but it would put too much of your money at risk at the same time.' });
      continue;
    }
    if (moneyUsed + c.plan.positionValue > capital + 1) {
      out.more.push(c);
      continue;
    }
    riskUsed += c.plan.riskRupees;
    moneyUsed += c.plan.positionValue;
    out.suggestions.push(c);
  }
  return out;
}

/** Top picks not yet announced today (for "New top pick" alerts). */
export function newTopPicks(announced: string[], picks: BuySuggestion[]): BuySuggestion[] {
  const seen = new Set(announced);
  return picks.filter((p) => !seen.has(p.key));
}

/** Slider stops for the price filter (₹). null = no upper limit. */
export const PRICE_STOPS: Array<number | null> = [0, 50, 100, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 10000, null];
