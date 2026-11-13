import { formatNumberIN } from '../lib/format';
import type { Flag, SetupLabel, Trend } from '../indicators/snapshot';

/**
 * Trade planner maths (spec §11). Pure. Read-only: produces an order ticket for the owner to type
 * into the Upstox app — nothing is ever sent to the broker.
 */

export type StopMethod = 'atr' | 'swingLow' | 'manual';
export type TargetMethod = 'history' | '2R' | '3R' | 'resistance' | 'manual';

export interface PlanSettings {
  capitalInr: number | null;
  riskPerTradePct: number;
  riskPerTradeCapPct: number;
  maxOpenTrades: number;
  maxTotalOpenRiskPct: number;
  chargesEstimatePct: number | null;
  stopAtrMultiple: number;
  swingLowBufferAtr: number;
  minRewardToRisk: number;
  positionPctWarn: number;
  resultsWindowDays: number;
}

export interface PlanInput {
  symbol: string;
  entry: number;
  /** price step in ₹ (instrument tick_size / 100) */
  tick: number;
  stopMethod: StopMethod;
  manualStop?: number | null;
  targetMethod: TargetMethod;
  manualTarget?: number | null;
  atr: number | null;
  lastSwingLow: number | null;
  /** resistance levels, any order */
  resistances: number[];
  /** history study levels in ATRs above entry (target method 'history') */
  history?: { safeAtr: number; holdAtr: number } | null;
  /** 'split' sizing: ₹ to put into this stock (quantity = allocation ÷ price). Otherwise risk-based. */
  allocation?: number | null;
  /** risk % for this trade (defaults to settings) */
  riskPct?: number;
  settings: PlanSettings;
  snapshot?: { flags: Flag[]; setup: SetupLabel; trend: Trend | null } | null;
  /** ₹ at risk of other trades that are planned or open */
  otherOpenRisks: number[];
  /** next results / board-meeting date (YYYY-MM-DD) if known */
  resultsDate?: string | null;
  today: string;
}

export interface Guardrail {
  level: 'warn' | 'block';
  text: string;
}

export interface PlanResult {
  ok: boolean;
  errors: string[];
  entry: number;
  stop: number;
  target: number;
  riskPerShare: number;
  qty: number;
  positionValue: number;
  positionPct: number | null;
  riskRupees: number;
  rewardRupees: number;
  rr: number;
  /** 'history' plans: hold-until target (null if not above the safe target) */
  holdTarget: number | null;
  targetMode: 'fixed' | 'history';
  riskPctUsed: number;
  charges: number | null;
  breakeven: number | null;
  stopLimit: number;
  guardrails: Guardrail[];
}

const EPS = 1e-9;
const fix = (x: number) => Number(x.toFixed(4));

