import { intradayCharges } from '../daytrade/rules';
import type { Bars } from '../daytrade/types';
import { downTick, upTick, type Size } from '../early/early';
import { rsi } from '../daytrade/shortScan';
import { barsVwap, emaLast, hhmmT, INTRADAY, volumeShare, type IntradayRow, type RowCheck } from './scanner';

/**
 * App v1.20 — the Intraday scanner's SELL side: sell first, buy back later the same day (an Intraday
 * short). A separate engine from the BUY one (scanner.ts, unchanged): its own checks, plan, size and
 * reasons, mirrored for a falling stock. Pure: the live job calls it every 15 seconds.
 *
 * A stock is looked at from 0.6 % below yesterday's close, or when it trades below VWAP after trying
 * to break out upwards. Nine checks, each worth points (score capped at 100):
 *   1. price below VWAP (the day's average traded price)                    15
 *   2. 5-minute EMA 9 below EMA 20, price below EMA 9                       10
 *   3. lower highs and lower lows (last three 5-minute candles)             10
 *   4. selling volume rising: day volume 1.5×+ usual and red candles heavy  15
 *   5. weaker than NIFTY 50 (1 point+) and than its sector (0.5 point+)     10
 *   6. RSI 14 bearish (25–45; 1-minute candles, else 5-minute)              10
 *   7. broke below the opening-range low or yesterday's low (5-min close)   15
 *   8. failed upward breakout: went above the opening-range high, fell back 10
 *   9. confirmed: a red 5-minute candle closing low, and 1-minute candles
 *      below the broken level                                               10
 * SELL = 1, 2, 4, 5, 6, 9 all true, plus 7 or 8 (a trigger) and 3 or 8 (the structure), not stretched,
 * in time, the market not rising, a stop within 2 %, and a size that fits the risk limit.
 * Never a single indicator. Only Nifty 500 stocks (on the brokers' Intraday lists) are shorted; BE / T2T
 * and other series never reach the scanner. Never a guarantee; the app never places an order.
 */

export const SHORT = {
  watchPct: -0.6,
  /** more than this down today: it has already fallen too much to chase */
  maxDayPct: -7,
  maxBelowVwapPct: 2.5,
  maxBelowEma9Pct: 1.5,
  rvolSell: 1.5,
  /** red candles' volume vs green candles' over the last six 5-minute candles */
  redHeavy: 1.5,
  /** the last red 5-minute candle vs the day's average candle */
  redSpike: 1.3,
  rsiLo: 25,
  rsiHi: 45,
  relNiftyPts: 1,
  relSectorPts: 0.5,
  /** the day's high at least this far above the price for a "failed breakout" */
  failedFromHighPct: 0.5,
  minStopPct: 0.4,
  maxStopPct: 2,
} as const;

export type ShortCheckId = 'vwap' | 'ema' | 'structure' | 'volume' | 'relative' | 'rsi' | 'breakdown' | 'failed' | 'confirm';

const WEIGHT: Record<ShortCheckId, number> = { vwap: 15, ema: 10, structure: 10, volume: 15, relative: 10, rsi: 10, breakdown: 15, failed: 10, confirm: 10 };

export interface ShortInput {
  key: string;
  symbol: string;
  tick: number;
  now: number;
  /** minutes since midnight IST */
  t: number;
  ltp: number;
  prevClose: number | null;
  volume: number | null;
  vwap: number | null;
  buyQty: number | null;
  sellQty: number | null;
  /** today's FINISHED 5-minute candles */
  bars: Bars;
  /** today's FINISHED 1-minute candles (null = not loaded) */
  bars1: Bars | null;
  avgDailyVol: number | null;
  /** yesterday's low (support), if known */
  prevLow: number | null;
  fetchedAt: number;
  /** NIFTY 50 change today, %, if fresh */
  niftyDayPct: number | null;
  /** the stock's sector, average change today of the other stocks, % (null = not known) */
  sectorDayPct: number | null;
  /** the market is rising (no new shorts) */
  marketStrong: boolean;
  /** shorting allowed for this stock (Nifty 500) */
  eligible: boolean;
  /** the exchange's lower price band today, if Upstox gave it */
  lowerCircuit?: number | null;
  capital: number;
  maxRisk: number;
}

