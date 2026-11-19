import { createLogger } from '../lib/log';
import { addDays, istDate, istEpoch, isWeekend, MINUTE } from '../lib/time';
import type { Candle } from '../indicators/types';
import { getDb } from '../storage/db';
import { getSettings } from '../storage/local';
import { upstoxRequest } from '../upstox/client';
import { nseSession, type MarketCalendar } from './calendar';
import { parseCandles } from './quotesParse';
import { historyByInstrument } from './historyCoverage';

const log = createLogger('candles');
const byInstrument = historyByInstrument();

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
export function syncCandles(key: string, cal: MarketCalendar | null, now = Date.now()): Promise<SyncResult> {
  return byInstrument(key, () => downloadCandles(key, cal, now));
}

export function dailyHistoryWindow(cal: MarketCalendar | null, now: number) {
  const today = istDate(now);
  const session = nseSession(today, cal);
  const final = !session.trading || !session.closeAt || now >= session.closeAt + 30 * MINUTE;
  return { today, final, closingRecheck: session.trading && final && now >= istEpoch(today, '18:00') };
}

async function downloadCandles(key: string, cal: MarketCalendar | null, now: number): Promise<SyncResult> {
  const window = dailyHistoryWindow(cal, now);
  const { today } = window;
  const db = await getDb();
  const id = `daily:${key}`;
  const checked = (await db.get('historyState', id))?.daily;
  const last = await lastStoredDate(key);
  // The scheduled 18:00 retry only needs stocks whose closing candle was missing the first time.
  const recheck = window.closingRecheck && last !== today && !checked?.closingRecheck;
  if (checked && (checked.today > today || (checked.today === today && (checked.final || !window.final) && !recheck))) {
    return { key, fetched: 0, lastDate: last };
  }
  const years = Math.min(10, Math.max(1, (await getSettings()).data.candleHistoryYears));
  const from = last ? addDays(last, -7) : addDays(today, -Math.round(years * 365.25) - 7);
  const data = await upstoxRequest<unknown>(`/v3/historical-candle/${encodeURIComponent(key)}/days/1/${today}/${from}`, { tokenKind: 'market' });
  let rows = parseCandles(data);
  if (!window.final) rows = rows.filter((r) => r.date < today);

  const tx = db.transaction(['candles', 'historyState'], 'readwrite');
  const writes = rows.map((r) => {
    const special = isWeekend(r.date) || nseSession(r.date, cal).special;
    return tx.objectStore('candles').put({ ...r, instrument_key: key, ...(special ? { special: true } : {}) });
  });
  const coverage = Promise.all(writes).then(() => tx.objectStore('historyState').put({ id, daily: window }));
  await Promise.all([coverage, tx.done]);
  const lastDate = rows.length ? rows[rows.length - 1]!.date : last;
  log.debug(`Candles ${key}: ${rows.length} rows (${from} → ${lastDate})`);
  return { key, fetched: rows.length, lastDate };
}
