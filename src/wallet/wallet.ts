import { intradayCharges } from '../daytrade/rules';

/**
 * Practice money ("paper trading"): pretend money to buy and sell any NSE stock at the live price.
 * Pure rules — no storage, no network — so they are fully tested. Nothing is ever sent to Upstox.
 *
 * App v1.10 — works like the Upstox order window:
 *  - Products. **Delivery**: pay the full price, keep the shares as long as you like. **Intraday**: pay
 *    only a margin (up to 5× leverage), close the same day; whatever is still open at 3:20 pm is
 *    squared off by Upstox for ₹50 + GST. **MTF** (margin trading): pay a margin (up to 4×), Upstox
 *    lends the rest at ₹20 a day for every ₹40,000 (or part) lent; the shares are pledged
 *    (₹20 + GST) and unpledged when sold (₹20 + GST). A big fall can force a sale (margin shortfall).
 *  - Order types. Market (live price), Limit (your price or better), SL (stop-loss: when the price
 *    reaches the trigger, a limit order at your limit price), SL-M (stop-loss market: at the trigger,
 *    a market order). Validity Day (until the close) or IOC (fills at once or is cancelled). Orders
 *    placed while the market is closed are after-market orders (AMO): they work from the next open.
 *  - Sell first (short) = an Intraday sell of a stock you do not hold; it is bought back the same day.
 *  - Charges are counted when a trade is closed, for the whole buy + sell (Upstox rates): same-day =
 *    intraday charges, kept overnight = delivery charges (MTF: + pledge and unpledge).
 *  - Every trade records the cash left after it ("balance after").
 */

export const WALLET_START = 1_000_000;
/** paid above the live price when buying (and below when selling) — real orders rarely fill exactly at the last price */
export const SLIPPAGE = 0.0002;
/** a price older than this is not used for a fill */
export const QUOTE_MAX_AGE_MS = 2 * 60_000;
/** the app's own same-day exit for its day-trade plans: 3:10 pm (minutes since midnight, IST) */
export const DAY_EXIT_T = 15 * 60 + 10;
/** Upstox squares off open Equity Intraday positions at 3:20 pm (from 22 June 2026; earlier 3:15 pm) */
export const AUTO_SQUARE_OFF_T = 15 * 60 + 20;
/** no new intraday positions after 3:15 pm (closing one is always allowed) */
export const INTRADAY_LAST_ENTRY_T = 15 * 60 + 15;
/** what Upstox charges for each position it has to square off: ₹50 + 18 % GST */
export const SQUARE_OFF_CHARGE = 59;
/** MTF interest: ₹20 a day for every ₹40,000 (or part of it) Upstox lends */
export const MTF_DAILY_PER_SLAB = 20;
export const MTF_SLAB = 40_000;
/** MTF shares are pledged when bought and unpledged when sold: ₹20 + GST each time */
export const PLEDGE_CHARGE = 23.6;

export type Product = 'delivery' | 'intraday' | 'mtf';
export type OrderSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit' | 'sl' | 'slm';
export type Validity = 'day' | 'ioc';
export type OrderStatus = 'open' | 'filled' | 'cancelled' | 'rejected';
export type FillReason = 'order' | 'stop' | 'target' | 'day-end' | 't1' | 'square-off' | 'margin';
/** how big and liquid a stock is — decides the leverage (Upstox shows the exact figure per stock) */
export type Tier = 'nifty100' | 'nifty500' | 'other';

export const PRODUCT_LABEL: Record<Product, string> = { delivery: 'Delivery', intraday: 'Intraday', mtf: 'MTF' };

export interface ProductTerms {
  product: Product;
  /** share of the order value you pay (1 = full price) */
  marginPct: number;
  leverage: number;
  available: boolean;
  note?: string;
}

/**
 * Leverage like Upstox's (exchange margins, which differ per stock and change daily): Intraday up to
 * 5× for the biggest companies (4× for the rest of the Nifty 500, 2× for others); MTF up to 4× for
 * the biggest (2.5× for the rest of the Nifty 500) and not offered for others.
 */
export function productTerms(product: Product, tier: Tier): ProductTerms {
  if (product === 'delivery') return { product, marginPct: 1, leverage: 1, available: true };
  if (product === 'intraday') {
    const leverage = tier === 'nifty100' ? 5 : tier === 'nifty500' ? 4 : 2;
    return { product, marginPct: 1 / leverage, leverage, available: true };
  }
  if (tier === 'other') return { product, marginPct: 1, leverage: 1, available: false, note: 'Not in the MTF list — Upstox lends only on bigger, approved stocks.' };
  const leverage = tier === 'nifty100' ? 4 : 2.5;
  return { product, marginPct: 1 / leverage, leverage, available: true };
}

export interface PaperOrder {
  id: string;
  key: string;
  symbol: string;
  side: OrderSide;
  qty: number;
  type: OrderType;
  limitPrice?: number;
  /** SL / SL-M: the order wakes up when the price reaches this */
  trigger?: number;
  /** the live price when it was placed: money is set aside at it when no newer price is known */
  refPrice?: number;
  /** SL: the trigger was reached; it now waits as a limit order */
  triggered?: boolean;
  validity?: Validity;
  /** undefined = Delivery */
  product?: Product;
  /** share of the order value paid by you (undefined = 1, full price) */
  marginPct?: number;
  /** an Intraday buy that buys back a sell-first trade */
  covers?: boolean;
  /** an Intraday sell of a stock not held: sells first */
  opensShort?: boolean;
  status: OrderStatus;
  createdAt: number;
  /** IST date of the session the order is for (day orders expire at its close) */
  date: string;
  /** a market order placed while the market was closed: fills at the next opening price */
  atOpen?: boolean;
  /** a limit / SL order placed while the market was closed (AMO): works from the next open */
  amo?: boolean;
  filledAt?: number;
  fillPrice?: number;
  note?: string;
  /** buys: what to attach to the holding once the order fills; sell-first: buy-back price (stop) and target 2 */
  stop?: number | null;
  target?: number | null;
  /** sell-first: target 1 (half bought back there) */
  t1?: number | null;
  /** Delivery: sell by itself at 3:10 pm; Intraday: close by itself at 3:10 pm (before Upstox's 3:20 square-off) */
  sellByClose?: boolean;
  /** where the idea came from (e.g. "Day trade signal", "Top pick") */
  source?: string;
}

export interface Lot {
  date: string;
  qty: number;
  price: number;
}

export interface Holding {
  key: string;
  symbol: string;
  qty: number;
  avgPrice: number;
  lots: Lot[];
  openedAt: number;
  stop: number | null;
  target: number | null;
  sellByClose: boolean;
  source?: string;
  /** undefined = Delivery */
  product?: Product;
  /** share of the value paid by you (undefined = 1); the rest is leverage (Intraday) or a loan (MTF) */
  marginPct?: number;
  /** MTF: interest paid so far on these shares */
  interest?: number;
  /** MTF: interest is counted up to this date */
  interestDate?: string;
  /** MTF: the interest taken at the last count (on `interestDate`) */
  interestLast?: number;
}

