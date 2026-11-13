import { createLogger } from '../lib/log';
import { ist } from '../lib/time';
import { getLocal, setLocal } from '../storage/local';
import { upstoxRequest } from '../upstox/client';
import { calendarNeedsRefresh, parseHolidays, type MarketCalendar } from './calendar';

const log = createLogger('calendar');

export async function getCalendar(): Promise<MarketCalendar | null> {
  return (await getLocal('marketCalendar')) ?? null;
}

/** Stores a holidays payload (array) as this year's calendar. */
export async function storeHolidays(data: unknown, now = Date.now()): Promise<MarketCalendar> {
  const holidays = parseHolidays(data);
  // The API returns "the current year"; take the year from the entries, in case Upstox has not rolled over yet.
  const years = new Map<number, number>();
  for (const h of holidays) {
    const y = Number(h.date.slice(0, 4));
    years.set(y, (years.get(y) ?? 0) + 1);
  }
  const year = [...years.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ist(now).year;
  if (year !== ist(now).year) log.warn(`Holiday list is for ${year}, not ${ist(now).year}; weekday rules will be used until it updates`);
  const cal: MarketCalendar = { year, fetchedAt: now, holidays };
  await setLocal('marketCalendar', cal);
  log.info(`Holiday list updated: ${holidays.length} entries for ${year}`);
  return cal;
}

/** GET /v2/market/holidays (current year). */
export async function refreshCalendar(): Promise<MarketCalendar> {
  const data = await upstoxRequest<unknown>('/v2/market/holidays', { tokenKind: 'market' });
  return storeHolidays(data);
}

/** Refreshes when stale and a token is available; never throws. */
export async function refreshCalendarIfNeeded(now = Date.now()): Promise<void> {
  if (!calendarNeedsRefresh(await getCalendar(), now)) return;
  try {
    await refreshCalendar();
  } catch (err) {
    log.info('Holiday list not refreshed yet', { reason: err instanceof Error ? err.message : String(err) });
  }
}
