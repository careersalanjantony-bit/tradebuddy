import { describe, expect, it } from 'vitest';
import { explainSnapshot } from '../src/advisor/explain';
import { buildStudyPrompt } from '../src/advisor/studyPrompt';
import { computeSnapshot, type TechSnapshot } from '../src/indicators/snapshot';
import { DEFAULT_SETTINGS } from '../src/storage/defaults';
import { candlesFrom, linear } from './helpers';

const settings = DEFAULT_SETTINGS.indicators;
const zigzagUp = Array.from({ length: 300 }, (_, i) => 500 + Math.ceil(i / 2) * 6 - Math.floor(i / 2) * 4);
const snapOf = (closes: number[], opts: { volume?: number } = {}) => computeSnapshot(candlesFrom(closes, { volume: opts.volume ?? 200_000 }), { settings })!;

describe('explainSnapshot', () => {
  it('clean uptrend, not stretched → Good setup with an entry hint', () => {
    const e = explainSnapshot('TEST', snapOf(zigzagUp));
    expect(e.verdict).toBe('Good setup');
    expect(e.tone).toBe('good');
    expect(e.summary).toMatch(/TEST is in a steady uptrend/);
    expect(e.entryHint).toMatch(/limit buy near ₹/);
    expect(e.points.join(' ')).toMatch(/Typical daily move/);
  });

  it('stretched uptrend → Wait for a pullback', () => {
    const e = explainSnapshot('UNIONBANK', snapOf([...linear(299, 150, 0.1), 200]));
    expect(e.verdict).toBe('Wait');
    expect(e.points[0]).toMatch(/It is stretched: RSI \d+/);
    expect(e.entryHint).toMatch(/Wait for a pullback to about ₹/);
  });

  it('downtrend → Avoid', () => {
    const e = explainSnapshot('DOWN', snapOf(linear(300, 1100, -2)));
    expect(e.verdict).toBe('Avoid');
    expect(e.summary).toMatch(/below its 200-day average/);
    expect(e.entryHint).toBeNull();
  });

  it('short history → No setup; suspicious data → Check data', () => {
    expect(explainSnapshot('NEW', snapOf(linear(60, 100, 1))).summary).toMatch(/Not enough history/);
    const bad = { ...snapOf(zigzagUp), flags: ['Possible unadjusted action' as const] };
    expect(explainSnapshot('X', bad).verdict).toBe('Check data');
  });

  it('mentions low liquidity', () => {
    const e = explainSnapshot('THIN', snapOf(zigzagUp, { volume: 1000 }));
    expect(e.points.join(' ')).toMatch(/Low trading activity/);
  });
});

describe('buildStudyPrompt', () => {
  const snap: TechSnapshot = snapOf(zigzagUp);
  it('packs the numbers, the sections and no placeholders', () => {
    const p = buildStudyPrompt({ symbol: 'TEST', name: 'TEST LTD', isin: 'INE000T01019', snap, priceTime: Date.UTC(2026, 10, 10, 5, 0) });
    expect(p).toMatch(/Stock: TEST LTD \(TEST, NSE, ISIN INE000T01019\)/);
    expect(p).toMatch(/price taken 10 Nov 2026, 10:30 IST/);
    expect(p).toMatch(/Setup: Clean uptrend/);
    expect(p).toMatch(/8\. Overall setup quality: Strong \/ Acceptable \/ Weak \/ Avoid/);
    expect(p).not.toMatch(/undefined|NaN/);
    expect(p).not.toMatch(/My plan/);
  });
  it('includes the plan in history mode', () => {
    const p = buildStudyPrompt({
      symbol: 'TEST',
      name: 'TEST LTD',
      snap,
      priceTime: 0,
      plan: { entry: 150, stop: 143, target: 158.4, holdTarget: 165.05, qty: 71, riskRupees: 497, historyMode: true },
    });
    expect(p).toMatch(/My plan: buy 71 at ₹150\.00, stop-loss ₹143\.00 \(risk ₹497\), no fixed target — safe target ₹158\.40, hold-until ₹165\.05/);
    expect(p).toMatch(/is my entry sensible/);
  });
});
