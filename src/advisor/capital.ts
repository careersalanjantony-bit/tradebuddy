/**
 * Capital helper (owner's request, 9 Nov 2026): suggests trading capital and risk settings from a few
 * plain questions. Prudent, standard rules — the owner decides and can change everything.
 *
 *  - Never trade borrowed money or money needed within a year; keep an emergency fund outside.
 *    If either is not true → practise with paper trades first.
 *  - Capital = the most you could lose in a bad year without harm × 5. With small risk per trade and the
 *    daily/weekly loss limits, losing 20% of capital needs a long losing streak.
 *  - Never more than the cash actually available in Upstox.
 *  - Risk per trade 0.5% while new to real-money trading (spec §20), 1% later.
 */

export interface CapitalInputs {
  availableCash: number | null;
  emergencyFundOk: boolean | null;
  borrowedOrNeeded: boolean | null;
  maxYearlyLoss: number | null;
  newToTrading: boolean;
}

export interface CapitalAdvice {
  status: 'incomplete' | 'ok' | 'paper';
  capital: number | null;
  riskPct: number;
  maxOpenTrades: number;
  riskPerTrade: number | null;
  dailyLossLimit: number | null;
  weeklyLossLimit: number | null;
  reasons: string[];
  warnings: string[];
}

export const LOSS_TO_CAPITAL = 5; // capital = tolerable yearly loss × 5  (a 20% drawdown)
const rs = (x: number) => `₹${Math.round(x).toLocaleString('en-IN')}`;

/** Rounds down to a tidy number: ₹1,000 steps below ₹1 lakh, ₹5,000 steps above. */
export function tidy(x: number): number {
  const step = x >= 100_000 ? 5000 : 1000;
  return Math.floor(x / step) * step;
}

export function adviseCapital(i: CapitalInputs): CapitalAdvice {
  const riskPct = i.newToTrading ? 0.5 : 1;
  const base: CapitalAdvice = { status: 'incomplete', capital: null, riskPct, maxOpenTrades: 3, riskPerTrade: null, dailyLossLimit: null, weeklyLossLimit: null, reasons: [], warnings: [] };
  if (i.emergencyFundOk === null || i.borrowedOrNeeded === null || !i.maxYearlyLoss || i.maxYearlyLoss <= 0) {
    return { ...base, reasons: ['Answer the questions above to get a suggestion.'] };
  }

  const reasons: string[] = [];
  const warnings: string[] = [];
  const fromLoss = i.maxYearlyLoss * LOSS_TO_CAPITAL;
  reasons.push(
    `You could lose up to ${rs(i.maxYearlyLoss)} in a bad year without real harm. Following the rules, losing 20% of capital takes a long losing streak, so capital ≈ ${rs(i.maxYearlyLoss)} × ${LOSS_TO_CAPITAL} = ${rs(fromLoss)}.`,
  );
  let capital = fromLoss;
  if (i.availableCash !== null && i.availableCash >= 0) {
    if (i.availableCash < fromLoss) {
      capital = i.availableCash;
      reasons.push(`Your Upstox account has ${rs(i.availableCash)} available, so capital is limited to that.`);
    } else {
      reasons.push(`Your Upstox account has ${rs(i.availableCash)}; the rest (${rs(i.availableCash - fromLoss)}) is not used for trading.`);
    }
  }
  capital = tidy(capital);
  const riskPerTrade = (capital * riskPct) / 100;
  reasons.push(
    i.newToTrading
      ? `Risk per trade ${riskPct}% (new to real-money trading) = ${rs(riskPerTrade)}: the most one trade may lose at its stop-loss.`
      : `Risk per trade ${riskPct}% = ${rs(riskPerTrade)}.`,
  );
  reasons.push(`At most 3 open trades at a time, so no more than about ${rs(riskPerTrade * 3)} is at risk together.`);

  let status: CapitalAdvice['status'] = 'ok';
  if (i.borrowedOrNeeded) {
    status = 'paper';
    warnings.push("Don't trade with borrowed money or money you need within a year. Practise with paper trades (plan and track, but don't place real orders) until you have spare money.");
  }
  if (i.emergencyFundOk === false) {
    status = 'paper';
    warnings.push('Build an emergency fund first (about 6 months of expenses, kept outside the trading account). Practise with paper trades meanwhile.');
  }
  if (capital <= 0) {
    warnings.push('No capital is available for trading right now.');
  } else if (riskPerTrade < 200) {
    warnings.push(
      `With only ${rs(riskPerTrade)} of risk per trade, positions will be small and fixed per-order charges (brokerage, DP fee) take a big share of each profit. Consider practising with paper trades until the capital is larger.`,
    );
  }

  return {
    ...base,
    status,
    capital,
    riskPerTrade,
    dailyLossLimit: capital * 0.02,
    weeklyLossLimit: capital * 0.05,
    reasons,
    warnings,
  };
}

export interface Funds {
  /** net cash available to trade */
  cash: number;
  /** cash + margin from pledged holdings */
  total: number;
  fetchedAt: number;
}

/** Parses GET /v3/user/get-funds-and-margin `data` (docs checked 9 Nov 2026). */
export function parseFunds(data: unknown, fetchedAt: number): Funds {
  const d = (data ?? {}) as { available_to_trade?: { total?: unknown; cash_available_to_trade?: { total?: unknown } } };
  const cash = d.available_to_trade?.cash_available_to_trade?.total;
  const total = d.available_to_trade?.total;
  if (typeof cash !== 'number' || !Number.isFinite(cash)) throw new Error('Funds response has no cash_available_to_trade.total');
  return { cash, total: typeof total === 'number' && Number.isFinite(total) ? total : cash, fetchedAt };
}
