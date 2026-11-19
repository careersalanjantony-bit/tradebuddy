import type { Bars, DayBars } from '../daytrade/types';
import { createLogger } from '../lib/log';
import { addDays, istDate } from '../lib/time';
import { getDb } from '../storage/db';
import { upstoxRequest } from '../upstox/client';
import { historyByInstrument, mergeRanges, missingRanges, type DateRange } from './historyCoverage';

/**
 * 5-minute candles for the day-trade mode (v0.11.0). Upstox v3 (docs checked 11 Nov 2026):
 *   history: GET /v3/historical-candle/{key}/minutes/5/{to}/{from} — minutes data from Jan 2022, at most
 *            1 month per request for 1–15 minute intervals;
 *   today:   GET /v3/historical-candle/intraday/{key}/minutes/5 — the current trading day.
 * Candle = [ "2025-01-12T15:15:00+05:30", open, high, low, close, volume, oi ] (start time of the bar).
 * Stored one record per stock per day (compact arrays).
 */

const log = createLogger('intraday');
export const INTRADAY_INTERVAL = 5;
const FIRST_T = 9 * 60 + 15;
const LAST_T = 15 * 60 + 30;
/** days per history request (the limit is "1 month") */
const CHUNK_DAYS = 28;
/**
 * App v1.11: trading days of 5-minute history kept for scan-list stocks outside the Stocks tab —
 * enough for the live scanners (usual opening volume of the last 10 days, yesterday's high), small
 * enough for a phone. Stocks-tab stocks keep the full past-test window.
 */
export const SCAN_HISTORY_SESSIONS = 25;
const byInstrument = historyByInstrument();
const liveRequests = new Map<string, Promise<Bars | null>>();

/** Groups a candles response by IST date; bars sorted by time, market hours only. */
export function parseIntraday(data: unknown): Map<string, Bars> {
  const rows = (data as { candles?: unknown })?.candles;
  const byDate = new Map<string, Array<[number, number, number, number, number, number]>>();
  if (!Array.isArray(rows)) throw new Error('Intraday candles response: candles is not an array');
  for (const r of rows) {
    if (!Array.isArray(r) || typeof r[0] !== 'string') continue;
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(r[0]);
    if (!m) continue;
    const t = Number(m[2]) * 60 + Number(m[3]);
    const [o, h, l, c, v] = [r[1], r[2], r[3], r[4], r[5]].map(Number) as [number, number, number, number, number];
    if (t < FIRST_T || t >= LAST_T || !(o > 0) || !(h > 0) || !(l > 0) || !(c > 0)) continue;
    const list = byDate.get(m[1]!) ?? [];
    list.push([t, o, h, l, c, Number.isFinite(v) ? v : 0]);
    byDate.set(m[1]!, list);
  }
  const out = new Map<string, Bars>();
  for (const [date, list] of byDate) {
    list.sort((a, b) => a[0] - b[0]);
    const b: Bars = { t: [], o: [], h: [], l: [], c: [], v: [] };
    let last = -1;
    for (const [t, o, h, l, c, v] of list) {
      if (t === last) continue;
      last = t;
      b.t.push(t);
      b.o.push(o);
      b.h.push(h);
      b.l.push(l);
      b.c.push(c);
      b.v.push(v);
    }
    out.set(date, b);
  }
  return out;
}

const range = (key: string) => IDBKeyRange.bound([key, ''], [key, '￿']);

export async function getIntradayDays(key: string): Promise<DayBars[]> {
  return (await getDb()).getAll('intraday', range(key));
}

export async function countIntradayDays(key: string): Promise<number> {
  return (await getDb()).count('intraday', range(key));
}

async function firstIntradayDate(key: string): Promise<string | null> {
  const cur = await (await getDb()).transaction('intraday').store.openCursor(range(key), 'next');
  return cur ? cur.value.date : null;
}

async function lastIntradayDate(key: string): Promise<string | null> {
  const cur = await (await getDb()).transaction('intraday').store.openCursor(range(key), 'prev');
  return cur ? cur.value.date : null;
}

