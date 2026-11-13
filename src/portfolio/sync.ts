import type { DayTrade } from '../daytrade/types';
import type { TradePlan } from '../storage/schema';

/**
 * Automatic sync with the owner's Upstox account (v0.12.0, owner: "fetch the bought stocks from
 * Upstox live and alert automatically"). READ-ONLY: `GET /v2/portfolio/short-term-positions`
 * (docs checked 12 Nov 2026) lists today's positions; nothing is ever sent to Upstox.
 *
 * Position fields used: instrument_token ("NSE_EQ|ISIN" / "BSE_EQ|ISIN"), trading_symbol, product
 * ("I" intraday, "D" delivery, "CO", "MTF"), quantity (net, negative = short), day_buy_quantity,
 * day_buy_price, day_sell_quantity, day_sell_price, buy_price, sell_price, last_price.
 *
 * Pure functions: they only decide what changed; background/portfolioJobs.ts applies it.
 */

export interface UpstoxPosition {
  /** always the NSE key of the company (BSE positions are mapped by ISIN) */
  key: string;
  symbol: string;
  /** 'I' = intraday, 'D' = delivery */
  product: string;
  /** net quantity now (negative = sold short) */
  quantity: number;
  dayBuyQty: number;
  dayBuyPrice: number;
  daySellQty: number;
  daySellPrice: number;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Equity positions from the API response, one per company and product (NSE + BSE lots are merged). */
export function parsePositions(data: unknown): UpstoxPosition[] {
  if (!Array.isArray(data)) throw new Error('Positions response: data is not a list');
  const out = new Map<string, UpstoxPosition>();
  for (const raw of data) {
    const r = raw as Record<string, unknown>;
    const token = typeof r.instrument_token === 'string' ? r.instrument_token : '';
    const m = /^(NSE|BSE)_EQ\|(IN[A-Z0-9]{10})$/.exec(token);
    if (!m) continue;
    const product = typeof r.product === 'string' ? r.product : '';
    if (product !== 'I' && product !== 'D') continue;
    const key = `NSE_EQ|${m[2]}`;
    const p: UpstoxPosition = {
      key,
      symbol: String(r.trading_symbol ?? r.tradingsymbol ?? key).replace(/-EQ$/, ''),
      product,
      quantity: num(r.quantity),
      dayBuyQty: num(r.day_buy_quantity),
      dayBuyPrice: num(r.day_buy_price) || num(r.buy_price),
      daySellQty: num(r.day_sell_quantity),
      daySellPrice: num(r.day_sell_price) || num(r.sell_price),
    };
    const id = `${key}:${product}`;
    const prev = out.get(id);
    if (!prev) {
      out.set(id, p);
      continue;
    }
    // same company on both exchanges: add up, average the prices by quantity
    const avg = (q1: number, p1: number, q2: number, p2: number) => (q1 + q2 > 0 ? (q1 * p1 + q2 * p2) / (q1 + q2) : 0);
    out.set(id, {
      ...prev,
      quantity: prev.quantity + p.quantity,
      dayBuyPrice: avg(prev.dayBuyQty, prev.dayBuyPrice, p.dayBuyQty, p.dayBuyPrice),
      dayBuyQty: prev.dayBuyQty + p.dayBuyQty,
      daySellPrice: avg(prev.daySellQty, prev.daySellPrice, p.daySellQty, p.daySellPrice),
      daySellQty: prev.daySellQty + p.daySellQty,
    });
  }
  return [...out.values()];
}

const differs = (a: number, b: number) => Math.abs(a - b) > 0.005;

export type DaySyncAction =
  /** a new intraday position: start watching it */
  | { type: 'open'; key: string; symbol: string; side: 'long' | 'short'; qty: number; entry: number }
  /** quantity or average price of a watched trade changed in Upstox */
  | { type: 'update'; id: string; side: 'long' | 'short'; qty: number; entry: number }
  /** the position is flat again: the trade is finished */
  | { type: 'close'; id: string; exitPrice: number }
  /** bought and sold before the extension saw it: record the finished trade */
  | { type: 'record'; key: string; symbol: string; qty: number; entry: number; exitPrice: number }
  /** a finished trade's totals changed (another round in the same stock) */
  | { type: 'rerecord'; id: string; qty: number; entry: number; exitPrice: number };

/** Intraday ("I") positions against today's REAL day trades (practice trades are never touched). */
export function reconcileDay(positions: UpstoxPosition[], trades: DayTrade[], date: string): DaySyncAction[] {
  const actions: DaySyncAction[] = [];
  const mine = trades.filter((t) => !t.practice && t.date === date);
  for (const p of positions) {
    if (p.product !== 'I') continue;
    const open = mine.find((t) => t.key === p.key && t.status === 'open');
    if (p.quantity !== 0) {
      const side = p.quantity > 0 ? 'long' : 'short';
      const qty = Math.abs(p.quantity);
      const entry = side === 'long' ? p.dayBuyPrice : p.daySellPrice;
      if (!(entry > 0)) continue;
      if (!open) actions.push({ type: 'open', key: p.key, symbol: p.symbol, side, qty, entry });
      else if (open.side !== side || open.qty !== qty || differs(open.entry, entry)) actions.push({ type: 'update', id: open.id, side, qty, entry });
      continue;
    }
    if (!(p.dayBuyQty > 0 && p.daySellQty > 0)) continue;
    if (open) {
      actions.push({ type: 'close', id: open.id, exitPrice: open.side === 'long' ? p.daySellPrice : p.dayBuyPrice });
      continue;
    }
    // flat and nothing open: make sure the finished round trip is on record (once per stock per day)
    const done = mine.filter((t) => t.key === p.key && t.status === 'closed');
    const auto = done.find((t) => t.auto);
    if (!done.length) actions.push({ type: 'record', key: p.key, symbol: p.symbol, qty: p.dayBuyQty, entry: p.dayBuyPrice, exitPrice: p.daySellPrice });
    else if (auto && done.length === 1 && auto.side === 'long' && (auto.qty !== p.dayBuyQty || differs(auto.entry, p.dayBuyPrice) || differs(auto.exitPrice ?? 0, p.daySellPrice))) {
      actions.push({ type: 'rerecord', id: auto.id, qty: p.dayBuyQty, entry: p.dayBuyPrice, exitPrice: p.daySellPrice });
    }
  }
  return actions;
}

export type DeliverySyncAction =
  /** delivery shares bought today; `planId` = the saved pick it belongs to, if any */
  | { type: 'bought'; key: string; symbol: string; qty: number; price: number; planId?: string }
  /** shares of a watched trade were sold today (`all` = the whole trade) */
  | { type: 'sold'; planId: string; soldQty: number; price: number; all: boolean };

/** Delivery ("D") positions against the REAL swing trades (planned or open). */
export function reconcileDelivery(positions: UpstoxPosition[], plans: TradePlan[], date: string): DeliverySyncAction[] {
  const actions: DeliverySyncAction[] = [];
  for (const p of positions) {
    if (p.product !== 'D') continue;
    const plan = plans.find((x) => !x.practice && x.key === p.key && (x.status === 'planned' || x.status === 'open'));
    // bought today and still holding
    if (p.dayBuyQty > 0 && p.quantity > 0 && p.dayBuyPrice > 0) {
      if (!plan) actions.push({ type: 'bought', key: p.key, symbol: p.symbol, qty: p.quantity, price: p.dayBuyPrice });
      else if (plan.status === 'planned') actions.push({ type: 'bought', key: p.key, symbol: p.symbol, qty: p.quantity, price: p.dayBuyPrice, planId: plan.id });
      else if (plan.auto && plan.openedDate === date && (plan.qty !== p.quantity || differs(plan.fillPrice ?? 0, p.dayBuyPrice))) {
        actions.push({ type: 'bought', key: p.key, symbol: p.symbol, qty: p.quantity, price: p.dayBuyPrice, planId: plan.id });
      }
      continue;
    }
    // sold today (from earlier holdings, or bought and sold the same day)
    if (plan && plan.status === 'open' && p.daySellQty > 0 && p.quantity <= 0 && p.daySellPrice > 0) {
      const already = plan.syncSold?.date === date ? plan.syncSold.qty : 0;
      const sold = p.daySellQty;
      if (sold > already) actions.push({ type: 'sold', planId: plan.id, soldQty: sold, price: p.daySellPrice, all: sold >= plan.qty + already });
    }
  }
  return actions;
}