export interface Fill {
  id: string;
  orderId: string;
  key: string;
  symbol: string;
  side: OrderSide;
  qty: number;
  price: number;
  at: number;
  date: string;
  reason: FillReason;
  /** closing trades only: profit/loss after charges (and MTF interest), and the charges */
  pnl?: number;
  charges?: number;
  /** closing trades only: the average opening price */
  buyPrice?: number;
  /** part of a sell-first (short) trade: 'sell' opens it, 'buy' buys back */
  short?: boolean;
  /** undefined = Delivery */
  product?: Product;
  /** cash left after this trade */
  cashAfter?: number;
  /** MTF: interest paid on the sold shares */
  interest?: number;
}

export interface WalletState {
  v: 1;
  startCash: number;
  cash: number;
  createdAt: number;
  holdings: Holding[];
  orders: PaperOrder[];
  fills: Fill[];
  /** value of the wallet at the end of each day it was used (for the chart on Home) */
  equity?: Array<{ date: string; total: number }>;
  /** sell-first (short) positions, same day only (app v1.4) */
  shorts?: ShortPos[];
  /** MTF interest taken from the cash today (counted in today's result) */
  interestToday?: { date: string; amount: number };
}

/**
 * A practice short: shares sold first at `entry`, to be bought back the same day. A margin (the
 * value at the entry price × marginPct) is set aside from the cash and returned with the result.
 */
export interface ShortPos {
  key: string;
  symbol: string;
  qty: number;
  /** shares when opened (half are bought back at target 1) */
  origQty: number;
  entry: number;
  openedAt: number;
  date: string;
  /** buy back if the price rises to this (null = none) */
  stop: number | null;
  /** target 1 (half) and target 2 (the rest); null = none */
  t1: number | null;
  t2: number | null;
  t1Done: boolean;
  source?: string;
  /** share of the value set aside (undefined = 1) */
  marginPct?: number;
  /** when it is bought back by itself: 3:10 pm (the app's plan, default) or 3:20 pm (Upstox's square-off, with its charge) */
  exitT?: number;
}

export interface WalletQuote {
  ltp: number;
  prevClose: number | null;
  fetchedAt: number;
}

export interface MarketCtx {
  now: number;
  /** IST date (YYYY-MM-DD) */
  today: string;
  /** minutes since midnight IST */
  t: number;
  /** regular session open (09:15–15:30) */
  open: boolean;
}

export const newWallet = (now: number, startCash = WALLET_START): WalletState => ({ v: 1, startCash, cash: startCash, createdAt: now, holdings: [], orders: [], fills: [] });

const round2 = (x: number) => Math.round(x * 100) / 100;
/** prices are rounded to the 5-paise tick, against the trader (buys up, sells down) */
const tickUp = (x: number) => Math.ceil(x * 20 - 1e-9) / 20;
const tickDown = (x: number) => Math.floor(x * 20 + 1e-9) / 20;
const prodOf = (x: { product?: Product }): Product => x.product ?? 'delivery';
const mOf = (x: { marginPct?: number }): number => (x.marginPct && x.marginPct > 0 && x.marginPct <= 1 ? x.marginPct : 1);
const rupees = (x: number) => `₹${Math.round(x).toLocaleString('en-IN')}`;
const daysBetween = (from: string, to: string) => Math.max(0, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000));

/** Upstox Equity Delivery: ₹20 per executed order; STT 0.1% both sides; stamp 0.015% on the buy; DP ₹18.50 + GST per sell. */
export function deliveryCharges(buyValue: number, sellValue: number): number {
  const brokerage = (buyValue > 0 ? Math.min(20, buyValue * 0.025) : 0) + (sellValue > 0 ? Math.min(20, sellValue * 0.025) : 0);
  const stt = (buyValue + sellValue) * 0.001;
  const txn = (buyValue + sellValue) * 0.0000297;
  const sebi = (buyValue + sellValue) * 0.000001;
  const stamp = buyValue * 0.00015;
  const dp = sellValue > 0 ? 18.5 * 1.18 : 0;
  const gst = (brokerage + txn + sebi) * 0.18;
  return brokerage + stt + txn + sebi + stamp + dp + gst;
}

/** MTF kept overnight: delivery charges plus pledging and unpledging the shares (₹20 + GST each). */
export function mtfCharges(buyValue: number, sellValue: number): number {
  return deliveryCharges(buyValue, sellValue) + 2 * PLEDGE_CHARGE;
}

/** MTF interest for one day on the amount Upstox lends: ₹20 for every ₹40,000 or part of it. */
export function mtfDailyInterest(funded: number): number {
  return funded > 0.5 ? Math.ceil(funded / MTF_SLAB - 1e-9) * MTF_DAILY_PER_SLAB : 0;
}

/** Estimated charges for buying and selling `qty` shares at `price` with this product (sold another day for Delivery / MTF). */
export function estimateCharges(product: Product, qty: number, price: number): number {
  const v = qty * price;
  if (!(v > 0)) return 0;
  return round2(product === 'intraday' ? intradayCharges(v, v) : product === 'mtf' ? mtfCharges(v, v) : deliveryCharges(v, v));
}

let seq = 0;
const newId = (prefix: string, now: number) => `${prefix}${now.toString(36)}${(seq++ % 1296).toString(36).padStart(2, '0')}`;

export interface OrderRequest {
  key: string;
  symbol: string;
  side: OrderSide;
  qty: number;
  type: OrderType;
  limitPrice?: number;
  trigger?: number;
  validity?: Validity;
  /** default Delivery */
  product?: Product;
  /** from productTerms (the caller knows the stock); Delivery is always 1 */
  marginPct?: number;
  /** buys: auto-sell prices; sell-first: buy back if it rises to (stop) and target 2 (target) */
  stop?: number | null;
  target?: number | null;
  /** sell-first: target 1 (half) */
  t1?: number | null;
  sellByClose?: boolean;
  source?: string;
}

/**
 * Money set aside for one waiting order, like Upstox blocks margin for an open order: the full value
 * (Delivery) or the margin (Intraday, MTF) at its price — for a market or SL-M order the live price
 * (or the price when it was placed) + 1 %, in case it fills a little higher. 0 for a buy-back or a sell.
 */
export function orderReserve(o: PaperOrder, quotes: Record<string, WalletQuote | undefined>): number {
  if (o.status !== 'open') return 0;
  const blocks = o.side === 'buy' ? !o.covers : !!o.opensShort;
  if (!blocks) return 0;
  const live = quotes[o.key]?.ltp;
  const px = o.type === 'market' ? (live && live > 0 ? live : (o.refPrice ?? 0)) * 1.01 : o.type === 'slm' ? o.trigger! * 1.01 : o.limitPrice!;
  return px * o.qty * mOf(o);
}

/** Cash set aside for open orders: the money (or margin) each would need. */
export function reservedCash(w: WalletState, quotes: Record<string, WalletQuote | undefined>): number {
  return w.orders.reduce((r, o) => r + orderReserve(o, quotes), 0);
}

export const availableCash = (w: WalletState, quotes: Record<string, WalletQuote | undefined>): number => Math.max(0, w.cash - reservedCash(w, quotes));

