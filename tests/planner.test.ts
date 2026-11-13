import { describe, expect, it } from 'vitest';
import { computePlan, orderTicket, roundDownToTick, roundToTick, roundUpToTick, type PlanInput, type PlanSettings } from '../src/planner/plan';

const settings: PlanSettings = {
  capitalInr: 500_000,
  riskPerTradePct: 1,
  riskPerTradeCapPct: 2,
  maxOpenTrades: 3,
  maxTotalOpenRiskPct: 5,
  chargesEstimatePct: 0.25,
  stopAtrMultiple: 2,
  swingLowBufferAtr: 0.1,
  minRewardToRisk: 2,
  positionPctWarn: 25,
  resultsWindowDays: 7,
};
const base: PlanInput = {
  symbol: 'TEST',
  entry: 1000,
  tick: 0.05,
  stopMethod: 'atr',
  targetMethod: '2R',
  atr: 20,
  lastSwingLow: 965,
  resistances: [1100, 1050],
  settings,
  otherOpenRisks: [],
  today: '2026-11-10',
};

describe('tick rounding', () => {
  it('rounds entry up, stop down, without float noise', () => {
    expect(roundUpToTick(100.01, 0.05)).toBe(100.05);
    expect(roundUpToTick(100.05, 0.05)).toBe(100.05);
    expect(roundDownToTick(99.99, 0.05)).toBe(99.95);
    expect(roundDownToTick(0.1 + 0.2, 0.05)).toBe(0.3);
    expect(roundToTick(4215.52, 0.1)).toBe(4215.5);
    expect(roundUpToTick(25403.01, 5)).toBe(25405); // MRF-style ₹5 tick
  });
});

describe('computePlan', () => {
  it('2×ATR stop, 2R target, 1% risk sizing', () => {
    const p = computePlan(base);
    expect(p.ok).toBe(true);
    expect(p).toMatchObject({ entry: 1000, stop: 960, target: 1080, riskPerShare: 40, qty: 125, positionValue: 125_000, riskRupees: 5000, rewardRupees: 10_000 });
    expect(p.rr).toBeCloseTo(2, 10);
    expect(p.positionPct).toBeCloseTo(25, 10);
    expect(p.charges).toBeCloseTo(312.5, 6);
    expect(p.breakeven).toBe(1002.5);
    expect(p.stopLimit).toBe(955.2); // 0.5% below the trigger, rounded down
    expect(p.guardrails).toEqual([]);
  });

  it('rounds a messy entry up and the stop down to the tick', () => {
    const p = computePlan({ ...base, entry: 1000.01, atr: 20.013 });
    expect(p.entry).toBe(1000.05);
    expect(p.stop).toBe(960.0); // 1000.05 − 40.026 = 960.024 → 960.00
  });

  it('swing-low stop and resistance target', () => {
    const p = computePlan({ ...base, stopMethod: 'swingLow', targetMethod: 'resistance' });
    expect(p.stop).toBe(963); // 965 − 0.1×20
    expect(p.target).toBe(1050);
    expect(p.guardrails.some((g) => g.text.includes('below your minimum'))).toBe(true); // 50/37 = 1.35R
  });

  it('caps risk % and limits quantity by capital', () => {
    const p = computePlan({ ...base, riskPct: 5, atr: 2 }); // stop 4 below; 2% cap → 10,000 / 4 = 2,500 shares = ₹25 lakh > capital
    expect(p.riskPctUsed).toBe(2);
    expect(p.qty).toBe(500); // 5,00,000 / 1000
    expect(p.guardrails.map((g) => g.text).join(' ')).toMatch(/above your cap.*limited to 500/s);
  });

  it('explains when even one share is too risky, or inputs are missing', () => {
    const tiny = computePlan({ ...base, settings: { ...settings, capitalInr: 2000 } });
    expect(tiny.ok).toBe(false);
    expect(tiny.errors[0]).toMatch(/One share risks/);
    expect(computePlan({ ...base, settings: { ...settings, capitalInr: null } }).errors[0]).toMatch(/capital/);
    expect(computePlan({ ...base, stopMethod: 'manual', manualStop: 1001 }).errors[0]).toMatch(/below the entry/);
    expect(computePlan({ ...base, atr: null }).errors[0]).toMatch(/ATR/);
  });

  it('guardrails: open trades, total risk, results date, flags, missing charges', () => {
    const p = computePlan({
      ...base,
      otherOpenRisks: [8000, 8000, 5000],
      resultsDate: '2026-11-14',
      snapshot: { flags: ['Below 200-day', 'Stretched'], setup: 'No setup', trend: 'Downtrend' },
      settings: { ...settings, chargesEstimatePct: null },
    });
    const t = p.guardrails.map((g) => g.text).join('\n');
    expect(t).toMatch(/already have 3/);
    expect(t).toMatch(/Total risk/);
    expect(t).toMatch(/Results\/event in 4 day/);
    expect(t).toMatch(/below the 200-day/);
    expect(t).toMatch(/Stretched/);
    expect(t).toMatch(/No valid setup/);
    expect(t).toMatch(/Charges not included/);
    expect(p.breakeven).toBeNull();
  });
});

