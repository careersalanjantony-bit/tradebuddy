import { createQueue } from '../lib/queue';
import { addDays } from '../lib/time';

export interface DateRange {
  from: string;
  to: string;
}

/** Serialize the cache lookup, download and write for each instrument on this runtime. */
export function historyByInstrument() {
  const active = new Map<string, { run: ReturnType<typeof createQueue>; jobs: number }>();
  return async function run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const entry = active.get(key) ?? { run: createQueue(), jobs: 0 };
    active.set(key, entry);
    entry.jobs++;
    try {
      return await entry.run(fn);
    } finally {
      if (--entry.jobs === 0) active.delete(key);
    }
  };
}

export function mergeRanges(ranges: DateRange[]): DateRange[] {
  const merged: DateRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.from.localeCompare(b.from))) {
    const last = merged.at(-1);
    if (!last || range.from > addDays(last.to, 1)) merged.push({ ...range });
    else if (range.to > last.to) last.to = range.to;
  }
  return merged;
}

/** Both stored and requested date ranges are inclusive. */
export function missingRanges({ from, to }: DateRange, covered: DateRange[]): DateRange[] {
  const gaps: DateRange[] = [];
  let next = from;
  for (const range of covered) {
    if (range.to < next) continue;
    if (range.from > to) break;
    if (range.from > next) gaps.push({ from: next, to: addDays(range.from, -1) });
    next = addDays(range.to, 1);
    if (next > to) break;
  }
  if (next <= to) gaps.push({ from: next, to });
  return gaps;
}
