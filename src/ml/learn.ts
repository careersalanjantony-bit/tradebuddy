import { simulatePolicy, MIN_CHECK_TRADES, MIN_SESSIONS, passes, type Candidate, type DayTestResult, type TargetKey, type Variant } from '../daytrade/backtest';
import { dayTradePnl } from '../daytrade/rules';
import { FEATURES, N_FEATURES } from './features';
import { auc, fitEnsemble, predictEnsemble, type EnsembleModel } from './models';

/**
 * Self-learning for day-trade signals.
 *
 *  1. Every past signal (5-minute history) becomes an example: what the app saw at that moment
 *     (features) and whether the trade made money after charges (label).
 *  2. Walk-forward check: learn on the OLDER 2/3 of the days only, then trade the NEWEST 1/3 — days
 *     the learning has never seen — taking only signals whose chance is above a bar chosen on the
 *     older days. Compare with the plain rules on the same newest days.
 *  3. The learned chance is used for live signals ONLY if it made money there AND beat the plain
 *     rules. Otherwise the app keeps the plain rules and says so.
 *  4. The model used live is then re-learned on all days. It is learned again every evening, so it
 *     follows the market as new days arrive.
 */

export const ML_VERSION = 'ml-v1';
export const THRESHOLDS = [0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7];
const MIN_TUNE_TRADES = 10;

export interface MlReport {
  version: string;
  trainedAt: number;
  from: string;
  to: string;
  sessions: number;
  samples: number;
  /** share of past signals that made money */
  baseRate: number;
  target: TargetKey;
  trainFrom: string;
  trainTo: string;
  checkFrom: string;
  checkTo: string;
  /** signals are taken when the learned chance is at least this */
  threshold: number;
  /** learned policy on the newest, unseen days */
  ml: DayTestResult;
  /** plain rules on the same days */
  base: DayTestResult;
  /** simply taking every signal in time order, on the same days */
  all: DayTestResult;
  /** how well the chance ranks winners above losers on unseen days (0.5 = coin toss) */
  auc: number | null;
  passed: boolean;
  reason: string;
  /** what pushed the chance up or down (logistic weights on standardised features) */
  importance: Array<{ id: string; weight: number }>;
  /** model learned on all days, for live signals */
  model: EnsembleModel;
  computedMs: number;
}

interface Cfg {
  amount: number;
  slots: number;
  maxLosses: number;
}

function labelled(cands: Candidate[], target: TargetKey, cfg: Cfg): Array<{ c: Candidate; y: number }> {
  const alloc = cfg.amount / cfg.slots;
  const out: Array<{ c: Candidate; y: number }> = [];
  for (const c of cands) {
    if (!c.f || c.f.length !== N_FEATURES) continue;
    const qty = Math.max(1, Math.floor(alloc / c.entry));
    const { pnl } = dayTradePnl(c.side, qty, c.entry, c.outcomes[target].price);
    out.push({ c, y: pnl > 0 ? 1 : 0 });
  }
  return out;
}

const groupByDate = (cands: Candidate[]) => {
  const m = new Map<string, Candidate[]>();
  for (const c of cands) {
    const l = m.get(c.date);
    if (l) l.push(c);
    else m.set(c.date, [c]);
  }
  return m;
};

function policy(byDate: Map<string, Candidate[]>, dates: string[], p: Map<Candidate, number>, thr: number, target: TargetKey, cfg: Cfg) {
  return simulatePolicy(byDate, dates, (c) => (p.get(c) ?? 0) >= thr, target, cfg, (a, b) => (p.get(b) ?? 0) - (p.get(a) ?? 0));
}

/** Picks the chance bar on days the check never uses. */
function tuneThreshold(rows: Array<{ c: Candidate; y: number }>, dates: string[], target: TargetKey, cfg: Cfg): number {
  const cut = Math.floor(dates.length * 0.75);
  const fitDates = new Set(dates.slice(0, cut));
  const tuneDates = dates.slice(cut);
  const fit = rows.filter((r) => fitDates.has(r.c.date));
  const tune = rows.filter((r) => !fitDates.has(r.c.date));
  if (fit.length < 60 || tune.length < 20) return 0.5;
  const m = fitEnsemble(
    fit.map((r) => r.c.f!),
    fit.map((r) => r.y),
  );
  const p = new Map(tune.map((r) => [r.c, predictEnsemble(m, r.c.f!)] as const));
  const byDate = groupByDate(tune.map((r) => r.c));
  let best = { thr: 0.5, pnl: -Infinity };
  for (const thr of THRESHOLDS) {
    const r = policy(byDate, tuneDates, p, thr, target, cfg).result;
    if (r.trades >= MIN_TUNE_TRADES && r.pnl > best.pnl) best = { thr, pnl: r.pnl };
  }
  return best.thr;
}

