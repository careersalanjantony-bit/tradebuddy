import { intradayCharges } from '../daytrade/rules';
import type { Bars } from '../daytrade/types';
import type { PrevDay } from '../ml/features';
import { auc, fitEnsemble, predictEnsemble, type EnsembleModel } from '../ml/models';

/**
 * App v1.14 — "Rising now", learned (owner: "we made money only from Rising today: buy a strongly
 * rising stock, hold 10–20 minutes, sell. Find them earlier, and tag whether it will keep rising so we
 * know whether to keep it").
 *
 * The question the model answers, for any stock at any moment: "bought at this price now, does it gain
 * PLAN.target (0.6 %) before it loses PLAN.stop (0.4 %), within PLAN.bars × 5 minutes (20 minutes)?"
 * — exactly the quick trade the owner makes, and the same question for a stock already held ("keep or
 * take the profit?").
 *
 * It learns from the stored 5-minute history of every scanned stock: 17 numbers per moment (how fast it
 * moves, volume against its usual volume at that time of day, price vs the day's average price, place in
 * the day's range, candle shape, RSI, trend of the last hour, the whole market…). The newest 30 % of the
 * days are kept aside: the model never sees them while learning, and every number shown on screen
 * (how often "likely to keep rising" was right, the old Rising-today list on the same days) comes from
 * those unseen days. No chance is ever 100 %: the tag says how often similar moments worked out before.
 *
 * Pure functions only — the background job feeds them, the screen shows the result.
 */

export const RISE_VERSION = 'rise-v1';
/** the quick trade: +0.6 % target, −0.4 % stop, at most 20 minutes (4 five-minute candles) */
export const PLAN = { target: 0.006, stop: 0.004, bars: 4 } as const;
export const RISE_FIRST_T = 9 * 60 + 25;
/** no new quick trade after 2:45 pm (it must be closed by 3:10) */
export const RISE_LAST_T = 14 * 60 + 45;
const EXIT_T = 15 * 60 + 10;
const OPEN_T = 9 * 60 + 15;

export const RISE_FEATURES = [
  'last 5 minutes',
  'last 15 minutes',
  'last 30 minutes',
  'since the open',
  'today',
  'vs day average price',
  'day average price rising',
  'volume now vs usual',
  'volume today vs usual',
  'place in the day range',
  'below the day high',
  'candle strength',
  'green candles',
  'RSI',
  'short vs longer trend',
  'time of day',
  'whole market',
] as const;

/** Running values along a day's 5-minute candles. */
export interface Running {
  vwap: number[];
  cumV: number[];
  hi: number[];
  lo: number[];
  ema9: number[];
  ema21: number[];
  rsi: Array<number | null>;
}

export function running(b: Bars): Running {
  const n = b.t.length;
  const out: Running = { vwap: [], cumV: [], hi: [], lo: [], ema9: [], ema21: [], rsi: [] };
  let pv = 0;
  let vv = 0;
  let hi = -Infinity;
  let lo = Infinity;
  let e9 = 0;
  let e21 = 0;
  let gain = 0;
  let loss = 0;
  for (let i = 0; i < n; i++) {
    const c = b.c[i]!;
    const v = b.v[i]!;
    pv += ((b.h[i]! + b.l[i]! + c) / 3) * v;
    vv += v;
    hi = Math.max(hi, b.h[i]!);
    lo = Math.min(lo, b.l[i]!);
    e9 = i === 0 ? c : e9 + (2 / 10) * (c - e9);
    e21 = i === 0 ? c : e21 + (2 / 22) * (c - e21);
    if (i > 0) {
      const d = c - b.c[i - 1]!;
      // Wilder's smoothing over 14 candles (a plain average for the first 14)
      const k = Math.min(i, 14);
      gain = (gain * (k - 1) + Math.max(0, d)) / k;
      loss = (loss * (k - 1) + Math.max(0, -d)) / k;
    }
    out.vwap.push(vv > 0 ? pv / vv : c);
    out.cumV.push(vv);
    out.hi.push(hi);
    out.lo.push(lo);
    out.ema9.push(e9);
    out.ema21.push(e21);
    out.rsi.push(i >= 3 ? (loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss)) : null);
  }
  return out;
}

