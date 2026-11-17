import type { Bars } from '../daytrade/types';
import type { PrevDay } from '../ml/features';
import { usualFrom } from '../rising/momentum';
import { downTick, EARLY, sizeTrade, upTick, type EarlyPlan, type Size } from './early';
import { playTrade, type GroupResult } from './earlyTest';

/**
 * App v1.16 — "Pre-open rising candidates" (9:00–9:15) and the "opening drive" (from 9:15).
 *
 * NSE's pre-open is a call auction: 9:00 to about 9:07–9:08 orders come in (the end is random within
 * the last minute), then the opening price is worked out, and trading starts at 9:15. While orders come
 * in, Upstox gives for each stock the indicative equilibrium price (IEP — where the auction would match
 * now), the quantity that would match there (IEQ), the unmatched quantity, and the waiting buy / sell
 * quantities. The app reads them every few seconds and ranks the stocks with fixed points:
 *
 *   IEP gap above yesterday's close ............ 25   (1 % at least to be listed)
 *   waiting buy vs sell quantity ............... 20
 *   matched quantity (size and growing) ........ 15
 *   good news since yesterday's close .......... 15   (bad news: not listed)
 *   yesterday's volume vs its usual ............ 10
 *   its sector's pre-open gap .................. 10
 *   IEP steady near the end of the pre-open .... 5
 *
 * The weights were set in advance (the owner's plan of 17 Nov 2026), not fitted to past winners — they
 * are points, NOT a chance of rising. Schedule: a first list at 9:05, re-checked when order entry
 * closes (9:08), recalculated while the price is discovered, the final top 10 fixed at 9:13.
 *
 * From 9:15 the final list (and any stock that OPENS 1 % or more up) is followed on live prices: a
 * stock "holds its opening gap" while it stays above its opening price and the day's average price
 * (VWAP), its volume runs at least 1.5× the usual pace, and buyers outnumber sellers. That is the
 * opening drive — no waiting for the 9:20 candle. A stock that falls back below its open is removed.
 * Pure: the same functions run live and in the past test.
 */

export const PRE = {
  startT: 9 * 60,
  rankT: 9 * 60 + 5,
  /** order entry closes at a random moment between 9:07 and 9:08 */
  entryCloseT: 9 * 60 + 8,
  finalT: 9 * 60 + 13,
  openT: 9 * 60 + 15,
  minGapPct: 1,
  top: 10,
} as const;

export type PrePhase = 'before' | 'collecting' | 'ranking' | 'discovery' | 'final' | 'open';

/** Where the pre-open is at a time of day (minutes since midnight IST, fractions allowed). */
export function prePhase(t: number): PrePhase {
  if (t < PRE.startT) return 'before';
  if (t < PRE.rankT) return 'collecting';
  if (t < PRE.entryCloseT) return 'ranking';
  if (t < PRE.finalT) return 'discovery';
  if (t < PRE.openT) return 'final';
  return 'open';
}

export const PHASE_WORDS: Record<PrePhase, string> = {
  before: 'Pre-open starts at 9:00',
  collecting: 'Reading pre-open orders — first ranking at 9:05',
  ranking: 'Ranked — orders still coming in (entry closes 9:07–9:08)',
  discovery: 'Order entry closed — opening price being worked out, re-checking',
  final: 'Final top 10 for the open',
  open: 'Market open — following the final list live',
};

/** One reading of a stock's pre-open auction. */
export interface PreSnap {
  at: number;
  iep: number;
  ieq: number | null;
  buy: number | null;
  sell: number | null;
}

export interface PreIn {
  prevClose: number;
  /** today's readings, oldest first */
  snaps: PreSnap[];
  catalyst: { tone: 'good' | 'bad' | 'neutral'; kind: string } | null;
  /** yesterday's volume ÷ the average of the stored days before it */
  prevVolRatio: number | null;
  /** average daily volume over the stored days (shares) */
  avgDailyVol: number | null;
  /** the other stocks of its sector: average IEP gap, % (null with fewer than 2 of them) */
  sectorGap: number | null;
  now: number;
}