async function store(key: string, days: Map<string, Bars>, covered: DateRange[]): Promise<void> {
  const tx = (await getDb()).transaction(['intraday', 'historyState'], 'readwrite');
  const bars = tx.objectStore('intraday');
  const writes = [...days].map(([date, b]) => bars.put({ key, date, ...b }));
  const checkpoint = Promise.all(writes).then(() =>
    tx.objectStore('historyState').put({ id: `intraday:${key}`, intraday: covered }));
  await Promise.all([checkpoint, tx.done]);
}

/** Calendar days to go back for `sessions` trading days (weekends + holidays). */
export const calendarDaysFor = (sessions: number): number => Math.ceil(sessions * 1.48) + 6;

/**
 * Downloads the missing 5-minute history for one stock up to yesterday (the first time ≈ `sessions`
 * trading days, 1 request per 28 days; afterwards only the new days). Returns the number of days stored.
 */
export function syncIntraday(key: string, sessions: number, now = Date.now()): Promise<number> {
  return byInstrument(key, () => downloadIntraday(key, sessions, now));
}

async function downloadIntraday(key: string, sessions: number, now: number): Promise<number> {
  const today = istDate(now);
  const end = addDays(today, -1);
  const earliest = addDays(today, -calendarDaysFor(sessions));
  const db = await getDb();
  let covered = (await db.get('historyState', `intraday:${key}`))?.intraday;
  if (!covered) {
    // Existing installations have bars but no range journal. Preserve their existing window.
    const [first, last] = await Promise.all([firstIntradayDate(key), lastIntradayDate(key)]);
    covered = first && last ? [{ from: first, to: last }] : [];
  }
  let stored = 0;
  for (const gap of missingRanges({ from: earliest, to: end }, covered)) {
    for (let from = gap.from; from <= gap.to;) {
      const lastDayInChunk = addDays(from, CHUNK_DAYS - 1);
      const to = lastDayInChunk < gap.to ? lastDayInChunk : gap.to;
      const data = await upstoxRequest<unknown>(`/v3/historical-candle/${encodeURIComponent(key)}/minutes/${INTRADAY_INTERVAL}/${to}/${from}`, { tokenKind: 'market' });
      const days = parseIntraday(data);
      covered = mergeRanges([...covered, { from, to }]);
      await store(key, days, covered);
      stored += days.size;
      from = addDays(to, 1);
    }
  }
  if (stored) log.debug(`Intraday ${key}: ${stored} day(s) stored`);
  return stored;
}

/** Removes days older than the test window (keeps storage small). */
export function pruneIntraday(key: string, sessions: number, now = Date.now()): Promise<void> {
  return byInstrument(key, async () => {
    const cutoff = addDays(istDate(now), -calendarDaysFor(sessions) - 30);
    const db = await getDb();
    const id = `intraday:${key}`;
    const saved = (await db.get('historyState', id))?.intraday;
    const tx = db.transaction(['intraday', 'historyState'], 'readwrite');
    const update = tx.objectStore('intraday').delete(IDBKeyRange.bound([key, ''], [key, cutoff])).then(() => {
      if (saved) {
        const intraday = saved.filter((r) => r.to > cutoff)
          .map((r) => ({ from: r.from <= cutoff ? addDays(cutoff, 1) : r.from, to: r.to }));
        return tx.objectStore('historyState').put({ id, intraday });
      }
      return undefined;
    });
    await Promise.all([update, tx.done]);
  });
}

/** Today's 5-minute bars so far (current trading day). */
export function fetchTodayBars(key: string, now = Date.now()): Promise<Bars | null> {
  const date = istDate(now);
  const id = `${key}:${date}`;
  const active = liveRequests.get(id);
  if (active) return active;
  const request = upstoxRequest<unknown>(`/v3/historical-candle/intraday/${encodeURIComponent(key)}/minutes/${INTRADAY_INTERVAL}`, { tokenKind: 'market' })
    .then((data) => parseIntraday(data).get(date) ?? null)
    .finally(() => liveRequests.delete(id));
  liveRequests.set(id, request);
  return request;
}

/** Runs `fn` over `items` with at most `n` running at once. */
export async function pool<T>(items: T[], n: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}
