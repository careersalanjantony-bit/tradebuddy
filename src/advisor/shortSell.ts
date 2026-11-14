import type { Candle } from '../indicators/types';

/**
 * "For short selling" (app v1.6): stocks that look most likely to fall today, from their price
 * history (trend), today's opening and live price, and today's news — with an honest, measured chance.
 *
 * Score (0–100) from what is known at today's open:
 *   below its 20-day average +15 · 20-day average below the 50-day average +15 · down over 20 days
 *   +5/+10 · lower highs over two weeks +10 · RSI 35–55 (room to fall) +10, RSI < 30 −10 (bounce
 *   risk) · heavy selling yesterday +10 · opened below yesterday's close +10, opened >0.5 % higher −10.
 *
 * The chance is measured, not guessed: the same score is computed for every past day of every stock
 * in the list (about a year), and the chance shown is how often those days ended at least 0.3 %
 * below their opening price (enough for a sell-first trade to make money after charges).
 * Live price, news and the market's mood are shown as extra reasons; they are not in the measured
 * chance because there is no record of them for past days.
 */

export const FALL_LABEL_PCT = 0.3;
const HISTORY_DAYS = 260;

export function emaSeries(v: number[], n: number): Array<number | null> {
  const out: Array<number | null> = [];
  const k = 2 / (n + 1);
  let e: number | null = null;
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    if (i < n) {
      sum += v[i]!;
      if (i === n - 1) e = sum / n;
    } else e = v[i]! * k + e! * (1 - k);
    out.push(i >= n - 1 ? e : null);
  }
  return out;
}