export function roundUpToTick(x: number, tick: number): number {
  return fix(Math.ceil(x / tick - EPS) * tick);
}
export function roundDownToTick(x: number, tick: number): number {
  return fix(Math.floor(x / tick + EPS) * tick);
}
export function roundToTick(x: number, tick: number): number {
  return fix(Math.round(x / tick) * tick);
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

const empty = (errors: string[], riskPctUsed: number): PlanResult => ({
  ok: false,
  errors,
  entry: 0,
  stop: 0,
  target: 0,
  riskPerShare: 0,
  qty: 0,
  positionValue: 0,
  positionPct: null,
  riskRupees: 0,
  rewardRupees: 0,
  rr: 0,
  holdTarget: null,
  targetMode: 'fixed',
  riskPctUsed,
  charges: null,
  breakeven: null,
  stopLimit: 0,
  guardrails: [],
});

export function computePlan(inp: PlanInput): PlanResult {
  const s = inp.settings;
  const tick = inp.tick > 0 ? inp.tick : 0.05;
  const guard: Guardrail[] = [];
  const wantedRisk = inp.riskPct ?? s.riskPerTradePct;
  const riskPctUsed = Math.min(wantedRisk, s.riskPerTradeCapPct);
  if (wantedRisk > s.riskPerTradeCapPct) guard.push({ level: 'warn', text: `Risk ${wantedRisk}% is above your cap of ${s.riskPerTradeCapPct}%; ${s.riskPerTradeCapPct}% is used.` });

  const errors: string[] = [];
  if (!s.capitalInr || s.capitalInr <= 0) errors.push('Enter your trading capital in Settings → Capital and risk.');
  if (!(inp.entry > 0)) errors.push('Enter an entry price.');
  if (errors.length) return empty(errors, riskPctUsed);

  const entry = roundUpToTick(inp.entry, tick);

  // ---- stop
  let rawStop: number | null = null;
  if (inp.stopMethod === 'atr') {
    if (!inp.atr) errors.push('ATR not available (not enough candle data). Use a manual stop.');
    else rawStop = entry - s.stopAtrMultiple * inp.atr;
  } else if (inp.stopMethod === 'swingLow') {
    if (inp.lastSwingLow === null || !inp.atr) errors.push('No swing low below the entry was found. Use the ATR or a manual stop.');
    else rawStop = inp.lastSwingLow - s.swingLowBufferAtr * inp.atr;
  } else {
    if (!inp.manualStop || inp.manualStop <= 0) errors.push('Enter a stop-loss price.');
    else rawStop = inp.manualStop;
  }
  if (rawStop === null) return empty(errors, riskPctUsed);
  const stop = roundDownToTick(rawStop, tick);
  if (stop >= entry) return empty(['The stop must be below the entry price.'], riskPctUsed);
  if (stop <= 0) return empty(['The stop works out at ₹0 or less — the stock is too volatile for this stop method.'], riskPctUsed);
  const riskPerShare = fix(entry - stop);

  // ---- target
  let target: number | null = null;
  let holdTarget: number | null = null;
  if (inp.targetMethod === 'history') {
    if (!inp.history || !inp.atr) return empty(['Not enough price history for the history-based targets. Use 2R or a manual target.'], riskPctUsed);
    target = roundDownToTick(entry + inp.history.safeAtr * inp.atr, tick);
    const hold = roundDownToTick(entry + inp.history.holdAtr * inp.atr, tick);
    // show a hold-until level only when it is meaningfully above the profit target (≥ half a typical day's move)
    holdTarget = hold >= target + Math.max(tick, 0.5 * inp.atr) ? hold : null;
    if (target <= entry) {
      return empty(['History: in similar past periods this stock usually fell back before rising — the safe level is not above the entry. Skip this trade, or use a fixed target.'], riskPctUsed);
    }
  } else if (inp.targetMethod === '2R' || inp.targetMethod === '3R') {
    const r = inp.targetMethod === '2R' ? 2 : 3;
    target = roundUpToTick(entry + r * riskPerShare, tick);
  } else if (inp.targetMethod === 'resistance') {
    const above = inp.resistances.filter((x) => x > entry).sort((a, b) => a - b);
    if (!above.length) return empty(['No resistance level above the entry. Use 2R/3R or a manual target.'], riskPctUsed);
    target = roundDownToTick(above[0]!, tick);
  } else {
    if (!inp.manualTarget || inp.manualTarget <= 0) return empty(['Enter a target price.'], riskPctUsed);
    target = roundToTick(inp.manualTarget, tick);
  }
  if (target <= entry) return empty(['The target must be above the entry price.'], riskPctUsed);

  // ---- size
  const capital = s.capitalInr!;
  const riskBudget = (capital * riskPctUsed) / 100;
  let qty: number;
  if (inp.allocation && inp.allocation > 0) {
    qty = Math.floor(inp.allocation / entry + EPS);
    if (qty < 1) {
      return { ...empty([`₹${formatNumberIN(inp.allocation, 0)} is not enough for one share at ₹${formatNumberIN(entry)}.`], riskPctUsed), entry, stop, target, riskPerShare };
    }
  } else {
    qty = Math.floor(riskBudget / riskPerShare + EPS);
    const affordable = Math.floor(capital / entry + EPS);
    if (qty > affordable) {
      guard.push({ level: 'warn', text: `Quantity limited to ${affordable} by your capital (the risk rule alone would allow ${qty}).` });
      qty = affordable;
    }
  }
  if (qty < 1) {
    return {
      ...empty([`One share risks ₹${formatNumberIN(riskPerShare)}, more than your ₹${formatNumberIN(riskBudget)} risk budget (${riskPctUsed}% of capital). Skip this trade or use a closer stop.`], riskPctUsed),
      entry,
      stop,
      target,
      riskPerShare,
    };
  }

  const positionValue = fix(qty * entry);
  const positionPct = (positionValue / capital) * 100;
  const riskRupees = fix(qty * riskPerShare);
  const rewardRupees = fix(qty * (target - entry));
  const rr = (target - entry) / riskPerShare;
  const charges = s.chargesEstimatePct !== null ? fix((positionValue * s.chargesEstimatePct) / 100) : null;
  const breakeven = charges !== null ? roundUpToTick(entry + charges / qty, tick) : null;
  const stopLimit = Math.max(tick, roundDownToTick(stop * 0.995, tick));

  // ---- guardrails (spec §11)
  const flags = inp.snapshot?.flags ?? [];
  if (flags.includes('Possible unadjusted action')) guard.push({ level: 'warn', text: 'Price history may be missing a bonus/split adjustment — the indicators could be wrong. Check the chart first.' });
  if (flags.includes('Below 200-day')) guard.push({ level: 'warn', text: 'Price is below the 200-day average (long-term downtrend). The playbook says no swing longs.' });
  if (flags.includes('Stretched')) guard.push({ level: 'warn', text: 'Stretched: price is far above its 20-day average or RSI is above 70. Wait for a pullback.' });
  if (flags.includes('Low liquidity')) guard.push({ level: 'warn', text: 'Low liquidity (under ₹10 crore traded per day). Fills and exits may be poor.' });
  if (flags.includes('Stale data')) guard.push({ level: 'warn', text: 'Price data is stale. Refresh before ordering.' });
  if (inp.snapshot && (inp.snapshot.setup === 'No setup' || inp.snapshot.trend === 'Downtrend')) guard.push({ level: 'warn', text: `No valid setup (${inp.snapshot.trend ?? 'trend unknown'}, ${inp.snapshot.setup}).` });
  if (inp.targetMethod === 'history') {
    const holdRr = holdTarget !== null ? (holdTarget - entry) / riskPerShare : rr;
    if (rr + EPS < 1) guard.push({ level: 'warn', text: `The safe target is only ${rr.toFixed(2)}R: in the past year this stock usually moved less than your risk. The trade may not be worth it.` });
    if (holdRr + EPS < s.minRewardToRisk) guard.push({ level: 'warn', text: `Even the hold-until target is only ${holdRr.toFixed(2)}R, below your ${s.minRewardToRisk}R minimum.` });
  } else if (rr + EPS < s.minRewardToRisk) {
    guard.push({ level: 'warn', text: `Reward-to-risk is ${rr.toFixed(2)}R, below your minimum of ${s.minRewardToRisk}R.` });
  }
  if (!inp.allocation && positionPct > s.positionPctWarn) guard.push({ level: 'warn', text: `This position is ${positionPct.toFixed(0)}% of your capital (warning above ${s.positionPctWarn}%).` });
  if (inp.otherOpenRisks.length >= s.maxOpenTrades) guard.push({ level: 'warn', text: `You already have ${inp.otherOpenRisks.length} planned/open trades (max ${s.maxOpenTrades}).` });
  const totalRisk = inp.otherOpenRisks.reduce((a, b) => a + b, 0) + riskRupees;
  if ((totalRisk / capital) * 100 > s.maxTotalOpenRiskPct) guard.push({ level: 'warn', text: `Total risk across trades would be ₹${formatNumberIN(totalRisk, 0)} (${((totalRisk / capital) * 100).toFixed(1)}% of capital), above your ${s.maxTotalOpenRiskPct}% limit.` });
  if (inp.resultsDate) {
    const d = daysBetween(inp.today, inp.resultsDate);
    if (d >= 0 && d <= s.resultsWindowDays) guard.push({ level: 'warn', text: `Results/event in ${d} day(s) (${inp.resultsDate}). The playbook avoids new entries within ${s.resultsWindowDays} days.` });
  }
  if (charges === null) guard.push({ level: 'warn', text: 'Charges not included — set a charges estimate in Settings to see the breakeven price.' });

  return {
    ok: true,
    errors: [],
    entry,
    stop,
    target,
    riskPerShare,
    qty,
    positionValue,
    positionPct,
    riskRupees,
    rewardRupees,
    rr,
    holdTarget,
    targetMode: inp.targetMethod === 'history' ? 'history' : 'fixed',
    riskPctUsed: inp.allocation ? Number(((riskRupees / capital) * 100).toFixed(2)) : riskPctUsed,
    charges,
    breakeven,
    stopLimit,
    guardrails: guard,
  };
}

const rs = (x: number) => `₹${formatNumberIN(x, 2)}`;

/** Order ticket text (spec §11) for manual entry in the Upstox app. */
export function orderTicket(symbol: string, p: PlanResult, planId: string): string {
  if (p.targetMode === 'history') {
    return [
      `BUY  ${symbol}  qty ${p.qty}  LIMIT ${rs(p.entry)}  product CNC`,
      'Then immediately create a GTT stop-loss in Upstox (single leg):',
      `  Stop-loss: trigger ${rs(p.stop)}, limit ${rs(p.stopLimit)}`,
      `  No fixed target. The extension will advise: safe ${rs(p.target)}${p.holdTarget !== null ? ` · hold-until ${rs(p.holdTarget)}` : ''}`,
      `Risk ₹${formatNumberIN(p.riskRupees, 0)}  ·  At safe target ₹${formatNumberIN(p.rewardRupees, 0)}  ·  ${p.rr.toFixed(1)}R  ·  plan id ${planId}`,
    ].join('\n');
  }
  return [
    `BUY  ${symbol}  qty ${p.qty}  LIMIT ${rs(p.entry)}  product CNC`,
    'Then immediately create a GTT in Upstox:',
    `  Stop-loss: trigger ${rs(p.stop)}, limit ${rs(p.stopLimit)}`,
    `  Target:    ${rs(p.target)}`,
    `Risk ₹${formatNumberIN(p.riskRupees, 0)}  ·  Potential ₹${formatNumberIN(p.rewardRupees, 0)}  ·  ${p.rr.toFixed(1)}R  ·  plan id ${planId}`,
  ].join('\n');
}
