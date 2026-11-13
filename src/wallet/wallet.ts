import { intradayCharges } from '../daytrade/rules';

/**
 * Practice money ("paper trading"): ₹10,00,000 of pretend money to buy and sell any NSE stock at the
 * live price. Pure rules — no storage, no network — so they are fully tested.
 *
 *  - Buy/sell at market (filled at the live price + a small slippage) or at a limit price (filled
 *    when the live price reaches it). A market order placed while the market is closed waits for
 *    the next opening price, like an after-market order in Upstox.
 *  - Holdings can be kept overnight (like Upstox "Delivery"). Optional per holding: a safety sell
 *    price (stop-loss), a profit target, and "sell by 3:10 pm" for day trades.
 *  - Charges are counted when shares are sold, for the whole buy+sell: shares bought and sold on the
 *    same day pay intraday charges, shares kept overnight pay delivery charges (Upstox rates).
 *  - Nothing is ever sent to Upstox.
 */

export const WALLET_START = 1_000_000;
/** paid above the live price when buying (and below when selling) — real orders rarely fill exactly at the last price */
export const SLIPPAGE = 0.0002;
/** a price older than this is not used for a fill */
export const QUOTE_MAX_AGE_MS = 2 * 60_000;
/** day trades are sold at 3:10 pm (minutes since midnight, IST) */
export const DAY_EXIT_T = 15 * 60 + 10;

export type OrderSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit';
export type OrderStatus = 'open' | 'filled' | 'cancelled' | 'rejected';
export type FillReason = 'order' | 'stop' | 'target' | 'day-end';

export interface PaperOrder {
  id: string;
  key: string;
  symbol: string;
  side: OrderSide;
  qty: number;
  type: OrderType;
  limitPrice?: number;
  status: OrderStatus;
  createdAt: number;
  /** IST date the order was placed (day orders expire at the close) */
  date: string;
  /** a market order placed while the market was closed: fills at the next opening price */
  atOpen?: boolean;
  filledAt?: number;
  fillPrice?: number;
  note?: string;
  /** what to attach to the holding once a buy fills */
  stop?: number | null;
  target?: number | null;
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
  /** sells only: profit/loss of the sold shares after charges, and the charges */
  pnl?: number;
  charges?: number;
  /** sells only: the average buy price of the sold shares */
  buyPrice?: number;
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

/** Upstox Equity Delivery: ₹20 per executed order; STT 0.1% both sides; stamp 0.015% on the buy; DP ₹20 + GST per sell. */
export function deliveryCharges(buyValue: number, sellValue: number): number {
  const brokerage = (buyValue > 0 ? 20 : 0) + (sellValue > 0 ? 20 : 0);
  const stt = (buyValue + sellValue) * 0.001;
  const txn = (buyValue + sellValue) * 0.0000297;
  const sebi = (buyValue + sellValue) * 0.000001;
  const stamp = buyValue * 0.00015;
  const dp = sellValue > 0 ? 20 * 1.18 : 0;
  const gst = (brokerage + txn + sebi) * 0.18;
  return brokerage + stt + txn + sebi + stamp + dp + gst;
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
  stop?: number | null;
  target?: number | null;
  sellByClose?: boolean;
  source?: string;
}

/** Cash set aside for open buy orders. */
export function reservedCash(w: WalletState, quotes: Record<string, WalletQuote | undefined>): number {
  let r = 0;
  for (const o of w.orders) {
    if (o.status !== 'open' || o.side !== 'buy') continue;
    const px = o.type === 'limit' ? o.limitPrice! : (quotes[o.key]?.ltp ?? 0) * 1.01;
    r += px * o.qty;
  }
  return r;
}

export const availableCash = (w: WalletState, quotes: Record<string, WalletQuote | undefined>): number => Math.max(0, w.cash - reservedCash(w, quotes));

/** Shares of a stock that are not already promised to an open sell order. */
export function sellableQty(w: WalletState, key: string): number {
  const held = w.holdings.find((h) => h.key === key)?.qty ?? 0;
  const pending = w.orders.filter((o) => o.status === 'open' && o.side === 'sell' && o.key === key).reduce((s, o) => s + o.qty, 0);
  return Math.max(0, held - pending);
}

const fresh = (q: WalletQuote | undefined, now: number): q is WalletQuote => !!q && q.ltp > 0 && now - q.fetchedAt <= QUOTE_MAX_AGE_MS;

function applyBuy(w: WalletState, o: PaperOrder, price: number, ctx: MarketCtx, reason: FillReason): { w: WalletState; fill: Fill } {
  const cost = price * o.qty;
  const holdings = [...w.holdings];
  const i = holdings.findIndex((h) => h.key === o.key);
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
    holdings.push({ key: o.key, symbol: o.symbol, qty: o.qty, avgPrice: price, lots: [{ date: ctx.today, qty: o.qty, price }], openedAt: ctx.now, stop: o.stop ?? null, target: o.target ?? null, sellByClose: !!o.sellByClose, ...(o.source ? { source: o.source } : {}) });
  }
  const fill: Fill = { id: newId('F', ctx.now), orderId: o.id, key: o.key, symbol: o.symbol, side: 'buy', qty: o.qty, price, at: ctx.now, date: ctx.today, reason };
  return { w: { ...w, cash: round2(w.cash - cost), holdings, fills: [...w.fills, fill] }, fill };
}