export type PartId = 'gap' | 'demand' | 'qty' | 'news' | 'prevVol' | 'sector' | 'stable';

export interface PrePart {
  id: PartId;
  label: string;
  pts: number;
  max: number;
  /** the number behind it, in words ("not available" when Upstox / the history does not give it) */
  text: string;
}

export interface PreRead {
  listed: boolean;
  /** why not listed */
  why?: string;
  gapPct: number;
  iep: number;
  ieq: number | null;
  buyShare: number | null;
  ieqTrend: 'up' | 'flat' | 'down' | null;
  /** IEP's range over the last 3 minutes, % */
  iepRangePct: number | null;
  score: number;
  parts: PrePart[];
  warnings: string[];
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
/** minutes since midnight IST */
export const minuteOf = (ms: number): number => (((ms + 5.5 * 3600_000) % 86_400_000) + 86_400_000) % 86_400_000 / 60_000;
const sgn = (x: number, d = 1) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(d)}`;

/** The fixed points for one stock's pre-open now. Null without a reading. */
export function readPreopen(x: PreIn): PreRead | null {
  const last = x.snaps[x.snaps.length - 1];
  if (!last || !(x.prevClose > 0) || !(last.iep > 0)) return null;
  const gapPct = (last.iep / x.prevClose - 1) * 100;
  const parts: PrePart[] = [];
  const warnings: string[] = [];
  const t = minuteOf(x.now);

  // 1. IEP gap (25): 1–2 % partly, 2–5 % in full, bigger gaps fade more often
  let gapPts = 0;
  if (gapPct >= 2 && gapPct <= 5) gapPts = 25;
  else if (gapPct >= 1 && gapPct < 2) gapPts = 10 + (gapPct - 1) * 10;
  else if (gapPct > 5 && gapPct <= 8) {
    gapPts = 18;
    warnings.push(`big gap (${sgn(gapPct)}%) — big gaps fade more often`);
  } else if (gapPct > 8) {
    gapPts = 10;
    warnings.push(`very big gap (${sgn(gapPct)}%) — often fades or stops at its price band`);
  }
  parts.push({ id: 'gap', label: 'Pre-open price vs yesterday', pts: gapPts, max: 25, text: `₹${last.iep.toFixed(2)} is ${sgn(gapPct, 2)}% from yesterday's ₹${x.prevClose.toFixed(2)}` });

  // 2. waiting buy vs sell quantity (20)
  const buyShare = last.buy !== null && last.sell !== null && last.buy + last.sell > 0 ? last.buy / (last.buy + last.sell) : null;
  parts.push({
    id: 'demand',
    label: 'Buyers vs sellers waiting',
    pts: buyShare === null ? 0 : clamp01((buyShare - 0.5) / 0.2) * 20,
    max: 20,
    text: buyShare === null ? 'buy / sell quantities: not available' : `${Math.round(buyShare * 100)}% of the waiting quantity is buying (${fmtQty(last.buy!)} buy / ${fmtQty(last.sell!)} sell)`,
  });
  if (buyShare !== null && buyShare < 0.45) warnings.push('more sellers than buyers waiting');

  // 3. matched quantity (15): its size against a usual day (10) and whether it grew while orders came in (5)
  const entry = x.snaps.filter((s) => minuteOf(s.at) < PRE.entryCloseT && s.ieq !== null);
  let ieqTrend: PreRead['ieqTrend'] = null;
  const lastE = entry[entry.length - 1];
  if (lastE && lastE.ieq !== null) {
    let base: PreSnap | undefined;
    for (const s of entry) if (s.at <= lastE.at - 90_000) base = s;
    if (base && base.ieq !== null && base.ieq > 0) {
      const r = lastE.ieq / base.ieq;
      ieqTrend = r >= 1.1 ? 'up' : r >= 0.9 ? 'flat' : 'down';
    }
  }
  const share = last.ieq !== null && x.avgDailyVol && x.avgDailyVol > 0 ? last.ieq / x.avgDailyVol : null;
  const sizePts = share === null ? 0 : clamp01((share - 0.005) / 0.025) * 10;
  const trendPts = ieqTrend === 'up' ? 5 : ieqTrend === 'flat' ? 2 : 0;
  parts.push({
    id: 'qty',
    label: 'Quantity matching at that price',
    pts: sizePts + trendPts,
    max: 15,
    text:
      last.ieq === null
        ? 'matched quantity: not available'
        : `${fmtQty(last.ieq)} shares${share !== null ? ` (${(share * 100).toFixed(1)}% of a usual day)` : ' (usual volume not known yet)'}${ieqTrend ? `, ${ieqTrend === 'up' ? 'growing' : ieqTrend === 'flat' ? 'steady' : 'shrinking'}` : ''}`,
  });

  // 4. news (15) — bad news is not listed at all
  if (x.catalyst?.tone === 'bad') return { listed: false, why: `bad news (${x.catalyst.kind})`, gapPct, iep: last.iep, ieq: last.ieq, buyShare, ieqTrend, iepRangePct: null, score: 0, parts, warnings };
  parts.push({ id: 'news', label: 'News since yesterday', pts: x.catalyst?.tone === 'good' ? 15 : 0, max: 15, text: x.catalyst ? `${x.catalyst.kind}${x.catalyst.tone === 'good' ? ' (good)' : ' (neutral)'}` : 'no headline in Upstox news' });

  // 5. yesterday's volume (10)
  parts.push({
    id: 'prevVol',
    label: "Yesterday's volume",
    pts: x.prevVolRatio === null ? 0 : clamp01(x.prevVolRatio - 1) * 10,
    max: 10,
    text: x.prevVolRatio === null ? 'not known yet (needs stored days)' : `${x.prevVolRatio.toFixed(1)}× its usual`,
  });

  // 6. sector (10)
  parts.push({
    id: 'sector',
    label: 'Its sector in the pre-open',
    pts: x.sectorGap === null ? 0 : clamp01(x.sectorGap / 1.5) * 10,
    max: 10,
    text: x.sectorGap === null ? 'too few stocks of its sector with a pre-open price' : `${sgn(x.sectorGap, 2)}% on average`,
  });
  if (x.sectorGap !== null && x.sectorGap < -0.5) warnings.push('its sector is opening lower');

  // 7. IEP steady near the end (5): judged from 9:06, over the last 3 minutes
  let iepRangePct: number | null = null;
  let stablePts = 0;
  let stableText = 'too early to judge (from 9:06)';
  if (t >= PRE.rankT + 1) {
    const recent = x.snaps.filter((s) => s.at >= x.now - 180_000);
    if (recent.length >= 3 && recent[recent.length - 1]!.at - recent[0]!.at >= 60_000) {
      const hi = Math.max(...recent.map((s) => s.iep));
      const lo = Math.min(...recent.map((s) => s.iep));
      iepRangePct = ((hi - lo) / last.iep) * 100;
      const slipping = last.iep < hi * (1 - 0.005);
      stablePts = slipping ? 0 : iepRangePct <= 0.3 ? 5 : iepRangePct <= 0.7 ? 3 : iepRangePct <= 1.2 ? 1 : 0;
      stableText = `moved ${iepRangePct.toFixed(2)}% in the last 3 minutes${slipping ? ' — slipping from its high' : ''}`;
      if (slipping) warnings.push('pre-open price slipping from its high');
    } else stableText = 'not enough readings yet';
  }
  parts.push({ id: 'stable', label: 'Pre-open price steady', pts: stablePts, max: 5, text: stableText });

  const score = Math.round(parts.reduce((s, p) => s + p.pts, 0));
  const listed = gapPct >= PRE.minGapPct;
  return { listed, ...(listed ? {} : { why: `pre-open gap ${sgn(gapPct, 2)}% — under ${PRE.minGapPct}%` }), gapPct, iep: last.iep, ieq: last.ieq, buyShare, ieqTrend, iepRangePct, score, parts, warnings };
}

