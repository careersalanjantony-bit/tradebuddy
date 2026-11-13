import { applyAdjustments, detectAdjustments, findSuspiciousGaps, type AdjustmentEvent, type SuspiciousGap } from '../indicators/adjust';
import { computeSnapshot, type TechSnapshot } from '../indicators/snapshot';
import type { Candle } from '../indicators/types';
import { istDate } from '../lib/time';
import type { CorpActionsRecord } from '../storage/db';
import type { Settings } from '../storage/schema';
import { marketState, quoteSessionDate, type MarketCalendar } from './calendar';
import { getRawCandles } from './candles';
import { getAdjustmentOverride, getCorporateActions } from './corporateActions';
import { getInstrument } from './instruments';
import type { Instrument } from './instrumentsParse';
import type { Quote } from './quotesParse';

/**
 * Everything the screens and the alert engine need for one stock, computed from stored data.
 * Usable from the service worker and from pages (IndexedDB is shared).
 */

/** A price older than this during market hours is "stale" (no price alerts on stale data). */
export const STALE_MS = 90_000;

export interface StockData {
  key: string;
  instrument: Instrument | null;
  raw: Candle[];
  /** adjusted candles + today's live candle (if any) */
  candles: Candle[];
  events: AdjustmentEvent[];
  suspicious: SuspiciousGap[];
  quote: Quote | null;
  snapshot: TechSnapshot | null;
  stale: boolean;
  corp: CorpActionsRecord | null;
  lastCandleDate: string | null;
}

/**
 * A candle for the latest session from the latest quote, when the stored history does not have that
 * session yet: today's unfinished candle during market hours, or the last session's finished candle
 * in the evening / before the next open (Upstox publishes the daily candle only late at night, so
 * without this the screens would show the previous day's close).
 */
export function liveCandle(quote: Quote | null | undefined, lastRawDate: string | null, now: number, cal: MarketCalendar | null): Candle | null {
  if (!quote || !(quote.ltp > 0)) return null;
  if (quote.fetchedAt > now) return null;
  const date = quoteSessionDate(quote.fetchedAt, cal);
  if (date === null) return null;
  if (lastRawDate !== null && lastRawDate >= date) return null;
  const m = marketState(now, cal);
  if (m.phase === 'pre_open') return null;
  // the day's open/high/low may be missing (e.g. before the open); the last price alone still gives today's price
  const open = quote.open !== null && quote.open > 0 ? quote.open : quote.ltp;
  return {
    date,
    open,
    high: Math.max(quote.high ?? quote.ltp, quote.ltp, open),
    low: Math.min(quote.low !== null && quote.low > 0 ? quote.low : quote.ltp, quote.ltp, open),
    close: quote.ltp,
    volume: quote.volume ?? 0,
    partial: true,
  };
}

export function isStale(quote: Quote | null | undefined, now: number, cal: MarketCalendar | null): boolean {
  if (marketState(now, cal).phase !== 'open') return false; // after hours prices are "closed", not stale
  return !quote || now - quote.fetchedAt > STALE_MS;
}

/**
 * Per-page cache of the slow part (IndexedDB reads + adjustment), so studying 50–100 stocks every
 * 30 s stays fast. Invalidated when new candles are stored (see invalidateStockCache).
 */
interface Cached {
  raw: Candle[];
  instrument: Instrument | null;
  corp: CorpActionsRecord | null;
  events: AdjustmentEvent[];
  adjusted: Candle[];
  suspicious: SuspiciousGap[];
  tol: string;
}
const cache = new Map<string, Cached>();

export function invalidateStockCache(key?: string): void {
  if (key) cache.delete(key);
  else cache.clear();
}

export async function loadStockData(key: string, ctx: { quote?: Quote | null; settings: Settings; calendar: MarketCalendar | null; now?: number }): Promise<StockData> {
  const now = ctx.now ?? Date.now();
  const ind = ctx.settings.indicators;
  const tol = `${ind.adjustmentTolerancePct}/${ind.gapDetectorPct}`;
  let c = cache.get(key);
  if (!c || c.tol !== tol) {
    const [rawRows, inst, override] = await Promise.all([getRawCandles(key), getInstrument(key), getAdjustmentOverride(key)]);
    const corpRec = inst?.isin ? ((await getCorporateActions(inst.isin)) ?? null) : null;
    const { events: ev } = detectAdjustments(rawRows, corpRec?.actions ?? [], ind.adjustmentTolerancePct);
    const adj = applyAdjustments(rawRows, ev);
    // Only gaps inside the window the indicators use (≈ last 260 sessions) affect the flags.
    const sus = findSuspiciousGaps(adj.slice(-260), ind.gapDetectorPct, override?.ignoredGapDates ?? []);
    c = { raw: rawRows, instrument: inst ?? null, corp: corpRec, events: ev, adjusted: adj, suspicious: sus, tol };
    cache.set(key, c);
  }
  const { raw, events, adjusted, suspicious, corp } = c;
  const instrument = c.instrument;

  const lastCandleDate = raw.length ? raw[raw.length - 1]!.date : null;
  const quote = ctx.quote ?? null;
  const live = liveCandle(quote, lastCandleDate, now, ctx.calendar);
  const candles = live ? [...adjusted, live] : adjusted;
  const stale = isStale(quote, now, ctx.calendar);
  const snapshot = computeSnapshot(candles, { settings: ind, unadjustedSuspected: suspicious.length > 0, stale });
  // Day change against Upstox's own previous close (the stored history can lag by a day: the daily
  // candle is not published by the evening of the same day — see docs/VERIFIED.md).
  if (snapshot && live && quote?.prevClose) {
    snapshot.prevClose = quote.prevClose;
    snapshot.changePct = (snapshot.price / quote.prevClose - 1) * 100;
  }

  return { key, instrument, raw, candles, events, suspicious, quote, snapshot, stale, corp, lastCandleDate };
}
