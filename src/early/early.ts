import { intradayCharges } from '../daytrade/rules';
import type { Bars } from '../daytrade/types';
import type { RiseCtx, Running } from '../rising/momentum';

/**
 * App v1.15 — "Early Movers — Before the Rally": stocks getting ready to rise BEFORE a big move, not
 * after 8–10 %. Pure rules, the same live (on every live price) and in the past test.
 *
 * A stock is a **potential setup** when, at the same time:
 *   - it has not run yet: up less than 4 % today and less than 2.5 % since the open;
 *   - buyers are in charge: price at or above the day's average price (VWAP) and above EMA 9 (5-minute);
 *   - momentum without overheating: RSI (14, 5-minute) between 50 and 72;
 *   - unusual volume: today's volume so far, or the last 5 minutes, at least 2× the usual for that time;
 *   - it is coiling under a ceiling: within 1.5 % below its resistance (today's high so far, or
 *     yesterday's high when that is just above), with higher lows over the last three candles or
 *     within 0.6 % of the resistance.
 * It becomes a **breakout (live, not confirmed)** the moment a live price crosses the breakout price
 * (resistance + one tick) with the candle's volume at least 1.5× usual — no waiting for the candle to
 * close — and a **confirmed breakout** when that 5-minute candle closes above the resistance. A candle
 * closing back below is a false breakout (removed). These thresholds were fixed before any testing;
 * the past test (earlyTest.ts) reports them as they are — nothing is tuned to past winners.
 */

export const EARLY = {
  maxDayPct: 4,
  maxFromOpenPct: 2.5,
  rsiLo: 50,
  rsiHi: 72,
  rvol: 2,
  nearPct: 1.5,
  tightPct: 0.6,
  breakoutVol: 1.5,
  minStopPct: 0.3,
  maxStopPct: 1.2,
  firstT: 9 * 60 + 20,
  lastT: 14 * 60 + 30,
  /** a setup that has not broken out within this many minutes is dropped */
  setupMin: 45,
  /** a confirmed breakout stays listed this long (minutes) */
  confirmedMin: 15,
} as const;

/** One tick of slippage at the stop is counted in the risk. */
const EXIT_SLIP_TICKS = 1;

export interface Look {
  price: number;
  changePct: number;
  fromOpenPct: number;
  /** opening gap vs yesterday's close, % (null before the open is known) */
  gapPct: number | null;
  vwap: number;
  ema9: number;
  rsi: number | null;
  /** today's volume so far vs usual by now, and the last 5-minute candle vs usual (×); null without history */
  rvolDay: number | null;
  rvolBar: number | null;
  higherLows: boolean;
  /** the ceiling: today's high before this candle, or yesterday's high when that is just above */
  resistance: number;
  /** how far below the resistance, % (negative = above it) */
  belowPct: number;
  /** lowest low of the last three candles */
  low3: number;
  /** minutes since midnight IST (the candle's end for finished candles) */
  t: number;
}

export interface LookIn {
  b: Bars;
  run: Running;
  /** index of the candle being read (the live one in progress, or a finished one in the past test) */
  i: number;
  /** price now (live) — the candle's close in the past test */
  price: number;
  prevClose: number | null;
  prevHigh: number | null;
  usual: RiseCtx['usual'];
  /** the candle's volume is still growing: compare it with the usual for the part of 5 minutes seen */
  partialShare?: number;
}

/** What the numbers say about a stock now. Null before 9:20 or without enough candles. */
export function lookAt(x: LookIn): Look | null {
  const { b, run, i } = x;
  if (i < 1 || !(x.price > 0)) return null;
  const t = b.t[i]! + 5;
  const open = b.o[0]!;
  let hiBefore = -Infinity;
  for (let k = 0; k < i; k++) hiBefore = Math.max(hiBefore, b.h[k]!);
  let resistance = hiBefore;
  if (x.prevHigh && x.prevHigh > resistance && x.prevHigh <= x.price * (1 + EARLY.nearPct / 100)) resistance = x.prevHigh;
  const u = x.usual(b.t[i]!);
  const share = Math.max(0.2, Math.min(1, x.partialShare ?? 1));
  const rvolBar = u.bar && u.bar > 0 ? b.v[i]! / (u.bar * share) : null;
  const cumBefore = i > 0 ? run.cumV[i - 1]! : 0;
  const uPrev = i > 0 ? x.usual(b.t[i - 1]!).cum : null;
  const usualNow = u.cum !== null && uPrev !== null ? uPrev + (u.cum - uPrev) * share : u.cum;
  const rvolDay = usualNow && usualNow > 0 ? (cumBefore + b.v[i]!) / usualNow : null;
  const l3 = [b.l[Math.max(0, i - 2)]!, b.l[Math.max(0, i - 1)]!, b.l[i]!];
  return {
    price: x.price,
    changePct: x.prevClose ? (x.price / x.prevClose - 1) * 100 : (x.price / open - 1) * 100,
    fromOpenPct: (x.price / open - 1) * 100,
    gapPct: x.prevClose ? (open / x.prevClose - 1) * 100 : null,
    vwap: run.vwap[i]!,
    ema9: run.ema9[i]!,
    rsi: run.rsi[i] ?? null,
    rvolDay,
    rvolBar,
    higherLows: i >= 2 && l3[2]! > l3[1]! && l3[1]! > l3[0]!,
    resistance,
    belowPct: (resistance / x.price - 1) * 100,
    low3: Math.min(...l3),
    t,
  };
}

