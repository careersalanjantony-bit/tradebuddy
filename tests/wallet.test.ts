import { describe, expect, it } from 'vitest';
import { intradayCharges } from '../src/daytrade/rules';
import { cancelOrder, deliveryCharges, newWallet, placeOrder, processWallet, sellableQty, sellFromBackground, sharesFor, WALLET_START, walletSummary, type MarketCtx, type WalletQuote } from '../src/wallet/wallet';

const T0 = Date.parse('2026-11-16T04:00:00Z'); // 09:30 IST
const ctx = (over: Partial<MarketCtx> = {}): MarketCtx => ({ now: T0, today: '2026-11-16', t: 570, open: true, ...over });
const q = (ltp: number, at = T0, prevClose: number | null = null): WalletQuote => ({ ltp, prevClose, fetchedAt: at });
const K = 'NSE_EQ|INE001';

describe('practice wallet', () => {
  it('starts with ₹10,00,000', () => {
    const w = newWallet(T0);
    expect(w.cash).toBe(WALLET_START);
    expect(WALLET_START).toBe(1_000_000);
  });

  it('market buy during market hours fills at once at the live price + slippage, rounded up to 5 paise', () => {
    const r = placeOrder(newWallet(T0), { key: K, symbol: 'ABC', side: 'buy', qty: 100, type: 'market' }, q(1000), ctx());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fill?.price).toBe(1000.2);
    expect(r.wallet.cash).toBeCloseTo(WALLET_START - 100_020, 2);
    expect(r.wallet.holdings[0]).toMatchObject({ key: K, qty: 100, avgPrice: 1000.2 });
    expect(r.order.status).toBe('filled');
  });

  it('refuses a buy larger than the free practice money, and a sell of shares not owned', () => {
    const w = newWallet(T0, 50_000);
    const r1 = placeOrder(w, { key: K, symbol: 'ABC', side: 'buy', qty: 100, type: 'market' }, q(1000), ctx());
    expect(r1.ok).toBe(false);
    const r2 = placeOrder(w, { key: K, symbol: 'ABC', side: 'sell', qty: 1, type: 'market' }, q(1000), ctx());
    expect(r2).toMatchObject({ ok: false });
  });

  it('a stale price is not used for a fill', () => {
    const r = placeOrder(newWallet(T0), { key: K, symbol: 'ABC', side: 'buy', qty: 1, type: 'market' }, q(1000, T0 - 10 * 60_000), ctx());
    expect(r.ok).toBe(false);
  });

  it('a market order while the market is closed waits and fills at the next opening price', () => {
    const closed = ctx({ open: false, t: 20 * 60, today: '2026-11-15' });
    const r = placeOrder(newWallet(T0), { key: K, symbol: 'ABC', side: 'buy', qty: 10, type: 'market' }, q(1000, T0), closed);
    expect(r.ok && r.order.atOpen).toBe(true);
    if (!r.ok) return;
    const next = processWallet(r.wallet, { [K]: q(990) }, ctx({ t: 555 }));
    expect(next.events).toHaveLength(1);
    expect(next.wallet.holdings[0]!.avgPrice).toBe(990.2);
  });

  it('limit buy waits until the price comes down to it, then fills at the limit or better', () => {
    const r = placeOrder(newWallet(T0), { key: K, symbol: 'ABC', side: 'buy', qty: 10, type: 'limit', limitPrice: 995 }, q(1000), ctx());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.wallet.holdings).toHaveLength(0);
    expect(processWallet(r.wallet, { [K]: q(998) }, ctx()).events).toHaveLength(0);
    const hit = processWallet(r.wallet, { [K]: q(994) }, ctx());
    expect(hit.events).toHaveLength(1);
    expect(hit.wallet.holdings[0]!.avgPrice).toBeLessThanOrEqual(995);
  });

  it('cash set aside for an open limit buy cannot be spent twice; cancelling frees it', () => {
    const w = newWallet(T0, 20_000);
    const r = placeOrder(w, { key: K, symbol: 'ABC', side: 'buy', qty: 15, type: 'limit', limitPrice: 1000 }, q(1010), ctx());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(placeOrder(r.wallet, { key: 'K2', symbol: 'XYZ', side: 'buy', qty: 10, type: 'market' }, q(1000), ctx()).ok).toBe(false);
    const freed = cancelOrder(r.wallet, r.order.id);
    expect(placeOrder(freed, { key: 'K2', symbol: 'XYZ', side: 'buy', qty: 10, type: 'market' }, q(1000), ctx()).ok).toBe(true);
  });

  it('same-day sell pays intraday charges; the result is after charges', () => {
    const b = placeOrder(newWallet(T0), { key: K, symbol: 'ABC', side: 'buy', qty: 100, type: 'market' }, q(1000), ctx());
    if (!b.ok) throw new Error('buy failed');
    const s = placeOrder(b.wallet, { key: K, symbol: 'ABC', side: 'sell', qty: 100, type: 'market' }, q(1010, T0 + 600_000), ctx({ now: T0 + 600_000, t: 580 }));
    if (!s.ok) throw new Error(s.error);
    const buy = 1000.2 * 100;
    const sell = 1009.75 * 100;
    expect(s.fill!.price).toBe(1009.75);
    expect(s.fill!.charges).toBeCloseTo(intradayCharges(buy, sell), 1);
    expect(s.fill!.pnl).toBeCloseTo(sell - buy - intradayCharges(buy, sell), 1);
    expect(s.wallet.holdings).toHaveLength(0);
    expect(s.wallet.cash).toBeCloseTo(WALLET_START + s.fill!.pnl!, 1);
  });

  it('shares kept overnight are sold with delivery charges (STT both sides, DP charge)', () => {
    const b = placeOrder(newWallet(T0), { key: K, symbol: 'ABC', side: 'buy', qty: 100, type: 'market' }, q(1000), ctx());
    if (!b.ok) throw new Error('buy failed');
    const nextDay = ctx({ today: '2026-11-17', now: T0 + 86_400_000 });
    const s = placeOrder(b.wallet, { key: K, symbol: 'ABC', side: 'sell', qty: 100, type: 'market' }, q(1020, nextDay.now), nextDay);
    if (!s.ok) throw new Error(s.error);
    expect(s.fill!.charges).toBeCloseTo(deliveryCharges(100_020, s.fill!.price * 100), 1);
    expect(s.fill!.charges!).toBeGreaterThan(200);
  });

  it('safety sell price and target sell by themselves; "sell by 3:10 pm" closes a day trade', () => {
    const b = placeOrder(newWallet(T0), { key: K, symbol: 'ABC', side: 'buy', qty: 10, type: 'market', stop: 990, target: 1030, sellByClose: true }, q(1000), ctx());
    if (!b.ok) throw new Error('buy failed');
    expect(processWallet(b.wallet, { [K]: q(1005) }, ctx()).events).toHaveLength(0);
    const stop = processWallet(b.wallet, { [K]: q(989.5) }, ctx());
    expect(stop.events[0]).toMatchObject({ fill: { side: 'sell', reason: 'stop' } });
    expect(stop.wallet.holdings).toHaveLength(0);
    const tgt = processWallet(b.wallet, { [K]: q(1031) }, ctx());
    expect(tgt.events[0]!.fill.reason).toBe('target');
    const late = processWallet(b.wallet, { [K]: q(1004) }, ctx({ t: 15 * 60 + 10 }));
    expect(late.events[0]!.fill.reason).toBe('day-end');
  });

  it('a holding without "sell by 3:10 pm" is kept overnight', () => {
    const b = placeOrder(newWallet(T0), { key: K, symbol: 'ABC', side: 'buy', qty: 10, type: 'market' }, q(1000), ctx());
    if (!b.ok) throw new Error('buy failed');
    expect(processWallet(b.wallet, { [K]: q(1004) }, ctx({ t: 15 * 60 + 20 })).events).toHaveLength(0);
  });

  it('unfilled day orders are cancelled after the close; orders wait while the market is closed', () => {
    const r = placeOrder(newWallet(T0), { key: K, symbol: 'ABC', side: 'buy', qty: 10, type: 'limit', limitPrice: 900 }, q(1000), ctx());
    if (!r.ok) throw new Error('order failed');
    const after = processWallet(r.wallet, { [K]: q(899) }, ctx({ open: false, t: 16 * 60 }));
    expect(after.events).toHaveLength(0);
    expect(after.wallet.orders[0]!.status).toBe('cancelled');
  });

  it("summary: total and today's profit/loss, holdings at live prices", () => {
    const b = placeOrder(newWallet(T0), { key: K, symbol: 'ABC', side: 'buy', qty: 100, type: 'market' }, q(1000), ctx());
    if (!b.ok) throw new Error('buy failed');
    const s = walletSummary(b.wallet, { [K]: q(1010, T0, 990) }, '2026-11-16');
    expect(s.value).toBe(101_000);
    expect(s.holdings[0]!.pnl).toBeCloseTo((1010 - 1000.2) * 100, 2);
    expect(s.todayPnl).toBeCloseTo((1010 - 1000.2) * 100, 2);
    expect(s.totalPnl).toBeCloseTo(s.total - WALLET_START, 2);
    // next day: today's change counts from yesterday's close
    const s2 = walletSummary(b.wallet, { [K]: q(1020, T0, 1010) }, '2026-11-17');
    expect(s2.todayPnl).toBeCloseTo(1000, 2);
  });

  it('partial sells keep the rest; sellable quantity accounts for open sell orders', () => {
    const b = placeOrder(newWallet(T0), { key: K, symbol: 'ABC', side: 'buy', qty: 10, type: 'market' }, q(1000), ctx());
    if (!b.ok) throw new Error('buy failed');
    const lim = placeOrder(b.wallet, { key: K, symbol: 'ABC', side: 'sell', qty: 4, type: 'limit', limitPrice: 1100 }, q(1000), ctx());
    if (!lim.ok) throw new Error(lim.error);
    expect(sellableQty(lim.wallet, K)).toBe(6);
    const s = placeOrder(lim.wallet, { key: K, symbol: 'ABC', side: 'sell', qty: 6, type: 'market' }, q(1001), ctx());
    if (!s.ok) throw new Error(s.error);
    expect(s.wallet.holdings[0]!.qty).toBe(4);
  });

  it('sharesFor turns an amount into a number of shares', () => {
    expect(sharesFor(100_000, 1000)).toBe(99);
    expect(sharesFor(100, 0)).toBe(0);
  });

  it('a sale seen by the background checker while the app was closed is applied at that price and time', () => {
    const b = placeOrder(newWallet(T0), { key: K, symbol: 'ABC', side: 'buy', qty: 10, type: 'market', target: 1030 }, q(1000), ctx());
    if (!b.ok) throw new Error('buy failed');
    const later = T0 + 3_600_000;
    const r = sellFromBackground(b.wallet, K, 1031, ctx({ now: later, t: 630 }), 'target');
    expect(r.fill).toMatchObject({ side: 'sell', qty: 10, reason: 'target', at: later });
    expect(r.fill!.price).toBe(1030.75);
    expect(r.wallet.holdings).toHaveLength(0);
    // already sold → nothing happens the second time
    expect(sellFromBackground(r.wallet, K, 1031, ctx(), 'target').fill).toBeNull();
  });
});

