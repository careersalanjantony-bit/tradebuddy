import { NIFTY_KEY, VIX_KEY } from '../data/indices';
import type { Quote } from '../data/quotesParse';

/**
 * "Market mood" in plain words (v0.12.0): is the market as a whole rising or falling today, and how
 * nervous is it? From the Nifty 50 index, the share of studied stocks that are up on the day, and
 * India VIX (the market's "fear gauge"). Shown as one line; it adds a caution to signals but never
 * creates a trade by itself.
 */

export type Direction = 'rising' | 'falling' | 'mixed' | 'unknown';
export type Nerves = 'calm' | 'normal' | 'nervous' | 'very nervous' | 'unknown';

export interface Mood {
  /** Nifty 50 change today, % */
  niftyPct: number | null;
  up: number;
  down: number;
  total: number;
  vix: number | null;
  vixChangePct: number | null;
  direction: Direction;
  nerves: Nerves;
  /** short caution for signals, or null */
  caution: string | null;
}

const change = (q: Quote | undefined): number | null => (q && q.ltp > 0 && q.prevClose && q.prevClose > 0 ? (q.ltp / q.prevClose - 1) * 100 : null);

/** Rough guide to India VIX levels: below 13 quiet, 13–17 usual, 17–22 nervous, above 22 very nervous. */
export function nervesFromVix(vix: number | null): Nerves {
  if (vix === null || !(vix > 0)) return 'unknown';
  if (vix < 13) return 'calm';
  if (vix < 17) return 'normal';
  if (vix < 22) return 'nervous';
  return 'very nervous';
}

export function marketMood(quotes: Record<string, Quote>, keys: string[]): Mood {
  let up = 0;
  let down = 0;
  let total = 0;
  for (const k of keys) {
    const c = change(quotes[k]);
    if (c === null) continue;
    total++;
    if (c > 0) up++;
    else if (c < 0) down++;
  }
  const niftyPct = change(quotes[NIFTY_KEY]);
  const vq = quotes[VIX_KEY];
  const vix = vq && vq.ltp > 0 ? vq.ltp : null;
  const upShare = total >= 10 ? up / total : null;

  let direction: Direction = 'unknown';
  if (niftyPct !== null && upShare !== null) direction = niftyPct >= 0.25 && upShare >= 0.55 ? 'rising' : niftyPct <= -0.25 && upShare <= 0.45 ? 'falling' : 'mixed';
  else if (upShare !== null) direction = upShare >= 0.6 ? 'rising' : upShare <= 0.4 ? 'falling' : 'mixed';
  else if (niftyPct !== null) direction = niftyPct >= 0.25 ? 'rising' : niftyPct <= -0.25 ? 'falling' : 'mixed';

  const nerves = nervesFromVix(vix);
  const caution = nerves === 'very nervous' ? 'The market is very nervous today — prices can swing hard. Trade smaller or skip.' : nerves === 'nervous' ? 'The market is nervous today — be careful.' : null;
  return { niftyPct, up, down, total, vix, vixChangePct: change(vq), direction, nerves, caution };
}