const fmtQty = (q: number) => (q >= 100_000 ? `${(q / 100_000).toFixed(2)} lakh` : Math.round(q).toLocaleString('en-IN'));

/**
 * A first estimate before the open: if it opens near its pre-open price and holds, about how many
 * shares keep the risk limit with a stop 0.8 % below. The real plan is made after 9:15 from live prices.
 */
export function preEstimate(iep: number, capital: number, maxRisk: number, tick = 0.05): { entry: number; stop: number; size: Size } {
  const entry = upTick(iep, tick);
  const stop = downTick(entry * (1 - 0.008), tick);
  const r = entry - stop;
  return { entry, stop, size: sizeTrade({ entry, stop, t1: upTick(entry + r, tick), t2: upTick(entry + 2 * r, tick) }, capital, maxRisk, tick) };
}

/** Small helper: stocks' IEP gaps by sector → each stock's sector gap from the OTHER stocks (2+). */
export function sectorGaps(gaps: Array<{ key: string; sector: string | undefined; gapPct: number }>): Map<string, number> {
  const sum = new Map<string, [number, number]>();
  for (const g of gaps) {
    if (!g.sector) continue;
    const c = sum.get(g.sector) ?? [0, 0];
    c[0] += g.gapPct;
    c[1]++;
    sum.set(g.sector, c);
  }
  const out = new Map<string, number>();
  for (const g of gaps) {
    if (!g.sector) continue;
    const c = sum.get(g.sector)!;
    if (c[1] - 1 >= 2) out.set(g.key, (c[0] - g.gapPct) / (c[1] - 1));
  }
  return out;
}

