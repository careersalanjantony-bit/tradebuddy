import { formatNumberIN } from '../lib/format';

/**
 * Alert rules (spec §12) — pure evaluation. The service worker feeds prices in and stores results.
 *  - above / below: price CROSSES a level (not "is above"); 0.1% hysteresis band stops flapping.
 *  - stop / target / nearStop / oneR: touch rules for a trade plan, one-shot.
 *  - closeBelowSma20: end-of-day rule, fires when the close moves below the 20-day average.
 * Never evaluate with stale prices (the caller checks).
 */

export type AlertKind = 'above' | 'below' | 'stop' | 'target' | 'safeTarget' | 'holdTarget' | 'nearStop' | 'oneR' | 'closeBelowSma20';

export interface AlertRule {
  id: string;
  key: string; // instrument key
  symbol: string;
  kind: AlertKind;
  /** price level (for closeBelowSma20: unused, 0) */
  level: number;
  planId?: string;
  /** for oneR: the plan's entry, shown as the breakeven stop */
  entry?: number;
  repeat: boolean;
  cooldownMinutes: number;
  active: boolean;
  createdAt: number;
  lastFiredAt?: number;
  /** last known side of the level (cross detection), persisted across restarts */
  side?: 'above' | 'below';
  firedCount: number;
  note?: string;
}

export interface AlertFiring {
  ruleId: string;
  key: string;
  symbol: string;
  kind: AlertKind;
  level: number;
  price: number;
  ts: number;
  message: string;
  /** stop / target: stays on screen until dismissed */
  critical: boolean;
}

export const CRITICAL_KINDS: AlertKind[] = ['stop', 'target', 'safeTarget', 'holdTarget'];

const rs = (x: number) => `₹${formatNumberIN(x, 2)}`;

export function alertMessage(rule: AlertRule, price: number, extra?: { sma20?: number }): string {
  const s = rule.symbol;
  switch (rule.kind) {
    case 'above':
      return `${s} crossed above ${rs(rule.level)} (now ${rs(price)}).`;
    case 'below':
      return `${s} crossed below ${rs(rule.level)} (now ${rs(price)}).`;
    case 'stop':
      return `${s} hit your STOP ${rs(rule.level)} (now ${rs(price)}). Your plan says exit.`;
    case 'target':
      return `${s} reached your TARGET ${rs(rule.level)} (now ${rs(price)}).`;
    case 'safeTarget':
      return `${s} reached the SAFE target ${rs(rule.level)} (now ${rs(price)}). Open the extension for hold-or-sell advice.`;
    case 'holdTarget':
      return `${s} reached the HOLD-UNTIL target ${rs(rule.level)} (now ${rs(price)}) — the top of its usual range. Consider booking profit.`;
    case 'nearStop':
      return `${s} is within 1% of your stop (now ${rs(price)}).`;
    case 'oneR':
      return `${s} is up 1R (now ${rs(price)}). Consider moving the stop to breakeven${rule.entry ? ` ${rs(rule.entry)}` : ''}.`;
    case 'closeBelowSma20':
      return `${s} closed below its 20-day average (close ${rs(price)}${extra?.sma20 ? `, SMA20 ${rs(extra.sma20)}` : ''}).`;
  }
}

/** Side of `level` with a hysteresis band; inside the band the previous side is kept. */
export function sideOf(price: number, level: number, hysteresisPct: number, prev?: 'above' | 'below'): 'above' | 'below' | undefined {
  const h = hysteresisPct / 100;
  if (price >= level * (1 + h)) return 'above';
  if (price <= level * (1 - h)) return 'below';
  return prev;
}

function cooledDown(rule: AlertRule, now: number): boolean {
  return rule.lastFiredAt === undefined || now - rule.lastFiredAt >= rule.cooldownMinutes * 60_000;
}