/** Which of the setup's conditions hold (all must), in plain words. */
export function setupCheck(l: Look): { ok: boolean; why: string[]; missing: string[] } {
  const why: string[] = [];
  const missing: string[] = [];
  const need = (ok: boolean, yes: string, no: string) => (ok ? why.push(yes) : missing.push(no));
  need(l.t >= EARLY.firstT && l.t <= EARLY.lastT, 'in the trading window (9:20–2:30)', 'outside 9:20–2:30');
  need(l.changePct < EARLY.maxDayPct && l.fromOpenPct < EARLY.maxFromOpenPct, `has not run yet (${l.changePct >= 0 ? '+' : ''}${l.changePct.toFixed(1)}% today)`, 'already up too much — late');
  need(l.price >= l.vwap, "at or above the day's average price (VWAP)", "below the day's average price");
  need(l.price > l.ema9, 'above its 5-minute EMA 9', 'below EMA 9');
  need(l.rsi !== null && l.rsi >= EARLY.rsiLo && l.rsi <= EARLY.rsiHi, `RSI ${l.rsi?.toFixed(0)} — momentum, not overheated`, l.rsi !== null && l.rsi > EARLY.rsiHi ? 'RSI overheated' : 'RSI too weak');
  const vol = Math.max(l.rvolDay ?? 0, l.rvolBar ?? 0);
  need(vol >= EARLY.rvol, `${vol.toFixed(1)}× its usual volume`, l.rvolDay === null && l.rvolBar === null ? 'no usual volume known yet' : 'volume not unusual');
  need(l.belowPct <= EARLY.nearPct, l.belowPct > 0 ? `${l.belowPct.toFixed(2)}% under its resistance ₹${l.resistance.toFixed(2)}` : `at its resistance ₹${l.resistance.toFixed(2)}`, 'far from its resistance');
  need(l.higherLows || l.belowPct <= EARLY.tightPct, l.higherLows ? 'higher lows (buyers stepping in earlier)' : 'pressing right under the resistance', 'no higher lows');
  return { ok: missing.length === 0, why, missing };
}

export const upTick = (x: number, tick: number) => Math.round(Math.ceil(x / tick - 1e-9) * tick * 100) / 100;
export const downTick = (x: number, tick: number) => Math.round(Math.floor(x / tick + 1e-9) * tick * 100) / 100;

export interface EarlyPlan {
  /** breakout price: buy only above it */
  breakout: number;
  entry: number;
  stop: number;
  t1: number;
  t2: number;
}

/**
 * The trade: buy at the breakout price (resistance + 1 tick); stop under the higher of the day's average
 * price and the last 15 minutes' low (0.3–1.2 % below the entry); targets at 1× and 2× that distance.
 */
export function planFor(l: Look, tick = 0.05): EarlyPlan {
  const breakout = upTick(l.resistance + tick, tick);
  const entry = Math.max(breakout, upTick(l.price, tick));
  const base = Math.max(l.vwap, l.low3) - tick;
  let dist = entry - base;
  dist = Math.min(entry * (EARLY.maxStopPct / 100), Math.max(entry * (EARLY.minStopPct / 100), dist));
  const stop = downTick(entry - dist, tick);
  const r = entry - stop;
  return { breakout, entry, stop, t1: upTick(entry + r, tick), t2: upTick(entry + 2 * r, tick) };
}

export interface Size {
  ok: boolean;
  qty: number;
  value: number;
  /** most it can lose at the stop, after all charges and one tick of slippage */
  risk: number;
  charges: number;
  /** after charges if half is sold at target 1 and half at target 2 */
  reward: number;
  why?: string;
}

