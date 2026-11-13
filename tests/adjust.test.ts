import { describe, expect, it } from 'vitest';
import { applyAdjustments, candidateFactors, detectAdjustments, findSuspiciousGaps, parseActionDate, parseRatio, type CorporateAction } from '../src/indicators/adjust';
import { sma } from '../src/indicators/core';
import { candlesFrom } from './helpers';

describe('parsing', () => {
  it('reads the API date format and ISO', () => {
    expect(parseActionDate('14 Aug 2025')).toBe('2025-08-14');
    expect(parseActionDate('3 Jun 2026')).toBe('2026-06-03');
    expect(parseActionDate('2026-06-04')).toBe('2026-06-04');
    expect(parseActionDate('soon')).toBeNull();
    expect(parseActionDate(null)).toBeNull();
  });
  it('reads ratios', () => {
    expect(parseRatio('1:2')).toEqual([1, 2]);
    expect(parseRatio(' 10 : 2 ')).toEqual([10, 2]);
    expect(parseRatio('1/5')).toEqual([1, 5]);
    expect(parseRatio('x')).toBeNull();
  });
  it('bonus 1:2 (Trent) has 2/3 as its first candidate; splits give new/old face value', () => {
    expect(candidateFactors('Bonus', '1:2')[0]).toBeCloseTo(2 / 3, 10);
    expect(candidateFactors('Bonus', '1:1')).toEqual([0.5]);
    expect(candidateFactors('Split', '10:2')).toEqual([0.2]);
    expect(candidateFactors('Split', '1:5')).toEqual([0.2]);
    expect(candidateFactors('Dividend', null)).toEqual([]);
  });
});

/** ~Trent-like: 300 sessions around ₹6,000, a fake −32.6% drop at the ex-date, then ~₹4,000. */
function trentLike() {
  const closes: number[] = [];
  for (let i = 0; i < 200; i++) closes.push(6000 + Math.sin(i / 7) * 60);
  closes.push(closes[199]! * 0.674); // the unadjusted gap (spec: −32.6%)
  for (let i = 1; i < 100; i++) closes.push(4044 + Math.sin(i / 7) * 40);
  return candlesFrom(closes, { start: '2025-08-01', volume: 300_000 });
}

describe('bonus adjustment (spec §7.5, Trent case)', () => {
  const raw = trentLike();
  const exDate = raw[200]!.date;
  const bonus: CorporateAction = { name: 'Bonus', exDate, ratio: '1:2', amount: null };

  it('detects the unadjusted 1:2 bonus and uses factor 2/3', () => {
    const r = detectAdjustments(raw, [bonus]);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]!.date).toBe(exDate);
    expect(r.events[0]!.factor).toBeCloseTo(2 / 3, 10);
    expect(r.events[0]!.observed).toBeCloseTo(0.674, 3);
  });

  it('finds the gap even when the API date is a day off (record date)', () => {
    const r = detectAdjustments(raw, [{ ...bonus, exDate: raw[201]!.date }]);
    expect(r.events[0]?.date).toBe(exDate);
  });

  it('adjusts prices before the ex-date (×2/3) and volume (÷2/3); fixes SMA200 and the gap flag', () => {
    const { events } = detectAdjustments(raw, [bonus]);
    const adj = applyAdjustments(raw, events);
    expect(adj[0]!.close).toBeCloseTo(raw[0]!.close * (2 / 3), 8);
    expect(adj[0]!.volume).toBeCloseTo(raw[0]!.volume * 1.5, 6);
    expect(adj[250]!.close).toBe(raw[250]!.close);
    const smaRaw = sma(raw.map((c) => c.close), 200)!;
    const smaAdj = sma(adj.map((c) => c.close), 200)!;
    expect(smaRaw).toBeGreaterThan(5000); // broken
    expect(smaAdj).toBeGreaterThan(3900);
    expect(smaAdj).toBeLessThan(4100); // continuous ~₹4,000 series
    expect(findSuspiciousGaps(raw).map((g) => g.date)).toEqual([exDate]);
    expect(findSuspiciousGaps(adj)).toEqual([]);
  });

  it('treats data without the gap as already adjusted', () => {
    const adj = applyAdjustments(raw, detectAdjustments(raw, [bonus]).events);
    const r = detectAdjustments(adj, [bonus]);
    expect(r.events).toEqual([]);
    expect(r.alreadyAdjusted).toEqual([bonus]);
  });

  it('handles a 1:5 split and compounding of two events', () => {
    const closes = [...Array(50).fill(1000), ...Array(50).fill(200), ...Array(50).fill(100)];
    const raw2 = candlesFrom(closes, { start: '2025-01-01' });
    const acts: CorporateAction[] = [
      { name: 'Split', exDate: raw2[50]!.date, ratio: '10:2', amount: null },
      { name: 'Bonus', exDate: raw2[100]!.date, ratio: '1:1', amount: null },
    ];
    const r = detectAdjustments(raw2, acts);
    expect(r.events.map((e) => e.factor)).toEqual([0.2, 0.5]);
    const adj = applyAdjustments(raw2, r.events);
    expect(adj[0]!.close).toBeCloseTo(100, 8);
    expect(adj[60]!.close).toBeCloseTo(100, 8);
    expect(findSuspiciousGaps(adj)).toEqual([]);
  });

  it('combines a bonus and a split on the same day (Bajaj Finance style: 4:1 bonus + 1:2 split = ×0.1)', () => {
    const closes = [...Array(120).fill(9000), ...Array(120).fill(900)];
    const raw3 = candlesFrom(closes, { start: '2025-01-01' });
    const ex = raw3[120]!.date;
    const acts: CorporateAction[] = [
      { name: 'Bonus', exDate: ex, ratio: '4:1', amount: null },
      { name: 'Split', exDate: ex, ratio: '2:1', amount: null },
    ];
    const r = detectAdjustments(raw3, acts);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]!.factor).toBeCloseTo(0.1, 10);
    expect(r.events[0]!.ratio).toBe('Bonus 4:1 + Split 2:1');
    expect(r.alreadyAdjusted).toEqual([]);
    const adj = applyAdjustments(raw3, r.events);
    expect(adj[0]!.close).toBeCloseTo(900, 6);
    expect(findSuspiciousGaps(adj)).toEqual([]);
  });

  it('BSE-style 2:1 bonus (2 new for 1 held) → ×1/3', () => {
    const closes = [...Array(60).fill(6000), ...Array(60).fill(2000)];
    const raw4 = candlesFrom(closes, { start: '2025-01-01' });
    const r = detectAdjustments(raw4, [{ name: 'Bonus', exDate: raw4[60]!.date, ratio: '2:1', amount: null }]);
    expect(r.events[0]!.factor).toBeCloseTo(1 / 3, 10);
  });

  it('ignores dividends, actions outside the data, and dates the owner confirmed', () => {
    expect(detectAdjustments(raw, [{ name: 'Dividend', exDate, ratio: null, amount: 5 }]).events).toEqual([]);
    expect(detectAdjustments(raw, [{ ...bonus, exDate: '2020-01-01' }]).events).toEqual([]);
    expect(findSuspiciousGaps(raw, 18, [exDate])).toEqual([]);
  });
});