/** Shares of a stock (in one product, or all) that are not already promised to an open sell order. */
export function sellableQty(w: WalletState, key: string, product?: Product): number {
  const held = w.holdings.filter((h) => h.key === key && (!product || prodOf(h) === product)).reduce((s, h) => s + h.qty, 0);
  const pending = w.orders.filter((o) => o.status === 'open' && o.side === 'sell' && o.key === key && !o.opensShort && (!product || prodOf(o) === product)).reduce((s, o) => s + o.qty, 0);
  return Math.max(0, held - pending);
}

/** The money an order needs now: the full value (Delivery) or the margin (Intraday, MTF); nothing for a buy-back. */
export function orderNeeds(price: number, qty: number, marginPct = 1): number {
  return price > 0 && qty > 0 ? round2(price * qty * mOf({ marginPct })) : 0;
}

const fresh = (q: WalletQuote | undefined, now: number): q is WalletQuote => !!q && q.ltp > 0 && now - q.fetchedAt <= QUOTE_MAX_AGE_MS;
const holdingIndex = (w: WalletState, key: string, product: Product) => w.holdings.findIndex((h) => h.key === key && prodOf(h) === product);

/** MTF interest up to `today` (every calendar day, weekends too), taken from the cash. */
function accrueInterest(w: WalletState, today: string): WalletState {
  let cash = w.cash;
  let changed = false;
  const holdings = w.holdings.map((h) => {
    if (prodOf(h) !== 'mtf' || !h.interestDate || h.interestDate >= today) return h;
    const days = daysBetween(h.interestDate, today);
    const funded = h.avgPrice * h.qty * (1 - mOf(h));
    const due = days * mtfDailyInterest(funded);
    changed = true;
    cash -= due;
    return { ...h, interest: round2((h.interest ?? 0) + due), interestDate: today, interestLast: due };
  });
  if (!changed) return w;
  const due = round2(w.cash - cash);
  const before = w.interestToday?.date === today ? w.interestToday.amount : 0;
  return { ...w, cash: round2(cash), holdings, interestToday: { date: today, amount: round2(before + due) } };
}

function applyBuy(w: WalletState, o: PaperOrder, price: number, ctx: MarketCtx, reason: FillReason): { w: WalletState; fill: Fill } {
  const product = prodOf(o);
  const m = mOf(o);
  const cost = price * o.qty;
  const holdings = [...w.holdings];
  const i = holdingIndex(w, o.key, product);
  if (i >= 0) {
    const h = holdings[i]!;
    const qty = h.qty + o.qty;
    holdings[i] = {
      ...h,
      qty,
      avgPrice: round2((h.avgPrice * h.qty + cost) / qty),
      lots: [...h.lots, { date: ctx.today, qty: o.qty, price }],
      ...(o.stop !== undefined ? { stop: o.stop } : {}),
      ...(o.target !== undefined ? { target: o.target } : {}),
      sellByClose: h.sellByClose && !!o.sellByClose,
    };
  } else {
    holdings.push({
      key: o.key,
      symbol: o.symbol,
      qty: o.qty,
      avgPrice: price,
      lots: [{ date: ctx.today, qty: o.qty, price }],
      openedAt: ctx.now,
      stop: o.stop ?? null,
      target: o.target ?? null,
      sellByClose: !!o.sellByClose,
      ...(o.source ? { source: o.source } : {}),
      ...(product !== 'delivery' ? { product, marginPct: m } : {}),
      ...(product === 'mtf' ? { interest: 0, interestDate: ctx.today } : {}),
    });
  }
  const cash = round2(w.cash - cost * m);
  const fill: Fill = { id: newId('F', ctx.now), orderId: o.id, key: o.key, symbol: o.symbol, side: 'buy', qty: o.qty, price, at: ctx.now, date: ctx.today, reason, cashAfter: cash, ...(product !== 'delivery' ? { product } : {}) };
  return { w: { ...w, cash, holdings, fills: [...w.fills, fill] }, fill };
}

/**
 * Sells `qty` shares of one product. Today's lots are sold first. Charges: intraday for shares bought
 * today (and every Intraday trade), delivery for older ones (MTF: + pledge and unpledge); + ₹59 when
 * Upstox squared it off. MTF interest already paid on the sold shares is part of the result.
 */
function applySell(w: WalletState, o: PaperOrder, price: number, ctx: MarketCtx, reason: FillReason): { w: WalletState; fill: Fill } {
  const product = prodOf(o);
  w = accrueInterest(w, ctx.today);
  const holdings = [...w.holdings];
  const i = holdingIndex(w, o.key, product);
  const h = holdings[i]!;
  const m = mOf(h);
  let left = o.qty;
  const lots = [...h.lots].sort((a, b) => (a.date === ctx.today ? -1 : 0) - (b.date === ctx.today ? -1 : 0));
  let todayBuy = 0;
  let todaySell = 0;
  let oldBuy = 0;
  let oldSell = 0;
  const remaining: Lot[] = [];
  for (const lot of lots) {
    const take = Math.min(left, lot.qty);
    left -= take;
    if (take > 0) {
      if (lot.date === ctx.today || product === 'intraday') {
        todayBuy += take * lot.price;
        todaySell += take * price;
      } else {
        oldBuy += take * lot.price;
        oldSell += take * price;
      }
    }
    if (lot.qty - take > 0) remaining.push({ ...lot, qty: lot.qty - take });
  }
  const overnight = oldSell > 0 ? (product === 'mtf' ? mtfCharges(oldBuy, oldSell) : deliveryCharges(oldBuy, oldSell)) : 0;
  const charges = round2((todaySell > 0 ? intradayCharges(todayBuy, todaySell) : 0) + overnight + (reason === 'square-off' ? SQUARE_OFF_CHARGE : 0));
  const proceeds = price * o.qty;
  const buyCost = todayBuy + oldBuy;
  const interest = product === 'mtf' && h.qty > 0 ? round2((h.interest ?? 0) * (o.qty / h.qty)) : 0;
  // today's interest on the sold shares is now inside this sale's result, not in "today's interest"
  const soldToday = product === 'mtf' && h.interestDate === ctx.today && h.interestLast ? round2(h.interestLast * (o.qty / h.qty)) : 0;
  if (soldToday > 0 && w.interestToday?.date === ctx.today) w = { ...w, interestToday: { date: ctx.today, amount: round2(Math.max(0, w.interestToday.amount - soldToday)) } };
  const pnl = round2(proceeds - buyCost - charges - interest);
  const qty = h.qty - o.qty;
  if (qty > 0) {
    const remCost = remaining.reduce((s, l) => s + l.qty * l.price, 0);
    holdings[i] = { ...h, qty, lots: remaining, avgPrice: round2(remCost / qty), ...(product === 'mtf' ? { interest: round2((h.interest ?? 0) - interest), ...(h.interestLast ? { interestLast: round2(h.interestLast - soldToday) } : {}) } : {}) };
  } else holdings.splice(i, 1);
  // the margin comes back with the gain (or minus the loss); the interest was paid day by day already
  const cash = round2(w.cash + buyCost * m + (proceeds - buyCost) - charges);
  const fill: Fill = {
    id: newId('F', ctx.now),
    orderId: o.id,
    key: o.key,
    symbol: o.symbol,
    side: 'sell',
    qty: o.qty,
    price,
    at: ctx.now,
    date: ctx.today,
    reason,
    pnl,
    charges,
    buyPrice: round2(buyCost / o.qty),
    cashAfter: cash,
    ...(product !== 'delivery' ? { product } : {}),
    ...(interest > 0 ? { interest } : {}),
  };
  return { w: { ...w, cash, holdings, fills: [...w.fills, fill] }, fill };
}