/** Yesterday's volume vs the days before it, and the average day, from the stored 5-minute days. */
export function volumeHistory(prev: PrevDay[]): { prevVolRatio: number | null; avgDailyVol: number | null } {
  const tot = prev.map((d) => d.cumV[d.cumV.length - 1] ?? 0).filter((v) => v > 0);
  if (tot.length < 3) return { prevVolRatio: null, avgDailyVol: tot.length ? tot.reduce((s, v) => s + v, 0) / tot.length : null };
  const before = tot.slice(0, -1);
  const avgBefore = before.reduce((s, v) => s + v, 0) / before.length;
  return { prevVolRatio: avgBefore > 0 ? tot[tot.length - 1]! / avgBefore : null, avgDailyVol: tot.reduce((s, v) => s + v, 0) / tot.length };
}

// ---------------------------------------------------------------- the opening drive (from 9:15)

export const DRIVE = {
  /** a stock not on the final pre-open list joins when it opens at least this much up */
  minOpenGapPct: 1,
  /** it must keep at least this much of the gap */
  keepGapPct: 0.5,
  maxFromOpenPct: 2.5,
  pace: 1.5,
  buyShare: 0.5,
  /** first reading this many seconds after 9:15 (a few trades first) */
  fromSecs: 30,
  untilT: 9 * 60 + 35,
} as const;

export interface DriveIn {
  price: number;
  open: number;
  prevClose: number;
  /** high / low since the open */
  high: number;
  low: number;
  vwap: number | null;
  volume: number | null;
  /** usual volume by this time of day (shares) — null when not known */
  usualVol: number | null;
  buyShare: number | null;
  secsSinceOpen: number;
}

export type DriveState = 'holding' | 'waiting' | 'faded' | 'ran';

export interface DriveRead {
  state: DriveState;
  gapPct: number;
  changePct: number;
  fromOpenPct: number;
  /** volume so far vs the usual by now (×) */
  pace: number | null;
  why: string[];
  missing: string[];
  outWhy?: string;
}

