import { describe, expect, it } from 'vitest';
import { lastSessionClose, pollDue, quoteSessionDate, type MarketCalendar } from '../src/data/calendar';
import type { Quote } from '../src/data/quotesParse';
import { liveCandle } from '../src/data/stockData';
import { istEpoch } from '../src/lib/time';

// Synthetic calendar (not real holidays): 2026-11-16 (Mon) closed.
const cal: MarketCalendar = {
  year: 2026,
  fetchedAt: istEpoch('2026-11-03', '07:00'),
  holidays: [{ date: '2026-11-16', description: 'Test holiday', holiday_type: 'TRADING_HOLIDAY', closed_exchanges: ['NSE'], open_exchanges: [] }],
};

const quote = (fetchedAt: number, ltp = 100, open: number | null = 98): Quote => ({
  key: 'NSE_EQ|X',
  ltp,
  open,
  high: open === null ? null : 101,
  low: open === null ? null : 97,
  volume: 1000,
  prevClose: 99,
  fetchedAt,
});

describe('lastSessionClose / quoteSessionDate (v0.8.0)', () => {
  it('finds the most recent close', () => {
    expect(lastSessionClose(istEpoch('2026-11-09', '21:30'), cal)).toBe(istEpoch('2026-11-09', '15:30'));
    expect(lastSessionClose(istEpoch('2026-11-10', '08:30'), cal)).toBe(istEpoch('2026-11-09', '15:30'));
    expect(lastSessionClose(istEpoch('2026-11-10', '11:00'), cal)).toBe(istEpoch('2026-11-09', '15:30'));
    // Saturday → Friday; the Monday holiday → Friday too
    expect(lastSessionClose(istEpoch('2026-11-14', '10:00'), cal)).toBe(istEpoch('2026-11-13', '15:30'));
    expect(lastSessionClose(istEpoch('2026-11-16', '12:00'), cal)).toBe(istEpoch('2026-11-13', '15:30'));
  });
  it('maps a quote time to the session it shows', () => {
    expect(quoteSessionDate(istEpoch('2026-11-10', '11:00'), cal)).toBe('2026-11-10');
    expect(quoteSessionDate(istEpoch('2026-11-10', '20:00'), cal)).toBe('2026-11-10');
    expect(quoteSessionDate(istEpoch('2026-11-10', '08:30'), cal)).toBe('2026-11-09');
    expect(quoteSessionDate(istEpoch('2026-11-10', '09:05'), cal)).toBeNull(); // pre-open
    expect(quoteSessionDate(istEpoch('2026-11-15', '10:00'), cal)).toBe('2026-11-13'); // Sunday
    expect(quoteSessionDate(istEpoch('2026-11-17', '08:00'), cal)).toBe('2026-11-13'); // after the holiday
  });
});

describe('pollDue: prices refresh by themselves (v0.8.0)', () => {
  it('always during pre-open and market hours', () => {
    const recent = { at: istEpoch('2026-11-10', '10:59'), ok: true };
    expect(pollDue(istEpoch('2026-11-10', '09:05'), cal, recent)).toBe(true);
    expect(pollDue(istEpoch('2026-11-10', '11:00'), cal, recent)).toBe(true);
  });
  it('evening install / browser restart: once, then not again until the next session', () => {
    const now = istEpoch('2026-11-09', '21:30');
    expect(pollDue(now, cal, null)).toBe(true);
    expect(pollDue(now, cal, { at: istEpoch('2026-11-09', '15:29'), ok: true })).toBe(true); // last poll was before the close
    expect(pollDue(now, cal, { at: istEpoch('2026-11-09', '21:00'), ok: true })).toBe(false);
    expect(pollDue(istEpoch('2026-11-10', '08:30'), cal, { at: istEpoch('2026-11-09', '21:00'), ok: true })).toBe(false);
  });
  it('retries every 5 minutes after a failed closed-market poll', () => {
    const failed = { at: istEpoch('2026-11-09', '21:00'), ok: false };
    expect(pollDue(istEpoch('2026-11-09', '21:03'), cal, failed)).toBe(false);
    expect(pollDue(istEpoch('2026-11-09', '21:05'), cal, failed)).toBe(true);
  });
  it('weekend: once, for Friday’s close', () => {
    expect(pollDue(istEpoch('2026-11-14', '10:00'), cal, { at: istEpoch('2026-11-13', '12:00'), ok: true })).toBe(true);
    expect(pollDue(istEpoch('2026-11-14', '10:00'), cal, { at: istEpoch('2026-11-13', '16:00'), ok: true })).toBe(false);
  });
});

describe('liveCandle: the latest session from the quote when history lags (v0.8.0)', () => {
  it('evening: today’s finished session is used while the daily candle is not published', () => {
    const c = liveCandle(quote(istEpoch('2026-11-09', '21:30')), '2026-11-06', istEpoch('2026-11-09', '21:31'), cal);
    expect(c).toMatchObject({ date: '2026-11-09', open: 98, close: 100, partial: true });
  });
  it('next morning before the open: still yesterday’s session', () => {
    const c = liveCandle(quote(istEpoch('2026-11-10', '08:30')), '2026-11-06', istEpoch('2026-11-10', '08:31'), cal);
    expect(c?.date).toBe('2026-11-09');
  });
  it('not used once history has that session, nor during pre-open', () => {
    expect(liveCandle(quote(istEpoch('2026-11-09', '21:30')), '2026-11-09', istEpoch('2026-11-09', '21:31'), cal)).toBeNull();
    expect(liveCandle(quote(istEpoch('2026-11-10', '09:05')), '2026-11-09', istEpoch('2026-11-10', '09:06'), cal)).toBeNull();
    expect(liveCandle(quote(istEpoch('2026-11-10', '08:30')), '2026-11-06', istEpoch('2026-11-10', '09:06'), cal)).toBeNull();
  });
  it('market hours: today’s unfinished candle', () => {
    const c = liveCandle(quote(istEpoch('2026-11-10', '11:00')), '2026-11-09', istEpoch('2026-11-10', '11:00'), cal);
    expect(c).toMatchObject({ date: '2026-11-10', close: 100, high: 101, low: 97 });
  });
  it('without the day’s open/high/low the last price is enough', () => {
    const c = liveCandle(quote(istEpoch('2026-11-10', '08:30'), 105, null), '2026-11-06', istEpoch('2026-11-10', '08:31'), cal);
    expect(c).toMatchObject({ date: '2026-11-09', open: 105, high: 105, low: 105, close: 105 });
  });
});
