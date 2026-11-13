import { isShortlisted, type TechSnapshot } from '../indicators/snapshot';
import { formatNumberIN, formatPct } from '../lib/format';

/**
 * Plain-English reading of a technical snapshot for a beginner (v0.5.0). Rule-based and
 * deterministic: it only restates what the numbers say, in the order of the playbook (spec §20).
 */

export type Verdict = 'Good setup' | 'Wait' | 'Avoid' | 'No setup' | 'Check data';

export interface Explanation {
  verdict: Verdict;
  tone: 'good' | 'wait' | 'bad' | 'neutral';
  /** one or two sentences */
  summary: string;
  /** supporting facts and cautions */
  points: string[];
  /** where a planned entry would make sense, if any */
  entryHint: string | null;
}

const rs = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `₹${formatNumberIN(x)}`);

export function explainSnapshot(symbol: string, s: TechSnapshot): Explanation {
  const points: string[] = [];
  const stretched = s.flags.includes('Stretched');
  if (s.flags.includes('Stale data')) points.push('Prices are stale — refresh before acting.');
  if (s.flags.includes('Low liquidity')) points.push(`Low trading activity (about ₹${formatNumberIN(s.avgTradedValueCr, 1)} crore a day) — buying and selling can be slow.`);

  if (s.flags.includes('Possible unadjusted action')) {
    return {
      verdict: 'Check data',
      tone: 'bad',
      summary: `${symbol}'s price history has a sudden jump that may be a missing bonus/split adjustment. Do not trust the signals until it is checked on the stock page.`,
      points,
      entryHint: null,
    };
  }
  if (s.trend === null || s.sma200 === null) {
    return { verdict: 'No setup', tone: 'neutral', summary: `Not enough history for ${symbol} yet (needs 200 trading days).`, points, entryHint: null };
  }
  if (s.trend === 'Downtrend' || s.flags.includes('Below 200-day')) {
    return {
      verdict: 'Avoid',
      tone: 'bad',
      summary: `${symbol} is below its 200-day average (${rs(s.sma200)}) — a long-term downtrend. The playbook says no swing buys here.`,
      points: [...points, `1-month change ${formatPct(s.ret1m, 1)}.`],
      entryHint: null,
    };
  }

  let summary: string;
  switch (s.setup) {
    case 'Breakout':
      summary = `${symbol} just broke above its 20-day high of ${rs(s.high20)} with ${formatNumberIN(s.volumeRatio, 1)}× its normal volume.`;
      break;
    case 'Pullback in uptrend':
      summary = `${symbol} is in an uptrend and has dipped back near its 20-day average (${rs(s.sma20)}) — a typical buy zone.`;
      break;
    case 'Clean uptrend':
      summary = `${symbol} is in a steady uptrend: the price is above its 20-, 50- and 200-day averages.`;
      break;
    case 'Recovering — trend not confirmed':
      summary = `${symbol} is back above its 200-day average, but the trend is not confirmed yet (50-day average still below the 200-day).`;
      break;
    default:
      summary = `${symbol} has no clear setup right now (${s.trend.toLowerCase()}).`;
  }

  if (stretched) {
    points.unshift(
      `It is stretched: RSI ${formatNumberIN(s.rsi14, 0)}, price ${formatNumberIN(s.stretch, 1)}× its daily move (ATR) above the 20-day average. Buying after a run like this often means buying the top of a swing.`,
    );
  }
  if (s.resistances[0]) points.push(`Next resistance (where sellers appeared before): ${rs(s.resistances[0].price)}.`);
  if (s.supports[0]) points.push(`Nearest support (where buyers appeared before): ${rs(s.supports[0].price)}.`);
  points.push(`Typical daily move: ${rs(s.atr14)} (ATR). 1-month change ${formatPct(s.ret1m, 1)}.`);

  const good = isShortlisted(s);
  let verdict: Verdict;
  let entryHint: string | null = null;
  const pullbackTop = s.sma20 !== null && s.atr14 !== null ? s.sma20 + 0.5 * s.atr14 : null;
  if (good && !stretched) {
    verdict = 'Good setup';
    entryHint =
      s.setup === 'Breakout' && s.high20 !== null
        ? `A limit buy near the breakout level ${rs(s.high20)} is safer than chasing the price.`
        : `A limit buy near ${rs(s.price)} fits; the 2×ATR stop would be about ${rs(s.atr14 ? s.price - 2 * s.atr14 : null)}.`;
  } else if (good || s.setup === 'Recovering — trend not confirmed') {
    verdict = 'Wait';
    entryHint = stretched && pullbackTop !== null ? `Wait for a pullback to about ${rs(pullbackTop)} or lower before planning a buy.` : 'Wait until the 50-day average crosses above the 200-day, or for a clear breakout.';
  } else {
    verdict = 'No setup';
  }
  const tone = verdict === 'Good setup' ? 'good' : verdict === 'Wait' ? 'wait' : 'neutral';
  return { verdict, tone, summary, points, entryHint };
}

/** Short label for the verdict a beginner can act on. */
export const PLAIN_VERDICT: Record<Verdict, string> = {
  'Good setup': 'Good to buy',
  Wait: 'Wait',
  Avoid: 'Avoid',
  'No setup': 'Nothing to do',
  'Check data': 'Ignore for now',
};

/**
 * One plain sentence about a stock for the Stocks list (owner, 11 Nov 2026: "I don't understand any of
 * these"). No RSI / SMA / "stretched" words — only what has happened to the price and what it means.
 * This is the few-days-to-weeks view; same-day BUY / SELL signals are shown separately.
 */
export function plainLine(s: TechSnapshot, verdict: Verdict): string {
  const stretched = s.flags.includes('Stretched');
  switch (verdict) {
    case 'Check data':
      return 'The price data needs checking.';
    case 'Avoid':
      return 'Has been falling for months — not a stock to buy now.';
    case 'Good setup':
      if (s.setup === 'Breakout') return 'Rising for months and just jumped to a new high with heavy buying.';
      if (s.setup === 'Pullback in uptrend') return 'Rising for months and has dipped a little — a usual point to buy.';
      return 'Rising steadily for months.';
    case 'Wait':
      if (s.setup === 'Recovering — trend not confirmed') return stretched ? 'Recovering after a fall, and it just rose fast — wait for a small dip.' : 'Recovering after a fall — not confirmed yet, so wait.';
      return 'Rising for months, but it rose too fast in the last few days — wait for a small dip.';
    default:
      if (s.trend === 'Uptrend') return 'Rising over the months, but not at a good buying point right now.';
      if (s.trend === 'Sideways') return 'Moving sideways — no clear direction.';
      return 'No clear direction right now.';
  }
}