/**
 * Sells `qty` shares. Today's lots are sold first (they are the day trade); charges: intraday for
 * shares bought today, delivery for older ones.
 */
function applySell(w: WalletState, o: PaperOrder, price: number, ctx: MarketCtx, reason: FillReason): { w: WalletState; fill: Fill } {
  const holdings = [...w.holdings];
  const i = holdings.findIndex((h) => h.key === o.key);
  const h = holdings[i]!;
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
      if (lot.date === ctx.today) {
        todayBuy += take * lot.price;
        todaySell += take * price;
      } else {
        oldBuy += take * lot.price;
        oldSell += take * price;
      }
    }
    if (lot.qty - take > 0) remaining.push({ ...lot, qty: lot.qty - take });
  }
  const charges = round2((todaySell > 0 ? intradayCharges(todayBuy, todaySell) : 0) + (oldSell > 0 ? deliveryCharges(oldBuy, oldSell) : 0));
  const proceeds = price * o.qty;
  const buyCost = todayBuy + oldBuy;
  const pnl = round2(proceeds - buyCost - charges);
  const qty = h.qty - o.qty;
  if (qty > 0) {
    const remCost = remaining.reduce((s, l) => s + l.qty * l.price, 0);
    holdings[i] = { ...h, qty, lots: remaining, avgPrice: round2(remCost / qty) };
  } else holdings.splice(i, 1);
  const fill: Fill = { id: newId('F', ctx.now), orderId: o.id, key: o.key, symbol: o.symbol, side: 'sell', qty: o.qty, price, at: ctx.now, date: ctx.today, reason, pnl, charges, buyPrice: round2(buyCost / o.qty) };
  return { w: { ...w, cash: round2(w.cash + proceeds - charges), holdings, fills: [...w.fills, fill] }, fill };
}

export type PlaceResult = { ok: true; wallet: WalletState; order: PaperOrder; fill?: Fill } | { ok: false; error: string };

/** Places an order; a market order during market hours fills at once. */
export function placeOrder(w: WalletState, req: OrderRequest, quote: WalletQuote | undefined, ctx: MarketCtx): PlaceResult {
  const qty = Math.floor(req.qty);
  if (!(qty >= 1)) return { ok: false, error: 'Enter how many shares (1 or more).' };
  if (req.type === 'limit' && !(req.limitPrice && req.limitPrice > 0)) return { ok: false, error: 'Enter the limit price.' };
  if (req.side === 'sell' && sellableQty(w, req.key) < qty) return { ok: false, error: `You have only ${sellableQty(w, req.key)} ${req.symbol} shares to sell.` };
  const ref = req.type === 'limit' ? req.limitPrice! : quote?.ltp;
  if (!ref || !(ref > 0)) return { ok: false, error: `No live price for ${req.symbol} yet — wait a few seconds.` };
  if (req.side === 'buy') {
    const need = ref * qty * (req.type === 'market' ? 1 + SLIPPAGE + 0.005 : 1);
    const avail = availableCash(w, { [req.key]: quote });
    if (need > avail) return { ok: false, error: `Not enough practice money: this needs about ₹${Math.round(need).toLocaleString('en-IN')}, you have ₹${Math.round(avail).toLocaleString('en-IN')} free.` };
    if (req.stop != null && !(req.stop < ref)) return { ok: false, error: 'The safety sell price must be below the buy price.' };
    if (req.target != null && !(req.target > ref)) return { ok: false, error: 'The profit target must be above the buy price.' };
  }
  const order: PaperOrder = {
    id: newId('O', ctx.now),
    key: req.key,
    symbol: req.symbol,
    side: req.side,
    qty,
    type: req.type,
    ...(req.type === 'limit' ? { limitPrice: req.limitPrice! } : {}),
    status: 'open',
    createdAt: ctx.now,
    date: ctx.today,
    ...(req.type === 'market' && !ctx.open ? { atOpen: true } : {}),
    ...(req.stop !== undefined ? { stop: req.stop } : {}),
    ...(req.target !== undefined ? { target: req.target } : {}),
    ...(req.sellByClose !== undefined ? { sellByClose: req.sellByClose } : {}),
    ...(req.source ? { source: req.source } : {}),
  };
  let wallet: WalletState = { ...w, orders: [...w.orders, order] };
  if (req.type === 'market' && ctx.open && fresh(quote, ctx.now)) {
    const r = fillOrder(wallet, order, quote.ltp, ctx, 'order');
    return { ok: true, wallet: r.w, order: r.w.orders.find((x) => x.id === order.id)!, fill: r.fill };
  }
  if (req.type === 'market' && ctx.open) return { ok: false, error: `The price of ${req.symbol} is not up to date — wait a few seconds and try again.` };
  return { ok: true, wallet, order };
}

