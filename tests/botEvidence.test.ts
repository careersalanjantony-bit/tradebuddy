import { describe, expect, it } from 'vitest';
import { addSample, EVIDENCE, evaluate, evaluateAll, priorsFrom, toSample, type Sample, type StoredTests } from '../src/bot/evidence';
import { PLAYBOOKS, playbookOf, RISE_STRONG_REASON } from '../src/bot/playbooks';

const s = (grossR: number, shadow = false): Sample => ({ at: 0, grossR, netR: grossR - 0.1, ...(shadow ? { shadow: true as const } : {}) });
/** n samples around `mean`, alternating ±`sd` (the mean is exact for an even n) */
const around = (n: number, mean: number, sd: number) => Array.from({ length: n }, (_, i) => s(mean + (i % 2 ? sd : -sd)));
const same = (n: number, v: number) => Array.from({ length: n }, () => s(v));
const prior = (trades: number, avgR: number) => ({ trades, avgR, label: 'test' });

describe('auto-trader evidence: the worked examples of docs/AUTO_TRADER_PLAN.md', () => {
  it('past test only, 30 unseen-day trades at +0.20 R: safe estimate +0.004 → trial', () => {
    const e = evaluate('day-buy', [], prior(30, 0.2));
    expect(e.safeR).toBeCloseTo(0.15 - 0.8 / Math.sqrt(30), 3);
    expect(e.state).toBe('trial');
    expect(e.priorCounted).toBe(true);
    expect(e.why).toMatch(/Trial \(small size\)/);
  });
  it('past test only at +0.15 R: safe estimate −0.046 → watch (shadow trades only)', () => {
    const e = evaluate('day-buy', [], prior(30, 0.15));
    expect(e.safeR).toBeCloseTo(-0.046, 3);
    expect(e.state).toBe('watch');
    expect(e.why).toMatch(/shadow trades/);
  });
  it('30 live trades averaging +0.30 R with a spread of about 1 R → proven', () => {
    const e = evaluate('rise-strong', around(30, 0.3, 1), null);
    expect(e.safeR!).toBeGreaterThanOrEqual(0.1);
    expect(e.safeR!).toBeLessThan(0.13);
    expect(e.state).toBe('proven');
  });
  it('the newest 20 average −0.10 R → paused, whatever came before', () => {
    const e = evaluate('short-scan', [...same(5, 2), ...around(20, -0.1, 1)], null);
    expect(e.last20R).toBeCloseTo(-0.1, 3);
    expect(e.state).toBe('paused');
  });
  it('a paused kind needs its newest 20 to average +0.10 R (shadow ones count) before it trades again', () => {
    expect(evaluate('short-scan', around(20, 0.06, 1), null, { paused: true }).state).toBe('paused');
    const back = evaluate('short-scan', around(20, 0.12, 1).map((x) => ({ ...x, shadow: true as const })), null, { paused: true });
    expect(back.state).not.toBe('paused');
    expect(back.shadow).toBe(20);
  });
});

describe('auto-trader evidence: the edges', () => {
  it('needs 20 trades for trial and 30 for proven', () => {
    expect(evaluate('breakout', same(19, 1), null).state).toBe('watch');
    expect(evaluate('breakout', same(20, 1), null).state).toBe('trial');
    expect(evaluate('breakout', same(29, 1), null).state).toBe('trial');
    expect(evaluate('breakout', same(30, 1), null).state).toBe('proven');
  });
  it('proven from a safe estimate of +0.10 R (30 trades)', () => {
    const edge = 0.1 + EVIDENCE.sdFloorR / Math.sqrt(30);
    expect(evaluate('breakout', same(30, edge + 1e-9), null).state).toBe('proven');
    expect(evaluate('breakout', same(30, edge - 0.001), null).state).toBe('trial');
  });
  it('a past test with fewer than 20 trades does not count; one with more counts as at most 30', () => {
    expect(evaluate('day-buy', [], prior(19, 1)).state).toBe('watch');
    expect(evaluate('day-buy', [], prior(19, 1)).priorCounted).toBe(false);
    const big = evaluate('day-buy', [], prior(5000, 0.2));
    expect(big.safeR).toBeCloseTo(0.15 - 0.8 / Math.sqrt(30), 3);
  });
  it('a losing kind with many trades is paused by its safe estimate too', () => {
    // newest 20 at +0.0 (not below −0.05) but 40 trades averaging −0.10 → safe estimate below −0.15
    const e = evaluate('day-buy', [...around(20, -0.2, 0.9), ...same(20, 0)], null);
    expect(e.state).toBe('paused');
  });
  it('off: switched off by the owner, nothing else counts', () => {
    expect(evaluate('day-buy', same(40, 1), null, { off: true }).state).toBe('off');
  });
  it('a cap keeps an otherwise good kind in watch (the Intraday record not proven yet)', () => {
    const e = evaluate('intraday-buy', same(40, 1), null, undefined, 'The Intraday scanner’s own record is not proven yet.');
    expect(e.state).toBe('watch');
    expect(e.why).toMatch(/not proven yet/);
  });
  it('every playbook gets a state, in the fixed order', () => {
    const all = evaluateAll({ 'day-buy': same(30, 1) }, {}, undefined, {}, 123);
    expect(all.at).toBe(123);
    expect(all.list.map((e) => e.id)).toEqual(PLAYBOOKS);
    expect(all.list[0]!.state).toBe('proven');
    expect(all.list[1]!.state).toBe('watch');
  });
});

