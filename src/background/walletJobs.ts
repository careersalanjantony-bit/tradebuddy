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
import { cancelOrder, newWallet, placeOrder, processWallet, updateHolding, type Holding, type MarketCtx, type OrderRequest, type PaperOrder, type WalletState } from '../wallet/wallet';

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
  if (!w0 || (!w0.holdings.length && !w0.orders.some((o) => o.status === 'open'))) return 0;
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

/** Stocks the wallet needs prices for. */
export async function walletKeys(): Promise<string[]> {
  const w = await getLocal('wallet');
  if (!w) return [];
  return [...new Set([...w.holdings.map((h) => h.key), ...w.orders.filter((o) => o.status === 'open').map((o) => o.key)])];
}