/** Is the stock holding its opening gap right now? */
export function readDrive(x: DriveIn): DriveRead {
  const gapPct = (x.open / x.prevClose - 1) * 100;
  const changePct = (x.price / x.prevClose - 1) * 100;
  const fromOpenPct = (x.price / x.open - 1) * 100;
  const pace = x.volume !== null && x.usualVol && x.usualVol > 0 ? x.volume / x.usualVol : null;
  const base = { gapPct, changePct, fromOpenPct, pace, why: [] as string[], missing: [] as string[] };
  if (x.price < x.open * 0.997) return { ...base, state: 'faded', outWhy: 'fell below its opening price' };
  if (changePct < 0.3) return { ...base, state: 'faded', outWhy: 'gave back its opening gap' };
  if (x.vwap && x.price < x.vwap * 0.997) return { ...base, state: 'faded', outWhy: "fell below the day's average price" };
  if (fromOpenPct >= DRIVE.maxFromOpenPct) return { ...base, state: 'ran', outWhy: `ran ${fromOpenPct.toFixed(1)}% from the open — too late to buy; wait for a setup` };
  const need = (ok: boolean, yes: string, no: string) => (ok ? base.why.push(yes) : base.missing.push(no));
  need(x.secsSinceOpen >= DRIVE.fromSecs, 'trading has started', 'first seconds of trading');
  need(x.price >= x.open * 0.999, `holding above its opening price ₹${x.open.toFixed(2)}`, 'just under its opening price');
  need(!x.vwap || x.price >= x.vwap, "above the day's average price (VWAP)", "under the day's average price");
  need(changePct >= DRIVE.keepGapPct, `still ${sgn(changePct)}% above yesterday`, 'most of the gap gone');
  need(pace === null || pace >= DRIVE.pace, pace === null ? 'usual volume not known — volume not checked' : `volume ${pace.toFixed(1)}× the usual pace`, 'volume not heavy yet');
  need(x.buyShare === null || x.buyShare >= DRIVE.buyShare, x.buyShare === null ? 'buy / sell quantities not given' : `${Math.round(x.buyShare * 100)}% of waiting orders are buys`, 'more sellers than buyers waiting');
  return { ...base, state: base.missing.length ? 'waiting' : 'holding' };
}

/**
 * The opening-drive trade: buy only above the high since the open (+1 tick); the stop under the higher
 * of the day's average price (or the open) and the low since the open, 0.3–1.2 % below the entry;
 * targets at 1× and 2× that distance.
 */
export function drivePlan(x: Pick<DriveIn, 'price' | 'open' | 'high' | 'low' | 'vwap'>, tick = 0.05): EarlyPlan {
  const breakout = upTick(x.high + tick, tick);
  const entry = Math.max(breakout, upTick(x.price, tick));
  return { breakout, ...planBelow(entry, Math.max(x.vwap ?? x.open, x.low) - tick, tick) };
}

/** Entry, a stop at `base` kept 0.3–1.2 % below the entry, targets at 1× and 2× the distance. */
function planBelow(entry: number, base: number, tick: number): Omit<EarlyPlan, 'breakout'> {
  const dist = Math.min(entry * (EARLY.maxStopPct / 100), Math.max(entry * (EARLY.minStopPct / 100), entry - base));
  const stop = downTick(entry - dist, tick);
  const r = entry - stop;
  return { entry, stop, t1: upTick(entry + r, tick), t2: upTick(entry + 2 * r, tick) };
}