export function learn(candidates: Candidate[], dates: string[], cfg: Cfg, baseVariant: Variant, now = Date.now()): MlReport | null {
  const t0 = Date.now();
  if (dates.length < MIN_SESSIONS) return null;
  const target = baseVariant.target;
  const rows = labelled(candidates, target, cfg);
  if (rows.length < 150) return null;
  const split = Math.floor((dates.length * 2) / 3);
  const trainDates = dates.slice(0, split);
  const checkDates = dates.slice(split);
  const trainSet = new Set(trainDates);
  const train = rows.filter((r) => trainSet.has(r.c.date));
  const check = rows.filter((r) => !trainSet.has(r.c.date));
  if (train.length < 100 || check.length < 30) return null;

  const threshold = tuneThreshold(train, trainDates, target, cfg);
  const m = fitEnsemble(
    train.map((r) => r.c.f!),
    train.map((r) => r.y),
  );
  const pCheck = new Map(check.map((r) => [r.c, predictEnsemble(m, r.c.f!)] as const));
  const checkByDate = groupByDate(check.map((r) => r.c));
  const ml = policy(checkByDate, checkDates, pCheck, threshold, target, cfg).result;
  const base = simulatePolicy(checkByDate, checkDates, (c) => passes(c, baseVariant), target, cfg, (a, b) => b.rvol - a.rvol).result;
  const all = simulatePolicy(checkByDate, checkDates, () => true, target, cfg, (a, b) => b.rvol - a.rvol).result;
  const score = auc(
    check.map((r) => pCheck.get(r.c)!),
    check.map((r) => r.y),
  );

  let passed = false;
  let reason: string;
  if (ml.trades < MIN_CHECK_TRADES) reason = `Only ${ml.trades} trades on the unseen days — too few to trust the learning yet.`;
  else if (ml.pnl <= 0) reason = 'The learned chance LOST money on the unseen days. Not used — the plain rules stay in charge.';
  else if (ml.pnl <= base.pnl) reason = 'The learned chance made money on the unseen days, but not more than the plain rules. Not used yet.';
  else if (ml.pnl <= all.pnl) reason = 'The learned chance did no better than simply taking every signal — it has not found anything real yet. Not used.';
  else {
    passed = true;
    reason = 'The learned chance made money on days it had never seen, and more than the plain rules. In use for live signals.';
  }

  const final = fitEnsemble(
    rows.map((r) => r.c.f!),
    rows.map((r) => r.y),
  );
  const importance = FEATURES.map((f, i) => ({ id: f.id, weight: final.logistic.w[i] ?? 0 })).sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  return {
    version: ML_VERSION,
    trainedAt: now,
    from: dates[0]!,
    to: dates[dates.length - 1]!,
    sessions: dates.length,
    samples: rows.length,
    baseRate: rows.reduce((a, r) => a + r.y, 0) / rows.length,
    target,
    trainFrom: trainDates[0]!,
    trainTo: trainDates[trainDates.length - 1]!,
    checkFrom: checkDates[0]!,
    checkTo: checkDates[checkDates.length - 1]!,
    threshold,
    ml,
    base,
    all,
    auc: score,
    passed,
    reason,
    importance,
    model: final,
    computedMs: Date.now() - t0,
  };
}

/** Plain-words summary of what pushed the chance up and down. */
export function explainImportance(imp: MlReport['importance'], n = 2): { more: string[]; less: string[] } {
  const label = (id: string, w: number) => {
    const f = FEATURES.find((x) => x.id === id);
    return f ? (w >= 0 ? f.more : f.less) : id;
  };
  const strong = imp.filter((x) => Math.abs(x.weight) >= 0.03);
  return {
    more: strong.slice(0, n * 2).filter((x) => x.weight > 0).slice(0, n).map((x) => label(x.id, x.weight)),
    less: strong.slice(0, n * 2).filter((x) => x.weight < 0).slice(0, n).map((x) => label(x.id, -x.weight)),
  };
}
