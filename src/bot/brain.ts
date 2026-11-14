/**
 * The auto-trader's brain (app v1.6): a small model that learns from the auto-trader's own trades.
 *
 * Every trade idea arrives with a "prior" chance from the app's existing studies (the self-learning
 * day-trade model, the top picks' past record, the sell-first past test…). The brain starts out
 * agreeing with those studies (its weights are set so its answer equals the prior), then after each
 * finished trade it nudges its weights toward what actually happened (online logistic regression,
 * one gradient step per trade, pulled gently back toward the starting point so a few lucky or
 * unlucky trades do not swing it wildly). It also keeps a simple scorecard per kind of trade.
 *
 * Pure functions only — no storage, no network.
 */

export type Strategy = 'day-buy' | 'rising' | 'swing' | 'short' | 'breakout';
export const STRATEGIES: Strategy[] = ['day-buy', 'rising', 'swing', 'short', 'breakout'];
export const STRATEGY_LABEL: Record<Strategy, string> = {
  'day-buy': 'Day-trade buy ideas',
  rising: 'Rising today',
  swing: 'Top picks (hold a few days)',
  short: 'Sell first (falling stocks)',
  breakout: 'Breakout today (buy first)',
};

/** What the brain looks at for each idea, all in the trade's own direction (for a sell-first trade, "up" means "down"). */
export interface IdeaContext {
  strategy: Strategy;
  /** 0–1 chance from the app's studies */
  prior: number;
  /** today's move in % in the trade's direction */
  movePct: number;
  /** buyers vs sellers in the trade's direction, −1…1 (0 = unknown) */
  pressure: number;
  /** market breadth in the trade's direction, −1…1 (0 = unknown) */
  breadth: number;
  /** minutes since midnight IST */
  t: number;
  /** today's news mood in the trade's direction: −1, 0, 1 */
  news: number;
  /** distance from the day's average price (VWAP) in % in the trade's direction (0 = unknown) */
  vwapPct: number;
  /** stop distance in % of the price */
  riskPct: number;
}

/** the order matters (saved weights follow it): new features are only ever added at the end */
export const FEATURES = ['base', 'day-buy', 'rising', 'swing', 'short', 'studies', 'move', 'pressure', 'breadth', 'time', 'news', 'vwap', 'risk', 'breakout'] as const;

/** Plain words for each feature, for "what it learned". [when the weight grows, when it shrinks] */
export const FEATURE_WORDS: Record<(typeof FEATURES)[number], [string, string]> = {
  base: ['trades in general work out more often', 'trades in general work out less often'],
  'day-buy': ['day-trade buy ideas work well', 'day-trade buy ideas disappoint'],
  rising: ['"Rising today" stocks keep rising', '"Rising today" stocks often fall back'],
  swing: ['top picks held for days work well', 'top picks held for days disappoint'],
  short: ['selling falling stocks first works well', 'falling stocks often bounce back up'],
  studies: ['the app\'s studies are reliable', 'the app\'s studies are too hopeful'],
  move: ['a big move already today helps', 'a big move already today means it is late'],
  pressure: ['strong buyers (or sellers for sell-first) help', 'strong buying pressure does not help'],
  breadth: ['going with the whole market helps', 'the whole market\'s direction matters less'],
  time: ['later in the day works better', 'earlier in the day works better'],
  news: ['good news (bad news for sell-first) helps', 'news makes little difference'],
  vwap: ['being well above the day\'s average price helps', 'buying far above the day\'s average price is risky'],
  risk: ['wider safety nets work better', 'tighter safety nets work better'],
  breakout: ['breakouts above resistance keep going', 'breakouts often fail and fall back'],
};

const clip = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export function features(c: IdeaContext): number[] {
  return [
    1,
    c.strategy === 'day-buy' ? 1 : 0,
    c.strategy === 'rising' ? 1 : 0,
    c.strategy === 'swing' ? 1 : 0,
    c.strategy === 'short' ? 1 : 0,
    clip((c.prior - 0.5) * 4, -2, 2),
    clip(c.movePct / 2, -2, 2),
    clip(c.pressure, -1, 1),
    clip(c.breadth, -1, 1),
    clip((c.t - 720) / 180, -1.5, 1.5),
    clip(c.news, -1, 1),
    clip(c.vwapPct, -2, 2),
    clip(c.riskPct - 1, -1, 2),
    c.strategy === 'breakout' ? 1 : 0,
  ];
}

export interface StrategyStats {
  n: number;
  wins: number;
  pnl: number;
  /** sum of results in R (1 R = the planned loss) */
  r: number;
}

