import type { DayTestReport } from '../daytrade/backtest';
import type { BreakoutTestReport } from '../daytrade/breakout';
import type { ShortTestReport } from '../daytrade/shortScan';
import type { IntradayTestReport } from '../intraday/backtest';
import type { RiseModel } from '../rising/momentum';
import { PLAYBOOKS, type PlaybookId } from './playbooks';

/**
 * App v1.23 — evidence first. Each kind of trade (playbook) gets a state from what it really did:
 * its own finished trades (real and shadow, counted BEFORE charges, because the charges of a future
 * trade depend on its own size) plus its past test on days it was never tuned on, counted cautiously.
 * Only "trial" and "proven" kinds trade with money (bot/policy.ts). Pure: no storage, no network.
 * App v1.24 (looser rules): kinds not proven yet ("watch") trade too, at a small learning size, and a kind
 * becomes "trial" after 10 results (was 20) and "proven" after 20 (was 30).
 */

export type PlaybookState = 'proven' | 'trial' | 'watch' | 'paused' | 'off';

/** One finished trade of a playbook. */
export interface Sample {
  at: number;
  /** result in R before charges (a winner counts at most EVIDENCE.winCapR) */
  grossR: number;
  /** result in R after charges, at the size it had */
  netR: number;
  /** a shadow trade (followed without money) */
  shadow?: true;
}

/** The newest samples of each playbook, oldest first (at most EVIDENCE.window each). */
export type SampleBook = Partial<Record<PlaybookId, Sample[]>>;

/** A past test used as a cautious head start. */
export interface TestPrior {
  trades: number;
  /** average result per trade in R (after charges where the test reports only that: the safe side) */
  avgR: number;
  label: string;
}

/** What is remembered per playbook besides its samples. */
export interface PlaybookMemo {
  /** switched off by the owner */
  off?: boolean;
  /** it was paused (it must recover clearly before it trades again) */
  paused?: boolean;
}

export interface PlaybookEvidence {
  id: PlaybookId;
  state: PlaybookState;
  /** finished trades counted (real + shadow; the newest EVIDENCE.window) */
  n: number;
  /** of those, shadow trades */
  shadow: number;
  wins: number;
  /** average result per trade before / after charges (R); null without trades */
  avgGrossR: number | null;
  avgNetR: number | null;
  /** the cautious estimate of the result per trade before charges (R); null = no evidence at all */
  safeR: number | null;
  /** average of the newest 20 (R before charges); null with fewer than 20 */
  last20R: number | null;
  prior: TestPrior | null;
  /** the past test counted (it has at least EVIDENCE.priorMin trades) */
  priorCounted: boolean;
  /** why it is in this state, in plain words */
  why: string;
}

export interface EvidenceSummary {
  at: number;
  list: PlaybookEvidence[];
}