/**
 * Shares for your capital and risk limit: the most shares whose loss at the stop — the price drop, one
 * tick of slippage, and every Upstox Intraday charge — stays within `maxRisk`, without spending more
 * than `capital` (no borrowing). Not ok (= no trade) when even one share would break the limit.
 */
export function sizeTrade(p: Pick<EarlyPlan, 'entry' | 'stop' | 't1' | 't2'>, capital: number, maxRisk: number, tick = 0.05): Size {
  const lossAt = (q: number) => {
    const exit = p.stop - EXIT_SLIP_TICKS * tick;
    const ch = intradayCharges(q * p.entry, q * exit);
    return { risk: q * (p.entry - exit) + ch, ch };
  };
  let q = Math.floor(capital / p.entry);
  if (q < 1) return { ok: false, qty: 0, value: 0, risk: 0, charges: 0, reward: 0, why: `one share costs ₹${p.entry.toFixed(2)} — more than the ₹${Math.round(capital).toLocaleString('en-IN')} capital` };
  // the risk grows with the quantity: step down from the most the capital buys
  let hi = q;
  let lo = 0;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (lossAt(mid).risk <= maxRisk) lo = mid;
    else hi = mid - 1;
  }
  q = lo;
  if (q < 1) {
    const one = lossAt(1).risk;
    return { ok: false, qty: 0, value: 0, risk: one, charges: lossAt(1).ch, reward: 0, why: `even 1 share risks ₹${one.toFixed(0)} with charges — more than ₹${maxRisk}` };
  }
  const { risk, ch } = lossAt(q);
  const h1 = Math.floor(q / 2);
  const h2 = q - h1;
  const sell = h1 * p.t1 + h2 * p.t2;
  const reward = sell - q * p.entry - intradayCharges(q * p.entry, sell);
  return { ok: true, qty: q, value: Math.round(q * p.entry * 100) / 100, risk: Math.round(risk * 100) / 100, charges: Math.round(ch * 100) / 100, reward: Math.round(reward * 100) / 100 };
}

// ---------------------------------------------------------------- live stages

export type Stage = 'setup' | 'breakout' | 'confirmed';

export interface EarlyState {
  stage: Stage | 'expired';
  /** the resistance it is measured against (frozen when the setup appears) */
  level: number;
  plan: EarlyPlan;
  since: number;
  /** start (minutes) of the candle in which it broke out */
  breakT?: number;
  breakAt?: number;
  confirmedAt?: number;
  expiredWhy?: string;
}

export type EarlyEvent = 'setup' | 'breakout' | 'confirmed' | 'expired' | null;

/**
 * One step of a stock's life in the list, on a live price. `lastDone` = the latest finished 5-minute
 * candle (to confirm or reject a breakout). Pure.
 */
export function stepEarly(
  s: EarlyState | null,
  l: Look,
  now: number,
  slotT: number,
  lastDone: { t: number; c: number; v: number; usualBar: number | null } | null,
  tick = 0.05,
): { state: EarlyState | null; event: EarlyEvent } {
  const check = setupCheck(l);
  if (!s || s.stage === 'expired') {
    // a stock that expired today can come back only above its old level (a new, higher ceiling)
    if (s && s.stage === 'expired' && l.resistance <= s.level * 1.003) return { state: s, event: null };
    if (!check.ok) return { state: s, event: null };
    const plan = planFor(l, tick);
    const fresh: EarlyState = { stage: 'setup', level: l.resistance, plan, since: now };
    // already crossing with volume: straight to a live breakout
    if (l.price >= plan.breakout && (l.rvolBar ?? 0) >= EARLY.breakoutVol) return { state: { ...fresh, stage: 'breakout', breakT: slotT, breakAt: now }, event: 'breakout' };
    return { state: fresh, event: 'setup' };
  }
  const R = s.plan.entry - s.plan.stop;
  const expire = (why: string) => ({ state: { ...s, stage: 'expired' as const, expiredWhy: why }, event: 'expired' as const });
  if (s.stage === 'setup') {
    if (l.price < s.plan.stop || l.price < l.vwap) return expire(l.price < s.plan.stop ? 'fell to the stop before breaking out' : "fell below the day's average price");
    if (now - s.since > EARLY.setupMin * 60_000) return expire(`no breakout within ${EARLY.setupMin} minutes`);
    if (l.changePct >= EARLY.maxDayPct + 1) return expire('ran up without a clean breakout');
    if (l.price >= s.plan.breakout && (l.rvolBar ?? 0) >= EARLY.breakoutVol) return { state: { ...s, stage: 'breakout', breakT: slotT, breakAt: now }, event: 'breakout' };
    return { state: s, event: null };
  }
  if (l.price > s.plan.entry + R) return expire('ran more than 1× the risk above the entry — too late to buy');
  if (l.price < s.plan.stop) return expire('fell to the stop');
  if (s.stage === 'breakout') {
    if (lastDone && s.breakT !== undefined && lastDone.t >= s.breakT) {
      if (lastDone.c > s.level) return { state: { ...s, stage: 'confirmed', confirmedAt: now }, event: 'confirmed' };
      return expire('the 5-minute candle closed back below the resistance — a false breakout');
    }
    if (now - (s.breakAt ?? now) > 11 * 60_000) return expire('not confirmed in time');
    return { state: s, event: null };
  }
  if (now - (s.confirmedAt ?? now) > EARLY.confirmedMin * 60_000) return expire(`confirmed more than ${EARLY.confirmedMin} minutes ago — too late`);
  return { state: s, event: null };
}

