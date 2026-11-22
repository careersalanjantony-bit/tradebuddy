import { chunk } from '../lib/chunk';
import { createLogger } from '../lib/log';
import { errorMessage } from '../lib/serialize';
import { getLocal } from '../storage/local';
import { getSession, setSession } from '../storage/session';
import { upstoxRequest } from '../upstox/client';
import { mergeLtp, mergeQuotes, type Quote } from './quotesParse';
import { universeKeys } from './universe';
import { isIndexKey } from './indices';

const log = createLogger('quotes');

/** Instruments we keep prices for: the studied list (Nifty 50/100) + watchlist + planned/open trades + active alerts. */
export async function trackedKeys(): Promise<string[]> {
  const [watchlist, plans, alerts, universe, dayTrades] = await Promise.all([getLocal('watchlist'), getLocal('plans'), getLocal('alerts'), universeKeys(), getLocal('dayTrades')]);
  // app v1.11: what you hold or trade first (the live feed serves these first), then your stocks and list
  const keys = new Set<string>();
  for (const t of dayTrades ?? []) if (t.status === 'open') keys.add(t.key);
  for (const p of plans ?? []) if (p.status === 'planned' || p.status === 'open') keys.add(p.key);
  for (const a of alerts ?? []) if (a.active) keys.add(a.key);
  const wallet = await getLocal('wallet');
  for (const h of wallet?.holdings ?? []) keys.add(h.key);
  for (const o of wallet?.orders ?? []) if (o.status === 'open') keys.add(o.key);
  for (const p of wallet?.shorts ?? []) keys.add(p.key);
  // the auto-trader's open trades (app v1.6)
  const bot = await getLocal('bot');
  for (const t of bot?.trades ?? []) if (t.status === 'open') keys.add(t.key);
  // its open shadow trades (app v1.23: followed with no money, they need live prices too)
  for (const t of bot?.shadow?.trades ?? []) if (t.status === 'open') keys.add(t.key);
  for (const k of watchlist ?? []) keys.add(k);
  for (const k of universe) keys.add(k);
  return [...keys];
}

export async function getQuotes(): Promise<Record<string, Quote>> {
  return (await getSession('quotes')) ?? {};
}

/**
 * One REST poll (LTP v3 + OHLC v3 interval=1d, up to 500 keys per call). Stands in for the live
 * WebSocket feed until M4.
 */
export async function pollQuotes(keys: string[], now = Date.now()): Promise<Record<string, Quote>> {
  if (!keys.length) return {};
  const fresh: Record<string, Quote> = {};
  try {
    for (const part of chunk(keys, 500)) {
      const query = { instrument_key: part.join(',') };
      const [ltp, ohlc] = await Promise.all([
        upstoxRequest<unknown>('/v3/market-quote/ltp', { tokenKind: 'market', query }),
        upstoxRequest<unknown>('/v3/market-quote/ohlc', { tokenKind: 'market', query: { ...query, interval: '1d' } }),
      ]);
      Object.assign(fresh, mergeQuotes(ltp, ohlc, now));
    }
    const prev = await getQuotes();
    await setSession('quotes', { ...prev, ...fresh });
    await setSession('lastPoll', { at: now, ok: true, count: Object.keys(fresh).length });
    const missing = keys.filter((k) => !fresh[k] && !isIndexKey(k));
    if (missing.length) log.warn(`No price returned for ${missing.length} instrument(s)`, { missing });
    return fresh;
  } catch (err) {
    await setSession('lastPoll', { at: now, ok: false, count: 0, error: errorMessage(err) });
    throw err;
  }
}

/**
 * App v1.20 — the price of ONE stock now (LTP v3 + OHLC v3), merged into the stored quotes. For a stock
 * opened in the order window or on its page that the app does not follow yet. Does not touch the
 * status of the regular price poll. Returns null when Upstox sends no price for it.
 */
export async function pollOne(key: string, now = Date.now()): Promise<Quote | null> {
  const query = { instrument_key: key };
  const [ltp, ohlc] = await Promise.all([
    upstoxRequest<unknown>('/v3/market-quote/ltp', { tokenKind: 'market', query, attempts: 2 }),
    upstoxRequest<unknown>('/v3/market-quote/ohlc', { tokenKind: 'market', query: { ...query, interval: '1d' }, attempts: 2 }),
  ]);
  const q = mergeQuotes(ltp, ohlc, now)[key];
  if (!q) return null;
  const prev = await getQuotes();
  // keep what the live feed added (VWAP, waiting quantities) when it is newer
  const old = prev[key];
  if (old && old.fetchedAt > q.fetchedAt) return old;
  await setSession('quotes', { ...prev, [key]: { ...(old ?? {}), ...q } });
  return q;
}

/** Number of requests one price poll needs for these keys (500 per call). */
export const quoteChunks = (keys: string[]): number => Math.max(1, Math.ceil(keys.length / 500));

/**
 * Light poll (v0.11.0): last prices only (LTP v3), merged into the stored quotes; the day's high/low
 * are stretched to include the new price. Used between full polls for ~2-second updates.
 */
export async function pollLtp(keys: string[], now = Date.now()): Promise<Record<string, Quote>> {
  if (!keys.length) return {};
  try {
    const prev = await getQuotes();
    let next = prev;
    let count = 0;
    for (const part of chunk(keys, 500)) {
      const ltp = await upstoxRequest<unknown>('/v3/market-quote/ltp', { tokenKind: 'market', query: { instrument_key: part.join(',') } });
      const r = mergeLtp(next, ltp, now);
      next = r.quotes;
      count += r.updated;
    }
    await setSession('quotes', next);
    await setSession('lastPoll', { at: now, ok: true, count });
    return next;
  } catch (err) {
    await setSession('lastPoll', { at: now, ok: false, count: 0, error: errorMessage(err) });
    throw err;
  }
}
