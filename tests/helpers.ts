import type { Candle } from '../src/indicators/types';
import { addDays, isWeekend } from '../src/lib/time';

/** Builds daily candles on weekdays starting from `start`, from a list of closes. */
export function candlesFrom(closes: number[], opts: { start?: string; volume?: number | ((i: number) => number); range?: number } = {}): Candle[] {
  const out: Candle[] = [];
  let d = opts.start ?? '2025-01-01';
  for (let i = 0; i < closes.length; i++) {
    while (isWeekend(d)) d = addDays(d, 1);
    const c = closes[i]!;
    const r = opts.range ?? c * 0.01;
    const vol = typeof opts.volume === 'function' ? opts.volume(i) : (opts.volume ?? 200_000);
    const prev = i ? closes[i - 1]! : c;
    out.push({ date: d, open: prev, high: Math.max(prev, c) + r / 2, low: Math.min(prev, c) - r / 2, close: c, volume: vol });
    d = addDays(d, 1);
  }
  return out;
}

export const linear = (n: number, start: number, step: number) => Array.from({ length: n }, (_, i) => start + i * step);