function fillOrder(w: WalletState, o: PaperOrder, livePrice: number, ctx: MarketCtx, reason: FillReason): { w: WalletState; fill: Fill } {
  const raw = o.type === 'limit' ? (o.side === 'buy' ? Math.min(livePrice, o.limitPrice!) : Math.max(livePrice, o.limitPrice!)) : livePrice;
  const price = o.side === 'buy' ? tickUp(raw * (1 + SLIPPAGE)) : tickDown(raw * (1 - SLIPPAGE));
  const r = o.side === 'buy' ? applyBuy(w, o, price, ctx, reason) : applySell(w, o, price, ctx, reason);
  const orders = r.w.orders.map((x) => (x.id === o.id ? { ...x, status: 'filled' as const, filledAt: ctx.now, fillPrice: price } : x));
  return { w: { ...r.w, orders }, fill: r.fill };
}

/**
 * A sale found by the background checker while the app was closed: sells the whole holding at the
 * price and time it was seen (with the usual slippage). Ignored if the holding is gone already.
 */
export function sellFromBackground(w: WalletState, key: string, price: number, ctx: MarketCtx, reason: FillReason): { wallet: WalletState; fill: Fill | null } {
  const h = w.holdings.find((x) => x.key === key);
  if (!h || !(price > 0)) return { wallet: w, fill: null };
  const open = w.orders.filter((o) => o.status === 'open' && o.side === 'sell' && o.key === key).map((o) => o.id);
  let wallet = open.reduce((acc, id) => cancelOrder(acc, id), w);
  const o: PaperOrder = { id: newId('O', ctx.now), key, symbol: h.symbol, side: 'sell', qty: h.qty, type: 'market', status: 'open', createdAt: ctx.now, date: ctx.today, source: 'background' };
  const r = fillOrder({ ...wallet, orders: [...wallet.orders, o] }, o, price, ctx, reason);
  wallet = r.w;
  return { wallet, fill: r.fill };
}

export function cancelOrder(w: WalletState, id: string): WalletState {
  return { ...w, orders: w.orders.map((o) => (o.id === id && o.status === 'open' ? { ...o, status: 'cancelled' as const } : o)) };
}

export function updateHolding(w: WalletState, key: string, patch: Partial<Pick<Holding, 'stop' | 'target' | 'sellByClose'>>): WalletState {
  return { ...w, holdings: w.holdings.map((h) => (h.key === key ? { ...h, ...patch } : h)) };
}

export interface WalletEvent {
  fill: Fill;
  /** plain-words reason for the notification */
  why: string;
}

/**
 * Runs on every price update: fills waiting orders whose price was reached, sells holdings at their
 * safety sell price / target, sells day trades at 3:10 pm, and cancels day orders after the close.
 */
