/**
 * IST (Asia/Kolkata) wall-clock arithmetic. IST is UTC+05:30 with no daylight saving, so plain
 * offset maths is exact and much faster than Intl for scheduling.
 * Dates are 'YYYY-MM-DD' strings in IST; times are epoch milliseconds.
 */

export const IST_OFFSET_MS = 330 * 60_000;
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export interface IstClock {
  date: string;
  year: number;
  month: number; // 1–12
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday … 6 = Saturday */
  dow: number;
  /** minutes since IST midnight */
  minuteOfDay: number;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function ist(ts: number): IstClock {
  const d = new Date(ts + IST_OFFSET_MS);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const hour = d.getUTCHours();
  const minute = d.getUTCMinutes();
  return {
    date: `${year}-${pad(month)}-${pad(day)}`,
    year,
    month,
    day,
    hour,
    minute,
    second: d.getUTCSeconds(),
    dow: d.getUTCDay(),
    minuteOfDay: hour * 60 + minute,
  };
}

export function istDate(ts: number): string {
  return ist(ts).date;
}

function parseDate(date: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`Invalid date "${date}" (expected YYYY-MM-DD)`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** "HH:MM" → minutes since midnight. */
export function parseHHMM(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`Invalid time "${hhmm}" (expected HH:MM)`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`Invalid time "${hhmm}"`);
  return h * 60 + min;
}

/** Epoch ms for an IST wall-clock date + time. */
export function istEpoch(date: string, hhmm = '00:00', seconds = 0): number {
  const [y, mo, d] = parseDate(date);
  const mins = parseHHMM(hhmm);
  return Date.UTC(y, mo - 1, d, Math.floor(mins / 60), mins % 60, seconds) - IST_OFFSET_MS;
}

export function addDays(date: string, n: number): string {
  const [y, mo, d] = parseDate(date);
  const t = Date.UTC(y, mo - 1, d) + n * DAY;
  const x = new Date(t);
  return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`;
}

export function dayOfWeek(date: string): number {
  const [y, mo, d] = parseDate(date);
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}

export function isWeekend(date: string): boolean {
  const dow = dayOfWeek(date);
  return dow === 0 || dow === 6;
}

/**
 * Next moment strictly after `after` when the IST clock reads `hhmm` on a day accepted by
 * `dayFilter` (default: any day). Looks ahead at most `maxDays` days; null if none found.
 */
export function nextIstTime(after: number, hhmm: string, dayFilter: (date: string) => boolean = () => true, maxDays = 400): number | null {
  let date = istDate(after);
  for (let i = 0; i <= maxDays; i++) {
    if (dayFilter(date)) {
      const t = istEpoch(date, hhmm);
      if (t > after) return t;
    }
    date = addDays(date, 1);
  }
  return null;
}

/** "10 h 05 min", "4 min", "45 s" */
export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const totalMin = Math.floor(ms / MINUTE);
  if (totalMin < 1) return `${Math.floor(ms / 1000)} s`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m} min`;
  if (h < 24) return `${h} h ${pad(m)} min`;
  const d = Math.floor(h / 24);
  return `${d} d ${h % 24} h`;
}
