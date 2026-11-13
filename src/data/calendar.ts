import { addDays, istDate, istEpoch, isWeekend, ist, MINUTE } from '../lib/time';

/**
 * NSE market calendar (spec §8) from the Upstox holidays API.
 *
 * Rule (see docs/VERIFIED.md): NSE is closed on a date only if NSE is in `closed_exchanges`.
 * If NSE is in `open_exchanges`, its start/end times are used — this covers special sessions such as
 * Diwali Muhurat on a weekend. `holiday_type` alone is not trusted. Dates not in the list follow
 * the normal weekday schedule.
 */

export type HolidayType = 'TRADING_HOLIDAY' | 'SETTLEMENT_HOLIDAY' | 'SPECIAL_TIMING' | string;

export interface HolidayEntry {
  date: string;
  description: string;
  holiday_type: HolidayType;
  closed_exchanges: string[];
  open_exchanges: Array<{ exchange: string; start_time: number; end_time: number }>;
}

export interface MarketCalendar {
  /** IST calendar year the list covers */
  year: number;
  fetchedAt: number;
  holidays: HolidayEntry[];
}

export const NSE = 'NSE';
export const NORMAL_PRE_OPEN = '09:00';
export const NORMAL_OPEN = '09:15';
export const NORMAL_CLOSE = '15:30';
/** For special sessions the API gives start/end only; assume pre-open starts 15 min before. */
const SPECIAL_PRE_OPEN_LEAD = 15 * MINUTE;

export interface DaySession {
  date: string;
  trading: boolean;
  /** different timing from a normal day (e.g. Muhurat) — such candles are excluded from volume averages */
  special: boolean;
  /** holiday / special-session description */
  reason?: string;
  preOpenAt?: number;
  openAt?: number;
  closeAt?: number;
  /** false when the holiday list for this year is not loaded: weekday rules were assumed */
  confirmed: boolean;
}

/** Validates and normalises the API's `data` array. Throws on a wrong shape. */
export function parseHolidays(data: unknown): HolidayEntry[] {
  if (!Array.isArray(data)) throw new Error('Holidays response: data is not an array');
  return data.map((raw, i) => {
    const h = raw as Partial<HolidayEntry>;
    if (typeof h.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(h.date)) {
      throw new Error(`Holidays response: entry ${i} has no valid date`);
    }
    return {
      date: h.date,
      description: typeof h.description === 'string' ? h.description : '',
      holiday_type: typeof h.holiday_type === 'string' ? h.holiday_type : 'TRADING_HOLIDAY',
      closed_exchanges: Array.isArray(h.closed_exchanges) ? h.closed_exchanges.filter((x): x is string => typeof x === 'string') : [],
      open_exchanges: Array.isArray(h.open_exchanges)
        ? h.open_exchanges.filter(
            (x): x is { exchange: string; start_time: number; end_time: number } =>
              !!x && typeof x.exchange === 'string' && Number.isFinite(x.start_time) && Number.isFinite(x.end_time),
          )
        : [],
    };
  });
}

function calendarCovers(cal: MarketCalendar | null | undefined, date: string): cal is MarketCalendar {
  return !!cal && String(cal.year) === date.slice(0, 4);
}

export function nseSession(date: string, cal: MarketCalendar | null | undefined): DaySession {
  const confirmed = calendarCovers(cal, date);
  const entry = confirmed ? cal.holidays.find((h) => h.date === date) : undefined;

  if (entry) {
    if (entry.closed_exchanges.includes(NSE)) {
      return { date, trading: false, special: false, reason: entry.description || 'Holiday', confirmed };
    }
    const open = entry.open_exchanges.find((o) => o.exchange === NSE);
    if (open) {
      const normalOpen = istEpoch(date, NORMAL_OPEN);
      const normalClose = istEpoch(date, NORMAL_CLOSE);
      const special = isWeekend(date) || open.start_time !== normalOpen || open.end_time !== normalClose || entry.holiday_type === 'SPECIAL_TIMING';
      return {
        date,
        trading: true,
        special,
        ...(special ? { reason: entry.description || 'Special session' } : {}),
        preOpenAt: special ? open.start_time - SPECIAL_PRE_OPEN_LEAD : istEpoch(date, NORMAL_PRE_OPEN),
        openAt: open.start_time,
        closeAt: open.end_time,
        confirmed,
      };
    }
  }

  if (isWeekend(date)) return { date, trading: false, special: false, reason: 'Weekend', confirmed };
  return {
    date,
    trading: true,
    special: false,
    preOpenAt: istEpoch(date, NORMAL_PRE_OPEN),
    openAt: istEpoch(date, NORMAL_OPEN),
    closeAt: istEpoch(date, NORMAL_CLOSE),
    confirmed,
  };
}