describe('auto-trader evidence: samples', () => {
  it('a trade as a sample: winners count at most +4 R, losses never cut; old trades use their result after charges', () => {
    expect(toSample({ openedAt: 1, closedAt: 2, riskRupees: 100, r: 6.5, grossR: 7 })).toEqual({ at: 2, grossR: 4, netR: 6.5 });
    expect(toSample({ openedAt: 1, riskRupees: 100, r: -3.2, grossR: -3 })).toEqual({ at: 1, grossR: -3, netR: -3.2 });
    expect(toSample({ openedAt: 1, riskRupees: 100, r: 0.8 })).toEqual({ at: 1, grossR: 0.8, netR: 0.8 });
    expect(toSample({ openedAt: 1, riskRupees: 200, pnl: -100 })).toEqual({ at: 1, grossR: -0.5, netR: -0.5 });
    expect(toSample({ openedAt: 1, riskRupees: 0, r: 1 })).toBeNull();
    expect(toSample({ openedAt: 1, riskRupees: 100, r: 1, shadow: true })).toMatchObject({ shadow: true });
  });
  it('keeps the newest 60 per playbook', () => {
    let book = {};
    for (let i = 0; i < 70; i++) book = addSample(book, 'breakout', { at: i, grossR: i, netR: i });
    const list = (book as { breakout: Sample[] }).breakout;
    expect(list).toHaveLength(60);
    expect(list[0]!.at).toBe(10);
    expect(list[59]!.at).toBe(69);
  });
});

describe('auto-trader evidence: the past tests as priors', () => {
  it('reads each test on its unseen days, in R', () => {
    const stored = {
      dayTest: {
        report: {
          checkFrom: '2026-09-01',
          checkTo: '2026-11-20',
          checkTrades: [
            { side: 'long', entry: 100, stop: 99, qty: 100, pnl: 150 }, // +1.5 R
            { side: 'long', entry: 200, stop: 198, qty: 50, pnl: -100 }, // −1 R
            { side: 'short', entry: 100, stop: 101, qty: 10, pnl: 50 }, // a sell-first trade: not this playbook
            { side: 'long', entry: 100, qty: 10, pnl: 50 }, // an older report without the stop
          ],
        },
      },
      riseModel: { report: { strong: { n: 500, win: 0.6, avgNetPct: 0.08 }, testFrom: '2026-10-01', testTo: '2026-11-20' } },
      shortTest: { newer: { trades: 40, wins: 22, pnl: 2_000, t1Hits: 20 }, riskRupees: 100 },
      breakoutTest: { newer: { trades: 25, wins: 12, t1Hits: 15, pnl: 1_000, avgR: 0.12 } },
      intradayTest: { trades: 80, avgR: 0.31, from: '2026-10-01', to: '2026-11-20' },
    } as unknown as StoredTests;
    const p = priorsFrom(stored, 0.004);
    expect(p['day-buy']).toMatchObject({ trades: 2, avgR: 0.25 });
    expect(p['rise-strong']).toMatchObject({ trades: 500, avgR: 0.2 });
    expect(p['short-scan']).toMatchObject({ trades: 40, avgR: 0.5 });
    expect(p.breakout).toMatchObject({ trades: 25, avgR: 0.12 });
    expect(p['intraday-buy']).toMatchObject({ trades: 80, avgR: 0.31 });
    expect(p['swing-pick']).toBeUndefined();
    expect(priorsFrom({}, 0.004)).toEqual({});
  });
});

describe('playbooks', () => {
  it('reads the kind of an old trade from its strategy and first reason', () => {
    expect(playbookOf({ strategy: 'rising', reasons: [RISE_STRONG_REASON] })).toBe('rise-strong');
    expect(playbookOf({ strategy: 'rising', reasons: ['up 2.1% since the open'] })).toBe('rise-flow');
    expect(playbookOf({ strategy: 'short', reasons: ['falling now (score 72)'] })).toBe('short-scan');
    expect(playbookOf({ strategy: 'short', reasons: ['in the Stocks tab’s “For short selling” list'] })).toBe('short-model');
    expect(playbookOf({ strategy: 'swing', reasons: [] })).toBe('swing-pick');
    expect(playbookOf({ strategy: 'breakout', playbook: 'intraday-buy', reasons: [] })).toBe('intraday-buy');
  });
});