/** A sell-first (short) position opened at `price` (already including slippage). */
function shortAt(w: WalletState, o: PaperOrder, price: number, ctx: MarketCtx): { w: WalletState; fill: Fill } {
  const m = mOf(o);
  const cash = round2(w.cash - price * o.qty * m);
  const fill: Fill = { id: newId('F', ctx.now), orderId: o.id, key: o.key, symbol: o.symbol, side: 'sell', qty: o.qty, price, at: ctx.now, date: ctx.today, reason: 'order', short: true, cashAfter: cash, product: 'intraday' };
  const pos: ShortPos = {
    key: o.key,
    symbol: o.symbol,
    qty: o.qty,
    origQty: o.qty,
    entry: price,
    openedAt: ctx.now,
    date: ctx.today,
    stop: o.stop ?? null,
    t1: o.t1 ?? null,
    t2: o.target ?? null,
    t1Done: false,
    ...(o.source ? { source: o.source } : {}),
    ...(m < 1 ? { marginPct: m } : {}),
    ...(o.sellByClose === false ? { exitT: AUTO_SQUARE_OFF_T } : {}),
  };
  return { w: { ...w, cash, fills: [...w.fills, fill], shorts: [...(w.shorts ?? []), pos] }, fill };
}

/** Buys back `qty` shares of a short at `price` (already including slippage). */
function coverAt(w: WalletState, key: string, price: number, ctx: MarketCtx, reason: FillReason, qty: number | undefined, orderId?: string): { wallet: WalletState; fill: Fill | null } {
  const shorts = [...(w.shorts ?? [])];
  const i = shorts.findIndex((x) => x.key === key);
  if (i < 0 || !(price > 0)) return { wallet: w, fill: null };
  const p = shorts[i]!;
  const n = Math.min(p.qty, Math.max(1, Math.floor(qty ?? p.qty)));
  const charges = round2(intradayCharges(price * n, p.entry * n) + (reason === 'square-off' ? SQUARE_OFF_CHARGE : 0));
  const pnl = round2((p.entry - price) * n - charges);
  const left = p.qty - n;
  if (left > 0) shorts[i] = { ...p, qty: left, ...(reason === 't1' ? { t1Done: true, stop: p.entry } : {}) };
  else shorts.splice(i, 1);
  const cash = round2(w.cash + p.entry * n * mOf(p) + (p.entry - price) * n - charges);
  const fill: Fill = { id: newId('F', ctx.now), orderId: orderId ?? newId('O', ctx.now), key, symbol: p.symbol, side: 'buy', qty: n, price, at: ctx.now, date: ctx.today, reason, pnl, charges, buyPrice: p.entry, short: true, cashAfter: cash, product: 'intraday' };
  return { wallet: { ...w, cash, shorts, fills: [...w.fills, fill] }, fill };
}

export type PlaceResult = { ok: true; wallet: WalletState; order: PaperOrder; fill?: Fill } | { ok: false; error: string };
const fail = (error: string): PlaceResult => ({ ok: false, error });

/**
 * The price an open order fills at now, or null. SL / SL-M first need their trigger: a buy when the
 * price rises to it, a sell when the price falls to it. `triggered` tells whether an SL woke up.
 */
function matchPrice(o: PaperOrder, ltp: number): { price: number | null; triggered: boolean } {
  if (o.type === 'sl' || o.type === 'slm') {
    const hit = !!o.triggered || (o.side === 'buy' ? ltp >= o.trigger! : ltp <= o.trigger!);
    if (!hit) return { price: null, triggered: false };
    if (o.type === 'slm') return { price: ltp, triggered: true };
    const ok = o.side === 'buy' ? ltp <= o.limitPrice! : ltp >= o.limitPrice!;
    return { price: ok ? ltp : null, triggered: true };
  }
  if (o.type === 'limit') return { price: (o.side === 'buy' ? ltp <= o.limitPrice! : ltp >= o.limitPrice!) ? ltp : null, triggered: false };
  return { price: ltp, triggered: false };
}

function fillOrder(w: WalletState, o: PaperOrder, livePrice: number, ctx: MarketCtx, reason: FillReason): { w: WalletState; fill: Fill } {
  let price = o.side === 'buy' ? tickUp(livePrice * (1 + SLIPPAGE)) : tickDown(livePrice * (1 - SLIPPAGE));
  // a limit price is never crossed by the slippage
  if ((o.type === 'limit' || o.type === 'sl') && o.limitPrice) price = o.side === 'buy' ? Math.min(price, o.limitPrice) : Math.max(price, o.limitPrice);
  let r: { w: WalletState; fill: Fill };
  if (o.side === 'buy' && o.covers) {
    const c = coverAt(w, o.key, price, ctx, reason, o.qty, o.id);
    r = { w: c.wallet, fill: c.fill! };
  } else if (o.side === 'sell' && o.opensShort) r = shortAt(w, o, price, ctx);
  else r = o.side === 'buy' ? applyBuy(w, o, price, ctx, reason) : applySell(w, o, price, ctx, reason);
  const orders = r.w.orders.map((x) => (x.id === o.id ? { ...x, status: 'filled' as const, filledAt: ctx.now, fillPrice: price } : x));
  return { w: { ...r.w, orders }, fill: r.fill };
}

const setStatus = (w: WalletState, id: string, status: OrderStatus, note: string): WalletState => ({ ...w, orders: w.orders.map((x) => (x.id === id ? { ...x, status, note } : x)) });