export const EVIDENCE = {
  /** newest finished samples per playbook (real + shadow) */
  window: 60,
  /** a winner counts at most +4 R, so one lucky trade cannot prove a playbook (losses are never cut) */
  winCapR: 4,
  /** the spread of results is never assumed smaller than this (R) */
  sdFloorR: 0.8,
  /** a past test needs at least this many trades to count … */
  priorMin: 20,
  /** … and counts as at most this many */
  priorMax: 30,
  /** live fills are worse than tested ones */
  priorHaircutR: 0.05,
  /** app v1.24: 10 (was 20) */
  trialMinN: 10,
  /** app v1.24: 20 (was 30) */
  provenMinN: 20,
  provenMinSafeR: 0.1,
  pauseLastN: 20,
  pauseBelowR: -0.05,
  pauseSafeBelowR: -0.15,
  resumeAboveR: 0.1,
} as const;

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const avg = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const fmt = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2)} R`;

/** A finished trade as a sample (null when its risk is unknown). Winners are capped, losses never. */
export function toSample(t: { closedAt?: number; openedAt: number; riskRupees: number; pnl?: number; r?: number; grossR?: number; shadow?: true }): Sample | null {
  if (!(t.riskRupees > 0)) return null;
  const netR = t.r ?? (t.pnl !== undefined ? t.pnl / t.riskRupees : undefined);
  if (netR === undefined || !Number.isFinite(netR)) return null;
  // trades closed before app 1.23 have no gross result: their result after charges is lower (the safe side)
  const gross = t.grossR !== undefined && Number.isFinite(t.grossR) ? t.grossR : netR;
  return { at: t.closedAt ?? t.openedAt, grossR: r3(Math.min(gross, EVIDENCE.winCapR)), netR: r3(netR), ...(t.shadow ? { shadow: true as const } : {}) };
}

/** Adds a sample (keeps the newest EVIDENCE.window of the playbook). */
export function addSample(book: SampleBook | undefined, id: PlaybookId, s: Sample): SampleBook {
  const list = [...(book?.[id] ?? []), s].slice(-EVIDENCE.window);
  return { ...(book ?? {}), [id]: list };
}

function sampleSd(xs: readonly number[]): number {
  if (xs.length < 2) return EVIDENCE.sdFloorR;
  const m = avg(xs);
  const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.max(EVIDENCE.sdFloorR, Math.sqrt(v));
}

/**
 * The state of one playbook. `cap` = a reason it may not trade with money whatever its numbers (e.g. the
 * Intraday scanner's own record is not proven yet): it then stays in "watch".
 */
export function evaluate(id: PlaybookId, samples: readonly Sample[] | undefined, prior: TestPrior | null, memo?: PlaybookMemo, cap?: string | null): PlaybookEvidence {
  const W = [...(samples ?? [])].slice(-EVIDENCE.window);
  const n = W.length;
  const gross = W.map((s) => s.grossR);
  const mean = n ? avg(gross) : 0;
  const sd = sampleSd(gross);
  const priorCounted = !!prior && prior.trades >= EVIDENCE.priorMin && Number.isFinite(prior.avgR);
  const n0 = priorCounted ? Math.min(prior!.trades, EVIDENCE.priorMax) : 0;
  const mu0 = priorCounted ? prior!.avgR - EVIDENCE.priorHaircutR : 0;
  const total = n0 + n;
  const mu = total ? (n0 * mu0 + n * mean) / total : 0;
  const safeR = total ? mu - sd / Math.sqrt(total) : null;
  const last = W.slice(-EVIDENCE.pauseLastN).map((s) => s.grossR);
  const last20R = n >= EVIDENCE.pauseLastN ? avg(last) : null;
  const liveSafe = n >= 2 ? mean - sd / Math.sqrt(n) : null;
  const base = {
    id,
    n,
    shadow: W.filter((s) => s.shadow).length,
    wins: W.filter((s) => s.netR > 0).length,
    avgGrossR: n ? r3(mean) : null,
    avgNetR: n ? r3(avg(W.map((s) => s.netR))) : null,
    safeR: safeR === null ? null : r3(safeR),
    last20R: last20R === null ? null : r3(last20R),
    prior: prior ?? null,
    priorCounted,
  };
  const done = (state: PlaybookState, why: string): PlaybookEvidence => ({ ...base, state, why });

  if (memo?.off) return done('off', 'Switched off by you: no trades, not even shadow ones.');
  const pausedNow = n >= EVIDENCE.pauseLastN && ((last20R as number) < EVIDENCE.pauseBelowR || (n >= EVIDENCE.provenMinN && liveSafe !== null && liveSafe < EVIDENCE.pauseSafeBelowR));
  const stillPaused = !!memo?.paused && !(last20R !== null && last20R >= EVIDENCE.resumeAboveR);
  if (pausedNow || stillPaused) {
    const lastText = last20R === null ? `it has ${n} of the 20 results it needs` : `its newest 20 trades average ${fmt(last20R)} before charges`;
    return done('paused', `Paused: ${lastText}. It trades again once the newest 20 (shadow trades count) average ${fmt(EVIDENCE.resumeAboveR)}.`);
  }
  const from = `${n} trade${n === 1 ? '' : 's'}${priorCounted ? ` and its past test (${prior!.trades} trades, ${fmt(prior!.avgR)})` : ''}`;
  let state: PlaybookState = 'watch';
  if (safeR !== null && n >= EVIDENCE.provenMinN && safeR >= EVIDENCE.provenMinSafeR) state = 'proven';
  else if (safeR !== null && safeR >= 0 && (n >= EVIDENCE.trialMinN || n0 >= EVIDENCE.priorMin)) state = 'trial';
  if (state !== 'watch' && cap) return done('watch', cap);
  if (state === 'proven') return done('proven', `Proven: safe estimate ${fmt(safeR!)} per trade before charges, from ${from}.`);
  if (state === 'trial') return done('trial', `Trial (small size): safe estimate ${fmt(safeR!)} per trade before charges, from ${from}. Normal size after ${EVIDENCE.provenMinN} trades at ${fmt(EVIDENCE.provenMinSafeR)} or better.`);
  if (safeR === null) return done('watch', `No results yet: it trades at the small learning size (at most 2 such trades at once) until it shows an edge — trial size after ${EVIDENCE.trialMinN} results at ${fmt(0)} or better.`);
  return done('watch', `Not proven yet: safe estimate ${fmt(safeR)} per trade before charges, from ${from}. It trades at the small learning size until it reaches ${fmt(0)} with ${EVIDENCE.trialMinN} trades.`);
}

/** Every playbook's state (in the fixed playbook order). */
export function evaluateAll(
  samples: SampleBook | undefined,
  priors: Partial<Record<PlaybookId, TestPrior>>,
  memos: Partial<Record<PlaybookId, PlaybookMemo>> | undefined,
  caps: Partial<Record<PlaybookId, string | null>>,
  now: number,
): EvidenceSummary {
  return { at: now, list: PLAYBOOKS.map((id) => evaluate(id, samples?.[id], priors[id] ?? null, memos?.[id], caps[id] ?? null)) };
}

/** The stored past tests the priors are read from (the app's own storage keys). */
export interface StoredTests {
  dayTest?: { report: DayTestReport } | null;
  riseModel?: RiseModel | null;
  shortTest?: ShortTestReport | null;
  breakoutTest?: BreakoutTestReport | null;
  intradayTest?: IntradayTestReport | null;
}

/**
 * The past tests as priors. Only results on days the rules were not tuned on: the day-trade test's
 * "check" days, the rise model's kept-aside days, the newest days of the sell-first and breakout tests,
 * and the Intraday test (its rules were fixed before it ran). `riseStopPct` = the quick trade's stop (0.4 %).
 */
export function priorsFrom(s: StoredTests, riseStopPct: number): Partial<Record<PlaybookId, TestPrior>> {
  const out: Partial<Record<PlaybookId, TestPrior>> = {};
  const day = s.dayTest?.report;
  if (day) {
    const rs = (day.checkTrades ?? [])
      .filter((t) => t.side === 'long' && typeof t.stop === 'number' && Math.abs(t.entry - t.stop) * t.qty > 0)
      .map((t) => t.pnl / (Math.abs(t.entry - t.stop!) * t.qty));
    if (rs.length) out['day-buy'] = { trades: rs.length, avgR: r3(avg(rs)), label: `day-trade past test, unseen days ${day.checkFrom}–${day.checkTo}` };
  }
  const strong = s.riseModel?.report.strong;
  if (strong && strong.n > 0 && riseStopPct > 0) out['rise-strong'] = { trades: strong.n, avgR: r3(strong.avgNetPct / (riseStopPct * 100)), label: `Rising now model, unseen days ${s.riseModel!.report.testFrom}–${s.riseModel!.report.testTo}` };
  const sh = s.shortTest;
  if (sh && sh.newer.trades > 0 && sh.riskRupees > 0) out['short-scan'] = { trades: sh.newer.trades, avgR: r3(sh.newer.pnl / sh.newer.trades / sh.riskRupees), label: 'Falling-now past test, newest days' };
  const bo = s.breakoutTest;
  if (bo && bo.newer.trades > 0) out.breakout = { trades: bo.newer.trades, avgR: r3(bo.newer.avgR), label: 'breakout past test, newest days' };
  const it = s.intradayTest;
  if (it && it.trades > 0 && it.avgR !== null) out['intraday-buy'] = { trades: it.trades, avgR: r3(it.avgR), label: `Intraday past test${it.from && it.to ? `, ${it.from}–${it.to}` : ''}` };
  return out;
}