/** What the features need besides today's candles. */
export interface RiseCtx {
  /** yesterday's close (null = unknown) */
  prevClose: number | null;
  /** usual volume of the 5-minute candle starting at `t`, and usual volume of the day up to the end of it */
  usual: (t: number) => { bar: number | null; cum: number | null };
  /** the whole market's average move since the open at `t`, in % (null = unknown) */
  market: (t: number) => number | null;
}

/** Usual volumes by time of day from earlier days (up to 10). */
export function usualFrom(prev: PrevDay[]): RiseCtx['usual'] {
  const days = prev.slice(-10);
  const cache = new Map<number, { bar: number | null; cum: number | null }>();
  return (t: number) => {
    const hit = cache.get(t);
    if (hit) return hit;
    const bars: number[] = [];
    const cums: number[] = [];
    for (const d of days) {
      const i = d.t.indexOf(t);
      if (i < 0) continue;
      bars.push(d.cumV[i]! - (i > 0 ? d.cumV[i - 1]! : 0));
      cums.push(d.cumV[i]!);
    }
    const avg = (a: number[]) => (a.length >= 3 ? a.reduce((s, x) => s + x, 0) / a.length : null);
    const r = { bar: avg(bars), cum: avg(cums) };
    cache.set(t, r);
    return r;
  };
}

const clamp = (x: number, lim: number) => (Number.isFinite(x) ? Math.max(-lim, Math.min(lim, x)) : 0);
const pct = (a: number, b: number) => (b > 0 ? (a / b - 1) * 100 : 0);
const log2r = (a: number, b: number | null) => (b && b > 0 ? clamp(Math.log2((a + 1) / (b + 1)), 4) : 0);

/** The 17 numbers for candle `i` (its close is "now"). Null before the 9:25 candle. */
export function riseFeatures(b: Bars, i: number, run: Running, ctx: RiseCtx): number[] | null {
  if (i < 2 || !(b.c[i]! > 0)) return null;
  const c = b.c[i]!;
  const t = b.t[i]!;
  const u = ctx.usual(t);
  const range = run.hi[i]! - run.lo[i]!;
  let green = 0;
  for (let k = Math.max(0, i - 2); k <= i; k++) if (b.c[k]! > b.o[k]!) green++;
  const hl = b.h[i]! - b.l[i]!;
  return [
    clamp(pct(c, b.c[i - 1]!), 5),
    clamp(pct(c, b.c[Math.max(0, i - 3)]!), 8),
    clamp(pct(c, b.c[Math.max(0, i - 6)]!), 10),
    clamp(pct(c, b.o[0]!), 15),
    clamp(ctx.prevClose ? pct(c, ctx.prevClose) : pct(c, b.o[0]!), 20),
    clamp(pct(c, run.vwap[i]!), 8),
    clamp(pct(run.vwap[i]!, run.vwap[Math.max(0, i - 3)]!), 4),
    log2r(b.v[i]!, u.bar),
    log2r(run.cumV[i]!, u.cum),
    range > 0 ? (c - run.lo[i]!) / range : 0.5,
    clamp(pct(c, run.hi[i]!), 10),
    hl > 0 ? clamp((c - b.o[i]!) / hl, 1) : 0,
    green,
    (run.rsi[i] ?? 50) / 100,
    clamp(pct(run.ema9[i]!, run.ema21[i]!), 5),
    (t + 5 - OPEN_T) / 375,
    clamp(ctx.market(t) ?? 0, 5),
  ];
}

/** Index of each feature by name (for rules and plain-words reasons). */
const F = Object.fromEntries(RISE_FEATURES.map((n, i) => [n, i])) as Record<(typeof RISE_FEATURES)[number], number>;

/** A rising moment worth asking about: above the day's average price and moving up (or up since the open). */
export const isRisingMoment = (x: number[]): boolean => x[F['vs day average price']]! > 0 && (x[F['last 15 minutes']]! > 0.15 || x[F['since the open']]! > 0.3) && x[F['last 5 minutes']]! > -0.2;

/** The old "Rising today" list's rule (app v1.0, without the order book, which history does not have). */
export const isOldRising = (x: number[]): boolean => x[F['since the open']]! >= 0.5 && x[F['vs day average price']]! > 0 && x[F['volume today vs usual']]! >= Math.log2(1.2);