describe('history-based targets (no fixed target)', () => {
  const hist = { ...base, targetMethod: 'history' as const, history: { safeAtr: 3, holdAtr: 5.2 } };
  it('safe = entry + safeAtr×ATR, hold-until = entry + holdAtr×ATR (rounded down to the tick)', () => {
    const p = computePlan(hist);
    expect(p.ok).toBe(true);
    expect(p.targetMode).toBe('history');
    expect(p.target).toBe(1060); // 1000 + 3×20
    expect(p.holdTarget).toBe(1104); // 1000 + 5.2×20
    expect(p.rr).toBeCloseTo(1.5, 10);
    const t = p.guardrails.map((g) => g.text).join(' ');
    expect(t).not.toMatch(/below your minimum of 2R/); // the generic fixed-target rule is replaced
    expect(t).not.toMatch(/hold-until target is only/); // 104/40 = 2.6R ≥ 2R
  });
  it('warns when history says the stock usually moves less than the risk', () => {
    const p = computePlan({ ...hist, history: { safeAtr: 1.2, holdAtr: 2.5 } });
    const t = p.guardrails.map((g) => g.text).join(' ');
    expect(t).toMatch(/safe target is only 0.60R/);
    expect(t).toMatch(/hold-until target is only 1.25R/);
  });
  it('refuses when the safe level is not above the entry, or there is no study', () => {
    expect(computePlan({ ...hist, history: { safeAtr: 0, holdAtr: 0.5 } }).errors[0]).toMatch(/not above the entry/);
    expect(computePlan({ ...hist, history: null }).errors[0]).toMatch(/Not enough price history/);
  });
  it('ticket: stop-only GTT, no fixed target', () => {
    const t = orderTicket('TEST', computePlan(hist), 'P9');
    expect(t).toBe(
      [
        'BUY  TEST  qty 125  LIMIT ₹1,000.00  product CNC',
        'Then immediately create a GTT stop-loss in Upstox (single leg):',
        '  Stop-loss: trigger ₹960.00, limit ₹955.20',
        '  No fixed target. The extension will advise: safe ₹1,060.00 · hold-until ₹1,104.00',
        'Risk ₹5,000  ·  At safe target ₹7,500  ·  1.5R  ·  plan id P9',
      ].join('\n'),
    );
  });
});

describe('orderTicket', () => {
  it('matches the spec format', () => {
    const t = orderTicket('TEST', computePlan(base), 'P1');
    expect(t).toBe(
      [
        'BUY  TEST  qty 125  LIMIT ₹1,000.00  product CNC',
        'Then immediately create a GTT in Upstox:',
        '  Stop-loss: trigger ₹960.00, limit ₹955.20',
        '  Target:    ₹1,080.00',
        'Risk ₹5,000  ·  Potential ₹10,000  ·  2.0R  ·  plan id P1',
      ].join('\n'),
    );
  });
});
