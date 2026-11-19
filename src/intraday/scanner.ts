import type { Bars } from '../daytrade/types';
import { downTick, sizeTrade, upTick, type Size } from '../early/early';

/**
 * App v1.19 — the Intraday scanner: stocks that start rising DURING the session (they may have opened
 * flat — URBANCO and SUNTV on 18 Nov), found among every NSE EQ-series stock, not only the pre-open
 * list. Pure: the live job (background/intradayJobs.ts) and the past test (intraday/backtest.ts) call
 * the same `classifyIntraday`, so the test measures exactly what the screen shows.
 *
 * A stock is looked at from +0.6 % above yesterday's close. Seven checks, each worth points (100 in all):
 *   1. +1 % or more from yesterday's close                       15
 *   2. volume 1.5× its usual for this time of day or more         20
 *   3. price above VWAP (the day's average traded price)          15
 *   4. above the first 15 minutes' high (opening-range breakout)  15
 *   5. 5-minute EMA trend up (EMA 9 above EMA 21, price above 9)  15
 *   6. the last 5-minute candle strong (green, closes near high)  10
 *   7. buyers ahead: 55 %+ of the waiting quantity is buying      10
 * BUY = all of 1–5 plus a strong candle or buyers ahead, not stretched, in time, market not falling.
 * WAIT = an early or stretched mover: it says what is missing (or "wait for a pullback").
 * NO TRADE = below VWAP, already up too much, stale price, too thin, or too late in the day.
 * Never a guarantee; the app never places an order.
 */

export const INTRADAY = {
  firstT: 9 * 60 + 15,
  lastT: 15 * 60 + 15,
  /** the opening range: the first three 5-minute candles, 9:15–9:30 */
  orEndT: 9 * 60 + 30,
  /** no new BUY after 2:45 pm — too little time left before the 3:15 exit */
  buyUntilT: 14 * 60 + 45,
  minPrice: 20,
  /** ₹ crore traded today, at least (thin stocks jump on small orders) */
  minValueCr: 0.5,
  watchPct: 0.6,
  buyPct: 1,
  /** more than this today: it has already moved too much to chase */
  maxDayPct: 7,
  maxAboveVwapPct: 2.5,
  maxAboveEma9Pct: 1.5,
  rvolBuy: 1.5,
  rvolWatch: 1.1,
  pressureBuy: 0.55,
  minStopPct: 0.4,
  maxStopPct: 2,
  /** target = this many times the risk */
  rr: 2,
  /** a price older than this is not used for a BUY */
  staleMs: 45_000,
} as const;

/** app v1.20: SELL = sell first, buy back later (the separate short engine, intraday/short.ts) */
export type IntradayCall = 'BUY' | 'SELL' | 'WAIT' | 'NO TRADE';

export interface IntradayInput {
  key: string;
  symbol: string;
  tick: number;
  now: number;
  /** minutes since midnight IST */
  t: number;
  ltp: number;
  prevClose: number | null;
  /** today's cumulative volume */
  volume: number | null;
  vwap: number | null;
  buyQty: number | null;
  sellQty: number | null;
  /** today's FINISHED 5-minute candles (start times in minutes IST) */
  bars: Bars;
  /** average daily volume of the last 20 sessions; null = not known yet */
  avgDailyVol: number | null;
  /** when the price was read */
  fetchedAt: number;
  marketWeak: boolean;
  capital: number;
  maxRisk: number;
}

/** One check of either engine (the BUY side's ids are below; the SELL side's in short.ts). */
export interface RowCheck {
  id: string;
  ok: boolean | null;
  text: string;
}

export interface IntradayCheck extends RowCheck {
  id: 'change' | 'volume' | 'vwap' | 'orb' | 'ema' | 'candle' | 'buyers';
}

export interface IntradayPlan {
  /** buy at (BUY) or buy only above (WAIT); SELL side: sell first at / only below */
  entry: number;
  /** SELL side: buy back if it rises to this */
  stop: number;
  /** BUY: the target; SELL side: target 2 (the rest) */
  target: number;
  /** SELL side only: target 1 (buy back half) */
  t1?: number;
  /** reward ÷ risk */
  rr: number;
}