export function isTradingDay(date: string, cal: MarketCalendar | null | undefined): boolean {
  return nseSession(date, cal).trading;
}

/** First trading session strictly after `date` (looks ahead up to 30 days). */
export function nextTradingSession(date: string, cal: MarketCalendar | null | undefined): DaySession | null {
  let d = date;
  for (let i = 0; i < 30; i++) {
    d = addDays(d, 1);
    const s = nseSession(d, cal);
    if (s.trading) return s;
  }
  return null;
}

export type MarketPhase = 'pre_open' | 'open' | 'before_open' | 'after_close' | 'holiday' | 'weekend';

export interface MarketState {
  phase: MarketPhase;
  /** short label for the status bar */
  label: string;
  session: DaySession;
  /** when the next normal/special session opens (null if unknown) */
  nextOpenAt: number | null;
}

export function marketState(now: number, cal: MarketCalendar | null | undefined): MarketState {
  const date = istDate(now);
  const session = nseSession(date, cal);
  const next = () => nextTradingSession(date, cal)?.openAt ?? null;

  if (!session.trading) {
    const phase: MarketPhase = session.reason === 'Weekend' ? 'weekend' : 'holiday';
    return { phase, label: phase === 'weekend' ? 'closed (weekend)' : 'holiday', session, nextOpenAt: next() };
  }
  const { preOpenAt = 0, openAt = 0, closeAt = 0 } = session;
  if (now < preOpenAt) return { phase: 'before_open', label: 'closed', session, nextOpenAt: openAt };
  if (now < openAt) return { phase: 'pre_open', label: 'pre-open', session, nextOpenAt: openAt };
  if (now < closeAt) return { phase: 'open', label: session.special ? 'open (special)' : 'open', session, nextOpenAt: null };
  return { phase: 'after_close', label: 'closed', session, nextOpenAt: next() };
}

/** Holidays need (re)fetching: none stored, wrong year, or older than 7 days. */
export function calendarNeedsRefresh(cal: MarketCalendar | null | undefined, now: number): boolean {
  if (!cal) return true;
  if (cal.year !== ist(now).year) return true;
  return now - cal.fetchedAt > 7 * 24 * 60 * MINUTE;
}

/** Close time of the most recent session that has already closed at `now` (looks back up to 30 days). */
export function lastSessionClose(now: number, cal: MarketCalendar | null | undefined): number | null {
  let d = istDate(now);
  for (let i = 0; i < 30; i++, d = addDays(d, -1)) {
    const s = nseSession(d, cal);
    if (s.trading && s.closeAt !== undefined && s.closeAt <= now) return s.closeAt;
  }
  return null;
}

/**
 * The trading session whose prices a quote fetched at `fetchedAt` shows (v0.8.0):
 *  - during or after a session's open on its own day → that day;
 *  - before the pre-open, or on a weekend/holiday → the previous trading session (its close);
 *  - during the pre-open (09:00–09:15) → null: those prices are not yet a real trading price.
 */
export function quoteSessionDate(fetchedAt: number, cal: MarketCalendar | null | undefined): string | null {
  let d = istDate(fetchedAt);
  const today = nseSession(d, cal);
  if (today.trading && today.openAt !== undefined && today.preOpenAt !== undefined) {
    if (fetchedAt >= today.openAt) return d;
    if (fetchedAt >= today.preOpenAt) return null;
  }
  for (let i = 0; i < 30; i++) {
    d = addDays(d, -1);
    if (nseSession(d, cal).trading) return d;
  }
  return null;
}

/**
 * Should the price poll run now? Live (pre-open/open): always. Market closed: once, if prices were
 * not fetched since the last session closed (evening install, browser restart, weekend), retrying
 * every 5 minutes after a failure. Closed-market prices are the last session's closing prices.
 */
export function pollDue(now: number, cal: MarketCalendar | null | undefined, lastPoll: { at: number; ok: boolean } | null | undefined): boolean {
  const m = marketState(now, cal);
  if (m.phase === 'open' || m.phase === 'pre_open') return true;
  const close = lastSessionClose(now, cal);
  if (close === null) return false;
  if (!lastPoll) return true;
  if (lastPoll.at < close + MINUTE) return true;
  return !lastPoll.ok && now - lastPoll.at >= 5 * MINUTE;
}