export interface Brain {
  v: 1;
  w: number[];
  /** the starting weights (= trust the studies); learning is pulled gently back toward them */
  w0: number[];
  n: number;
  wins: number;
  by: Record<Strategy, StrategyStats>;
  /** win rate after each trade, for the learning chart (last 200) */
  curve: number[];
}

/** Weight 1 on "studies" makes the starting answer ≈ the prior: sigmoid(4(p−0.5)) ≈ p for p in 0.3–0.7. */
export function newBrain(): Brain {
  const w0 = FEATURES.map((f) => (f === 'studies' ? 1 : 0));
  const by = Object.fromEntries(STRATEGIES.map((s) => [s, { n: 0, wins: 0, pnl: 0, r: 0 }])) as Record<Strategy, StrategyStats>;
  return { v: 1, w: [...w0], w0, n: 0, wins: 0, by, curve: [] };
}

/**
 * A brain saved by an older version (fewer features or kinds of trade): new weights start at 0 —
 * the studies decide for the new kind until it has its own results. Nothing learned is lost.
 */
export function upgradeBrain(b: Brain): Brain {
  const fresh = newBrain();
  if (b.w.length === FEATURES.length && STRATEGIES.every((k) => b.by[k])) return b;
  const pad = (w: number[], base: number[]) => [...w, ...base.slice(w.length)];
  return { ...b, w: pad(b.w, fresh.w0), w0: pad(b.w0, fresh.w0), by: { ...fresh.by, ...b.by } };
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0);

/** The brain's chance (0–1) that this idea ends with a profit after charges. */
export function predict(b: Brain, x: number[]): number {
  return clip(sigmoid(dot(b.w, x)), 0.02, 0.98);
}

export const LEARN_RATE = 0.15;
export const PULL_BACK = 0.02;

export interface Lesson {
  brain: Brain;
  /** the feature whose weight moved most, in plain words, or null */
  text: string | null;
  /** chance before vs after this lesson for the same idea */
  before: number;
  after: number;
}

/**
 * One finished trade → one learning step. `won` = profit after charges; `r` = result in R
 * (bigger surprises teach a bit more, capped at 2×).
 */
export function learnFrom(b: Brain, x: number[], won: boolean, r: number, pnl: number, strategy: Strategy): Lesson {
  const before = predict(b, x);
  const y = won ? 1 : 0;
  const weight = clip(Math.abs(r), 0.5, 2);
  const w = b.w.map((wi, i) => wi + LEARN_RATE * (weight * (y - before) * (x[i] ?? 0) - PULL_BACK * (wi - (b.w0[i] ?? 0))));
  const s = b.by[strategy] ?? { n: 0, wins: 0, pnl: 0, r: 0 };
  const by = { ...b.by, [strategy]: { n: s.n + 1, wins: s.wins + y, pnl: Math.round((s.pnl + pnl) * 100) / 100, r: Math.round((s.r + r) * 100) / 100 } };
  const n = b.n + 1;
  const wins = b.wins + y;
  const next: Brain = { ...b, w, n, wins, by, curve: [...b.curve, wins / n].slice(-200) };
  // the biggest change that this trade's own features caused
  let best = -1;
  let size = 0;
  w.forEach((wi, i) => {
    const d = Math.abs(wi - (b.w[i] ?? 0));
    if (i > 0 && d > size) {
      size = d;
      best = i;
    }
  });
  const f = best > 0 ? FEATURES[best]! : null;
  const grew = best > 0 && w[best]! > b.w[best]!;
  return { brain: next, text: f && size > 0.002 ? `Learned: ${FEATURE_WORDS[f][grew ? 0 : 1]}.` : null, before, after: predict(next, x) };
}

/** The 3 strongest lessons so far (how far each weight moved from where it started), in plain words. */
export function topLessons(b: Brain, n = 3): Array<{ text: string; up: boolean; size: number }> {
  return FEATURES.map((f, i) => ({ f, d: (b.w[i] ?? 0) - (b.w0[i] ?? 0) }))
    .filter((x) => x.f !== 'base' && Math.abs(x.d) > 0.01)
    .sort((a, b2) => Math.abs(b2.d) - Math.abs(a.d))
    .slice(0, n)
    .map((x) => ({ text: FEATURE_WORDS[x.f][x.d > 0 ? 0 : 1], up: x.d > 0, size: Math.abs(x.d) }));
}

/** How much the brain trusts each kind of trade now: 'more', 'less', 'paused' or 'learning' (too few trades). */
export function strategyFocus(s: StrategyStats): 'more' | 'less' | 'paused' | 'learning' {
  if (s.n < 5) return 'learning';
  const winRate = s.wins / s.n;
  if (s.n >= 10 && winRate < 0.35 && s.r < 0) return 'paused';
  if (s.r > 0) return 'more';
  return 'less';
}
