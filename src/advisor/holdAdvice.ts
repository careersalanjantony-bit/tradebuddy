import type { Candle } from '../indicators/types';

/**
 * Hold-or-sell advice for an open trade (owner's request, 9 Nov 2026). Evaluated live in the UI and
 * after the close by the service worker. Order of checks (first match wins):
 *   1. EXIT        price at/below the stop
 *   2. SELL        last COMPLETED close below the trailing stop. Trailing starts only once a close has
 *                  reached +1R (spec: "after +1R move the stop to breakeven"): then it is the higher of
 *                  the entry and (highest close − trail×ATR). Before +1R the initial stop stays.
 *   3. BOOK_PROFIT price at/above the hold-until target
 *   4. safe target reached:
 *        HOLD        trend still healthy (above SMA20, RSI ≤ 75, stretch ≤ 3 ATR)
 *        BOOK_PROFIT otherwise (momentum fading)
 *   5. REVIEW      held ≥ time-stop sessions and less than +0.5R
 *   6. HOLD        otherwise
 * Advice, not an order: the owner decides and acts in the Upstox app.
 */

export type AdviceAction = 'EXIT' | 'SELL' | 'BOOK_PROFIT' | 'HOLD' | 'REVIEW';

export interface AdviceInput {
  entry: number; // fill price (or planned entry)
  stop: number; // initial stop
  safeTarget: number | null;
  holdTarget: number | null;
  /** adjusted candles from the entry date on, oldest first; may end with today's partial candle */
  sinceEntry: Candle[];
  price: number;
  atr: number | null;
  sma20: number | null;
  rsi: number | null;
  stretch: number | null;
  trailAtr?: number;
  timeStopSessions?: number;
  tick?: number;
}

export interface Advice {
  action: AdviceAction;
  headline: string;
  reasons: string[];
  /** current trailing stop (₹) */
  trailingStop: number;
  /** suggested new GTT stop when the trailing stop has risen above the initial stop */
  moveStopTo: number | null;
  /** current gain/loss in R */
  r: number;
  sessionsHeld: number;
}

