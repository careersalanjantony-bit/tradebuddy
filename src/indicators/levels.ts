import type { Candle } from './types';

/**
 * Swing points and support/resistance (spec §9).
 * A swing high is a bar whose high is the highest of k bars on each side (strictly above the left
 * side, not below the right side, so a flat top counts once). Swing lows mirror this.
 */

export interface SwingPoint {
  index: number;
  date: string;
  price: number;
}

export function swingHighs(candles: Candle[], k = 3): SwingPoint[] {
  const out: SwingPoint[] = [];
  for (let i = k; i < candles.length - k; i++) {
    const h = candles[i]!.high;
    let ok = true;
    for (let j = i - k; j < i && ok; j++) if (candles[j]!.high >= h) ok = false;
    for (let j = i + 1; j <= i + k && ok; j++) if (candles[j]!.high > h) ok = false;
    if (ok) out.push({ index: i, date: candles[i]!.date, price: h });
  }
  return out;
}

export function swingLows(candles: Candle[], k = 3): SwingPoint[] {
  const out: SwingPoint[] = [];
  for (let i = k; i < candles.length - k; i++) {
    const l = candles[i]!.low;
    let ok = true;
    for (let j = i - k; j < i && ok; j++) if (candles[j]!.low <= l) ok = false;
    for (let j = i + 1; j <= i + k && ok; j++) if (candles[j]!.low < l) ok = false;
    if (ok) out.push({ index: i, date: candles[i]!.date, price: l });
  }
  return out;
}

export interface Level {
  price: number;
  /** how many swing points formed this level */
  touches: number;
  /** most recent swing date in the cluster */
  lastDate: string;
}

/** Groups prices that lie within `width` of their neighbour; each group becomes one level (its mean). */
export function clusterLevels(points: SwingPoint[], width: number): Level[] {
  if (!points.length) return [];
  const sorted = [...points].sort((a, b) => a.price - b.price);
  const levels: Level[] = [];
  let group: SwingPoint[] = [sorted[0]!];
  const flush = () => {
    const price = group.reduce((s, p) => s + p.price, 0) / group.length;
    const lastDate = group.reduce((d, p) => (p.date > d ? p.date : d), group[0]!.date);
    levels.push({ price, touches: group.length, lastDate });
  };
  for (let i = 1; i < sorted.length; i++) {
    const p = sorted[i]!;
    if (p.price - group[group.length - 1]!.price <= width) group.push(p);
    else {
      flush();
      group = [p];
    }
  }
  flush();
  return levels;
}

/**
 * App v1.18 — "major support": the floor the stock bounced from most often in the past year, below the
 * nearer supports. Same swing lows and the same grouping as `supportResistance`, over a longer window;
 * the level with the most bounces wins (the higher one on a tie). Null when there is none below `below`.
 */
export function majorSupport(candles: Candle[], below: number, atrValue: number, opts: { k?: number; lookback?: number; clusterAtr?: number } = {}): Level | null {
  const { k = 3, lookback = 250, clusterAtr = 0.5 } = opts;
  const width = Math.max(atrValue * clusterAtr, 0);
  const floors = clusterLevels(swingLows(candles.slice(-lookback), k), width).filter((l) => l.price < below);
  if (!floors.length) return null;
  return floors.reduce((best, l) => (l.touches > best.touches || (l.touches === best.touches && l.price > best.price) ? l : best));
}

/**
 * Nearest support (below price) and resistance (above price) from swing points in the last
 * `lookback` sessions, clustered within `clusterAtr × ATR`. Returns up to `count` of each,
 * nearest first.
 */
export function supportResistance(
  candles: Candle[],
  price: number,
  atrValue: number,
  opts: { k?: number; lookback?: number; clusterAtr?: number; count?: number } = {},
): { supports: Level[]; resistances: Level[] } {
  const { k = 3, lookback = 120, clusterAtr = 0.5, count = 2 } = opts;
  const recent = candles.slice(-lookback);
  const width = Math.max(atrValue * clusterAtr, 0);
  const levels = clusterLevels([...swingHighs(recent, k), ...swingLows(recent, k)], width);
  const supports = levels.filter((l) => l.price < price).sort((a, b) => b.price - a.price).slice(0, count);
  const resistances = levels.filter((l) => l.price > price).sort((a, b) => a.price - b.price).slice(0, count);
  return { supports, resistances };
}
