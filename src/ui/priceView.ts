import { formatNumberIN } from '../lib/format';

/** App v1.20: while the market is open, a price older than this is not shown (never a stale price). */
export const PRICE_FRESH_MS = 60_000;

/**
 * What the order window may show as the price. Pure. While the market is open (or in the pre-open)
 * only a price from the last minute; when closed, the last traded price (marked as such by the window).
 */
export function priceView(
  q: { ltp: number; fetchedAt: number } | undefined,
  marketLive: boolean,
  now: number,
  loading: boolean,
  error: string | null,
): { ltp: number | null; state: 'live' | 'closed' | 'loading' | 'error'; text: string } {
  if (q && q.ltp > 0 && (!marketLive || now - q.fetchedAt < PRICE_FRESH_MS)) return { ltp: q.ltp, state: marketLive ? 'live' : 'closed', text: `₹${formatNumberIN(q.ltp)}` };
  if (loading || (!error && !q)) return { ltp: null, state: 'loading', text: q ? 'updating price…' : 'price loading…' };
  return { ltp: null, state: 'error', text: 'live price unavailable' };
}