/** Points for a stock holding its gap: half its pre-open score (if it was on the list) plus the live signs. Not a chance. */
export function scoreDrive(d: DriveRead, preScore: number | null, extra: { goodNews: boolean; sectorPct: number | null; marketPct: number | null; buyShare: number | null }): { score: number; reasons: string[]; warnings: string[] } {
  let p = preScore !== null ? preScore * 0.5 : 10;
  const reasons: string[] = [];
  const warnings: string[] = [];
  if (preScore !== null) reasons.push(`pre-open score ${preScore}`);
  if (d.state === 'holding') (p += 15), reasons.push('holding above its open and VWAP');
  if (d.pace !== null && d.pace >= 2) (p += 15), reasons.push(`${d.pace.toFixed(1)}× usual volume`);
  else if (d.pace !== null && d.pace >= DRIVE.pace) (p += 10), reasons.push(`${d.pace.toFixed(1)}× usual volume`);
  if (extra.buyShare !== null && extra.buyShare >= 0.6) (p += 10), reasons.push(`${Math.round(extra.buyShare * 100)}% of waiting orders are buys`);
  if (d.gapPct >= 1 && d.gapPct <= 5) (p += 5), reasons.push(`opened ${sgn(d.gapPct)}% up`);
  if (d.gapPct > 5) warnings.push(`opened ${sgn(d.gapPct)}% up — big gaps fade more often`);
  if (preScore === null && extra.goodNews) (p += 5), reasons.push('good news since yesterday');
  if (extra.sectorPct !== null && extra.marketPct !== null && extra.sectorPct > extra.marketPct + 0.3) (p += 5), reasons.push('its sector is stronger than the market');
  if (extra.marketPct !== null && extra.marketPct < -0.4) (p -= 10), warnings.push('the whole market is falling');
  return { score: Math.max(0, Math.min(100, Math.round(p))), reasons, warnings };
}

// ---------------------------------------------------------------- what happened after the open

export interface OpenOutcome {
  /** the first 30 minutes (9:15–9:45): best and worst move from the opening price, % */
  upPct: number;
  downPct: number;
  /** 9:45 close vs the open, % */
  at945Pct: number;
  /** reached +1 % above the open before falling 1 % below it (same candle counts as a fall) */
  upFirst: boolean;
}

/** From today's 5-minute candles (9:15 first): how a stock did in its first 30 minutes. */
export function openOutcome(b: Bars): OpenOutcome | null {
  if (b.t.length < 6 || b.t[0]! !== PRE.openT || !(b.o[0]! > 0)) return null;
  const o = b.o[0]!;
  let hi = -Infinity;
  let lo = Infinity;
  let upFirst: boolean | null = null;
  for (let i = 0; i < 6; i++) {
    hi = Math.max(hi, b.h[i]!);
    lo = Math.min(lo, b.l[i]!);
    if (upFirst === null) {
      const down = b.l[i]! <= o * 0.99;
      const up = b.h[i]! >= o * 1.01;
      if (down) upFirst = false;
      else if (up) upFirst = true;
    }
  }
  return { upPct: (hi / o - 1) * 100, downPct: (lo / o - 1) * 100, at945Pct: (b.c[5]! / o - 1) * 100, upFirst: upFirst === true };
}

/** The daily record so far (each day's final pre-open list and its first 30 minutes), for the screen. */
export function recordSummary(rec: Array<{ date: string; rows: Array<{ out: OpenOutcome | null }> }> | null | undefined): { days: number; stocks: number; upFirst: number; avg945: number | null; since: string | null } {
  const rows = (rec ?? []).flatMap((d) => d.rows.filter((r) => r.out).map((r) => r.out!));
  const days = (rec ?? []).filter((d) => d.rows.some((r) => r.out)).length;
  return {
    days,
    stocks: rows.length,
    upFirst: rows.filter((o) => o.upFirst).length,
    avg945: rows.length ? rows.reduce((s, o) => s + o.at945Pct, 0) / rows.length : null,
    since: (rec ?? []).find((d) => d.rows.some((r) => r.out))?.date ?? null,
  };
}

// ---------------------------------------------------------------- the past test of the opening rule

export interface OpenTestDay {
  date: string;
  bars: Bars;
  prevClose: number | null;
  prev: PrevDay[];
}