/** Places an order. During market hours a market order (or a limit / SL that can fill already) fills at once. */
export function placeOrder(w: WalletState, req: OrderRequest, quote: WalletQuote | undefined, ctx: MarketCtx): PlaceResult {
  const qty = Math.floor(req.qty);
  if (!(qty >= 1)) return fail('Enter how many shares (1 or more).');
  const product = req.product ?? 'delivery';
  const type = req.type;
  const validity = req.validity ?? 'day';
  const marginPct = product === 'delivery' ? 1 : mOf({ marginPct: req.marginPct ?? productTerms(product, 'nifty500').marginPct });
  if (product === 'mtf' && !(marginPct < 1)) return fail(`${req.symbol} is not in Upstox's MTF list — buy it with Delivery.`);
  if ((type === 'limit' || type === 'sl') && !(req.limitPrice && req.limitPrice > 0)) return fail('Enter the limit price.');
  if ((type === 'sl' || type === 'slm') && !(req.trigger && req.trigger > 0)) return fail('Enter the trigger price.');
  const ltp = quote && quote.ltp > 0 ? quote.ltp : null;
  if ((type === 'sl' || type === 'slm') && ltp !== null && ctx.open && fresh(quote, ctx.now)) {
    if (req.side === 'buy' && !(req.trigger! > ltp)) return fail('A stop-loss buy waits for the price to RISE to the trigger: set the trigger above the current price (or use Limit).');
    if (req.side === 'sell' && !(req.trigger! < ltp)) return fail('A stop-loss sell waits for the price to FALL to the trigger: set the trigger below the current price (or use Limit).');
  }
  if (type === 'sl' && req.side === 'buy' && req.limitPrice! < req.trigger!) return fail('For a stop-loss buy, set the limit price at or above the trigger.');
  if (type === 'sl' && req.side === 'sell' && req.limitPrice! > req.trigger!) return fail('For a stop-loss sell, set the limit price at or below the trigger.');
  const ref = type === 'market' ? ltp : type === 'slm' ? req.trigger! : req.limitPrice!;
  if (!ref || !(ref > 0)) return fail(`No live price for ${req.symbol} yet — wait a few seconds.`);
  const short = (w.shorts ?? []).find((s) => s.key === req.key);
  let covers = false;
  let opensShort = false;
  if (req.side === 'sell') {
    if (product === 'intraday') {
      const held = sellableQty(w, req.key, 'intraday');
      const holds = w.holdings.some((h) => h.key === req.key && prodOf(h) === 'intraday');
      if (holds && held < qty) return fail(`You hold ${held} ${req.symbol} in Intraday — sell at most ${held}.`);
      if (!holds) {
        if (short) return fail(`You already sold ${req.symbol} first today — buy it back before selling it again.`);
        if (!ctx.open) return fail('Selling first works only while the market is open (9:15 am – 3:15 pm).');
        if (ctx.t >= INTRADAY_LAST_ENTRY_T) return fail('No new intraday trades after 3:15 pm (Upstox squares off at 3:20 pm).');
        opensShort = true;
      }
    } else {
      const held = sellableQty(w, req.key, product);
      if (held < qty) {
        if (held > 0) return fail(`You have only ${held} ${req.symbol} shares in ${PRODUCT_LABEL[product]} to sell.`);
        if (product === 'delivery' && sellableQty(w, req.key) > 0) return fail(`Your ${req.symbol} shares are not in Delivery — choose the product you bought them with.`);
        return fail(product === 'delivery' ? `You do not hold ${req.symbol}. To sell first and buy back today, choose Intraday.` : `You hold no ${req.symbol} in MTF.`);
      }
    }
  } else if (product === 'intraday' && short) {
    if (qty > short.qty) return fail(`You sold ${short.qty} ${req.symbol} first — buy back at most ${short.qty}.`);
    covers = true;
  }
  const enters = (req.side === 'buy' && !covers) || opensShort;
  if (enters && product === 'intraday' && ctx.open && ctx.t >= INTRADAY_LAST_ENTRY_T) return fail('No new intraday trades after 3:15 pm (Upstox squares off at 3:20 pm).');
  if (enters) {
    const need = ref * qty * marginPct * (type === 'market' ? 1 + SLIPPAGE + 0.005 : 1);
    const avail = availableCash(w, { [req.key]: quote });
    if (need > avail) return fail(`Not enough practice money: this needs about ${rupees(need)}${marginPct < 1 ? ` (the ${Math.round(marginPct * 100)}% margin)` : ''}, you have ${rupees(avail)} free.`);
  }
  if (req.side === 'buy' && !covers) {
    if (req.stop != null && !(req.stop < ref)) return fail('The stop-loss (sell if it falls to) must be below the buy price.');
    if (req.target != null && !(req.target > ref)) return fail('The target must be above the buy price.');
  }
  if (opensShort) {
    if (req.stop != null && !(req.stop > ref)) return fail('"Buy back if it rises to" must be above the selling price.');
    if (req.target != null && !(req.target < ref)) return fail('The target must be below the selling price.');
    if (req.t1 != null && !(req.t1 < ref && (req.target == null || req.target < req.t1))) return fail('Target 1 must be below the selling price and above target 2.');
  }
  const order: PaperOrder = {
    id: newId('O', ctx.now),
    key: req.key,
    symbol: req.symbol,
    side: req.side,
    qty,
    type,
    ...(type === 'limit' || type === 'sl' ? { limitPrice: req.limitPrice! } : {}),
    ...(type === 'sl' || type === 'slm' ? { trigger: req.trigger! } : {}),
    ...(ltp !== null ? { refPrice: ltp } : {}),
    ...(validity === 'ioc' ? { validity } : {}),
    ...(product !== 'delivery' ? { product, marginPct } : {}),
    ...(covers ? { covers } : {}),
    ...(opensShort ? { opensShort } : {}),
    status: 'open',
    createdAt: ctx.now,
    date: ctx.today,
    ...(type === 'market' && !ctx.open ? { atOpen: true } : {}),
    ...(type !== 'market' && !ctx.open ? { amo: true } : {}),
    ...(req.stop !== undefined ? { stop: req.stop } : {}),
    ...(req.target !== undefined ? { target: req.target } : {}),
    ...(opensShort && req.t1 !== undefined ? { t1: req.t1 } : {}),
    ...(req.sellByClose !== undefined ? { sellByClose: req.sellByClose } : {}),
    ...(req.source ? { source: req.source } : {}),
  };
  const wallet: WalletState = { ...w, orders: [...w.orders, order] };
  if (!ctx.open) return { ok: true, wallet, order };
  if (type === 'market') {
    if (!fresh(quote, ctx.now)) return fail(`The price of ${req.symbol} is not up to date — wait a few seconds and try again.`);
    const r = fillOrder(wallet, order, quote.ltp, ctx, 'order');
    return { ok: true, wallet: r.w, order: r.w.orders.find((x) => x.id === order.id)!, fill: r.fill };
  }
  // a limit / SL that can already fill does so (like the exchange); IOC: fill at once or cancel
  if (fresh(quote, ctx.now)) {
    const m = matchPrice(order, quote.ltp);
    if (m.price !== null) {
      const r = fillOrder(wallet, order, m.price, ctx, 'order');
      return { ok: true, wallet: r.w, order: r.w.orders.find((x) => x.id === order.id)!, fill: r.fill };
    }
  }
  if (validity === 'ioc') {
    const cancelled = setStatus(wallet, order.id, 'cancelled', 'IOC: could not fill at once, so it was cancelled.');
    return { ok: true, wallet: cancelled, order: cancelled.orders.find((x) => x.id === order.id)! };
  }
  return { ok: true, wallet, order };
}

/**
 * A sale found by the background checker while the app was closed: sells the whole holding (of one
 * product, or the first one of the stock) at the price and time it was seen, with the usual slippage.
 */
export function sellFromBackground(w: WalletState, key: string, price: number, ctx: MarketCtx, reason: FillReason, product?: Product): { wallet: WalletState; fill: Fill | null } {
  const h = w.holdings.find((x) => x.key === key && (!product || prodOf(x) === product));
  if (!h || !(price > 0)) return { wallet: w, fill: null };
  const p = prodOf(h);
  const open = w.orders.filter((o) => o.status === 'open' && o.side === 'sell' && o.key === key && !o.opensShort && prodOf(o) === p).map((o) => o.id);
  const wallet = open.reduce((acc, id) => cancelOrder(acc, id), w);
  const o: PaperOrder = { id: newId('O', ctx.now), key, symbol: h.symbol, side: 'sell', qty: h.qty, type: 'market', status: 'open', createdAt: ctx.now, date: ctx.today, source: 'background', ...(p !== 'delivery' ? { product: p, marginPct: mOf(h) } : {}) };
  const r = fillOrder({ ...wallet, orders: [...wallet.orders, o] }, o, price, ctx, reason);
  return { wallet: r.w, fill: r.fill };
}

