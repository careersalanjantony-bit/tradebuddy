import { describe, expect, it } from 'vitest';
import { adviseCapital, parseFunds, tidy } from '../src/advisor/capital';

const base = { availableCash: 250_000, emergencyFundOk: true, borrowedOrNeeded: false, maxYearlyLoss: 20_000, newToTrading: true };

describe('adviseCapital', () => {
  it('capital = tolerable yearly loss × 5, risk 0.5% when new', () => {
    const a = adviseCapital(base);
    expect(a.status).toBe('ok');
    expect(a.capital).toBe(100_000);
    expect(a.riskPct).toBe(0.5);
    expect(a.riskPerTrade).toBe(500);
    expect(a.maxOpenTrades).toBe(3);
    expect(a.dailyLossLimit).toBe(2000);
    expect(a.weeklyLossLimit).toBe(5000);
    expect(a.reasons.join(' ')).toMatch(/₹20,000 × 5 = ₹1,00,000/);
    expect(a.reasons.join(' ')).toMatch(/the rest \(₹1,50,000\) is not used/);
    expect(a.warnings).toEqual([]);
  });

  it('never more than the cash in Upstox (tidied down)', () => {
    const a = adviseCapital({ ...base, availableCash: 63_450 });
    expect(a.capital).toBe(63_000);
    expect(a.reasons.join(' ')).toMatch(/limited to that/);
  });

  it('experienced → 1% risk', () => {
    expect(adviseCapital({ ...base, newToTrading: false }).riskPct).toBe(1);
  });

  it('borrowed / needed money or no emergency fund → practise with paper trades', () => {
    const a = adviseCapital({ ...base, borrowedOrNeeded: true });
    expect(a.status).toBe('paper');
    expect(a.warnings[0]).toMatch(/borrowed money/);
    const b = adviseCapital({ ...base, emergencyFundOk: false });
    expect(b.status).toBe('paper');
    expect(b.warnings[0]).toMatch(/emergency fund/);
  });

  it('warns when trades would be too small to beat fixed charges', () => {
    const a = adviseCapital({ ...base, maxYearlyLoss: 4000 }); // capital 20,000 → ₹100 risk/trade
    expect(a.capital).toBe(20_000);
    expect(a.warnings.join(' ')).toMatch(/fixed per-order charges/);
  });

  it('incomplete until the questions are answered', () => {
    expect(adviseCapital({ ...base, maxYearlyLoss: null }).status).toBe('incomplete');
    expect(adviseCapital({ ...base, emergencyFundOk: null }).capital).toBeNull();
  });

  it('works without the Upstox balance', () => {
    expect(adviseCapital({ ...base, availableCash: null }).capital).toBe(100_000);
  });
});

describe('tidy', () => {
  it('₹1,000 steps below 1 lakh, ₹5,000 above', () => {
    expect(tidy(99_999)).toBe(99_000);
    expect(tidy(123_456)).toBe(120_000);
  });
});

describe('parseFunds (docs example, v3)', () => {
  const docs = {
    available_to_trade: {
      total: 5379.03,
      cash_available_to_trade: { total: 5117.34, cash: { opening_balance: 5137.34, added_today: 110.0, withdrawn_today: -130.0 } },
      pledge_available_to_trade: { total: 261.69 },
    },
  };
  it('reads cash and total available to trade', () => {
    expect(parseFunds(docs, 7)).toEqual({ cash: 5117.34, total: 5379.03, fetchedAt: 7 });
  });
  it('rejects a wrong shape', () => {
    expect(() => parseFunds({ equity: {} }, 0)).toThrow();
  });
});