/** Evaluates one intraday rule against a fresh price. Returns the updated rule and an optional firing. */
export function evaluateRule(rule: AlertRule, price: number, now: number, hysteresisPct = 0.1): { rule: AlertRule; firing: AlertFiring | null } {
  if (!rule.active || rule.kind === 'closeBelowSma20' || !(price > 0)) return { rule, firing: null };
  let fire = false;
  const next: AlertRule = { ...rule };

  if (rule.kind === 'above' || rule.kind === 'below') {
    const prev = rule.side;
    const side = sideOf(price, rule.level, hysteresisPct, prev);
    if (side) next.side = side;
    const crossed = prev !== undefined && side !== undefined && prev !== side && side === rule.kind;
    fire = crossed && cooledDown(rule, now);
  } else if (rule.kind === 'stop' || rule.kind === 'nearStop') {
    fire = price <= rule.level;
  } else {
    // target, oneR
    fire = price >= rule.level;
  }
  if (!fire) return { rule: next, firing: null };

  next.lastFiredAt = now;
  next.firedCount = rule.firedCount + 1;
  if (!rule.repeat) next.active = false;
  return {
    rule: next,
    firing: {
      ruleId: rule.id,
      key: rule.key,
      symbol: rule.symbol,
      kind: rule.kind,
      level: rule.level,
      price,
      ts: now,
      message: alertMessage(rule, price),
      critical: CRITICAL_KINDS.includes(rule.kind),
    },
  };
}

/** End-of-day rule: fires when the close is below SMA20 and was not below at the last evaluation. */
export function evaluateCloseBelowSma20(rule: AlertRule, close: number, sma20: number | null, now: number): { rule: AlertRule; firing: AlertFiring | null } {
  if (!rule.active || rule.kind !== 'closeBelowSma20' || sma20 === null) return { rule, firing: null };
  const side: 'above' | 'below' = close < sma20 ? 'below' : 'above';
  const next: AlertRule = { ...rule, side };
  if (side !== 'below' || rule.side === 'below') return { rule: next, firing: null };
  next.lastFiredAt = now;
  next.firedCount = rule.firedCount + 1;
  return {
    rule: next,
    firing: { ruleId: rule.id, key: rule.key, symbol: rule.symbol, kind: rule.kind, level: sma20, price: close, ts: now, message: alertMessage(rule, close, { sma20 }), critical: false },
  };
}

let seq = 0;
export function newId(prefix: string, now = Date.now()): string {
  seq = (seq + 1) % 1000;
  return `${prefix}-${now.toString(36)}-${seq.toString(36)}${Math.floor(Math.random() * 36 ** 3).toString(36)}`;
}

/**
 * Default alerts for a saved plan (spec §12). History-mode plans get safe and hold-until target
 * alerts instead of a fixed target alert.
 */
export function defaultPlanAlerts(
  p: { planId: string; key: string; symbol: string; entry: number; stop: number; target: number; targetMode?: 'fixed' | 'history'; holdTarget?: number | null },
  cooldownMinutes: number,
  now = Date.now(),
): AlertRule[] {
  const base = { key: p.key, symbol: p.symbol, planId: p.planId, repeat: false, cooldownMinutes, active: true, createdAt: now, firedCount: 0 };
  const r = p.entry - p.stop;
  const targets: AlertRule[] =
    p.targetMode === 'history'
      ? [
          { ...base, id: newId('al', now), kind: 'safeTarget', level: p.target },
          ...(p.holdTarget ? [{ ...base, id: newId('al', now), kind: 'holdTarget' as const, level: p.holdTarget }] : []),
        ]
      : [{ ...base, id: newId('al', now), kind: 'target', level: p.target }];
  return [
    { ...base, id: newId('al', now), kind: 'stop', level: p.stop },
    ...targets,
    { ...base, id: newId('al', now), kind: 'nearStop', level: Number((p.stop * 1.01).toFixed(2)) },
    { ...base, id: newId('al', now), kind: 'oneR', level: Number((p.entry + r).toFixed(2)), entry: p.entry },
    { ...base, id: newId('al', now), kind: 'closeBelowSma20', level: 0, repeat: true },
  ];
}