export interface ShortExtra {
  orLow: number | null;
  /** minutes IST when a 5-minute candle first closed below the broken level */
  breakdownT: number | null;
  /** the level the stock broke below (opening-range low or yesterday's low), or the opening-range high it failed at */
  level: number | null;
  rsi: number | null;
  ema20: number | null;
  /** stock minus NIFTY, percentage points */
  relNifty: number | null;
  relSector: number | null;
}

const pct = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}%`;
const rs = (v: number) => `₹${v.toFixed(2)}`;

/**
 * Shares for a sell-first trade: the most shares whose loss if it RISES to the stop (plus one tick of
 * slippage and every Upstox Intraday charge) stays within `maxRisk`, with the position's value within
 * `capital`. Mirrors sizeTrade (early.ts) for a short.
 */
export function sizeShort(p: { entry: number; stop: number; t1: number; t2: number }, capital: number, maxRisk: number, tick = 0.05): Size {
  const lossAt = (q: number) => {
    const exit = p.stop + tick;
    const ch = intradayCharges(q * exit, q * p.entry);
    return { risk: q * (exit - p.entry) + ch, ch };
  };
  let q = Math.floor(capital / p.entry);
  if (q < 1) return { ok: false, qty: 0, value: 0, risk: 0, charges: 0, reward: 0, why: `one share is ₹${p.entry.toFixed(2)} — more than the ₹${Math.round(capital).toLocaleString('en-IN')} capital` };
  let hi = q;
  let lo = 0;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (lossAt(mid).risk <= maxRisk) lo = mid;
    else hi = mid - 1;
  }
  q = lo;
  if (q < 1) {
    const one = lossAt(1);
    return { ok: false, qty: 0, value: 0, risk: one.risk, charges: one.ch, reward: 0, why: `even 1 share risks ₹${one.risk.toFixed(0)} with charges — more than ₹${maxRisk}` };
  }
  const { risk, ch } = lossAt(q);
  const h1 = Math.floor(q / 2);
  const h2 = q - h1;
  const buyBack = h1 * p.t1 + h2 * p.t2;
  const reward = q * p.entry - buyBack - intradayCharges(buyBack, q * p.entry);
  return { ok: true, qty: q, value: Math.round(q * p.entry * 100) / 100, risk: Math.round(risk * 100) / 100, charges: Math.round(ch * 100) / 100, reward: Math.round(reward * 100) / 100 };
}

/**
 * No new shorts while the market rises (fixed in advance, the mirror of the BUY side's falling-market
 * gate): NIFTY 50 0.5 %+ above yesterday's close or 0.3 %+ above today's open, or the scanned stocks
 * 0.3 %+ above their opens on average.
 */
export function marketRising(x: { niftyDayPct: number | null; niftyFromOpenPct: number | null; listFromOpenPct: number | null }): { strong: boolean; text: string } {
  const f = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}%`;
  if (x.niftyDayPct !== null && x.niftyDayPct >= 0.5) return { strong: true, text: `NIFTY 50 ${f(x.niftyDayPct)} today` };
  if (x.niftyFromOpenPct !== null && x.niftyFromOpenPct >= 0.3) return { strong: true, text: `NIFTY 50 ${f(x.niftyFromOpenPct)} since the open` };
  if (x.listFromOpenPct !== null && x.listFromOpenPct >= 0.3) return { strong: true, text: `the scanned stocks ${f(x.listFromOpenPct)} since the open on average` };
  return { strong: false, text: '' };
}