/** The quick trade from the close of candle `i`: +0.6 % first = win. Inside a candle the stop counts first. */
export function riseOutcome(b: Bars, i: number): { win: boolean; ret: number } | null {
  const entry = b.c[i]!;
  if (!(entry > 0) || i + 1 >= b.t.length) return null;
  const tgt = entry * (1 + PLAN.target);
  const stp = entry * (1 - PLAN.stop);
  const last = Math.min(b.t.length - 1, i + PLAN.bars);
  for (let j = i + 1; j <= last; j++) {
    if (b.t[j]! >= EXIT_T) return { win: false, ret: b.o[j]! / entry - 1 };
    if (b.o[j]! <= stp) return { win: false, ret: b.o[j]! / entry - 1 };
    if (b.l[j]! <= stp) return { win: false, ret: -PLAN.stop };
    if (b.o[j]! >= tgt) return { win: true, ret: b.o[j]! / entry - 1 };
    if (b.h[j]! >= tgt) return { win: true, ret: PLAN.target };
  }
  if (last === i) return null;
  const ret = b.c[last]! / entry - 1;
  return { win: false, ret };
}

/** Result after Upstox Intraday charges for a ₹1 lakh trade, as a fraction. */
export const netOf = (ret: number): number => ret - intradayCharges(100_000, 100_000 * (1 + ret)) / 100_000;

export interface RiseSample {
  x: number[];
  y: 0 | 1;
  /** result of the quick trade after charges (fraction) */
  net: number;
  date: string;
  /** would have been in the old Rising-today list */
  old: boolean;
  /** since the open, % (for "early" = not up much yet) */
  fromOpen: number;
}

/** Every rising moment of one stock-day (and every old-list moment), with its outcome. */
export function samplesOfDay(date: string, b: Bars, ctx: RiseCtx, keep: (i: number) => boolean = () => true): RiseSample[] {
  const run = running(b);
  const out: RiseSample[] = [];
  for (let i = 2; i < b.t.length; i++) {
    const t = b.t[i]!;
    if (t < RISE_FIRST_T || t > RISE_LAST_T - 5) continue;
    const x = riseFeatures(b, i, run, ctx);
    if (!x) continue;
    const rising = isRisingMoment(x);
    const old = isOldRising(x);
    if ((!rising && !old) || !keep(i)) continue;
    const o = riseOutcome(b, i);
    if (!o) continue;
    out.push({ x, y: o.win ? 1 : 0, net: netOf(o.ret), date, old, fromOpen: x[F['since the open']]! });
  }
  return out;
}

// ---------------------------------------------------------------- learning and the honest test

export interface RiseGroup {
  n: number;
  /** share that gained +0.6 % first */
  win: number;
  /** average result after charges, % per trade */
  avgNetPct: number;
}

export interface RiseReport {
  version: string;
  at: number;
  /** days learned from / days kept aside for the test */
  trainDays: number;
  testDays: number;
  testFrom: string;
  testTo: string;
  samples: number;
  /** on the unseen days: all rising moments, and how well the chance ranks them (0.5 = coin, 1 = perfect) */
  base: RiseGroup;
  auc: number | null;
  /** chance bands (on the unseen days): how often each band really worked */
  bands: Array<{ lo: number; hi: number } & RiseGroup>;
  /** chance from which a stock is tagged "likely to keep rising" (null = no band was clearly better) */
  strongFrom: number | null;
  /** chance up to which it is tagged "slowing — take the profit" */
  fadeTo: number;
  /** the same unseen days: the old Rising-today list, "likely", and "likely" while still early (< 1 % since the open) */
  old: RiseGroup;
  strong: RiseGroup | null;
  early: RiseGroup | null;
  /** what matters most, by how much the chance moves when it changes (top first) */
  importance: Array<{ name: string; weight: number }>;
}

export interface RiseModel {
  version: string;
  model: EnsembleModel;
  report: RiseReport;
}

const group = (rows: RiseSample[]): RiseGroup => ({
  n: rows.length,
  win: rows.length ? rows.reduce((s, r) => s + r.y, 0) / rows.length : 0,
  avgNetPct: rows.length ? (rows.reduce((s, r) => s + r.net, 0) / rows.length) * 100 : 0,
});

/** Spreads `rows` evenly over the days, at most `max` (the phone learns from a sample, not everything). */
export function thin<T>(rows: T[], max: number): T[] {
  if (rows.length <= max) return rows;
  const step = rows.length / max;
  const out: T[] = [];
  for (let k = 0; k < max; k++) out.push(rows[Math.floor(k * step)]!);
  return out;
}