export function processWallet(w: WalletState, quotes: Record<string, WalletQuote | undefined>, ctx: MarketCtx): { wallet: WalletState; events: WalletEvent[] } {
  let wallet = w;
  const events: WalletEvent[] = [];

  // day orders expire after the session they were placed for
  wallet = {
    ...wallet,
    orders: wallet.orders.map((o) => {
      if (o.status !== 'open') return o;
      const expired = o.atOpen ? false : o.date < ctx.today || (!ctx.open && ctx.t >= 15 * 60 + 30 && o.date === ctx.today);
      return expired ? { ...o, status: 'cancelled' as const, note: 'Not filled before the market closed.' } : o;
    }),
  };
  if (!ctx.open) return { wallet, events };

  for (const o of wallet.orders) {
    if (o.status !== 'open') continue;
    const q = quotes[o.key];
    if (!fresh(q, ctx.now)) continue;
    if (o.side === 'sell' && sellableQty({ ...wallet, orders: wallet.orders.filter((x) => x.id !== o.id) }, o.key) < o.qty) {
      wallet = { ...wallet, orders: wallet.orders.map((x) => (x.id === o.id ? { ...x, status: 'rejected' as const, note: 'Not enough shares.' } : x)) };
      continue;
    }
    const reached = o.type === 'market' || (o.side === 'buy' ? q.ltp <= o.limitPrice! : q.ltp >= o.limitPrice!);
    if (!reached) continue;
    if (o.side === 'buy' && q.ltp * o.qty > wallet.cash) {
      wallet = { ...wallet, orders: wallet.orders.map((x) => (x.id === o.id ? { ...x, status: 'rejected' as const, note: 'Not enough practice money when the price was reached.' } : x)) };
      continue;
    }
    const r = fillOrder(wallet, o, q.ltp, ctx, 'order');
    wallet = r.w;
    events.push({ fill: r.fill, why: o.atOpen ? 'filled at the opening price' : o.type === 'limit' ? 'your limit price was reached' : 'filled' });
  }

  for (const h of [...wallet.holdings]) {
    const q = quotes[h.key];
    if (!fresh(q, ctx.now)) continue;
    const pending = wallet.orders.some((o) => o.status === 'open' && o.side === 'sell' && o.key === h.key);
    if (pending) continue;
    let reason: FillReason | null = null;
    if (h.stop !== null && q.ltp <= h.stop) reason = 'stop';
    else if (h.target !== null && q.ltp >= h.target) reason = 'target';
    else if (h.sellByClose && ctx.t >= DAY_EXIT_T) reason = 'day-end';
    if (!reason) continue;
    const o: PaperOrder = { id: newId('O', ctx.now), key: h.key, symbol: h.symbol, side: 'sell', qty: h.qty, type: 'market', status: 'open', createdAt: ctx.now, date: ctx.today, source: reason };
    const r = fillOrder({ ...wallet, orders: [...wallet.orders, o] }, o, q.ltp, ctx, reason);
    wallet = r.w;
    events.push({ fill: r.fill, why: reason === 'stop' ? 'the safety sell price was hit' : reason === 'target' ? 'the profit target was reached' : 'day trade closed at 3:10 pm' });
  }
  return { wallet, events };
}

export interface HoldingView extends Holding {
  ltp: number | null;
  value: number;
  pnl: number;
  pnlPct: number;
  /** change today (vs yesterday's close, or vs the buy price for shares bought today) */
  todayPnl: number;
}

export interface WalletSummary {
  cash: number;
  free: number;
  invested: number;
  value: number;
  /** cash + holdings at live prices */
  total: number;
  totalPnl: number;
  totalPct: number;
  todayPnl: number;
  realizedToday: number;
  realizedAll: number;
  trades: number;
  wins: number;
  holdings: HoldingView[];
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
    return { ...h, ltp, value: round2(value), pnl: round2(pnl), pnlPct: h.avgPrice > 0 ? ((px / h.avgPrice) - 1) * 100 : 0, todayPnl: round2(todayPnl) };
  });
  const value = holdings.reduce((s, h) => s + h.value, 0);
  const invested = holdings.reduce((s, h) => s + h.avgPrice * h.qty, 0);
  const sells = w.fills.filter((f) => f.side === 'sell');
  const realizedToday = sells.filter((f) => f.date === today).reduce((s, f) => s + (f.pnl ?? 0), 0);
  const total = w.cash + value;
  return {
    cash: w.cash,
    free: availableCash(w, quotes),
    invested: round2(invested),
    value: round2(value),
    total: round2(total),
    totalPnl: round2(total - w.startCash),
    totalPct: ((total / w.startCash) - 1) * 100,
    todayPnl: round2(realizedToday + holdings.reduce((s, h) => s + h.todayPnl, 0)),
    realizedToday: round2(realizedToday),
    realizedAll: round2(sells.reduce((s, f) => s + (f.pnl ?? 0), 0)),
    trades: sells.length,
    wins: sells.filter((f) => (f.pnl ?? 0) > 0).length,
    holdings,
  };
}

/** Number of shares a rupee amount buys at a price (at least 0). */
export const sharesFor = (amount: number, price: number): number => (price > 0 ? Math.max(0, Math.floor(amount / (price * (1 + SLIPPAGE)))) : 0);