export interface IntradayRow {
  key: string;
  symbol: string;
  call: IntradayCall;
  /** app v1.20: which engine made the row — 'sell' = the short engine (missing = the BUY engine) */
  side?: 'buy' | 'sell';
  score: number;
  /** the one-line reason for the call */
  why: string;
  checks: RowCheck[];
  price: number;
  changePct: number;
  fromOpenPct: number | null;
  /** volume vs usual for this time of day */
  rvol: number | null;
  vwap: number | null;
  /** share of the waiting quantity that is buying, 0–1 */
  buyers: number | null;
  ema9: number | null;
  ema21: number | null;
  orHigh: number | null;
  /** minutes IST when a 5-minute candle first closed above the opening range */
  breakoutT: number | null;
  plan: IntradayPlan | null;
  size: Size | null;
  /** ₹ crore traded today */
  valueCr: number | null;
  at: number;
  // ---- app v1.20, SELL side only
  orLow?: number | null;
  /** minutes IST when a 5-minute candle first closed below the broken level */
  breakdownT?: number | null;
  /** the level it broke below (or the opening-range high it failed at) */
  level?: number | null;
  rsi?: number | null;
  ema20?: number | null;
  /** change today minus NIFTY 50's / its sector's, percentage points */
  relNifty?: number | null;
  relSector?: number | null;
}

const WEIGHT: Record<IntradayCheck['id'], number> = { change: 15, volume: 20, vwap: 15, orb: 15, ema: 15, candle: 10, buyers: 10 };

/** Share of a normal NSE day's volume traded by `t` (heavier in the first half hour). */
export function volumeShare(t: number): number {
  const m = Math.max(0, t - INTRADAY.firstT);
  if (m <= 15) return Math.max(0.02, (0.12 * m) / 15);
  if (m <= 60) return 0.12 + (0.13 * (m - 15)) / 45;
  return Math.min(1, 0.25 + (0.75 * (m - 60)) / (375 - 60));
}

export function emaLast(values: number[], n: number): number | null {
  if (!values.length) return null;
  const k = 2 / (n + 1);
  let e = values[0]!;
  for (let i = 1; i < values.length; i++) e = values[i]! * k + e * (1 - k);
  return e;
}

/** VWAP from candles (typical price × volume), when the exchange's own is not available. */
export function barsVwap(b: Bars): number | null {
  let pv = 0;
  let v = 0;
  for (let i = 0; i < b.t.length; i++) {
    pv += ((b.h[i]! + b.l[i]! + b.c[i]!) / 3) * b.v[i]!;
    v += b.v[i]!;
  }
  return v > 0 ? pv / v : null;
}

export const hhmmT = (t: number): string => `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
const pct = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}%`;

