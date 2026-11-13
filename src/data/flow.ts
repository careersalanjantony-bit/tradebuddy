/**
 * "Who is in control right now?" — from Upstox's full market quote (docs checked 14 Nov 2026):
 * GET /v2/market-quote/quotes?instrument_key=… (up to 500 keys) returns, per stock, last_price,
 * volume (today), average_price (the day's volume-weighted average price), net_change (vs
 * yesterday's close), total_buy_quantity / total_sell_quantity (shares waiting to be bought / sold
 * in the order book) and the top 5 bids and offers.
 *
 * Waiting orders can be cancelled in a second and big traders sometimes show orders they do not
 * mean, so the meter is a CLUE that is always combined with price and volume, never a reason alone.
 */

export interface Flow {
  key: string;
  ltp: number;
  /** day's average price (VWAP) */
  vwap: number | null;
  volume: number;
  buyQty: number;
  sellQty: number;
  prevClose: number | null;
  open: number | null;
  at: number;
}

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

export function parseFullQuotes(data: unknown, at: number): Record<string, Flow> {
  const out: Record<string, Flow> = {};
  if (!data || typeof data !== 'object') return out;
  for (const v of Object.values(data as Record<string, unknown>)) {
    const q = v as Record<string, unknown>;
    const key = typeof q.instrument_token === 'string' ? q.instrument_token : null;
    const ltp = num(q.last_price);
    if (!key || !ltp || ltp <= 0) continue;
    const net = num(q.net_change);
    const ohlc = (q.ohlc ?? {}) as Record<string, unknown>;
    const avg = num(q.average_price);
    out[key] = {
      key,
      ltp,
      vwap: avg && avg > 0 ? avg : null,
      volume: num(q.volume) ?? 0,
      buyQty: num(q.total_buy_quantity) ?? 0,
      sellQty: num(q.total_sell_quantity) ?? 0,
      prevClose: net !== null ? Math.round((ltp - net) * 100) / 100 : null,
      open: num(ohlc.open),
      at,
    };
  }
  return out;
}

export type MeterLabel = 'Buyers strong' | 'More buyers' | 'Balanced' | 'More sellers' | 'Sellers strong';

export interface Meter {
  /** share of waiting shares on the buy side (0–1); null without order-book data */
  buyShare: number | null;
  /** price vs the day's average price, % */
  vsVwapPct: number | null;
  label: MeterLabel;
  /** −2 … +2 */
  score: number;
}

/** Combines the order book (who is waiting) with price vs the day's average price (who has been paying more). */
export function buyersMeter(f: Pick<Flow, 'ltp' | 'vwap' | 'buyQty' | 'sellQty'>): Meter {
  const total = f.buyQty + f.sellQty;
  const buyShare = total > 0 ? f.buyQty / total : null;
  const vsVwapPct = f.vwap ? (f.ltp / f.vwap - 1) * 100 : null;
  let score = 0;
  if (buyShare !== null) score += buyShare >= 0.65 ? 1 : buyShare >= 0.55 ? 0.5 : buyShare <= 0.35 ? -1 : buyShare <= 0.45 ? -0.5 : 0;
  if (vsVwapPct !== null) score += vsVwapPct >= 0.3 ? 1 : vsVwapPct > 0 ? 0.5 : vsVwapPct <= -0.3 ? -1 : vsVwapPct < 0 ? -0.5 : 0;
  const label: MeterLabel = score >= 1.5 ? 'Buyers strong' : score >= 0.5 ? 'More buyers' : score <= -1.5 ? 'Sellers strong' : score <= -0.5 ? 'More sellers' : 'Balanced';
  return { buyShare, vsVwapPct, label, score };
}

export interface RisingRow {
  key: string;
  /** % change today (vs yesterday's close) */
  changePct: number;
  /** % move since the opening price */
  fromOpenPct: number;
  /** today's volume so far vs the usual volume by this time (1 = usual); null without history */
  pace: number | null;
  meter: Meter;
  score: number;
}

/**
 * "Rising now": stocks moving up from their opening price, above the day's average price, with
 * more buyers than sellers and more trading than usual. A list to WATCH, not a signal.
 */
export function risingNow(flows: Record<string, Flow>, pace: (key: string) => number | null, opts: { limit?: number; minFromOpenPct?: number } = {}): RisingRow[] {
  const rows: RisingRow[] = [];
  for (const f of Object.values(flows)) {
    if (!f.open || !f.prevClose || !f.vwap) continue;
    const fromOpenPct = (f.ltp / f.open - 1) * 100;
    const changePct = (f.ltp / f.prevClose - 1) * 100;
    const meter = buyersMeter(f);
    const p = pace(f.key);
    if (fromOpenPct < (opts.minFromOpenPct ?? 0.5)) continue;
    if (f.ltp <= f.vwap) continue;
    if (meter.score < 0.5) continue;
    if (p !== null && p < 1.2) continue;
    // a stock that is up a lot already is more likely to fall back: the score rewards the
    // combination, not the size of the move alone
    const score = meter.score + Math.min(2, Math.log2(Math.max(1, p ?? 1))) + Math.min(1, fromOpenPct / 2) - Math.max(0, changePct - 4) * 0.5;
    rows.push({ key: f.key, changePct, fromOpenPct, pace: p, meter, score });
  }
  return rows.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 10);
}