export interface OpenTestResult {
  days: number;
  gapDays: number;
  /** gapped up 1 %+, first 5-minute candle held above the open and its average price with 1.5×+ volume: bought above its high */
  drive: GroupResult;
  /** every 1 %+ gap-up bought at 9:20 without the hold check (what "just buy the gap" would do) */
  anyGap: GroupResult;
  older: GroupResult;
  newer: GroupResult;
}

const emptyG = (): GroupResult => ({ trades: 0, wins: 0, t1: 0, pnl: 0, avg: 0, tooRisky: 0 });
function addG(g: GroupResult, pnl: number, hitT1: boolean): void {
  g.trades++;
  if (pnl > 0) g.wins++;
  if (hitT1) g.t1++;
  g.pnl += pnl;
  g.avg = g.pnl / g.trades;
}

/**
 * The opening-drive rule on stored 5-minute days. The app has no stored pre-open auctions (they are
 * recorded from now on), so this tests what can be tested: the gap and the first minutes. Five-minute
 * candles are coarser than the live check (which starts 30 seconds after 9:15): here the first candle
 * (9:15–9:20) must hold, and the buy is above its high in a later candle. Nothing is tuned.
 */
export function runOpenTest(days: OpenTestDay[], capital: number, maxRisk: number, tick = 0.05): OpenTestResult | null {
  const dates = [...new Set(days.map((d) => d.date))].sort();
  if (dates.length < 5) return null;
  const mid = dates[Math.floor(dates.length / 2)]!;
  const r: OpenTestResult = { days: dates.length, gapDays: 0, drive: emptyG(), anyGap: emptyG(), older: emptyG(), newer: emptyG() };
  for (const d of days) {
    const b = d.bars;
    if (b.t.length < 10 || b.t[0] !== PRE.openT || !d.prevClose) continue;
    const open = b.o[0]!;
    const gap = (open / d.prevClose - 1) * 100;
    if (gap < DRIVE.minOpenGapPct) continue;
    r.gapDays++;
    const vwap1 = (b.h[0]! + b.l[0]! + b.c[0]!) / 3;
    const plan = drivePlan({ price: b.c[0]!, open, high: b.h[0]!, low: b.l[0]!, vwap: vwap1 }, tick);
    // just buy the gap: at the 9:20 open, same kind of stop and targets
    {
      const fill = b.o[1]!;
      const p = { ...plan, ...planBelow(fill, Math.max(vwap1, b.l[0]!) - tick, tick) };
      const s = sizeTrade(p, capital, maxRisk, tick);
      if (!s.ok) r.anyGap.tooRisky++;
      else {
        const t = playTrade(b, 1, fill, p, s.qty, tick);
        addG(r.anyGap, t.pnl, t.hitT1);
      }
    }
    // the opening drive: the first candle held (close ≥ open, ≥ its average price, ≥ half the gap kept) with heavy volume
    const usual = usualFrom(d.prev)(PRE.openT).bar;
    const held = b.c[0]! >= open && b.c[0]! >= vwap1 && (b.c[0]! / d.prevClose - 1) * 100 >= DRIVE.keepGapPct && (b.c[0]! / open - 1) * 100 < DRIVE.maxFromOpenPct;
    const heavy = usual === null || b.v[0]! >= DRIVE.pace * usual;
    if (!held || !heavy) continue;
    let j = -1;
    for (let k = 1; k <= Math.min(b.t.length - 1, 4); k++) {
      if (b.l[k]! <= plan.stop) break;
      if (b.h[k]! >= plan.breakout) {
        j = k;
        break;
      }
    }
    if (j < 0) continue;
    const fill = Math.max(plan.entry, b.o[j]!);
    const p = { ...plan, entry: fill };
    const s = sizeTrade(p, capital, maxRisk, tick);
    if (!s.ok) {
      r.drive.tooRisky++;
      continue;
    }
    const t = playTrade(b, j, fill, p, s.qty, tick);
    addG(r.drive, t.pnl, t.hitT1);
    addG(d.date < mid ? r.older : r.newer, t.pnl, t.hitT1);
  }
  return r;
}
