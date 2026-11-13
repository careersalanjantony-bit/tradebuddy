/**
 * Parsing for Upstox v3 market quotes (see docs/VERIFIED.md). Responses are keyed by
 * "EXCHANGE:SYMBOL"; each item carries `instrument_token` = our instrument key.
 */

export interface Quote {
  key: string;
  ltp: number;
  open: number | null;
  high: number | null;
  low: number | null;
  /** today's cumulative volume */
  volume: number | null;
  /** previous trading day's close */
  prevClose: number | null;
  /** when we received it (epoch ms) */
  fetchedAt: number;
}

type Obj = Record<string, unknown>;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Merges LTP v3 (`last_price`, `volume`, `cp`) and OHLC v3 interval=1d (`live_ohlc`) data. */
export function mergeQuotes(ltpData: unknown, ohlcData: unknown, fetchedAt: number): Record<string, Quote> {
  const out: Record<string, Quote> = {};
  const get = (key: string): Quote => (out[key] ??= { key, ltp: 0, open: null, high: null, low: null, volume: null, prevClose: null, fetchedAt });
  for (const item of Object.values((ltpData ?? {}) as Obj)) {
    const it = item as Obj;
    const key = it?.instrument_token;
    const ltp = num(it?.last_price);
    if (typeof key !== 'string' || ltp === null) continue;
    const q = get(key);
    q.ltp = ltp;
    q.volume = num(it.volume) ?? q.volume;
    q.prevClose = num(it.cp);
  }
  for (const item of Object.values((ohlcData ?? {}) as Obj)) {
    const it = item as Obj;
    const key = it?.instrument_token;
    if (typeof key !== 'string') continue;
    const q = get(key);
    const ltp = num(it.last_price);
    if (ltp !== null && !q.ltp) q.ltp = ltp;
    const live = it.live_ohlc as Obj | undefined;
    if (live) {
      q.open = num(live.open);
      q.high = num(live.high);
      q.low = num(live.low);
      q.volume = num(live.volume) ?? q.volume;
    }
    if (q.prevClose === null) {
      const prev = it.prev_ohlc as Obj | undefined;
      q.prevClose = prev ? num(prev.close) : null;
    }
  }
  for (const [k, q] of Object.entries(out)) if (!(q.ltp > 0)) delete out[k];
  return out;
}

/** Applies an LTP v3 response to stored quotes: new last price, volume, previous close; high/low stretched. */
export function mergeLtp(prev: Record<string, Quote>, ltpData: unknown, fetchedAt: number): { quotes: Record<string, Quote>; updated: number } {
  const quotes = { ...prev };
  let updated = 0;
  for (const item of Object.values((ltpData ?? {}) as Obj)) {
    const it = item as Obj;
    const key = it?.instrument_token;
    const ltp = num(it?.last_price);
    if (typeof key !== 'string' || ltp === null || !(ltp > 0)) continue;
    const old = quotes[key];
    quotes[key] = {
      key,
      ltp,
      open: old?.open ?? null,
      high: old?.high !== null && old?.high !== undefined ? Math.max(old.high, ltp) : null,
      low: old?.low !== null && old?.low !== undefined && old.low > 0 ? Math.min(old.low, ltp) : (old?.low ?? null),
      volume: num(it.volume) ?? old?.volume ?? null,
      prevClose: num(it.cp) ?? old?.prevClose ?? null,
      fetchedAt,
    };
    updated++;
  }
  return { quotes, updated };
}

/**
 * Applies live feed ticks (WebSocket) to the stored quotes. Only watched stocks; a tick that is more
 * than 25% away from the stored price or previous close is treated as bad data and ignored.
 */
export function mergeTicks(prev: Record<string, Quote>, ticks: Array<{ key: string; ltp: number; cp: number; ltt?: number; ltq?: number }>, watched: ReadonlySet<string>, fetchedAt: number): { quotes: Record<string, Quote>; updated: number } {
  const quotes = { ...prev };
  let updated = 0;
  for (const t of ticks) {
    if (!watched.has(t.key) || !Number.isFinite(t.ltp) || !(t.ltp > 0)) continue;
    const old = quotes[t.key];
    const ref = old?.ltp ?? (t.cp > 0 ? t.cp : null);
    if (ref !== null && Math.abs(t.ltp / ref - 1) > 0.25) continue;
    quotes[t.key] = {
      key: t.key,
      ltp: t.ltp,
      open: old?.open ?? null,
      high: old?.high !== null && old?.high !== undefined ? Math.max(old.high, t.ltp) : null,
      low: old?.low !== null && old?.low !== undefined && old.low > 0 ? Math.min(old.low, t.ltp) : (old?.low ?? null),
      volume: old?.volume ?? null,
      prevClose: t.cp > 0 ? t.cp : (old?.prevClose ?? null),
      fetchedAt,
    };
    updated++;
  }
  return { quotes, updated };
}

/** Daily candles from /v3/historical-candle: [ts, o, h, l, c, volume, oi], any order → oldest first, deduped. */
export function parseCandles(data: unknown): Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }> {
  const rows = (data as { candles?: unknown })?.candles;
  if (!Array.isArray(rows)) throw new Error('Candle response: data.candles is not an array');
  const byDate = new Map<string, { date: string; open: number; high: number; low: number; close: number; volume: number }>();
  for (const r of rows) {
    if (!Array.isArray(r) || typeof r[0] !== 'string') continue;
    const date = r[0].slice(0, 10);
    const [o, h, l, c, v] = [r[1], r[2], r[3], r[4], r[5]].map(num);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || o == null || h == null || l == null || c == null) continue;
    byDate.set(date, { date, open: o, high: h, low: l, close: c, volume: v ?? 0 });
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}
