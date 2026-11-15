import { createQueue } from '../lib/queue';
import { istDate } from '../lib/time';
import { getLocal, setLocal } from '../storage/local';

/**
 * App v1.11: one alert per stock and direction across the three Day Trade scanners. A stock that
 * Today's buy ideas already announced as a BUY is not announced again by Breakout today within 30
 * minutes (and the other way round); the same for SELL between Falling now and the day-trade SELL
 * signals. Each scanner still lists the idea — only the second alert is left out. Each scanner keeps
 * its own once-per-stock rules as before (a breakout's "Confirmed" follow-up is the same idea).
 */

export type IdeaSide = 'buy' | 'sell';
export const SAME_IDEA_MS = 30 * 60_000;
type Item = { key: string; side: IdeaSide; src: string; at: number };

/** May `src` alert this stock now? Not when another scanner alerted it, same direction, in the last 30 minutes. */
export function gateAllows(items: Item[], key: string, side: IdeaSide, src: string, now: number): boolean {
  return !items.some((x) => x.key === key && x.side === side && x.src !== src && now - x.at >= 0 && now - x.at < SAME_IDEA_MS);
}

const queue = createQueue();

/** Records the alert and returns true when it may go out (one at a time, so two scanners cannot both pass). */
export function claimAlert(key: string, side: IdeaSide, src: string, now = Date.now()): Promise<boolean> {
  return queue(async () => {
    const date = istDate(now);
    const prev = await getLocal('ideaAlerts');
    const items = prev?.date === date ? prev.items : [];
    if (!gateAllows(items, key, side, src, now)) return false;
    await setLocal('ideaAlerts', { date, items: [...items, { key, side, src, at: now }].slice(-600) });
    return true;
  });
}