const fmt = (x: number) => `₹${x.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const roundDown = (x: number, tick: number) => Number((Math.floor(x / tick + 1e-9) * tick).toFixed(4));

export function trailingStopFor(entry: number, stop: number, closes: number[], atr: number | null, trailAtr = 2): number {
  const R = entry - stop;
  const highest = closes.length ? Math.max(...closes) : entry;
  if (highest < entry + R) return stop; // not yet +1R: keep the initial stop
  let t = Math.max(stop, entry); // after +1R: never give back the whole trade
  if (atr) t = Math.max(t, highest - trailAtr * atr);
  return t;
}

export function adviseOpenTrade(inp: AdviceInput): Advice {
  const trailAtr = inp.trailAtr ?? 2;
  const timeStop = inp.timeStopSessions ?? 15;
  const tick = inp.tick ?? 0.05;
  const R = inp.entry - inp.stop;
  const r = R > 0 ? (inp.price - inp.entry) / R : 0;
  const completed = inp.sinceEntry.filter((c) => !c.partial);
  const sessionsHeld = completed.length;
  const closesForTrail = [...completed.map((c) => c.close)];
  const trailingStop = roundDown(trailingStopFor(inp.entry, inp.stop, closesForTrail, inp.atr, trailAtr), tick);
  const moveStopTo = inp.atr && trailingStop > inp.stop + 0.1 * inp.atr ? trailingStop : null;
  const lastClose = completed.length ? completed[completed.length - 1]!.close : null;
  const base = { trailingStop, moveStopTo, r, sessionsHeld };
  const healthy = inp.sma20 !== null && inp.price > inp.sma20 && (inp.rsi === null || inp.rsi <= 75) && (inp.stretch === null || inp.stretch <= 3);

  if (inp.price <= inp.stop) {
    return { ...base, action: 'EXIT', headline: `Stop ${fmt(inp.stop)} hit — exit.`, reasons: ['Your GTT stop-loss should already have sold. If not, sell now.', 'Never move a stop lower.'] };
  }
  if (lastClose !== null && trailingStop > inp.stop && lastClose < trailingStop) {
    return {
      ...base,
      action: 'SELL',
      headline: `Closed below the trailing stop ${fmt(trailingStop)} — sell.`,
      reasons: [`Last close ${fmt(lastClose)} is below the trailing stop (highest close − ${trailAtr}×ATR${trailingStop === roundDown(inp.entry, tick) ? ', held at breakeven' : ''}).`, 'The up-move has broken; protect what is left.'],
    };
  }
  if (inp.holdTarget !== null && inp.price >= inp.holdTarget) {
    return {
      ...base,
      action: 'BOOK_PROFIT',
      headline: `Hold-until target ${fmt(inp.holdTarget)} reached — book profit.`,
      reasons: ['This is the top of how far the stock usually ran in 20 days in the last year.', `If you keep part, raise the stop to at least ${fmt(roundDown(inp.price - (inp.atr ?? R / 2), tick))}.`],
    };
  }
  if (inp.safeTarget !== null && inp.price >= inp.safeTarget) {
    if (healthy) {
      return {
        ...base,
        action: 'HOLD',
        headline: `Safe target ${fmt(inp.safeTarget)} reached; trend still healthy — hold${inp.holdTarget ? ` toward ${fmt(inp.holdTarget)}` : ''}.`,
        reasons: [
          `Price is above its 20-day average${inp.rsi !== null ? `, RSI ${inp.rsi.toFixed(0)}` : ''}.`,
          `Raise your GTT stop to ${fmt(Math.max(trailingStop, roundDown(inp.entry, tick)))} so the profit cannot turn into a loss.`,
          'Prefer certainty? Selling here is also fine — this level was reached in most similar past cases.',
        ],
        moveStopTo: Math.max(trailingStop, roundDown(inp.entry, tick)),
      };
    }
    const why: string[] = [];
    const belowAvg = inp.sma20 !== null && inp.price <= inp.sma20;
    const hot = inp.rsi !== null && inp.rsi > 75;
    if (belowAvg) why.push('price is below its 20-day average');
    if (hot) why.push(`RSI ${inp.rsi!.toFixed(0)} is very high`);
    if (inp.stretch !== null && inp.stretch > 3) why.push(`price is ${inp.stretch.toFixed(1)} ATR above its 20-day average`);
    const protect = Math.max(trailingStop, roundDown(inp.entry, tick));
    if (!belowAvg && !hot) {
      // only overextended: a pullback is likely, but the trend itself is fine
      return {
        ...base,
        action: 'BOOK_PROFIT',
        headline: `Safe target ${fmt(inp.safeTarget)} reached and the price is overextended — book profit, or at least raise your stop to ${fmt(protect)}.`,
        reasons: [`Because ${why.join(', ')}. Prices this far above their average usually pull back.`],
        moveStopTo: protect,
      };
    }
    return { ...base, action: 'BOOK_PROFIT', headline: `Safe target ${fmt(inp.safeTarget)} reached and momentum is fading — book profit.`, reasons: [`Because ${why.join(', ')}.`] };
  }
  if (sessionsHeld >= timeStop && r < 0.5) {
    return { ...base, action: 'REVIEW', headline: `No progress in ${sessionsHeld} sessions — review; usually exit.`, reasons: [`The trade is at ${r.toFixed(2)}R after ${sessionsHeld} sessions (time stop: ${timeStop}).`, 'Money stuck in a flat trade could be used elsewhere.'] };
  }
  const reasons = [`Now ${r >= 0 ? '+' : ''}${r.toFixed(2)}R.`];
  if (inp.safeTarget) reasons.push(`Next level: safe target ${fmt(inp.safeTarget)}.`);
  if (moveStopTo) reasons.push(`Move your GTT stop up to ${fmt(moveStopTo)}.`);
  else reasons.push(`Keep the stop at ${fmt(inp.stop)}.`);
  return { ...base, action: 'HOLD', headline: healthy ? 'Trend intact — hold.' : 'Hold, but the trend is soft — watch the stop.', reasons };
}
