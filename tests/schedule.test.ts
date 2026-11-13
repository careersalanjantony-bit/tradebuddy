import { describe, expect, it } from 'vitest';
import { loginReminderDue, nextRun } from '../src/background/schedule';
import type { MarketCalendar } from '../src/data/calendar';
import { istEpoch } from '../src/lib/time';

const cal: MarketCalendar = {
  year: 2026,
  fetchedAt: 0,
  holidays: [{ date: '2026-11-16', description: 'Test holiday', holiday_type: 'TRADING_HOLIDAY', closed_exchanges: ['NSE'], open_exchanges: [] }],
};

describe('nextRun', () => {
  it('token-expiry: next 03:30 IST', () => {
    expect(nextRun('token-expiry', istEpoch('2026-11-09', '16:58'), cal)).toBe(istEpoch('2026-11-10', '03:30'));
  });
  it('login-reminder: 08:45 on the next trading day, skipping weekend and holiday', () => {
    expect(nextRun('login-reminder', istEpoch('2026-11-10', '07:00'), cal)).toBe(istEpoch('2026-11-10', '08:45'));
    expect(nextRun('login-reminder', istEpoch('2026-11-13', '10:00'), cal)).toBe(istEpoch('2026-11-17', '08:45'));
  });
  it('holidays-refresh: Monday 07:00 or 1 Jan 07:00, whichever is first', () => {
    expect(nextRun('holidays-refresh', istEpoch('2026-11-09', '10:00'), cal)).toBe(istEpoch('2026-11-16', '07:00'));
    expect(nextRun('holidays-refresh', istEpoch('2026-12-30', '10:00'), cal)).toBe(istEpoch('2027-01-01', '07:00'));
  });
});

describe('data jobs', () => {
  it('morning-recheck: 09:20 on trading days', () => {
    expect(nextRun('morning-recheck', istEpoch('2026-11-10', '08:00'), cal)).toBe(istEpoch('2026-11-10', '09:20'));
    expect(nextRun('morning-recheck', istEpoch('2026-11-13', '10:00'), cal)).toBe(istEpoch('2026-11-17', '09:20'));
  });
  it('instruments-refresh: daily 06:45', () => {
    expect(nextRun('instruments-refresh', istEpoch('2026-11-09', '10:00'), cal)).toBe(istEpoch('2026-11-10', '06:45'));
  });
  it('eod-candles: 16:00 then 18:00 retry, trading days only', () => {
    expect(nextRun('eod-candles', istEpoch('2026-11-10', '12:00'), cal)).toBe(istEpoch('2026-11-10', '16:00'));
    expect(nextRun('eod-candles', istEpoch('2026-11-10', '16:00'), cal)).toBe(istEpoch('2026-11-10', '18:00'));
    expect(nextRun('eod-candles', istEpoch('2026-11-13', '18:30'), cal)).toBe(istEpoch('2026-11-17', '16:00')); // weekend + holiday
  });
});

describe('loginReminderDue', () => {
  const loggedOut = { status: 'logged_out' as const };
  it('due on a trading day between 08:45 and close when not logged in', () => {
    expect(loginReminderDue(istEpoch('2026-11-10', '08:45'), cal, loggedOut, undefined)).toBe(true);
    expect(loginReminderDue(istEpoch('2026-11-10', '14:00'), cal, loggedOut, undefined)).toBe(true);
  });
  it('not due before 08:45, after close, on holidays/weekends', () => {
    expect(loginReminderDue(istEpoch('2026-11-10', '08:44'), cal, loggedOut, undefined)).toBe(false);
    expect(loginReminderDue(istEpoch('2026-11-10', '15:30'), cal, loggedOut, undefined)).toBe(false);
    expect(loginReminderDue(istEpoch('2026-11-16', '09:00'), cal, loggedOut, undefined)).toBe(false);
    expect(loginReminderDue(istEpoch('2026-11-14', '09:00'), cal, loggedOut, undefined)).toBe(false);
  });
  it('not due when logged in, or already shown today', () => {
    const live = { status: 'logged_in' as const, accessToken: 't', expiresAt: istEpoch('2026-11-11', '03:30') };
    expect(loginReminderDue(istEpoch('2026-11-10', '09:00'), cal, live, undefined)).toBe(false);
    expect(loginReminderDue(istEpoch('2026-11-10', '10:00'), cal, loggedOut, istEpoch('2026-11-10', '08:45'))).toBe(false);
    expect(loginReminderDue(istEpoch('2026-11-10', '10:00'), cal, loggedOut, istEpoch('2026-11-09', '08:45'))).toBe(true);
  });
  it('due when the stored session has passed its expiry time', () => {
    const stale = { status: 'logged_in' as const, accessToken: 't', expiresAt: istEpoch('2026-11-10', '03:30') };
    expect(loginReminderDue(istEpoch('2026-11-10', '09:00'), cal, stale, undefined)).toBe(true);
  });
});
