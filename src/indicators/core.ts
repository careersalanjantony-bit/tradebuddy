/**
 * Core indicators (spec §9). Pure functions over number arrays (oldest → newest).
 * Series functions return arrays aligned with the input (null where not enough data).
 */

export function smaSeries(values: number[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (n <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= n) sum -= values[i - n]!;
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

export function sma(values: number[], n: number): number | null {
  if (n <= 0 || values.length < n) return null;
  let sum = 0;
  for (let i = values.length - n; i < values.length; i++) sum += values[i]!;
  return sum / n;
}

/** EMA with α = 2/(n+1), seeded with the SMA of the first n values. */
export function emaSeries(values: number[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < n || n <= 0) return out;
  const a = 2 / (n + 1);
  let e = 0;
  for (let i = 0; i < n; i++) e += values[i]!;
  e /= n;
  out[n - 1] = e;
  for (let i = n; i < values.length; i++) {
    e = values[i]! * a + e * (1 - a);
    out[i] = e;
  }
  return out;
}

export function ema(values: number[], n: number): number | null {
  const s = emaSeries(values, n);
  return s.length ? (s[s.length - 1] ?? null) : null;
}

/**
 * Wilder RSI: first average gain/loss = simple mean of the first n changes,
 * then avg = (prev × (n−1) + current) / n. RSI = 100 − 100/(1 + avgGain/avgLoss); 100 if avgLoss = 0.
 */
export function rsiSeries(closes: number[], n = 14): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < n + 1) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const ch = closes[i]! - closes[i - 1]!;
    if (ch > 0) gain += ch;
    else loss -= ch;
  }
  gain /= n;
  loss /= n;
  const rsi = (g: number, l: number) => (l === 0 ? 100 : 100 - 100 / (1 + g / l));
  out[n] = rsi(gain, loss);
  for (let i = n + 1; i < closes.length; i++) {
    const ch = closes[i]! - closes[i - 1]!;
    gain = (gain * (n - 1) + (ch > 0 ? ch : 0)) / n;
    loss = (loss * (n - 1) + (ch < 0 ? -ch : 0)) / n;
    out[i] = rsi(gain, loss);
  }
  return out;
}

export function rsi(closes: number[], n = 14): number | null {
  const s = rsiSeries(closes, n);
  return s.length ? (s[s.length - 1] ?? null) : null;
}

export interface HLC {
  high: number;
  low: number;
  close: number;
}

/** True range for bar i ≥ 1: max(H − L, |H − prevC|, |L − prevC|). */
export function trueRange(bars: HLC[], i: number): number {
  const b = bars[i]!;
  if (i === 0) return b.high - b.low;
  const pc = bars[i - 1]!.close;
  return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
}

/** Wilder ATR: first value = mean of TR for bars 1..n, then (prev × (n−1) + TR) / n. */
export function atrSeries(bars: HLC[], n = 14): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null);
  if (bars.length < n + 1) return out;
  let a = 0;
  for (let i = 1; i <= n; i++) a += trueRange(bars, i);
  a /= n;
  out[n] = a;
  for (let i = n + 1; i < bars.length; i++) {
    a = (a * (n - 1) + trueRange(bars, i)) / n;
    out[i] = a;
  }
  return out;
}

export function atr(bars: HLC[], n = 14): number | null {
  const s = atrSeries(bars, n);
  return s.length ? (s[s.length - 1] ?? null) : null;
}

export function mean(values: number[]): number | null {
  if (!values.length) return null;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}
