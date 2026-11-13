import { describe, expect, it } from 'vitest';
import { defaultPlanAlerts, evaluateCloseBelowSma20, evaluateRule, sideOf, type AlertRule } from '../src/alerts/rules';

const rule = (over: Partial<AlertRule>): AlertRule => ({
  id: 'r1',
  key: 'NSE_EQ|X',
  symbol: 'X',
  kind: 'above',
  level: 100,
  repeat: false,
  cooldownMinutes: 15,
  active: true,
  createdAt: 0,
  firedCount: 0,
  ...over,
});
const MIN = 60_000;

describe('cross detection with hysteresis', () => {
  it('keeps the previous side inside the ±0.1% band', () => {
    expect(sideOf(100.05, 100, 0.1, 'below')).toBe('below');
    expect(sideOf(100.1, 100, 0.1, 'below')).toBe('above');
    expect(sideOf(99.9, 100, 0.1, 'above')).toBe('below');
    expect(sideOf(100, 100, 0.1)).toBeUndefined();
  });

  it('"above" fires only on a cross, not when already above', () => {
    let r = rule({});
    let res = evaluateRule(r, 101, 0);
    expect(res.firing).toBeNull(); // first sight, already above: no cross
    r = res.rule;
    res = evaluateRule(r, 99, MIN);
    expect(res.firing).toBeNull();
    res = evaluateRule(res.rule, 100.05, 2 * MIN); // inside band → no flapping
    expect(res.firing).toBeNull();
    res = evaluateRule(res.rule, 100.2, 3 * MIN);
    expect(res.firing?.message).toMatch(/X crossed above ₹100.00/);
    expect(res.rule.active).toBe(false); // one-shot
  });

  it('repeating alerts respect the cooldown', () => {
    let r = rule({ kind: 'below', repeat: true, side: 'above' });
    let res = evaluateRule(r, 99, 0);
    expect(res.firing).not.toBeNull();
    res = evaluateRule(res.rule, 101, 1 * MIN);
    res = evaluateRule(res.rule, 99, 2 * MIN);
    expect(res.firing).toBeNull(); // within 15 min
    res = evaluateRule(res.rule, 101, 10 * MIN);
    res = evaluateRule(res.rule, 99, 20 * MIN);
    expect(res.firing).not.toBeNull();
    expect(res.rule.firedCount).toBe(2);
    r = res.rule;
    expect(r.active).toBe(true);
  });
});

describe('plan alerts', () => {
  const plan = { planId: 'P1', key: 'NSE_EQ|X', symbol: 'X', entry: 1000, stop: 960, target: 1080 };
  const rules = defaultPlanAlerts(plan, 15, 0);
  const byKind = (k: string) => rules.find((r) => r.kind === k)!;

  it('creates the five default alerts with the right levels', () => {
    expect(rules.map((r) => r.kind)).toEqual(['stop', 'target', 'nearStop', 'oneR', 'closeBelowSma20']);
    expect(byKind('nearStop').level).toBe(969.6);
    expect(byKind('oneR').level).toBe(1040);
  });

  it('stop fires on touch (even on first sight) and is critical, once', () => {
    const res = evaluateRule(byKind('stop'), 959.5, 0);
    expect(res.firing).toMatchObject({ kind: 'stop', critical: true });
    expect(res.firing!.message).toMatch(/hit your STOP ₹960.00/);
    expect(evaluateRule(res.rule, 950, MIN).firing).toBeNull();
  });

  it('target and 1R fire at or above the level', () => {
    expect(evaluateRule(byKind('target'), 1079.95, 0).firing).toBeNull();
    expect(evaluateRule(byKind('target'), 1080, 0).firing?.critical).toBe(true);
    expect(evaluateRule(byKind('oneR'), 1041, 0).firing?.message).toMatch(/breakeven ₹1,000.00/);
  });

  it('never fires when inactive or with a bad price', () => {
    expect(evaluateRule({ ...byKind('stop'), active: false }, 900, 0).firing).toBeNull();
    expect(evaluateRule(byKind('stop'), 0, 0).firing).toBeNull();
  });

  it('history-mode plans get safe + hold-until target alerts instead of a fixed target', () => {
    const h = defaultPlanAlerts({ ...plan, target: 1060, targetMode: 'history', holdTarget: 1104 }, 15, 0);
    expect(h.map((r) => r.kind)).toEqual(['stop', 'safeTarget', 'holdTarget', 'nearStop', 'oneR', 'closeBelowSma20']);
    const res = evaluateRule(h.find((r) => r.kind === 'safeTarget')!, 1061, 0);
    expect(res.firing).toMatchObject({ kind: 'safeTarget', critical: true });
    expect(res.firing!.message).toMatch(/SAFE target ₹1,060.00 .* hold-or-sell advice/);
    expect(defaultPlanAlerts({ ...plan, targetMode: 'history', holdTarget: null }, 15, 0).map((r) => r.kind)).not.toContain('holdTarget');
  });

  it('close below SMA20 fires on the first close below, then only after a recovery', () => {
    let r = byKind('closeBelowSma20');
    let res = evaluateCloseBelowSma20(r, 990, 1000, 0);
    expect(res.firing).not.toBeNull();
    res = evaluateCloseBelowSma20(res.rule, 985, 1000, 1);
    expect(res.firing).toBeNull();
    res = evaluateCloseBelowSma20(res.rule, 1010, 1000, 2);
    res = evaluateCloseBelowSma20(res.rule, 995, 1000, 3);
    expect(res.firing).not.toBeNull();
    r = res.rule;
    expect(r.firedCount).toBe(2);
  });
});