describe('practice sell-first (short) trades', () => {
  it('sell first, half bought back at target 1 (rest can no longer lose), rest at target 2; result after charges', async () => {
    const { openShort, processWallet: pw, walletSummary: ws } = await import('../src/wallet/wallet');
    const r = openShort(newWallet(T0), { key: K, symbol: 'ABC', qty: 50, stop: 1010, t1: 990, t2: 980 }, q(1000), ctx());
    if (!r.ok) throw new Error(r.error);
    expect(r.fill).toMatchObject({ side: 'sell', short: true, qty: 50 });
    expect(r.wallet.cash).toBeCloseTo(WALLET_START - r.fill!.price * 50, 2);
    const a = pw(r.wallet, { [K]: q(989.9) }, ctx());
    expect(a.events[0]!.fill).toMatchObject({ side: 'buy', reason: 't1', qty: 25 });
    expect(a.wallet.shorts![0]).toMatchObject({ qty: 25, t1Done: true, stop: r.fill!.price });
    const b = pw(a.wallet, { [K]: q(979) }, ctx());
    expect(b.events[0]!.fill).toMatchObject({ reason: 'target', qty: 25 });
    expect(b.wallet.shorts).toHaveLength(0);
    const s = ws(b.wallet, {}, '2026-11-16');
    expect(s.trades).toBe(2);
    expect(s.totalPnl).toBeGreaterThan(25 * 9 + 25 * 19 - 120);
  });

  it('stop: bought back when the price rises to it; 3:10 pm closes it; needs the market open', async () => {
    const { openShort, processWallet: pw } = await import('../src/wallet/wallet');
    const r = openShort(newWallet(T0), { key: K, symbol: 'ABC', qty: 10, stop: 1010, t1: 990, t2: 980 }, q(1000), ctx());
    if (!r.ok) throw new Error(r.error);
    expect(pw(r.wallet, { [K]: q(1011) }, ctx()).events[0]!.fill).toMatchObject({ reason: 'stop', qty: 10 });
    expect(pw(r.wallet, { [K]: q(1001) }, ctx({ t: 15 * 60 + 10 })).events[0]!.fill.reason).toBe('day-end');
    expect(openShort(newWallet(T0), { key: K, symbol: 'ABC', qty: 10, stop: 1010, t1: 990, t2: 980 }, q(1000), ctx({ open: false })).ok).toBe(false);
    expect(openShort(newWallet(T0), { key: K, symbol: 'ABC', qty: 10, stop: 990, t1: 980, t2: 970 }, q(1000), ctx()).ok).toBe(false);
  });
});
