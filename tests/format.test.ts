import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatCrore,
  formatDateIST,
  formatDateTimeIST,
  formatINR,
  formatNumberIN,
  formatPct,
  formatRelative,
  formatTimeIST,
  isoDateIST,
} from '../src/lib/format';

describe('Indian number formatting', () => {
  it('formats rupees with lakh/crore grouping', () => {
    expect(formatINR(123456.78)).toBe('₹1,23,456.78');
    expect(formatINR(12345678.9)).toBe('₹1,23,45,678.90');
    expect(formatINR(-2500)).toBe('-₹2,500.00');
    expect(formatINR(1000, 0)).toBe('₹1,000');
  });
  it('shows a dash for missing values', () => {
    expect(formatINR(null)).toBe('—');
    expect(formatINR(undefined)).toBe('—');
    expect(formatINR(NaN)).toBe('—');
  });
  it('formats plain numbers and crore amounts', () => {
    expect(formatNumberIN(2794.7, 1)).toBe('2,794.7');
    expect(formatCrore(1_234_500_000)).toBe('₹123.45 cr');
  });
  it('formats percentages with a real minus sign', () => {
    expect(formatPct(1.234)).toBe('+1.23%');
    expect(formatPct(-32.6, 1)).toBe('−32.6%');
    expect(formatPct(0)).toBe('0.00%');
  });
});

describe('IST time formatting', () => {
  // 2026-11-08T22:15:30.045Z = 2026-11-09 03:45:30.045 IST (after midnight IST)
  const ts = Date.UTC(2026, 10, 8, 22, 15, 30, 45);
  it('converts across the UTC/IST date boundary', () => {
    expect(isoDateIST(ts)).toBe('2026-11-09');
    expect(formatTimeIST(ts)).toBe('03:45:30');
    expect(formatTimeIST(ts, true)).toBe('03:45:30.045');
  });
  it('formats date and date-time', () => {
    expect(formatDateIST(ts)).toBe('09 Nov 2026');
    expect(formatDateTimeIST(ts)).toBe('09 Nov 2026, 03:45 IST');
    expect(formatDateTimeIST(ts, true)).toBe('09 Nov 2026, 03:45:30 IST');
  });
  it('handles 15:30 IST market close', () => {
    expect(formatTimeIST(Date.UTC(2026, 10, 9, 10, 0, 0))).toBe('15:30:00');
  });
});

describe('misc', () => {
  it('formats bytes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
  it('formats relative time', () => {
    const now = 1_000_000_000;
    expect(formatRelative(now - 10_000, now)).toBe('10 s ago');
    expect(formatRelative(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(formatRelative(now + 2 * 3600_000, now)).toBe('in 2 h');
  });
});