export function cancelOrder(w: WalletState, id: string): WalletState {
  return { ...w, orders: w.orders.map((o) => (o.id === id && o.status === 'open' ? { ...o, status: 'cancelled' as const } : o)) };
}

export function updateHolding(w: WalletState, key: string, patch: Partial<Pick<Holding, 'stop' | 'target' | 'sellByClose'>>, product?: Product): WalletState {
  return { ...w, holdings: w.holdings.map((h) => (h.key === key && (!product || prodOf(h) === product) ? { ...h, ...patch } : h)) };
}

/**
 * Converts today's position between Intraday and Delivery, like Upstox's "Convert":
 *  - Intraday → Delivery (keep it overnight): pay the rest of the price now;
 *  - Delivery → Intraday (only shares bought today, market open, before 3:15 pm): the extra money comes back.
 */
export function convertPosition(w: WalletState, key: string, from: Product, to: Product, ctx: MarketCtx, toMarginPct?: number): { ok: true; wallet: WalletState } | { ok: false; error: string } {
  const i = holdingIndex(w, key, from);
  if (i < 0) return { ok: false, error: `No ${PRODUCT_LABEL[from]} position to convert.` };
  const h = w.holdings[i]!;
  if (w.orders.some((o) => o.status === 'open' && o.side === 'sell' && o.key === key && prodOf(o) === from)) return { ok: false, error: 'Cancel the waiting sell order for these shares first.' };
  if (from === 'intraday' && to === 'delivery') {
    const cost = h.lots.reduce((s, l) => s + l.qty * l.price, 0);
    const extra = round2(cost * (1 - mOf(h)));
    const avail = availableCash(w, {});
    if (extra > avail) return { ok: false, error: `Keeping it overnight needs the full price: ${rupees(extra)} more, you have ${rupees(avail)} free.` };
    const holdings = w.holdings.filter((_, j) => j !== i);
    const d = holdings.findIndex((x) => x.key === key && prodOf(x) === 'delivery');
    if (d >= 0) {
      const old = holdings[d]!;
      const qty = old.qty + h.qty;
      holdings[d] = { ...old, qty, lots: [...old.lots, ...h.lots], avgPrice: round2((old.avgPrice * old.qty + cost) / qty) };
    } else {
      const { product: _p, marginPct: _m, ...rest } = h;
      holdings.push({ ...rest, sellByClose: false });
    }
    return { ok: true, wallet: { ...w, cash: round2(w.cash - extra), holdings } };
  }
  if (from === 'delivery' && to === 'intraday') {
    if (!ctx.open || ctx.t >= INTRADAY_LAST_ENTRY_T) return { ok: false, error: 'Converting to Intraday works while the market is open, before 3:15 pm.' };
    const todays = h.lots.filter((l) => l.date === ctx.today);
    if (!todays.length) return { ok: false, error: 'Only shares bought today can be converted to Intraday.' };
    const m = mOf({ marginPct: toMarginPct ?? productTerms('intraday', 'nifty500').marginPct });
    const qty = todays.reduce((s, l) => s + l.qty, 0);
    const cost = todays.reduce((s, l) => s + l.qty * l.price, 0);
    const back = round2(cost * (1 - m));
    const holdings = [...w.holdings];
    const rest = h.lots.filter((l) => l.date !== ctx.today);
    if (rest.length) {
      const rq = rest.reduce((s, l) => s + l.qty, 0);
      holdings[i] = { ...h, qty: rq, lots: rest, avgPrice: round2(rest.reduce((s, l) => s + l.qty * l.price, 0) / rq) };
    } else holdings.splice(i, 1);
    const k = holdings.findIndex((x) => x.key === key && prodOf(x) === 'intraday');
    if (k >= 0) {
      const old = holdings[k]!;
      const q2 = old.qty + qty;
      holdings[k] = { ...old, qty: q2, lots: [...old.lots, ...todays], avgPrice: round2((old.avgPrice * old.qty + cost) / q2) };
    } else holdings.push({ key, symbol: h.symbol, qty, avgPrice: round2(cost / qty), lots: todays, openedAt: ctx.now, stop: h.stop, target: h.target, sellByClose: true, product: 'intraday', marginPct: m, ...(h.source ? { source: h.source } : {}) });
    return { ok: true, wallet: { ...w, cash: round2(w.cash + back), holdings } };
  }
  return { ok: false, error: `${PRODUCT_LABEL[from]} cannot be converted to ${PRODUCT_LABEL[to]} here.` };
}

export interface ShortRequest {
  key: string;
  symbol: string;
  qty: number;
  stop: number;
  t1: number;
  t2: number;
  source?: string;
  /** share of the value set aside (default 1: the full value) */
  marginPct?: number;
}

/** Sell first at the live price (market hours only, before 3:10 pm) — used by the "Falling now" cards and the auto-trader. */
export function openShort(w: WalletState, req: ShortRequest, quote: WalletQuote | undefined, ctx: MarketCtx): PlaceResult {
  const qty = Math.floor(req.qty);
  if (!ctx.open || ctx.t >= DAY_EXIT_T) return fail('Sell-first trades are only possible while the market is open, before 3:10 pm.');
  if (!(qty >= 1)) return fail('Enter how many shares (1 or more).');
  if ((w.shorts ?? []).some((x) => x.key === req.key)) return fail(`You already sold ${req.symbol} first today — buy it back before selling it again.`);
  if (w.holdings.some((h) => h.key === req.key && prodOf(h) === 'intraday')) return fail(`You hold ${req.symbol} in Intraday — sell those shares instead.`);
  if (!fresh(quote, ctx.now)) return fail(`The price of ${req.symbol} is not up to date — wait a few seconds and try again.`);
  const price = tickDown(quote.ltp * (1 - SLIPPAGE));
  if (!(req.stop > price)) return fail('The buy-back-if-it-rises price must be above the current price.');
  if (!(req.t1 < price && req.t2 < req.t1)) return fail('The targets must be below the current price.');
  const m = mOf({ marginPct: req.marginPct ?? 1 });
  const margin = price * qty * m;
  if (margin > availableCash(w, { [req.key]: quote })) return fail(`Not enough practice money: this needs about ${rupees(margin)} set aside.`);
  const order: PaperOrder = { id: newId('O', ctx.now), key: req.key, symbol: req.symbol, side: 'sell', qty, type: 'market', status: 'filled', createdAt: ctx.now, date: ctx.today, filledAt: ctx.now, fillPrice: price, product: 'intraday', ...(m < 1 ? { marginPct: m } : {}), opensShort: true, ...(req.source ? { source: req.source } : {}) };
  const r = shortAt({ ...w, orders: [...w.orders, order] }, { ...order, stop: req.stop, t1: req.t1, target: req.t2 }, price, ctx);
  return { ok: true, wallet: r.w, order, fill: r.fill };
}