/** The SELL-side call for one stock now; null when it is not weak enough to look at (or not shortable). */
export function classifyShort(x: ShortInput): (IntradayRow & ShortExtra) | null {
  if (!x.eligible || !(x.ltp > 0) || !(x.prevClose && x.prevClose > 0)) return null;
  const changePct = (x.ltp / x.prevClose - 1) * 100;
  const b = x.bars;
  const n = b.t.length;
  const vwap = x.vwap && x.vwap > 0 ? x.vwap : barsVwap(b);
  const belowVwap = vwap !== null && x.ltp < vwap;
  // looked at: down 0.6 %+, or below VWAP after rising (a possible failed breakout)
  if (changePct > SHORT.watchPct && !belowVwap) return null;
  const open = n ? b.o[0]! : null;
  const fromOpenPct = open ? (x.ltp / open - 1) * 100 : null;
  const valueCr = x.volume !== null ? (x.volume * (vwap ?? x.ltp)) / 1e7 : null;
  const rvol = x.avgDailyVol && x.avgDailyVol > 0 && x.volume !== null ? x.volume / (x.avgDailyVol * volumeShare(x.t)) : null;
  const buyers = x.buyQty !== null && x.sellQty !== null && x.buyQty + x.sellQty > 0 ? x.buyQty / (x.buyQty + x.sellQty) : null;

  // opening range (9:15–9:30)
  const orIdx: number[] = [];
  for (let i = 0; i < n; i++) if (b.t[i]! < INTRADAY.orEndT) orIdx.push(i);
  const orDone = orIdx.length > 0 && x.t >= INTRADAY.orEndT;
  const orLow = orDone ? Math.min(...orIdx.map((i) => b.l[i]!)) : null;
  const orHigh = orDone ? Math.max(...orIdx.map((i) => b.h[i]!)) : null;

  // 7. breakdown: a finished 5-minute candle after 9:30 closed below the opening-range low (or yesterday's low)
  const firstCloseBelow = (lvl: number): number | null => {
    for (let i = 0; i < n; i++) if (b.t[i]! >= INTRADAY.orEndT && b.c[i]! < lvl) return b.t[i]! + 5;
    return null;
  };
  let level: number | null = null;
  let breakdownT: number | null = null;
  let brokeWhat = '';
  if (orLow !== null) {
    const tOr = firstCloseBelow(orLow);
    if (tOr !== null && x.ltp < orLow) {
      level = orLow;
      breakdownT = tOr;
      brokeWhat = `the opening-range low ${rs(orLow)}`;
    }
  }
  if (level === null && orDone && x.prevLow && x.prevLow > 0) {
    const tY = firstCloseBelow(x.prevLow);
    if (tY !== null && x.ltp < x.prevLow) {
      level = x.prevLow;
      breakdownT = tY;
      brokeWhat = `yesterday's low ${rs(x.prevLow)}`;
    }
  }
  const breakdown = level !== null;

  // 8. failed upward breakout: went above the opening-range high, a candle closed back below it, sellers now in charge
  let dayHigh = -Infinity;
  for (let i = 0; i < n; i++) dayHigh = Math.max(dayHigh, b.h[i]!);
  let triedUp = false;
  if (orHigh !== null) for (let i = 0; i < n; i++) if (b.t[i]! >= INTRADAY.orEndT && b.h[i]! > orHigh) triedUp = true;
  const lastC = n ? b.c[n - 1]! : null;
  const failed =
    orHigh !== null && triedUp && lastC !== null && lastC < orHigh && x.ltp < orHigh && belowVwap && Number.isFinite(dayHigh) && (dayHigh / x.ltp - 1) * 100 >= SHORT.failedFromHighPct;

  // 2. EMA 9 / EMA 20 on the 5-minute closes
  const closes = b.c.slice(0, n);
  const enough = n >= 6;
  const ema9 = enough ? emaLast(closes, 9) : null;
  const ema20 = enough ? emaLast(closes, 20) : null;
  const emaDown = ema9 !== null && ema20 !== null && ema9 < ema20 && x.ltp < ema9;

  // 3. lower highs and lower lows
  const structure =
    n >= 3 ? b.h[n - 1]! < b.h[n - 2]! && b.h[n - 2]! <= b.h[n - 3]! && b.l[n - 1]! < b.l[n - 2]! && b.l[n - 2]! <= b.l[n - 3]! : null;

  // 4. selling volume
  let redV = 0;
  let greenV = 0;
  for (let i = Math.max(0, n - 6); i < n; i++) {
    if (b.c[i]! < b.o[i]!) redV += b.v[i]!;
    else if (b.c[i]! > b.o[i]!) greenV += b.v[i]!;
  }
  const avgBarV = n > 1 ? b.v.slice(0, n - 1).reduce((s, v) => s + v, 0) / (n - 1) : null;
  const lastRedSpike = n >= 2 && b.c[n - 1]! < b.o[n - 1]! && avgBarV !== null && avgBarV > 0 && b.v[n - 1]! >= SHORT.redSpike * avgBarV;
  const redHeavy = n >= 3 && redV > 0 && redV >= SHORT.redHeavy * Math.max(1, greenV);
  const volumeOk = rvol === null ? null : rvol >= SHORT.rvolSell && (redHeavy || lastRedSpike);

  // 5. relative weakness
  const relNifty = x.niftyDayPct !== null ? changePct - x.niftyDayPct : null;
  const relSector = x.sectorDayPct !== null ? changePct - x.sectorDayPct : null;
  const relative = relNifty === null ? null : relNifty <= -SHORT.relNiftyPts && (relSector === null || relSector <= -SHORT.relSectorPts);

  // 6. RSI 14: 1-minute candles when there are enough, else 5-minute
  const c1 = x.bars1 ? x.bars1.c : [];
  const rsiV = c1.length > 14 ? rsi(c1, 14) : closes.length > 14 ? rsi(closes, 14) : null;
  const rsiOk = rsiV === null ? null : rsiV > SHORT.rsiLo && rsiV <= SHORT.rsiHi;

  // 9. confirmation: the last 5-minute candle red and closing in its lower half below VWAP; the 1-minute candles below the level
  const last = n ? { o: b.o[n - 1]!, h: b.h[n - 1]!, l: b.l[n - 1]!, c: b.c[n - 1]! } : null;
  const range = last ? last.h - last.l : 0;
  const conf5 = !!last && range > 0 && last.c < last.o && (last.c - last.l) / range <= 0.5 && (vwap === null || last.c < vwap);
  const trig = level ?? (failed ? Math.min(orHigh!, vwap ?? orHigh!) : null);
  let conf1: boolean | null = null;
  if (x.bars1 && x.bars1.t.length >= 3) {
    const k = x.bars1.t.length;
    let reds = 0;
    for (let i = k - 3; i < k; i++) if (x.bars1.c[i]! < x.bars1.o[i]!) reds++;
    const lastC1 = x.bars1.c[k - 1]!;
    conf1 = reds >= 2 && (trig === null || lastC1 < trig) && (vwap === null || lastC1 < vwap);
  }
  const confirm = !last ? null : conf5 && conf1 === true ? true : conf5 && conf1 === null ? null : false;

  const checks: Array<RowCheck & { id: ShortCheckId }> = [
    { id: 'vwap', ok: vwap === null ? null : belowVwap, text: vwap === null ? 'VWAP not known yet' : `${belowVwap ? 'below' : 'above'} VWAP ${rs(vwap)}` },
    { id: 'ema', ok: !enough ? null : emaDown, text: !enough ? 'EMA trend after 6 candles (9:45)' : emaDown ? '5-minute trend down (EMA 9 below EMA 20)' : '5-minute trend not down yet' },
    { id: 'structure', ok: structure, text: structure === null ? 'lower highs / lows need 3 candles' : structure ? 'lower highs and lower lows — each bounce weaker' : 'no lower highs and lower lows' },
    {
      id: 'volume',
      ok: volumeOk,
      text: rvol === null ? 'usual volume not known yet' : `volume ${rvol.toFixed(1)}× its usual${redHeavy ? `, red candles ${greenV > 0 ? (redV / greenV).toFixed(1) + '×' : 'all'} the green` : lastRedSpike ? ', heavy last red candle' : ', selling not heavier than buying'}`,
    },
    {
      id: 'relative',
      ok: relative,
      text: relNifty === null ? 'NIFTY 50 not known yet' : `${pct(changePct)} today vs NIFTY ${pct(x.niftyDayPct!)}${x.sectorDayPct !== null ? `, its sector ${pct(x.sectorDayPct)}` : ' (sector not known)'}`,
    },
    { id: 'rsi', ok: rsiOk, text: rsiV === null ? 'RSI not known yet' : `RSI ${Math.round(rsiV)}${rsiOk ? ' — bearish momentum' : rsiV <= SHORT.rsiLo ? ' — oversold, bounces likely' : ' — not bearish yet'}` },
    {
      id: 'breakdown',
      ok: orLow === null ? null : breakdown,
      text: orLow === null ? 'opening range forms until 9:30' : breakdown ? `broke below ${brokeWhat} at ${hhmmT(breakdownT!)}` : `not below the opening-range low ${rs(orLow)}`,
    },
    { id: 'failed', ok: orHigh === null ? null : failed, text: orHigh === null ? 'opening range forms until 9:30' : failed ? `failed above the opening-range high ${rs(orHigh)} — fell back, sellers in charge` : 'no failed upward breakout' },
    {
      id: 'confirm',
      ok: confirm,
      text: !last ? 'no finished candle yet' : !conf5 ? 'last 5-minute candle not a red close near its low' : conf1 === null ? 'waiting for the 1-minute candles' : conf1 ? 'confirmed: red 5-minute close and 1-minute candles below the level' : '1-minute candles not confirming',
    },
  ];
  const score = Math.min(100, checks.reduce((s, c) => s + (c.ok ? WEIGHT[c.id] : 0), 0));

  // the plan: sell now after the trigger, else only below the opening-range low
  const tick = x.tick > 0 ? x.tick : 0.05;
  const trigger = breakdown || failed;
  const entry = trigger || orLow === null ? downTick(x.ltp, tick) : downTick(orLow - tick, tick);
  const highs = n ? b.h.slice(Math.max(0, n - 2), n) : [];
  const above = [vwap ?? 0, highs.length ? Math.max(...highs) : 0].filter((v) => v > entry);
  const stopRaw = above.length ? Math.min(...above) : entry * (1 + SHORT.minStopPct / 100);
  let stop = upTick(stopRaw + tick, tick);
  if ((stop - entry) / entry < SHORT.minStopPct / 100) stop = upTick(entry * (1 + SHORT.minStopPct / 100), tick);
  const stopPct = ((stop - entry) / entry) * 100;
  let stopTooFar: number | null = null;
  let plan: IntradayRow['plan'] = null;
  if (stopPct > SHORT.maxStopPct) stopTooFar = stopPct;
  else {
    const r = stop - entry;
    const t1 = downTick(entry - r, tick);
    const t2 = downTick(entry - 2 * r, tick);
    if (t2 > 0) plan = { entry, stop, target: t2, t1, rr: Math.round(((entry - t2) / r) * 100) / 100 };
  }
  const size = plan ? sizeShort({ entry: plan.entry, stop: plan.stop, t1: plan.t1!, t2: plan.target }, x.capital, x.maxRisk, tick) : null;

  const belowVwapPct = vwap ? (1 - x.ltp / vwap) * 100 : 0;
  const belowEmaPct = ema9 ? (1 - x.ltp / ema9) * 100 : 0;
  const stretched = belowVwapPct > SHORT.maxBelowVwapPct ? `${belowVwapPct.toFixed(1)}% below VWAP` : belowEmaPct > SHORT.maxBelowEma9Pct ? `${belowEmaPct.toFixed(1)}% below its 5-minute EMA 9` : null;

  const base = {
    key: x.key,
    symbol: x.symbol,
    side: 'sell' as const,
    score,
    checks,
    price: x.ltp,
    changePct,
    fromOpenPct,
    rvol,
    vwap,
    buyers,
    ema9,
    ema21: null,
    orHigh,
    breakoutT: null,
    plan,
    size,
    valueCr,
    at: x.now,
    orLow,
    breakdownT,
    level: level ?? (failed ? orHigh : null),
    rsi: rsiV,
    ema20,
    relNifty,
    relSector,
  };
  const no = (why: string) => ({ ...base, call: 'NO TRADE' as const, why, plan: null, size: null });
  const wait = (why: string) => ({ ...base, call: 'WAIT' as const, why: `sell-first: ${why}` });

  if (x.now - x.fetchedAt > INTRADAY.staleMs) return no('price is not fresh — waiting for a new one');
  if (x.ltp < INTRADAY.minPrice) return no(`price below ₹${INTRADAY.minPrice}`);
  if (valueCr !== null && valueCr < INTRADAY.minValueCr && x.t >= INTRADAY.orEndT) return no(`only ₹${valueCr.toFixed(2)} crore traded today — too thin to short`);
  if (x.t >= INTRADAY.lastT) return no('after 3:15 pm — the intraday day is over');
  if (changePct < SHORT.maxDayPct) return no(`already ${pct(changePct)} today — too late to short`);
  if (x.lowerCircuit && x.lowerCircuit > 0 && x.ltp <= x.lowerCircuit * 1.02) return no(`within 2% of its lower price band ₹${x.lowerCircuit.toFixed(2)} — no short (it can freeze there)`);
  if (vwap !== null && !belowVwap) {
    // falling but above VWAP: buyers are defending it — no short
    if (changePct <= -1) return no(`above VWAP ${rs(vwap)} — buyers defending it, no short`);
    return null;
  }
  if (x.t < INTRADAY.orEndT) return wait('the opening range forms until 9:30 — then a break below its low is needed');
  if (x.t > INTRADAY.buyUntilT) return wait('after 2:45 pm — too little time left for a new short');
  if (rsiV !== null && rsiV <= SHORT.rsiLo) return wait(`oversold (RSI ${Math.round(rsiV)}) — bounces are likely, do not chase`);
  if (stretched) return wait(`stretched: ${stretched} — wait for a pullback up, do not chase`);
  if (stopTooFar !== null) return wait(`the buy-back stop would be ${stopTooFar.toFixed(1)}% away — too far; wait for a tighter setup`);
  if (!trigger)
    return wait(
      orLow === null ? 'waiting for a breakdown' : x.ltp < orLow ? `below the opening-range low ${rs(orLow)} — waiting for a 5-minute candle to close below it` : `waiting for a break below the opening-range low ${rs(orLow)}`,
    );
  if (rvol === null) return wait('usual volume not known yet — no short without it');
  if (!volumeOk) return wait(`selling volume not rising enough (${rvol.toFixed(1)}× usual; a short needs ${SHORT.rvolSell}× with heavy red candles)`);
  if (!emaDown) return wait(ema9 === null ? 'the 5-minute trend shows after 9:45' : 'the 5-minute trend is not down (EMA 9 not below EMA 20)');
  if (!structure && !failed) return wait('no lower highs and lower lows yet');
  if (relative === null) return wait('NIFTY 50 price not known yet — no short without it');
  if (!relative) return wait('not weaker than NIFTY and its sector — no short');
  if (rsiV === null) return wait('RSI not known yet');
  if (!rsiOk) return wait(`momentum not bearish yet (RSI ${Math.round(rsiV)}; a short needs ${SHORT.rsiLo}–${SHORT.rsiHi})`);
  if (confirm === null) return wait('waiting for the 1-minute candles to confirm');
  if (!confirm) return wait(`waiting for a red 5-minute close and 1-minute candles below ${trig !== null ? rs(trig) : 'the level'}`);
  if (x.marketStrong) return wait('the market is rising — no shorts now');
  if (!size?.ok) return wait(size?.why ?? 'no trade size fits your risk limit');
  const why = breakdown
    ? `breakdown below ${brokeWhat} at ${hhmmT(breakdownT!)} — selling volume ${rvol.toFixed(1)}×, below VWAP, weaker than NIFTY`
    : `failed breakout above ${rs(orHigh!)} — sellers took over, volume ${rvol.toFixed(1)}×, below VWAP`;
  return { ...base, call: 'SELL', why };
}
