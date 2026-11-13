import { describe, expect, it } from 'vitest';
import example from './fixtures/upstox-holidays-docs-example.json';
import {
  calendarNeedsRefresh,
  isTradingDay,
  marketState,
  nextTradingSession,
  nseSession,
  parseHolidays,
  type MarketCalendar,
} from '../src/data/calendar';
import { istEpoch } from '../src/lib/time';

const docs2024: MarketCalendar = { year: 2024, fetchedAt: 0, holidays: parseHolidays(example.data) };

// Synthetic 2026 test calendar (not real holiday data).
const cal2026: MarketCalendar = {
  year: 2026,
  fetchedAt: istEpoch('2026-11-03', '07:00'),
  holidays: [
    {
      date: '2026-11-08',
      description: 'Diwali Muhurat (test)',
      holiday_type: 'SPECIAL_TIMING',
      closed_exchanges: [],
      open_exchanges: [{ exchange: 'NSE', start_time: istEpoch('2026-11-08', '18:00'), end_time: istEpoch('2026-11-08', '19:00') }],
    },
    {
      date: '2026-11-16',
      description: 'Test holiday',
      holiday_type: 'TRADING_HOLIDAY',
      closed_exchanges: ['NSE', 'BSE'],
      open_exchanges: [],
    },
  ],
};

describe('parseHolidays (docs example response)', () => {
  it('parses all entries', () => {
    expect(docs2024.holidays.map((h) => h.date)).toEqual(['2024-01-01', '2024-01-20', '2024-01-26']);
  });
  it('rejects a wrong shape', () => {
    expect(() => parseHolidays({})).toThrow();
    expect(() => parseHolidays([{ date: 'x' }])).toThrow();
  });
  it('drops malformed open_exchanges items', () => {
    const [h] = parseHolidays([{ date: '2026-01-01', open_exchanges: [{ exchange: 'NSE' }, null] }]);
    expect(h!.open_exchanges).toEqual([]);
    expect(h!.closed_exchanges).toEqual([]);
  });
});

describe('nseSession', () => {
  it('docs quirk: "TRADING_HOLIDAY" with NSE open at normal times is a normal trading day', () => {
    const s = nseSession('2024-01-01', docs2024);
    expect(s).toMatchObject({ trading: true, special: false, confirmed: true });
    expect(s.openAt).toBe(istEpoch('2024-01-01', '09:15'));
    expect(s.closeAt).toBe(istEpoch('2024-01-01', '15:30'));
  });
  it('a Saturday with NSE in open_exchanges is a special session with the given times', () => {
    const s = nseSession('2024-01-20', docs2024);
    expect(s).toMatchObject({ trading: true, special: true, reason: 'Special DR Trading' });
    expect(s.openAt).toBe(istEpoch('2024-01-20', '09:15'));
    expect(s.closeAt).toBe(istEpoch('2024-01-20', '12:30'));
  });
  it('NSE in closed_exchanges is a holiday', () => {
    expect(nseSession('2024-01-26', docs2024)).toMatchObject({ trading: false, reason: 'Republic Day' });
  });
  it('weekends without an entry are closed; weekdays are normal', () => {
    expect(nseSession('2026-11-14', cal2026)).toMatchObject({ trading: false, reason: 'Weekend' });
    expect(nseSession('2026-11-13', cal2026)).toMatchObject({ trading: true, special: false, confirmed: true });
  });
  it('Muhurat-style Sunday session is trading + special', () => {
    const s = nseSession('2026-11-08', cal2026);
    expect(s).toMatchObject({ trading: true, special: true });
    expect(s.preOpenAt).toBe(istEpoch('2026-11-08', '17:45'));
  });
  it('without the right year loaded, falls back to weekday rules and says so', () => {
    expect(nseSession('2027-01-04', cal2026)).toMatchObject({ trading: true, confirmed: false });
    expect(nseSession('2026-11-16', null)).toMatchObject({ trading: true, confirmed: false });
  });
  it('isTradingDay and nextTradingSession skip weekends and holidays', () => {
    expect(isTradingDay('2026-11-16', cal2026)).toBe(false);
    // Friday 13th → (Sat, Sun, Mon holiday) → Tuesday 17th
    expect(nextTradingSession('2026-11-13', cal2026)?.date).toBe('2026-11-17');
  });
});

describe('marketState', () => {
  const at = (date: string, hhmm: string) => marketState(istEpoch(date, hhmm), cal2026);
  it('walks through a normal day', () => {
    expect(at('2026-11-10', '08:30').phase).toBe('before_open');
    expect(at('2026-11-10', '09:05').phase).toBe('pre_open');
    expect(at('2026-11-10', '09:15').phase).toBe('open');
    expect(at('2026-11-10', '15:29').phase).toBe('open');
    expect(at('2026-11-10', '15:30').phase).toBe('after_close');
  });
  it('after Friday close, next open is the next trading session', () => {
    expect(at('2026-11-13', '16:00').nextOpenAt).toBe(istEpoch('2026-11-17', '09:15'));
  });
  it('reports weekends, holidays and special sessions', () => {
    expect(at('2026-11-14', '11:00')).toMatchObject({ phase: 'weekend', label: 'closed (weekend)' });
    expect(at('2026-11-16', '11:00')).toMatchObject({ phase: 'holiday', label: 'holiday' });
    expect(at('2026-11-08', '18:30')).toMatchObject({ phase: 'open', label: 'open (special)' });
    expect(at('2026-11-08', '12:00').phase).toBe('before_open');
  });
});

describe('calendarNeedsRefresh', () => {
  it('refreshes when missing, wrong year, or older than 7 days', () => {
    const now = istEpoch('2026-11-09', '10:00');
    expect(calendarNeedsRefresh(null, now)).toBe(true);
    expect(calendarNeedsRefresh(cal2026, now)).toBe(false);
    expect(calendarNeedsRefresh({ ...cal2026, fetchedAt: istEpoch('2026-11-01', '07:00') }, now)).toBe(true);
    expect(calendarNeedsRefresh(cal2026, istEpoch('2027-01-01', '08:00'))).toBe(true);
  });
});