// ---------------------------------------------------------------- the score and why

export interface Signs {
  look: Look;
  stage: Stage;
  /** positive / negative catalyst today (null = none found in the headlines read) */
  catalyst: { tone: 'good' | 'bad' | 'neutral'; kind: string } | null;
  /** the learned Rising-now tag, when there is one */
  rise: 'strong' | 'unclear' | 'fading' | null;
  /** NSE bulk / block deal BUY (latest file), delivery % (latest day) */
  dealBuy: boolean;
  dealSell: boolean;
  deliveryPct: number | null;
  /** sector's and whole market's average move since the open, % */
  sectorPct: number | null;
  marketPct: number | null;
  /** waiting buy orders' share (full live feed), 0–1 */
  buyShare: number | null;
}

/**
 * Score 0–100: how many independent signs agree, each worth fixed points (set in advance, not fitted).
 * NOT a chance of rising — the past test says how setups like these did.
 */
export function scoreEarly(s: Signs): { score: number; reasons: string[]; warnings: string[] } {
  let p = 20;
  const reasons: string[] = [];
  const warnings: string[] = [];
  const l = s.look;
  const vol = Math.max(l.rvolDay ?? 0, l.rvolBar ?? 0);
  if (vol >= 3) (p += 15), reasons.push(`${vol.toFixed(1)}× usual volume`);
  else if (vol >= 2) (p += 10), reasons.push(`${vol.toFixed(1)}× usual volume`);
  if ((l.rvolBar ?? 0) >= 2) (p += 5), reasons.push('sudden volume in the last 5 minutes');
  if (s.buyShare !== null && s.buyShare >= 0.6) (p += 5), reasons.push(`${Math.round(s.buyShare * 100)}% of waiting orders are buys`);
  if (l.higherLows) (p += 5), reasons.push('higher lows');
  if (l.price > l.vwap * 1.001) (p += 5), reasons.push("above the day's average price");
  if (l.rsi !== null && l.rsi >= 55 && l.rsi <= 68) p += 5;
  if (l.gapPct !== null && l.gapPct >= 1 && l.gapPct <= 4 && l.price >= l.vwap) (p += 5), reasons.push(`gapped up ${l.gapPct.toFixed(1)}% and holding`);
  if (s.stage === 'breakout') (p += 5), reasons.push('breaking out now (live)');
  if (s.stage === 'confirmed') (p += 10), reasons.push('breakout confirmed by the 5-minute close');
  if (s.catalyst?.tone === 'good') (p += 15), reasons.push(`news: ${s.catalyst.kind}`);
  if (s.catalyst?.tone === 'bad') (p -= 25), warnings.push(`bad news today (${s.catalyst.kind})`);
  if (s.rise === 'strong') (p += 10), reasons.push('learned check: likely to keep rising');
  if (s.rise === 'fading') (p -= 10), warnings.push('learned check: slowing');
  if (s.dealBuy) (p += 5), reasons.push('bulk/block deal BUY in the latest NSE file');
  if (s.dealSell) (p -= 5), warnings.push('bulk/block deal SELL in the latest NSE file');
  if (s.deliveryPct !== null && s.deliveryPct >= 55) (p += 3), reasons.push(`${s.deliveryPct.toFixed(0)}% delivery last session`);
  if (s.sectorPct !== null && s.marketPct !== null && s.sectorPct > s.marketPct + 0.3) (p += 5), reasons.push('its sector is stronger than the market');
  if (s.marketPct !== null && s.marketPct < -0.4) (p -= 10), warnings.push('the whole market is falling');
  if (l.changePct > 3) (p -= 5), warnings.push(`already +${l.changePct.toFixed(1)}% today`);
  return { score: Math.max(0, Math.min(100, Math.round(p))), reasons, warnings };
}
