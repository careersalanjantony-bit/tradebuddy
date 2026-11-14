/**
 * Market breadth (app v1.4, owner's picture): how many Nifty 500 stocks are up vs down today, and
 * what that means for today's trades, in plain words.
 */

export interface Breadth {
  advanced: number;
  declined: number;
  unchanged: number;
  total: number;
}

export function breadthOf(quotes: Record<string, { ltp: number; prevClose: number | null } | undefined>, keys: string[]): Breadth {
  let advanced = 0;
  let declined = 0;
  let unchanged = 0;
  for (const k of keys) {
    const q = quotes[k];
    if (!q || !(q.ltp > 0) || !q.prevClose) continue;
    const ch = q.ltp / q.prevClose - 1;
    if (ch > 0.0005) advanced++;
    else if (ch < -0.0005) declined++;
    else unchanged++;
  }
  return { advanced, declined, unchanged, total: advanced + declined + unchanged };
}

export type BreadthTone = 'strong-up' | 'up' | 'mixed' | 'down' | 'strong-down';

export interface BreadthAdvice {
  tone: BreadthTone;
  headline: string;
  points: Array<{ label: string; text: string }>;
}

/** Plain-words meaning for day trades (buy and sell-first) and for holding a few days. */
export function breadthAdvice(b: Breadth): BreadthAdvice | null {
  if (b.total < 20) return null;
  const ratio = (b.advanced + 1) / (b.declined + 1);
  const tone: BreadthTone = ratio >= 2 ? 'strong-up' : ratio >= 1.25 ? 'up' : ratio <= 0.5 ? 'strong-down' : ratio <= 0.8 ? 'down' : 'mixed';
  const map: Record<BreadthTone, BreadthAdvice> = {
    'strong-up': {
      tone,
      headline: `Most stocks are rising — ${b.advanced} up, ${b.declined} down.`,
      points: [
        { label: 'Day trade', text: 'Buy ideas have the wind behind them; be careful with sell-first ideas.' },
        { label: 'Hold a few days', text: 'A good day, but do not chase stocks that already jumped.' },
      ],
    },
    up: {
      tone,
      headline: `More stocks are rising than falling — ${b.advanced} up, ${b.declined} down.`,
      points: [
        { label: 'Day trade', text: 'Buy ideas are favoured, but wait for the signal.' },
        { label: 'Hold a few days', text: 'Normal conditions.' },
      ],
    },
    mixed: {
      tone,
      headline: `Rising and falling stocks are about even — ${b.advanced} up, ${b.declined} down.`,
      points: [
        { label: 'Day trade', text: 'No side has the advantage; take only the clearest ideas.' },
        { label: 'Hold a few days', text: 'Normal conditions.' },
      ],
    },
    down: {
      tone,
      headline: `More stocks are falling than rising — ${b.advanced} up, ${b.declined} down.`,
      points: [
        { label: 'Day trade', text: 'Sell-first ideas may have an advantage, but wait for confirmation.' },
        { label: 'Hold a few days', text: 'Do not assume a longer rise has ended on one weak day.' },
      ],
    },
    'strong-down': {
      tone,
      headline: `Most stocks are falling — only ${b.advanced} up, ${b.declined} down.`,
      points: [
        { label: 'Day trade', text: 'Sell-first ideas have the wind behind them; be extra careful with buys.' },
        { label: 'Hold a few days', text: 'Do not assume the bigger uptrend has reversed — but buy smaller or wait.' },
        { label: 'Sell first', text: 'Look for stocks below the day’s average price and EMA 9, with lower highs and heavy selling — the "Falling now" list does this.' },
      ],
    },
  };
  return map[tone];
}
