import { isTradingDay, nseSession, type MarketCalendar } from '../data/calendar';
import { dayOfWeek, istDate, istEpoch, nextIstTime } from '../lib/time';
import type { AuthState } from '../storage/schema';
import { hasLiveSession } from '../upstox/token';

/**
 * Pure schedule maths for chrome.alarms (spec §17). Each job's next fire time is computed in IST
 * and re-computed after every run, so drift, sleep and holidays are handled.
 */

export type JobName = 'token-expiry' | 'login-reminder' | 'holidays-refresh' | 'instruments-refresh' | 'eod-candles' | 'morning-recheck';

export const LOGIN_REMINDER_HHMM = '08:45';
export const HOLIDAYS_REFRESH_HHMM = '07:00';

export function nextRun(job: JobName, now: number, cal: MarketCalendar | null | undefined): number | null {
  switch (job) {
    case 'token-expiry':
      return nextIstTime(now, '03:30');
    case 'login-reminder':
      return nextIstTime(now, LOGIN_REMINDER_HHMM, (d) => isTradingDay(d, cal));
    case 'holidays-refresh':
      return nextIstTime(now, HOLIDAYS_REFRESH_HHMM, (d) => dayOfWeek(d) === 1 || d.endsWith('-01-01'));
    case 'instruments-refresh':
      return nextIstTime(now, '06:45');
    case 'morning-recheck':
      // spec §17: 09:20 on trading days — fills in yesterday's candle and re-checks with live prices
      return nextIstTime(now, '09:20', (d) => isTradingDay(d, cal));
    case 'eod-candles': {
      // 16:00 after the close, retried at 18:00 (spec §17)
      const trading = (d: string) => isTradingDay(d, cal);
      const a = nextIstTime(now, '16:00', trading);
      const b = nextIstTime(now, '18:00', trading);
      return a === null ? b : b === null ? a : Math.min(a, b);
    }
  }
}

/**
 * Should the "please log in" reminder show now? On a trading day, from 08:45 until the close,
 * when there is no live session and it has not been shown yet today.
 * Used both by the 08:45 alarm and as catch-up when Chrome starts later in the day.
 */
export function loginReminderDue(now: number, cal: MarketCalendar | null | undefined, auth: AuthState | undefined, lastShownAt: number | undefined): boolean {
  const today = istDate(now);
  const s = nseSession(today, cal);
  if (!s.trading || s.closeAt === undefined) return false;
  if (now < istEpoch(today, LOGIN_REMINDER_HHMM) || now >= s.closeAt) return false;
  if (hasLiveSession(auth, now)) return false;
  return !(lastShownAt !== undefined && istDate(lastShownAt) === today);
}
