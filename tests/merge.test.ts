import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/storage/defaults';
import { applyPatch, mergeWithDefaults } from '../src/storage/merge';

describe('mergeWithDefaults', () => {
  it('returns defaults when nothing is stored', () => {
    expect(mergeWithDefaults(DEFAULT_SETTINGS, undefined)).toEqual(DEFAULT_SETTINGS);
  });
  it('keeps stored values and fills in new fields', () => {
    const stored = { risk: { riskPerTradePct: 0.5, capitalInr: 500000 }, ui: { theme: 'dark' } };
    const s = mergeWithDefaults(DEFAULT_SETTINGS, stored);
    expect(s.risk.riskPerTradePct).toBe(0.5);
    expect(s.risk.capitalInr).toBe(500000);
    expect(s.risk.maxOpenTrades).toBe(3); // filled from defaults
    expect(s.ui.theme).toBe('dark');
    expect(s.indicators.swingK).toBe(3);
  });
  it('rejects wrong types and non-finite numbers', () => {
    const s = mergeWithDefaults(DEFAULT_SETTINGS, { risk: { riskPerTradePct: '5', maxOpenTrades: NaN, paperMode: 'no' } });
    expect(s.risk.riskPerTradePct).toBe(1);
    expect(s.risk.maxOpenTrades).toBe(3);
    expect(s.risk.paperMode).toBe(true);
  });
  it('accepts numbers for null defaults and drops unknown keys', () => {
    const s = mergeWithDefaults(DEFAULT_SETTINGS, { claude: { monthlyBudgetUsd: 20, oldField: 1 }, obsolete: true });
    expect(s.claude.monthlyBudgetUsd).toBe(20);
    expect((s.claude as Record<string, unknown>).oldField).toBeUndefined();
    expect((s as unknown as Record<string, unknown>).obsolete).toBeUndefined();
  });
  it('does not share references with the defaults object', () => {
    const s = mergeWithDefaults(DEFAULT_SETTINGS, undefined);
    s.notifications.quietHours.start = '23:00';
    expect(DEFAULT_SETTINGS.notifications.quietHours.start).toBe('22:00');
  });
});

describe('applyPatch', () => {
  it('deep-merges objects and replaces leaves', () => {
    const base = { a: { b: 1, c: 2 }, d: [1, 2], e: 'x' };
    expect(applyPatch(base, { a: { c: 3 }, d: [9] })).toEqual({ a: { b: 1, c: 3 }, d: [9], e: 'x' });
    expect(base.a.c).toBe(2);
  });
});