/** Buys back `qty` shares of a short (all when omitted) at the live price. */
export function coverShort(w: WalletState, key: string, livePrice: number, ctx: MarketCtx, reason: FillReason, qty?: number): { wallet: WalletState; fill: Fill | null } {
  if (!(livePrice > 0)) return { wallet: w, fill: null };
  return coverAt(w, key, tickUp(livePrice * (1 + SLIPPAGE)), ctx, reason, qty);
}

export interface WalletEvent {
  fill: Fill;
  /** plain-words reason for the notification */
  why: string;
}

const exitWhy = (reason: FillReason, short: boolean): string =>
  reason === 'square-off'
    ? `Upstox squares off Intraday trades at 3:20 pm — this one was closed for you (₹${SQUARE_OFF_CHARGE} charge). Close Intraday trades yourself before 3:18 pm`
    : reason === 'margin'
      ? 'the loss used up most of the margin, so the position was closed (margin shortfall)'
      : reason === 'day-end'
        ? short
          ? 'sell-first trade closed at 3:10 pm'
          : 'day trade closed at 3:10 pm'
        : reason === 'stop'
          ? short
            ? 'the buy-back-if-it-rises price was reached'
            : 'the safety sell price was hit'
          : 'the profit target was reached';

/**
 * Runs on every price update: MTF interest for each new day, after-market orders waking up at the
 * open, day orders expiring at the close, waiting orders filling (limit, stop-loss), sell-first
 * targets and stops, auto-sells (stop-loss / target), the 3:10 pm day-trade exits, Upstox's 3:20 pm
 * Intraday square-off, and margin shortfalls.
 */
export function processWallet(w: WalletState, quotes: Record<string, WalletQuote | undefined>, ctx: MarketCtx): { wallet: WalletState; events: WalletEvent[] } {
  let wallet = accrueInterest(w, ctx.today);
  const events: WalletEvent[] = [];

  // after-market orders work from the next open; day orders expire after the session they were placed for
  wallet = {
    ...wallet,
    orders: wallet.orders.map((o) => {
      if (o.status !== 'open') return o;
      if (o.amo) return ctx.open ? { ...o, amo: false, date: ctx.today } : o;
      if (o.atOpen) return o;
      const expired = o.date < ctx.today || (!ctx.open && ctx.t >= 15 * 60 + 30 && o.date === ctx.today);
      return expired ? { ...o, status: 'cancelled' as const, note: 'Not filled before the market closed.' } : o;
    }),
  };
  // market closed: nothing Intraday may stay overnight — closed at its last price
  if (!ctx.open) {
    const over = (date: string) => date < ctx.today || ctx.t >= 15 * 60 + 30;
    for (const p of [...(wallet.shorts ?? [])]) {
      if (!over(p.date)) continue;
      const q = quotes[p.key];
      const reason: FillReason = p.exitT === AUTO_SQUARE_OFF_T ? 'square-off' : 'day-end';
      const r = coverShort(wallet, p.key, q?.ltp ?? p.entry, ctx, reason);
      wallet = r.wallet;
      if (r.fill) events.push({ fill: r.fill, why: reason === 'square-off' ? exitWhy(reason, true) : 'a sell-first trade must be closed the same day' });
    }
    for (const h of [...wallet.holdings]) {
      if (prodOf(h) !== 'intraday' || !h.lots.some((l) => over(l.date))) continue;
      const q = quotes[h.key];
      const reason: FillReason = h.sellByClose ? 'day-end' : 'square-off';
      const r = sellFromBackground(wallet, h.key, q?.ltp ?? h.avgPrice, ctx, reason, 'intraday');
      wallet = r.wallet;
      if (r.fill) events.push({ fill: r.fill, why: reason === 'square-off' ? exitWhy(reason, false) : 'an Intraday trade must be closed the same day' });
    }
    return { wallet, events };
  }

  for (const p of [...(wallet.shorts ?? [])]) {
    const q = quotes[p.key];
    if (!fresh(q, ctx.now)) continue;
    const exitT = p.exitT ?? DAY_EXIT_T;
    let reason: FillReason | null = null;
    let qty: number | undefined;
    if (p.stop !== null && q.ltp >= p.stop) reason = 'stop';
    else if (ctx.t >= exitT) reason = exitT === AUTO_SQUARE_OFF_T ? 'square-off' : 'day-end';
    else if ((q.ltp - p.entry) * p.qty >= 0.8 * p.entry * p.qty * mOf(p)) reason = 'margin';
    else if (p.t2 !== null && q.ltp <= p.t2) reason = 'target';
    else if (p.t1 !== null && !p.t1Done && q.ltp <= p.t1) {
      const half = Math.floor(p.origQty / 2);
      if (half >= 1 && half < p.qty) {
        reason = 't1';
        qty = half;
      } else reason = 'target';
    }
    if (!reason) continue;
    const r = coverShort(wallet, p.key, q.ltp, ctx, reason, qty);
    wallet = r.wallet;
    if (!r.fill) continue;
    const why =
      reason === 't1'
        ? 'target 1 reached — half bought back, the rest can no longer lose'
        : reason === 'target'
          ? p.t2 !== null && q.ltp <= p.t2
            ? 'target 2 reached'
            : 'target reached'
          : reason === 'stop' && p.t1Done
            ? 'the price came back to where you sold — the rest bought back at no loss'
            : exitWhy(reason, true);
    events.push({ fill: r.fill, why });
  }

  for (const o0 of wallet.orders) {
    if (o0.status !== 'open') continue;
    const o = wallet.orders.find((x) => x.id === o0.id)!;
    const q = quotes[o.key];
    if (!fresh(q, ctx.now)) continue;
    if (o.side === 'sell' && !o.opensShort && sellableQty({ ...wallet, orders: wallet.orders.filter((x) => x.id !== o.id) }, o.key, prodOf(o)) < o.qty) {
      wallet = setStatus(wallet, o.id, 'rejected', 'Not enough shares.');
      continue;
    }
    const m = matchPrice(o, q.ltp);
    if (m.triggered && !o.triggered) wallet = { ...wallet, orders: wallet.orders.map((x) => (x.id === o.id ? { ...x, triggered: true } : x)) };
    if (m.price === null) continue;
    if (o.covers) {
      const s = (wallet.shorts ?? []).find((x) => x.key === o.key);
      if (!s || s.qty < o.qty) {
        wallet = setStatus(wallet, o.id, 'rejected', 'The sell-first trade is already closed.');
        continue;
      }
    }
    if ((o.side === 'buy' && !o.covers) || o.opensShort) {
      if (prodOf(o) === 'intraday' && ctx.t >= INTRADAY_LAST_ENTRY_T) {
        wallet = setStatus(wallet, o.id, 'cancelled', 'No new intraday trades after 3:15 pm.');
        continue;
      }
      if (o.opensShort && ((wallet.shorts ?? []).some((x) => x.key === o.key) || wallet.holdings.some((h) => h.key === o.key && prodOf(h) === 'intraday'))) {
        wallet = setStatus(wallet, o.id, 'rejected', 'This stock already has an Intraday position.');
        continue;
      }
      if (m.price * o.qty * mOf(o) > wallet.cash) {
        wallet = setStatus(wallet, o.id, 'rejected', 'Not enough practice money when the price was reached.');
        continue;
      }
    }
    const r = fillOrder(wallet, wallet.orders.find((x) => x.id === o.id)!, m.price, ctx, 'order');
    wallet = r.w;
    events.push({ fill: r.fill, why: o.atOpen ? 'filled at the opening price' : o.type === 'sl' || o.type === 'slm' ? 'your stop-loss trigger was reached' : o.type === 'limit' ? 'your limit price was reached' : 'filled' });
  }

  for (const h of [...wallet.holdings]) {
    const q = quotes[h.key];
    if (!fresh(q, ctx.now)) continue;
    const product = prodOf(h);
    const m = mOf(h);
    // forced exits first: they also cancel a waiting sell order for these shares (like Upstox's risk team)
    let reason: FillReason | null = null;
    if (product === 'intraday' && ctx.t >= AUTO_SQUARE_OFF_T) reason = 'square-off';
    else if (product === 'intraday' && (h.avgPrice - q.ltp) * h.qty >= 0.8 * h.avgPrice * h.qty * m) reason = 'margin';
    else if (product === 'mtf' && q.ltp * h.qty - h.avgPrice * h.qty * (1 - m) < 0.5 * q.ltp * h.qty * m) reason = 'margin';
    if (!reason) {
      if (wallet.orders.some((o) => o.status === 'open' && o.side === 'sell' && o.key === h.key && !o.opensShort && prodOf(o) === product)) continue;
      if (h.stop !== null && q.ltp <= h.stop) reason = 'stop';
      else if (h.target !== null && q.ltp >= h.target) reason = 'target';
      else if (h.sellByClose && ctx.t >= DAY_EXIT_T) reason = 'day-end';
    }
    if (!reason) continue;
    const r = sellFromBackground(wallet, h.key, q.ltp, ctx, reason, product);
    wallet = r.wallet;
    if (r.fill) events.push({ fill: r.fill, why: exitWhy(reason, false) });
  }
  return { wallet, events };
}