/** Wilder's RSI for every day. */
export function rsiSeries(c: number[], n = 14): Array<number | null> {
  const out: Array<number | null> = c.map(() => null);
  if (c.length <= n) return out;
  let g = 0;
  let l = 0;
  for (let i = 1; i <= n; i++) {
    const d = c[i]! - c[i - 1]!;
    if (d > 0) g += d;
    else l -= d;
  }
  g /= n;
  l /= n;
  out[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = n + 1; i < c.length; i++) {
    const d = c[i]! - c[i - 1]!;
    g = (g * (n - 1) + Math.max(0, d)) / n;
    l = (l * (n - 1) + Math.max(0, -d)) / n;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

export interface Indicators {
  ema20: Array<number | null>;
  ema50: Array<number | null>;
  rsi14: Array<number | null>;
  vol20: Array<number | null>;
}

export function indicatorsOf(c: Candle[]): Indicators {
  const closes = c.map((x) => x.close);
  const vol20: Array<number | null> = [];
  let s = 0;
  for (let i = 0; i < c.length; i++) {
    s += c[i]!.volume;
    if (i >= 20) s -= c[i - 20]!.volume;
    vol20.push(i >= 19 ? s / 20 : null);
  }
  return { ema20: emaSeries(closes, 20), ema50: emaSeries(closes, 50), rsi14: rsiSeries(closes), vol20 };
}

export interface ShortSetup {
  /** with today's opening gap */
  score: number;
  /** without it (for the next session, before it opens) */
  base: number;
  reasons: string[];
  /** reasons that count against */
  against: string[];
}

/** The setup for day i, from the days before it and (if `withOpen`) day i's opening price. */
export function shortSetupAt(c: Candle[], i: number, ind: Indicators, withOpen = true): ShortSetup | null {
  const p = i - 1;
  if (p < 50) return null;
  const close = c[p]!.close;
  const e20 = ind.ema20[p];
  const e50 = ind.ema50[p];
  const r = ind.rsi14[p];
  const v20 = ind.vol20[p - 1] ?? ind.vol20[p];
  if (e20 == null || e50 == null || r == null) return null;
  let base = 0;
  const reasons: string[] = [];
  const against: string[] = [];
  if (close < e20) {
    base += 15;
    reasons.push('below its 20-day average price');
  }
  if (e20 < e50) {
    base += 15;
    reasons.push('in a downtrend (20-day average below the 50-day)');
  }
  const ret20 = close / c[p - 20]!.close - 1;
  if (ret20 < -0.03) {
    base += 10;
    reasons.push(`down ${Math.abs(ret20 * 100).toFixed(1)}% in 4 weeks`);
  } else if (ret20 < 0) base += 5;
  const hiRecent = Math.max(...c.slice(p - 4, p + 1).map((x) => x.high));
  const hiBefore = Math.max(...c.slice(p - 9, p - 4).map((x) => x.high));
  if (hiRecent < hiBefore) {
    base += 10;
    reasons.push('lower highs over the last two weeks');
  }
  if (r >= 35 && r <= 55) {
    base += 10;
    reasons.push(`room to fall further (RSI ${Math.round(r)})`);
  } else if (r < 30) {
    base -= 10;
    against.push(`already fallen a lot (RSI ${Math.round(r)}) — often bounces`);
  }
  if (c[p]!.close < c[p]!.open && v20 && c[p]!.volume > 1.3 * v20) {
    base += 10;
    reasons.push('heavy selling in the last session');
  }
  let score = base;
  if (withOpen && i < c.length) {
    const open = c[i]!.open;
    if (open < close * 0.998) {
      score += 10;
      reasons.push(`opened ${((1 - open / close) * 100).toFixed(1)}% below the last close`);
    } else if (open > close * 1.005) {
      score -= 10;
      against.push('opened higher than the last close');
    }
  }
  return { score: Math.max(0, Math.min(100, score)), base: Math.max(0, Math.min(100, base)), reasons, against };
}

export interface Pair {
  score: number;
  base: number;
  /** ended ≥ 0.3 % below the open */
  fell: boolean;
  /** open → close in % (negative = fell) */
  movePct: number;
}

/** Every finished past day of one stock (last ~year): its setup and what happened from open to close. */
export function historyPairs(c: Candle[], ind: Indicators = indicatorsOf(c)): Pair[] {
  const out: Pair[] = [];
  const last = c.length - 1 - (c[c.length - 1]?.partial ? 1 : 0);
  for (let i = Math.max(51, last - HISTORY_DAYS + 1); i <= last; i++) {
    const s = shortSetupAt(c, i, ind);
    const d = c[i]!;
    if (!s || !(d.open > 0) || d.special) continue;
    const movePct = (d.close / d.open - 1) * 100;
    out.push({ score: s.score, base: s.base, fell: movePct <= -FALL_LABEL_PCT, movePct });
  }
  return out;
}

export interface Bin {
  lo: number;
  hi: number;
  n: number;
  fell: number;
  avgMove: number;
}

export interface Calibration {
  bins: Bin[];
  total: number;
  /** share of all past days that fell ≥ 0.3 % from the open (the "any stock, any day" chance) */
  baseRate: number;
}

const EDGES = [0, 30, 40, 50, 60, 70, 101];

export function calibrate(pairs: Pair[], which: 'score' | 'base' = 'score'): Calibration {
  const bins: Bin[] = EDGES.slice(0, -1).map((lo, i) => ({ lo, hi: EDGES[i + 1]! - 1, n: 0, fell: 0, avgMove: 0 }));
  let fellAll = 0;
  for (const p of pairs) {
    const v = which === 'score' ? p.score : p.base;
    const b = bins.find((x) => v >= x.lo && v <= x.hi);
    if (!b) continue;
    b.n++;
    if (p.fell) b.fell++;
    b.avgMove += p.movePct;
    if (p.fell) fellAll++;
  }
  for (const b of bins) b.avgMove = b.n ? Math.round((b.avgMove / b.n) * 100) / 100 : 0;
  return { bins, total: pairs.length, baseRate: pairs.length ? fellAll / pairs.length : 0 };
}

/** Measured chance for a score: the share of similar past days that fell, if there were at least 30. */
export function chanceFor(cal: Calibration, score: number): { chance: number; n: number; fell: number; avgMove: number } | null {
  const b = cal.bins.find((x) => score >= x.lo && score <= x.hi);
  if (!b || b.n < 30) return null;
  return { chance: b.fell / b.n, n: b.n, fell: b.fell, avgMove: b.avgMove };
}

export interface ShortSellInput {
  key: string;
  symbol: string;
  candles: Candle[];
  /** live price (null when unknown) */
  ltp: number | null;
  /** today's news mood for this stock: −1 bad, 0 none/mixed, 1 good */
  news: number;
}

export interface ShortSellRow {
  key: string;
  symbol: string;
  score: number;
  /** the stock's own past year: days that fell ≥ 0.3 % from the open, out of how many (per-stock model only) */
  ownFell: number;
  ownDays: number;
  /** the chance comes from the per-stock model (app v1.7), not the score bands */
  modelled: boolean;
  /** measured chance (0–1) that it ends ≥ 0.3 % below today's open, or null if too few similar days */
  chance: number | null;
  similar: number;
  fellCount: number;
  avgMove: number;
  reasons: string[];
  against: string[];
  changePct: number | null;
  /** the live price is below today's opening price */
  belowOpen: boolean | null;
  /** true while today's session is running (else: setups for the next session) */
  live: boolean;
}

export const MIN_SHORT_SCORE = 45;

/** The per-stock model's answer for one stock (app v1.7, see shortModel.ts). */
export type ChanceOf = (s: ShortSellInput) => { chance: number; ownFell: number; ownDays: number } | null;

/**
 * Today's list: during market hours the setup uses today's open and the stock must be trading below
 * it; otherwise the setups are for the next session (no opening price yet). Best chance first.
 * With `model`, each stock gets its own chance and only stocks above the average day's chance are
 * listed; without it, the score bands (one chance per band) are used.
 */
export function shortSellList(stocks: ShortSellInput[], calLive: Calibration, calNext: Calibration, model?: { chanceOf: ChanceOf; minChance: number }): ShortSellRow[] {
  const rows: ShortSellRow[] = [];
  for (const s of stocks) {
    const c = s.candles;
    if (c.length < 60) continue;
    const last = c[c.length - 1]!;
    const live = !!last.partial;
    const ind = indicatorsOf(c);
    const setup = live ? shortSetupAt(c, c.length - 1, ind, true) : shortSetupAt(c, c.length, ind, false);
    if (!setup) continue;
    const score = live ? setup.score : setup.base;
    const own = model ? model.chanceOf(s) : null;
    if (model ? !own || own.chance < model.minChance : score < MIN_SHORT_SCORE) continue;
    const reasons = [...setup.reasons];
    const against = [...setup.against];
    const ltp = s.ltp ?? last.close;
    const prevClose = live ? c[c.length - 2]!.close : last.close;
    const belowOpen = live ? ltp < last.open : null;
    if (live && belowOpen === false) continue; // rising since the open: not a sell-first candidate now
    if (live && belowOpen) reasons.push('trading below today\'s opening price now');
    if (s.news < 0) reasons.push('bad news today');
    if (s.news > 0) against.push('good news today');
    const m = chanceFor(live ? calLive : calNext, score);
    rows.push({
      key: s.key,
      symbol: s.symbol,
      score,
      ownFell: own?.ownFell ?? 0,
      ownDays: own?.ownDays ?? 0,
      modelled: !!own,
      chance: own ? own.chance : (m?.chance ?? null),
      similar: m?.n ?? 0,
      fellCount: m?.fell ?? 0,
      avgMove: m?.avgMove ?? 0,
      reasons,
      against,
      changePct: prevClose ? (ltp / prevClose - 1) * 100 : null,
      belowOpen,
      live,
    });
  }
  return rows.sort((a, b) => (b.chance ?? 0) - (a.chance ?? 0) || b.score - a.score || (a.changePct ?? 0) - (b.changePct ?? 0));
}