/**
 * Learns on the older 70 % of the days and measures on the newest 30 % it never saw. Null when there
 * is too little history (fewer than 10 days, or fewer than 2,000 moments).
 */
export function trainRise(samples: RiseSample[], now: number, opts: { maxTrain?: number } = {}): RiseModel | null {
  const dates = [...new Set(samples.map((s) => s.date))].sort();
  if (dates.length < 10 || samples.length < 2_000) return null;
  const cut = dates[Math.floor(dates.length * 0.7)]!;
  const trainRows = thin(samples.filter((s) => s.date < cut && isRisingMoment(s.x)), opts.maxTrain ?? 40_000);
  const testAll = samples.filter((s) => s.date >= cut);
  const test = testAll.filter((s) => isRisingMoment(s.x));
  if (trainRows.length < 1_000 || test.length < 300) return null;
  const model = fitEnsemble(
    trainRows.map((r) => r.x),
    trainRows.map((r) => r.y),
  );
  const p = test.map((r) => predictEnsemble(model, r.x));
  const base = group(test);
  // chance bands of equal size (fifths), lowest first
  const order = p.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const bands: RiseReport['bands'] = [];
  for (let k = 0; k < 5; k++) {
    const part = order.slice(Math.floor((k * order.length) / 5), Math.floor(((k + 1) * order.length) / 5));
    if (!part.length) continue;
    bands.push({ lo: part[0]![0], hi: part[part.length - 1]![0], ...group(part.map(([, i]) => test[i]!)) });
  }
  // "likely to keep rising": the highest chances, only if they clearly beat the average and make money after charges
  let strongFrom: number | null = null;
  for (const cutAt of [0.9, 0.8, 0.7]) {
    const from = order[Math.floor(order.length * cutAt)]?.[0];
    if (from === undefined) continue;
    const g = group(test.filter((_, i) => p[i]! >= from));
    if (g.n >= 40 && g.win >= base.win + 0.08 && g.avgNetPct > 0) {
      strongFrom = from;
      break;
    }
  }
  // "slowing": only the lowest band, and only when it really did worse than the average
  const fadeTo = bands[0] && bands[0].win <= base.win - 0.05 ? bands[0].hi : -1;
  const strongRows = strongFrom === null ? [] : test.filter((_, i) => p[i]! >= strongFrom!);
  const old = testAll.filter((s) => s.old);
  // importance: how far the chance moves when one number goes from low to high (on a sample of test rows)
  const probe = thin(test, 300);
  const importance = RISE_FEATURES.map((name, j) => {
    const vals = probe.map((r) => r.x[j]!).sort((a, b) => a - b);
    const lo = vals[Math.floor(vals.length * 0.2)] ?? 0;
    const hi = vals[Math.floor(vals.length * 0.8)] ?? 0;
    let d = 0;
    for (const r of probe) {
      const a = [...r.x];
      const z = [...r.x];
      a[j] = lo;
      z[j] = hi;
      d += predictEnsemble(model, z) - predictEnsemble(model, a);
    }
    return { name, weight: d / Math.max(1, probe.length) };
  }).sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  const report: RiseReport = {
    version: RISE_VERSION,
    at: now,
    trainDays: dates.filter((d) => d < cut).length,
    testDays: dates.filter((d) => d >= cut).length,
    testFrom: cut,
    testTo: dates[dates.length - 1]!,
    samples: samples.length,
    base,
    auc: auc(p, test.map((r) => r.y)),
    bands,
    strongFrom,
    fadeTo,
    old: group(old),
    strong: strongRows.length ? group(strongRows) : null,
    early: strongRows.length ? group(strongRows.filter((r) => r.fromOpen < 1)) : null,
    importance: importance.slice(0, 6),
  };
  return { version: RISE_VERSION, model, report };
}

// ---------------------------------------------------------------- live: the tag

export type RiseTag = 'strong' | 'unclear' | 'fading';

export interface RiseRead {
  tag: RiseTag;
  /** the model's chance (0–1), null without a model or outside a rising moment */
  chance: number | null;
  /** how often similar moments gained +0.6 % first on the unseen days (the band's real rate) */
  measured: number | null;
  /** plain words: why */
  reasons: string[];
}

/** How often moments with this chance really worked (on the unseen test days). */
export function measuredFor(report: RiseReport, p: number): number | null {
  const b = report.bands.find((x) => p >= x.lo && p <= x.hi) ?? (p > (report.bands[report.bands.length - 1]?.hi ?? 1) ? report.bands[report.bands.length - 1] : report.bands[0]);
  return b ? b.win : null;
}