export interface HoldingView extends Holding {
  ltp: number | null;
  /** market value of the shares */
  value: number;
  pnl: number;
  pnlPct: number;
  /** change today (vs yesterday's close, or vs the buy price for shares bought today) */
  todayPnl: number;
  /** your own money in it: the margin (Delivery: the whole cost) */
  margin: number;
  /** what the position is worth to you: margin + profit / loss */
  equity: number;
  leverage: number;
  /** MTF: the amount Upstox lends, and its interest per day */
  funded: number;
  dailyInterest: number;
  /** MTF: money missing to keep the margin (0 = fine) */
  shortfall: number;
}

export interface WalletSummary {
  cash: number;
  free: number;
  /** cost of the shares held (buy price × quantity) */
  invested: number;
  /** what your positions are worth to you (margin + profit / loss) */
  value: number;
  /** cash + positions */
  total: number;
  totalPnl: number;
  totalPct: number;
  todayPnl: number;
  realizedToday: number;
  realizedAll: number;
  trades: number;
  wins: number;
  /** used margin like Upstox: the margin in open positions + the money set aside for waiting orders */
  used: number;
  /** the money set aside for waiting orders (part of `used`) */
  blocked: number;
  /** full market value of the open positions */
  exposure: number;
  holdings: HoldingView[];
  /** open sell-first trades at live prices */
  shorts: Array<ShortPos & { ltp: number | null; pnl: number; pnlPct: number; margin: number }>;
}

export function walletSummary(w: WalletState, quotes: Record<string, WalletQuote | undefined>, today: string): WalletSummary {
  const holdings: HoldingView[] = w.holdings.map((h) => {
    const q = quotes[h.key];
    const ltp = q && q.ltp > 0 ? q.ltp : null;
    const px = ltp ?? h.avgPrice;
    const value = px * h.qty;
    const pnl = (px - h.avgPrice) * h.qty;
    let todayPnl = 0;
    for (const lot of h.lots) {
      const ref = lot.date === today ? lot.price : (q?.prevClose ?? lot.price);
      todayPnl += (px - ref) * lot.qty;
    }
    const m = mOf(h);
    const margin = h.avgPrice * h.qty * m;
    const funded = prodOf(h) === 'mtf' ? h.avgPrice * h.qty * (1 - m) : 0;
    const shortfall = prodOf(h) === 'mtf' ? Math.max(0, value * m - (value - funded)) : 0;
    return {
      ...h,
      ltp,
      value: round2(value),
      pnl: round2(pnl),
      pnlPct: h.avgPrice > 0 ? (px / h.avgPrice - 1) * 100 : 0,
      todayPnl: round2(todayPnl),
      margin: round2(margin),
      equity: round2(margin + pnl),
      leverage: Math.round((1 / m) * 10) / 10,
      funded: round2(funded),
      dailyInterest: mtfDailyInterest(funded),
      shortfall: round2(shortfall),
    };
  });
  const shortViews = (w.shorts ?? []).map((p) => {
    const q = quotes[p.key];
    const ltp = q && q.ltp > 0 ? q.ltp : null;
    const px = ltp ?? p.entry;
    return { ...p, ltp, pnl: round2((p.entry - px) * p.qty), pnlPct: ((p.entry - px) / p.entry) * 100, margin: round2(p.entry * p.qty * mOf(p)) };
  });
  const value = holdings.reduce((s, h) => s + h.equity, 0) + shortViews.reduce((a, p) => a + p.margin + p.pnl, 0);
  const invested = holdings.reduce((s, h) => s + h.avgPrice * h.qty, 0);
  const sells = w.fills.filter((f) => f.pnl !== undefined);
  const realizedToday = sells.filter((f) => f.date === today).reduce((s, f) => s + (f.pnl ?? 0), 0);
  const total = w.cash + value;
  return {
    cash: w.cash,
    free: availableCash(w, quotes),
    invested: round2(invested),
    value: round2(value),
    total: round2(total),
    totalPnl: round2(total - w.startCash),
    totalPct: (total / w.startCash - 1) * 100,
    // MTF interest taken today counts (interest paid on shares sold today is already in their result)
    todayPnl: round2(realizedToday + holdings.reduce((s, h) => s + h.todayPnl, 0) + shortViews.reduce((a, p) => a + p.pnl, 0) - (w.interestToday?.date === today ? w.interestToday.amount : 0)),
    realizedToday: round2(realizedToday),
    realizedAll: round2(sells.reduce((s, f) => s + (f.pnl ?? 0), 0)),
    trades: sells.length,
    wins: sells.filter((f) => (f.pnl ?? 0) > 0).length,
    used: round2(holdings.reduce((s, h) => s + h.margin, 0) + shortViews.reduce((a, p) => a + p.margin, 0) + reservedCash(w, quotes)),
    blocked: round2(reservedCash(w, quotes)),
    exposure: round2(holdings.reduce((s, h) => s + h.value, 0) + shortViews.reduce((a, p) => a + (p.ltp ?? p.entry) * p.qty, 0)),
    holdings,
    shorts: shortViews,
  };
}

/** Number of shares a rupee amount buys at a price (at least 0); with leverage the amount is your margin. */
export const sharesFor = (amount: number, price: number, marginPct = 1): number => (price > 0 ? Math.max(0, Math.floor(amount / (price * (1 + SLIPPAGE) * mOf({ marginPct })))) : 0);
