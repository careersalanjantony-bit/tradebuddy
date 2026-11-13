import { describe, expect, it } from 'vitest';
import { addDays, dayOfWeek, formatDuration, ist, istDate, istEpoch, isWeekend, nextIstTime, parseHHMM } from '../src/lib/time';

describe('IST clock', () => {
  it('converts epoch to IST wall clock', () => {
    const c = ist(Date.UTC(2026, 10, 9, 4, 30)); // 10:00 IST
    expect(c).toMatchObject({ date: '2026-11-09', hour: 10, minute: 0, dow: 1, minuteOfDay: 600 });
  });
  it('crosses midnight correctly (UTC evening = next IST day)', () => {
    expect(istDate(Date.UTC(2026, 10, 8, 22, 0))).toBe('2026-11-09'); // 03:30 IST
    expect(istDate(Date.UTC(2026, 10, 8, 18, 29))).toBe('2026-11-08'); // 23:59 IST
    expect(istDate(Date.UTC(2026, 10, 8, 18, 30))).toBe('2026-11-09'); // 00:00 IST
  });
  it('builds epochs from IST wall clock', () => {
    expect(istEpoch('2026-11-09', '09:15')).toBe(Date.UTC(2026, 10, 9, 3, 45));
    expect(istEpoch('2026-11-09', '03:30')).toBe(Date.UTC(2026, 10, 8, 22, 0));
    expect(istEpoch('2026-11-09')).toBe(Date.UTC(2026, 10, 8, 18, 30));
  });
  it('adds days across month, year and leap boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
  it('knows weekdays', () => {
    expect(dayOfWeek('2026-11-08')).toBe(0); // Sunday (Muhurat 2026)
    expect(isWeekend('2026-11-08')).toBe(true);
    expect(isWeekend('2026-11-09')).toBe(false);
  });
  it('validates input', () => {
    expect(() => parseHHMM('25:00')).toThrow();
    expect(() => istEpoch('09-11-2026')).toThrow();
  });
});

describe('nextIstTime', () => {
  it('returns the same day if still ahead, else the next day', () => {
    const at0800 = istEpoch('2026-11-09', '08:00');
    expect(nextIstTime(at0800, '08:45')).toBe(istEpoch('2026-11-09', '08:45'));
    expect(nextIstTime(istEpoch('2026-11-09', '09:00'), '08:45')).toBe(istEpoch('2026-11-10', '08:45'));
  });
  it('is strictly after', () => {
    const t = istEpoch('2026-11-09', '08:45');
    expect(nextIstTime(t, '08:45')).toBe(istEpoch('2026-11-10', '08:45'));
  });
  it('applies a day filter', () => {
    const fri = istEpoch('2026-11-13', '10:00');
    expect(nextIstTime(fri, '08:45', (d) => !isWeekend(d))).toBe(istEpoch('2026-11-16', '08:45'));
  });
});

describe('formatDuration', () => {
  it('formats short and long spans', () => {
    expect(formatDuration(45_000)).toBe('45 s');
    expect(formatDuration(4 * 60_000)).toBe('4 min');
    expect(formatDuration((10 * 60 + 5) * 60_000)).toBe('10 h 05 min');
    expect(formatDuration(-5)).toBe('0 s');
  });
});