/** Plain-words reasons from the numbers (the strongest few). */
export function reasonsOf(x: number[]): string[] {
  const r: string[] = [];
  const v = (n: (typeof RISE_FEATURES)[number]) => x[F[n]]!;
  if (v('volume now vs usual') >= 1) r.push(`${(2 ** v('volume now vs usual')).toFixed(1)}× its usual volume in the last 5 minutes`);
  if (v('last 15 minutes') > 0.3) r.push(`+${v('last 15 minutes').toFixed(1)}% in the last 15 minutes`);
  if (v('below the day high') > -0.15) r.push('at the high of the day');
  if (v('vs day average price') > 0) r.push(`${v('vs day average price').toFixed(1)}% above the day's average price`);
  if (v('green candles') === 3) r.push('three green 5-minute candles in a row');
  if (v('whole market') > 0.3) r.push('the whole market is rising');
  if (v('whole market') < -0.3) r.push('against a falling market');
  if (v('since the open') > 3) r.push(`already +${v('since the open').toFixed(1)}% since the open — late, it can fall back`);
  if (v('RSI') > 0.8) r.push('RSI very high — overheated');
  return r.slice(0, 4);
}

/**
 * The tag for a stock now: "likely to keep rising", "unclear" or "slowing — take the profit". Outside a
 * rising moment (below the day's average price, or falling for 15 minutes) it is "slowing". Without a
 * model (no history yet) a rising moment is "unclear".
 */
export function readRise(x: number[] | null, m: RiseModel | null): RiseRead {
  if (!x) return { tag: 'unclear', chance: null, measured: null, reasons: [] };
  const reasons = reasonsOf(x);
  if (!isRisingMoment(x)) {
    const below = x[F['vs day average price']]! <= 0;
    return { tag: 'fading', chance: null, measured: null, reasons: [below ? "below the day's average price" : 'falling in the last 15 minutes', ...reasons].slice(0, 4) };
  }
  if (!m) return { tag: 'unclear', chance: null, measured: null, reasons };
  const p = predictEnsemble(m.model, x);
  const measured = measuredFor(m.report, p);
  const tag: RiseTag = m.report.strongFrom !== null && p >= m.report.strongFrom ? 'strong' : p <= m.report.fadeTo ? 'fading' : 'unclear';
  return { tag, chance: p, measured, reasons };
}

/** Plan for the quick trade from `price`: take profit, stop, sell-by time (5-paise ticks). */
export function quickPlan(price: number, now: number): { entry: number; target: number; stop: number; sellBy: number } {
  const up = (v: number) => Math.ceil(v * 20 - 1e-9) / 20;
  const down = (v: number) => Math.floor(v * 20 + 1e-9) / 20;
  return { entry: price, target: up(price * (1 + PLAN.target)), stop: down(price * (1 - PLAN.stop)), sellBy: now + PLAN.bars * 5 * 60_000 };
}

/**
 * For a stock you hold: keep it (and where to protect the profit) or take the profit. The protect price
 * follows the price: 0.4 % under it when "likely", 0.25 % when "unclear", never below what you paid once
 * you are 0.4 % up.
 */
export function holdAdvice(read: RiseRead, price: number, buyPrice: number | null): { action: 'keep' | 'protect' | 'sell'; protectAt: number | null; text: string } {
  const down = (v: number) => Math.floor(v * 20 + 1e-9) / 20;
  const up = buyPrice ? (price / buyPrice - 1) * 100 : null;
  if (read.tag === 'fading') return { action: 'sell', protectAt: null, text: up !== null && up > 0 ? `Slowing — take the profit (+${up.toFixed(1)}%)` : 'Slowing — think about selling' };
  let protectAt = down(price * (1 - (read.tag === 'strong' ? PLAN.stop : 0.0025)));
  if (buyPrice && up !== null && up >= 0.4) protectAt = Math.max(protectAt, down(buyPrice * 1.001));
  return read.tag === 'strong'
    ? { action: 'keep', protectAt, text: `Likely to keep rising — keep, sell if it drops to ₹${protectAt.toFixed(2)}` }
    : { action: 'protect', protectAt, text: `Unclear — keep a tight stop at ₹${protectAt.toFixed(2)}` };
}
