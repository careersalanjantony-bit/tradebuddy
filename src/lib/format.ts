/**
 * Display formatting (spec §15): Indian number format (en-IN, ₹1,23,456.78) and IST times.
 */

export const IST_TZ = 'Asia/Kolkata';

const inrFormatters = new Map<number, Intl.NumberFormat>();
const numFormatters = new Map<number, Intl.NumberFormat>();

function inrFmt(decimals: number): Intl.NumberFormat {
  let f = inrFormatters.get(decimals);
  if (!f) {
    f = new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    inrFormatters.set(decimals, f);
  }
  return f;
}

function numFmt(decimals: number): Intl.NumberFormat {
  let f = numFormatters.get(decimals);
  if (!f) {
    f = new Intl.NumberFormat('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    numFormatters.set(decimals, f);
  }
  return f;
}

/** ₹1,23,456.78 — returns "—" for null/undefined/NaN. */
export function formatINR(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return inrFmt(decimals).format(value);
}

/** 1,23,456.78 (Indian grouping, no currency sign). */
export function formatNumberIN(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return numFmt(decimals).format(value);
}

/** +1.23% / −4.50% with a real minus sign. */
export function formatPct(value: number | null | undefined, decimals = 2, withSign = true): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = numFmt(decimals).format(Math.abs(value));
  if (!withSign) return `${value < 0 ? '−' : ''}${abs}%`;
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${abs}%`;
}

/** Amounts in crore: 1234.5 crore → "₹1,234.50 cr". Input is rupees. */
export function formatCrore(rupees: number | null | undefined, decimals = 2): string {
  if (rupees === null || rupees === undefined || !Number.isFinite(rupees)) return '—';
  return `₹${numFmt(decimals).format(rupees / 1e7)} cr`;
}

type ISTParts = { year: string; month: string; day: string; hour: string; minute: string; second: string };

const istPartsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: IST_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

export function istParts(ts: number | Date): ISTParts {
  const parts = istPartsFmt.formatToParts(ts);
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? '00';
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

/** "09 Nov 2026" */
export function formatDateIST(ts: number | Date): string {
  return new Intl.DateTimeFormat('en-IN', { timeZone: IST_TZ, day: '2-digit', month: 'short', year: 'numeric' }).format(ts);
}

/** "14:05:09" (24h IST); with ms: "14:05:09.123" */
export function formatTimeIST(ts: number | Date, withMs = false): string {
  const p = istParts(ts);
  const base = `${p.hour}:${p.minute}:${p.second}`;
  if (!withMs) return base;
  const ms = (typeof ts === 'number' ? ts : ts.getTime()) % 1000;
  return `${base}.${String((ms + 1000) % 1000).padStart(3, '0')}`;
}

/** "09 Nov 2026, 14:05 IST" */
export function formatDateTimeIST(ts: number | Date, withSeconds = false): string {
  const p = istParts(ts);
  const time = withSeconds ? `${p.hour}:${p.minute}:${p.second}` : `${p.hour}:${p.minute}`;
  return `${formatDateIST(ts)}, ${time} IST`;
}

/** ISO-style "2026-11-09" date in IST. */
export function isoDateIST(ts: number | Date): string {
  const p = istParts(ts);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Bytes → "1.2 MB". */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** "3 min ago", "in 2 h" style relative time. */
export function formatRelative(ts: number, now = Date.now()): string {
  const diff = ts - now;
  const abs = Math.abs(diff);
  const s = Math.round(abs / 1000);
  let txt: string;
  if (s < 45) txt = `${s} s`;
  else if (s < 45 * 60) txt = `${Math.round(s / 60)} min`;
  else if (s < 36 * 3600) txt = `${Math.round(s / 3600)} h`;
  else txt = `${Math.round(s / 86400)} d`;
  return diff < 0 ? `${txt} ago` : `in ${txt}`;
}