/** The call for one stock now; null when it is not rising enough to look at. */
export function classifyIntraday(x: IntradayInput): IntradayRow | null {
  if (!(x.ltp > 0) || !(x.prevClose && x.prevClose > 0)) return null;
  const changePct = (x.ltp / x.prevClose - 1) * 100;
  if (changePct < INTRADAY.watchPct) return null;
  const b = x.bars;
  const n = b.t.length;
  const open = n ? b.o[0]! : null;
  const fromOpenPct = open ? (x.ltp / open - 1) * 100 : null;
  const vwap = x.vwap && x.vwap > 0 ? x.vwap : barsVwap(b);
  const valueCr = x.volume !== null ? (x.volume * (vwap ?? x.ltp)) / 1e7 : null;
  const rvol = x.avgDailyVol && x.avgDailyVol > 0 && x.volume !== null ? x.volume / (x.avgDailyVol * volumeShare(x.t)) : null;
  const buyers = x.buyQty !== null && x.sellQty !== null && x.buyQty + x.sellQty > 0 ? x.buyQty / (x.buyQty + x.sellQty) : null;

  // opening range and its breakout
  const orIdx: number[] = [];
  for (let i = 0; i < n; i++) if (b.t[i]! < INTRADAY.orEndT) orIdx.push(i);
  const orDone = orIdx.length > 0 && x.t >= INTRADAY.orEndT;
  const orHigh = orDone ? Math.max(...orIdx.map((i) => b.h[i]!)) : null;
  let breakoutT: number | null = null;
  if (orHigh !== null) {
    for (let i = 0; i < n; i++) {
      if (b.t[i]! >= INTRADAY.orEndT && b.c[i]! > orHigh) {
        breakoutT = b.t[i]! + 5;
        break;
      }
    }
  }
  const orb = orHigh !== null && breakoutT !== null && x.ltp > orHigh;

  const closes = b.c.slice(0, n);
  const enough = n >= 6;
  const ema9 = enough ? emaLast(closes, 9) : null;
  const ema21 = enough ? emaLast(closes, 21) : null;
  const emaUp = ema9 !== null && ema21 !== null && ema9 > ema21 && x.ltp > ema9;

  const last = n ? { o: b.o[n - 1]!, h: b.h[n - 1]!, l: b.l[n - 1]!, c: b.c[n - 1]! } : null;
  const range = last ? last.h - last.l : 0;
  const strong = !!last && range > 0 && last.c > last.o && (last.c - last.l) / range >= 0.7 && (last.c - last.o) / range >= 0.5;

  const aboveVwap = vwap !== null && x.ltp > vwap;
  const checks: IntradayCheck[] = [
    { id: 'change', ok: changePct >= INTRADAY.buyPct, text: `${pct(changePct)} from yesterday's close` },
    { id: 'volume', ok: rvol === null ? null : rvol >= INTRADAY.rvolBuy, text: rvol === null ? 'usual volume not known yet' : `volume ${rvol.toFixed(1)}× its usual for this time` },
    { id: 'vwap', ok: vwap === null ? null : aboveVwap, text: vwap === null ? 'VWAP not known yet' : `${aboveVwap ? 'above' : 'below'} VWAP ₹${vwap.toFixed(2)}` },
    { id: 'orb', ok: orHigh === null ? null : orb, text: orHigh === null ? 'opening range forms until 9:30' : orb ? `broke the first 15 minutes' high ₹${orHigh.toFixed(2)} at ${hhmmT(breakoutT!)}` : `not above the first 15 minutes' high ₹${orHigh.toFixed(2)}` },
    { id: 'ema', ok: !enough ? null : emaUp, text: !enough ? 'EMA trend after 6 candles (9:45)' : emaUp ? '5-minute trend up (EMA 9 above EMA 21)' : '5-minute trend not up yet' },
    { id: 'candle', ok: last ? strong : null, text: !last ? 'no finished candle yet' : strong ? 'last 5-minute candle strong (closed near its high)' : 'last 5-minute candle weak' },
    { id: 'buyers', ok: buyers === null ? null : buyers >= INTRADAY.pressureBuy, text: buyers === null ? 'buy / sell quantities not known' : `${Math.round(buyers * 100)}% of the waiting quantity is buying` },
  ];
  const score = checks.reduce((s, c) => s + (c.ok ? WEIGHT[c.id] : 0), 0);

  const aboveVwapPct = vwap ? (x.ltp / vwap - 1) * 100 : 0;
  const aboveEmaPct = ema9 ? (x.ltp / ema9 - 1) * 100 : 0;
  const stretched = changePct > INTRADAY.maxDayPct ? null : aboveVwapPct > INTRADAY.maxAboveVwapPct ? `${aboveVwapPct.toFixed(1)}% above VWAP` : aboveEmaPct > INTRADAY.maxAboveEma9Pct ? `${aboveEmaPct.toFixed(1)}% above its 5-minute EMA 9` : null;

  // the plan: buy now after a breakout, else only above the opening-range high
  const tick = x.tick > 0 ? x.tick : 0.05;
  let plan: IntradayPlan | null = null;
  let stopTooFar: number | null = null;
  const entry = orb || orHigh === null ? upTick(x.ltp, tick) : upTick(orHigh + tick, tick);
  const lows = n ? b.l.slice(Math.max(0, n - 2), n) : [];
  let stopRaw = Math.max(vwap ?? 0, lows.length ? Math.min(...lows) : 0);
  if (!(stopRaw > 0) || stopRaw >= entry) stopRaw = entry * (1 - INTRADAY.minStopPct / 100);
  let stop = downTick(stopRaw - tick, tick);
  if ((entry - stop) / entry < INTRADAY.minStopPct / 100) stop = downTick(entry * (1 - INTRADAY.minStopPct / 100), tick);
  const stopPct = ((entry - stop) / entry) * 100;
  if (stopPct > INTRADAY.maxStopPct) stopTooFar = stopPct;
  else {
    const target = upTick(entry + INTRADAY.rr * (entry - stop), tick);
    plan = { entry, stop, target, rr: Math.round(((target - entry) / (entry - stop)) * 100) / 100 };
  }
  const size = plan ? sizeTrade({ entry: plan.entry, stop: plan.stop, t1: plan.target, t2: plan.target }, x.capital, x.maxRisk, tick) : null;

  const base = { key: x.key, symbol: x.symbol, score, checks, price: x.ltp, changePct, fromOpenPct, rvol, vwap, buyers, ema9, ema21, orHigh, breakoutT, plan, size, valueCr, at: x.now };
  const no = (why: string): IntradayRow => ({ ...base, call: 'NO TRADE', why, plan: null, size: null });
  const wait = (why: string): IntradayRow => ({ ...base, call: 'WAIT', why });

  if (x.now - x.fetchedAt > INTRADAY.staleMs) return no('price is not fresh — waiting for a new one');
  if (x.ltp < INTRADAY.minPrice) return no(`price below ₹${INTRADAY.minPrice}`);
  if (valueCr !== null && valueCr < INTRADAY.minValueCr && x.t >= INTRADAY.orEndT) return no(`only ₹${valueCr.toFixed(2)} crore traded today — too thin`);
  if (x.t >= INTRADAY.lastT) return no('after 3:15 pm — the intraday day is over');
  if (changePct > INTRADAY.maxDayPct) return no(`already ${pct(changePct)} today — too late to chase`);
  if (vwap !== null && !aboveVwap && changePct >= INTRADAY.buyPct) return no(`below VWAP ₹${vwap.toFixed(2)} — sellers in control`);

  if (changePct < INTRADAY.buyPct) {
    // early: up a little with some volume and above VWAP — worth watching, not buying yet
    if ((vwap === null || aboveVwap) && (rvol === null || rvol >= INTRADAY.rvolWatch)) return wait(`early: ${pct(changePct)} — a buy needs +1% with volume and a breakout`);
    return null;
  }
  if (x.t > INTRADAY.buyUntilT) return wait('after 2:45 pm — too little time left for a new trade');
  if (x.t < INTRADAY.orEndT) return wait('the opening range forms until 9:30 — then a break above its high is needed');
  if (stretched) return wait(`stretched: ${stretched} — wait for a pullback, do not chase`);
  if (stopTooFar !== null) return wait(`the stop-loss would be ${stopTooFar.toFixed(1)}% away — too far; wait for a tighter setup`);
  // app v1.20.1: without today's candles (not loaded yet) there is no opening-range high to quote —
  // this message used to crash the whole round (same WAIT as before, only the words differ)
  if (!orb) return wait(orHigh === null ? "today's 5-minute candles are still loading — a break above the first 15 minutes' high is needed" : `waiting for a break above the first 15 minutes' high ₹${orHigh.toFixed(2)}`);
  if (rvol !== null && rvol < INTRADAY.rvolBuy) return wait(`volume only ${rvol.toFixed(1)}× its usual — a buy needs ${INTRADAY.rvolBuy}×`);
  if (rvol === null) return wait('usual volume not known yet — no buy without it');
  if (!emaUp) return wait(ema9 === null ? 'the 5-minute trend shows after 9:45' : 'the 5-minute trend is not up yet');
  if (!strong && !(buyers !== null && buyers >= INTRADAY.pressureBuy)) return wait('needs a strong 5-minute candle or more buyers than sellers');
  if (x.marketWeak) return wait('the market is falling — no buys now');
  if (!size?.ok) return wait(size?.why ?? 'no trade size fits your risk limit');
  return { ...base, call: 'BUY', why: `momentum after a breakout at ${hhmmT(breakoutT!)} — volume ${rvol.toFixed(1)}×, above VWAP` };
}

const CALL_RANK: Record<IntradayCall, number> = { BUY: 0, SELL: 0, WAIT: 1, 'NO TRADE': 2 };

/** BUY and SELL first, then WAIT, then NO TRADE; inside each the higher score first. */
export function sortIntraday(rows: IntradayRow[]): IntradayRow[] {
  return [...rows].sort((a, b) => CALL_RANK[a.call] - CALL_RANK[b.call] || b.score - a.score || b.changePct - a.changePct);
}
