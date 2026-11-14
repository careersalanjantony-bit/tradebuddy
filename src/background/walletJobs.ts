import { marketState } from '../data/calendar';
import { getCalendar } from '../data/calendarSync';
import { getQuotes } from '../data/quotes';
import { minutesIST } from '../daytrade/live';
import { createLogger } from '../lib/log';
import { istDate } from '../lib/time';
import { notify } from '../notify/chrome';
import { playSound } from '../notify/sound';
import { getLocal, setLocal } from '../storage/local';
import { createQueue } from '../lib/queue';
import { cancelOrder, coverShort, newWallet, openShort, placeOrder, type ShortRequest, processWallet, sellFromBackground, updateHolding, walletSummary, type Holding, type MarketCtx, type OrderRequest, type PaperOrder, type WalletState } from '../wallet/wallet';

/**
 * Practice money (v1.0): stores the wallet, places orders at live prices and runs the waiting
 * orders, safety sells, targets and 3:10 pm day-trade exits on every price update. Nothing is sent to Upstox.
 */

const log = createLogger('wallet');
const queue = createQueue();
const rs = (x: number) => `₹${x.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signedRs = (x: number) => `${x >= 0 ? '+' : '−'}₹${Math.abs(Math.round(x)).toLocaleString('en-IN')}`;

export async function getWallet(now = Date.now()): Promise<WalletState> {
  return (await getLocal('wallet')) ?? newWallet(now);
}

async function marketCtx(now: number): Promise<MarketCtx> {
  const m = marketState(now, await getCalendar());
  return { now, today: istDate(now), t: minutesIST(now), open: m.phase === 'open' };
}

/** All wallet changes go through one queue, so two quick taps cannot spend the same money twice. */
function mutate<T>(fn: (w: WalletState) => Promise<{ wallet: WalletState; result: T }>): Promise<T> {
  return queue(async () => {
    const { wallet, result } = await fn(await getWallet());
    await setLocal('wallet', wallet);
    return result;
  });
}

export function walletOrder(req: OrderRequest, now = Date.now()): Promise<{ order: PaperOrder; filledAt?: number }> {
  return mutate(async (w) => {
    const ctx = await marketCtx(now);
    const quote = (await getQuotes())[req.key];
    const r = placeOrder(w, req, quote ? { ltp: quote.ltp, prevClose: quote.prevClose, fetchedAt: quote.fetchedAt } : undefined, ctx);
    if (!r.ok) throw new Error(r.error);
    if (r.fill) log.info(`Practice ${r.fill.side} ${r.fill.qty} ${r.fill.symbol} @ ${r.fill.price}`);
    else log.info(`Practice ${req.side} order placed: ${req.qty} ${req.symbol} (${req.type}${r.order.atOpen ? ', at the next open' : ''})`);
    return { wallet: r.wallet, result: { order: r.order, ...(r.fill ? { filledAt: r.fill.price } : {}) } };
  });
}

export function walletCancel(id: string): Promise<void> {
  return mutate(async (w) => ({ wallet: cancelOrder(w, id), result: undefined }));
}

export function walletUpdate(key: string, patch: Partial<Pick<Holding, 'stop' | 'target' | 'sellByClose'>>): Promise<void> {
  return mutate(async (w) => ({ wallet: updateHolding(w, key, patch), result: undefined }));
}

export function walletReset(startCash: number, now = Date.now()): Promise<void> {
  return mutate(async () => ({ wallet: newWallet(now, startCash), result: undefined }));
}

/** On every price update. */
export async function checkWallet(now = Date.now()): Promise<number> {
  const w0 = await getLocal('wallet');
  if (!w0 || (!w0.holdings.length && !w0.orders.some((o) => o.status === 'open') && !(w0.shorts ?? []).length)) return 0;
  const events = await mutate(async (w) => {
    const quotes = await getQuotes();
    const r = processWallet(w, quotes, await marketCtx(now));
    return { wallet: r.wallet, result: r.events };
  });
  for (const e of events) {
    const f = e.fill;
    const title = f.side === 'buy' ? `Practice: bought ${f.qty} ${f.symbol} at ${rs(f.price)}` : `Practice: sold ${f.qty} ${f.symbol} at ${rs(f.price)} — ${signedRs(f.pnl ?? 0)}`;
    await notify(`alert:wallet-${f.id}`, { title, message: `${e.why[0]!.toUpperCase()}${e.why.slice(1)}. Pretend money — nothing was sent to Upstox.`, priority: 1 });
    await playSound(f.reason === 'stop' ? 'stop' : f.reason === 'target' ? 'target' : 'info');
  }
  return events.length;
}

/** Sales the background checker saw while the app was closed (applied at their own price and time). */
export function walletApplyBackground(hits: Array<{ key: string; price: number; at: number; reason: string }>): Promise<number> {
  return mutate(async (w) => {
    let wallet = w;
    let n = 0;
    for (const h of hits) {
      const reason = h.reason === 'stop' || h.reason === 'target' || h.reason === 'day-end' ? h.reason : 'order';
      const r = sellFromBackground(wallet, h.key, h.price, { now: h.at, today: istDate(h.at), t: minutesIST(h.at), open: true }, reason);
      wallet = r.wallet;
      if (r.fill) {
        n++;
        log.info(`Practice sale found by the background check: ${r.fill.qty} ${r.fill.symbol} @ ${r.fill.price} (${reason})`);
      }
    }
    return { wallet, result: n };
  });
}

/** Practice sell-first: sell now at the live price (app v1.4). */
export function walletShort(req: ShortRequest, now = Date.now()): Promise<{ price: number }> {
  return mutate(async (w) => {
    const quote = (await getQuotes())[req.key];
    const r = openShort(w, req, quote ? { ltp: quote.ltp, prevClose: quote.prevClose, fetchedAt: quote.fetchedAt } : undefined, await marketCtx(now));
    if (!r.ok) throw new Error(r.error);
    log.info(`Practice sell-first ${req.qty} ${req.symbol} @ ${r.fill!.price}`);
    return { wallet: r.wallet, result: { price: r.fill!.price } };
  });
}

/** Practice: buy back a sell-first trade now. */
export function walletCover(key: string, now = Date.now()): Promise<{ pnl: number }> {
  return mutate(async (w) => {
    const q = (await getQuotes())[key];
    const ctx = await marketCtx(now);
    const r = coverShort(w, key, q?.ltp ?? 0, ctx, 'order');
    if (!r.fill) throw new Error('No price for this stock yet — wait a few seconds.');
    return { wallet: r.wallet, result: { pnl: r.fill.pnl ?? 0 } };
  });
}

/** Keeps today's wallet value for the small chart on Home (one point per day, last 120 days). */
export async function recordEquity(now = Date.now()): Promise<void> {
  const w0 = await getLocal('wallet');
  if (!w0) return;
  const quotes = await getQuotes();
  const total = Math.round(walletSummary(w0, quotes, istDate(now)).total);
  const today = istDate(now);
  const last = w0.equity?.[w0.equity.length - 1];
  if (last && last.date === today && last.total === total) return;
  await mutate(async (w) => {
    const eq = (w.equity ?? []).filter((e) => e.date !== today);
    return { wallet: { ...w, equity: [...eq, { date: today, total }].slice(-120) }, result: undefined };
  });
}

/** Stocks the wallet needs prices for. */
export async function walletKeys(): Promise<string[]> {
  const w = await getLocal('wallet');
  if (!w) return [];
  return [...new Set([...w.holdings.map((h) => h.key), ...w.orders.filter((o) => o.status === 'open').map((o) => o.key)])];
}
