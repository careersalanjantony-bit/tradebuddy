import { createLogger } from '../lib/log';
import { addDays, istDate, isWeekend, MINUTE } from '../lib/time';
import type { Candle } from '../indicators/types';
import { getDb } from '../storage/db';
import { getSettings } from '../storage/local';
import { upstoxRequest } from '../upstox/client';
import { nseSession, type MarketCalendar } from './calendar';
import { parseCandles } from './quotesParse';

const log = createLogger('candles');

/** Raw (unadjusted) daily candles for one instrument, oldest first. */
export async function getRawCandles(key: string): Promise<Candle[]> {
  const rows = await (await getDb()).getAll('candles', IDBKeyRange.bound([key, ''], [key, '￿']));
  return rows.map(({ instrument_key: _k, ...c }) => c);
}

/** The newest `n` stored daily candles of a stock, oldest first (reads only those, app v1.9). */
export async function getRecentCandles(key: string, n: number): Promise<Candle[]> {
  const db = await getDb();
  const out: Candle[] = [];
  let cur = await db.transaction('candles').store.openCursor(IDBKeyRange.bound([key, ''], [key, '￿']), 'prev');
  while (cur && out.length < n) {
    const { instrument_key: _k, ...c } = cur.value;
    out.push(c);
    cur = await cur.continue();
  }
  return out.reverse();
}

async function lastStoredDate(key: string): Promise<string | null> {
  const db = await getDb();
  const cur = await db.transaction('candles').store.openCursor(IDBKeyRange.bound([key, ''], [key, '￿']), 'prev');
  return cur ? cur.value.date : null;
}

export interface SyncResult {
  key: string;
  fetched: number;
  lastDate: string | null;
}

/**
 * Fetches daily candles (spec §7.4): the first time `candleHistoryYears` of history, afterwards
 * the last week again (in case of corrections) up to today. Today's candle is stored only once the
 * session has been closed for 30 minutes; until then the live quote supplies today's values.
 */
export async function syncCandles(key: string, cal: MarketCalendar | null, now = Date.now()): Promise<SyncResult> {
  const today = istDate(now);
  const last = await lastStoredDate(key);
  const years = Math.min(10, Math.max(1, (await getSettings()).data.candleHistoryYears));
  const from = last ? addDays(last, -7) : addDays(today, -Math.round(years * 365.25) - 7);
  const data = await upstoxRequest<unknown>(`/v3/historical-candle/${encodeURIComponent(key)}/days/1/${today}/${from}`, { tokenKind: 'market' });
  let rows = parseCandles(data);
  const session = nseSession(today, cal);
  if (session.trading && session.closeAt && now < session.closeAt + 30 * MINUTE) rows = rows.filter((r) => r.date < today);

  const db = await getDb();
  const tx = db.transaction('candles', 'readwrite');
  for (const r of rows) {
    const special = isWeekend(r.date) || nseSession(r.date, cal).special;
    void tx.store.put({ ...r, instrument_key: key, ...(special ? { special: true } : {}) });
  }
  await tx.done;
  const lastDate = rows.length ? rows[rows.length - 1]!.date : last;
  log.debug(`Candles ${key}: ${rows.length} rows (${from} → ${lastDate})`);
  return { key, fetched: rows.length, lastDate };
}
