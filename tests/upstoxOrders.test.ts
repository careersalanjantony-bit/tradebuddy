import { describe, expect, it } from 'vitest';
import { intradayCharges } from '../src/daytrade/rules';
import {
  AUTO_SQUARE_OFF_T,
  convertPosition,
  deliveryCharges,
  estimateCharges,
  mtfCharges,
  mtfDailyInterest,
  newWallet,
  placeOrder,
  processWallet,
  productTerms,
  reservedCash,
  SQUARE_OFF_CHARGE,
  walletSummary,
  WALLET_START,
  type MarketCtx,
  type OrderRequest,
  type WalletQuote,
  type WalletState,
} from '../src/wallet/wallet';
import { tierOf } from '../src/wallet/tiers';

const T0 = Date.parse('2026-11-16T05:00:00Z'); // Monday 10:30 IST
const ctx = (over: Partial<MarketCtx> = {}): MarketCtx => ({ now: T0, today: '2026-11-16', t: 630, open: true, ...over });
const q = (ltp: number, at = T0): WalletQuote => ({ ltp, prevClose: null, fetchedAt: at });
const K = 'NSE_EQ|INE002A01018';
const buy = (over: Partial<OrderRequest> = {}): OrderRequest => ({ key: K, symbol: 'RELIANCE', side: 'buy', qty: 100, type: 'market', ...over });
const ok = (r: ReturnType<typeof placeOrder>): Extract<ReturnType<typeof placeOrder>, { ok: true }> => {
  if (!r.ok) throw new Error(r.error);
  return r;
};

describe('products and leverage (like the Upstox order window)', () => {
  it('Delivery 1×; Intraday up to 5× (big companies), 4× (Nifty 500), 2× (others); MTF up to 4× / 2.5×, not for small stocks', () => {
    expect(productTerms('delivery', 'other')).toMatchObject({ marginPct: 1, leverage: 1, available: true });
    expect(productTerms('intraday', 'nifty100')).toMatchObject({ marginPct: 0.2, leverage: 5 });
    expect(productTerms('intraday', 'nifty500')).toMatchObject({ marginPct: 0.25, leverage: 4 });
    expect(productTerms('intraday', 'other')).toMatchObject({ marginPct: 0.5, leverage: 2 });
    expect(productTerms('mtf', 'nifty100')).toMatchObject({ marginPct: 0.25, leverage: 4, available: true });
    expect(productTerms('mtf', 'nifty500')).toMatchObject({ marginPct: 0.4, leverage: 2.5 });
    expect(productTerms('mtf', 'other').available).toBe(false);
    expect(tierOf(K)).toBe('nifty100'); // Reliance
    expect(tierOf('NSE_EQ|INF000000000')).toBe('other');
  });

  it('Intraday buy pays only the margin; the balance after it is recorded; the summary shows margin, exposure and value', () => {
    const r = ok(placeOrder(newWallet(T0), buy({ product: 'intraday', marginPct: 0.2 }), q(1500), ctx()));
    const cost = r.fill!.price * 100;
    expect(r.wallet.cash).toBeCloseTo(WALLET_START - cost * 0.2, 2);
    expect(r.fill!.cashAfter).toBe(r.wallet.cash);
    expect(r.wallet.holdings[0]).toMatchObject({ product: 'intraday', marginPct: 0.2, qty: 100 });
    const s = walletSummary(r.wallet, { [K]: q(1510) }, '2026-11-16');
    expect(s.used).toBeCloseTo(cost * 0.2, 1);
    expect(s.exposure).toBeCloseTo(151_000, 1);
    expect(s.holdings[0]!.leverage).toBe(5);
    expect(s.total).toBeCloseTo(WALLET_START + (1510 - r.fill!.price) * 100, 1);
  });

  it('closing an Intraday trade returns the margin with the gain, after intraday charges', () => {
    const b = ok(placeOrder(newWallet(T0), buy({ product: 'intraday', marginPct: 0.2 }), q(1500), ctx()));
    const s = ok(placeOrder(b.wallet, buy({ side: 'sell', product: 'intraday', marginPct: 0.2 }), q(1520), ctx({ t: 700 })));
    const bp = b.fill!.price * 100;
    const sp = s.fill!.price * 100;
    expect(s.fill!.charges).toBeCloseTo(intradayCharges(bp, sp), 1);
    expect(s.fill!.pnl).toBeCloseTo(sp - bp - intradayCharges(bp, sp), 1);
    expect(s.wallet.cash).toBeCloseTo(WALLET_START + s.fill!.pnl!, 1);
    expect(s.wallet.holdings).toHaveLength(0);
  });

  it('Upstox squares off an open Intraday trade at 3:20 pm and charges ₹59; "close by itself at 3:10" avoids it', () => {
    const b = ok(placeOrder(newWallet(T0), buy({ product: 'intraday', marginPct: 0.2 }), q(1500), ctx()));
    expect(processWallet(b.wallet, { [K]: q(1505) }, ctx({ t: 15 * 60 + 12 })).events).toHaveLength(0);
    const sq = processWallet(b.wallet, { [K]: q(1505) }, ctx({ t: AUTO_SQUARE_OFF_T }));
    expect(sq.events[0]!.fill).toMatchObject({ reason: 'square-off', qty: 100 });
    expect(sq.events[0]!.fill.charges!).toBeGreaterThan(SQUARE_OFF_CHARGE);
    expect(sq.events[0]!.why).toMatch(/3:20 pm/);
    const planned = ok(placeOrder(newWallet(T0), buy({ product: 'intraday', marginPct: 0.2, sellByClose: true }), q(1500), ctx()));
    const out = processWallet(planned.wallet, { [K]: q(1505) }, ctx({ t: 15 * 60 + 10 }));
    expect(out.events[0]!.fill.reason).toBe('day-end');
    // same prices, so the only difference is Upstox's ₹59
    expect(sq.events[0]!.fill.charges! - out.events[0]!.fill.charges!).toBeCloseTo(SQUARE_OFF_CHARGE, 2);
  });

  it('an Intraday trade still open when the app comes back after the close is squared off at its last price', () => {
    const b = ok(placeOrder(newWallet(T0), buy({ product: 'intraday', marginPct: 0.2 }), q(1500), ctx()));
    const later = processWallet(b.wallet, { [K]: q(1490, T0 + 6 * 3600_000) }, ctx({ open: false, t: 16 * 60 + 30, now: T0 + 6 * 3600_000 }));
    expect(later.events[0]!.fill).toMatchObject({ reason: 'square-off' });
    expect(later.wallet.holdings).toHaveLength(0);
  });

  it('no new Intraday trades after 3:15 pm (closing one is still allowed)', () => {
    expect(placeOrder(newWallet(T0), buy({ product: 'intraday', marginPct: 0.2 }), q(1500), ctx({ t: 15 * 60 + 16 })).ok).toBe(false);
    const b = ok(placeOrder(newWallet(T0), buy({ product: 'intraday', marginPct: 0.2 }), q(1500), ctx()));
    expect(placeOrder(b.wallet, buy({ side: 'sell', product: 'intraday' }), q(1500), ctx({ t: 15 * 60 + 16 })).ok).toBe(true);
  });

  it('a big Intraday loss that eats 80% of the margin closes the trade (margin shortfall)', () => {
    const b = ok(placeOrder(newWallet(T0), buy({ product: 'intraday', marginPct: 0.2 }), q(1500), ctx()));
    const r = processWallet(b.wallet, { [K]: q(1255) }, ctx());
    expect(r.events[0]!.fill.reason).toBe('margin');
  });
});

describe('sell first and buy back (Intraday short)', () => {
  it('an Intraday sell of a stock not held sells first with a margin; an Intraday buy buys it back', () => {
    const s = ok(placeOrder(newWallet(T0), buy({ side: 'sell', product: 'intraday', marginPct: 0.2, qty: 50 }), q(1500), ctx()));
    expect(s.fill).toMatchObject({ side: 'sell', short: true, product: 'intraday' });
    expect(s.wallet.shorts![0]).toMatchObject({ qty: 50, marginPct: 0.2, stop: null, t1: null, t2: null });
    expect(s.wallet.cash).toBeCloseTo(WALLET_START - s.fill!.price * 50 * 0.2, 2);
    expect(placeOrder(s.wallet, buy({ qty: 60, product: 'intraday' }), q(1490), ctx()).ok).toBe(false); // more than sold
    const c = ok(placeOrder(s.wallet, buy({ qty: 50, product: 'intraday' }), q(1490), ctx()));
    expect(c.fill).toMatchObject({ side: 'buy', short: true });
    expect(c.wallet.shorts).toHaveLength(0);
    expect(c.wallet.cash).toBeCloseTo(WALLET_START + c.fill!.pnl!, 1);
    expect(c.fill!.pnl!).toBeGreaterThan(0);
  });

  it('Delivery cannot sell what you do not hold — it points to Intraday', () => {
    const r = placeOrder(newWallet(T0), buy({ side: 'sell', qty: 1 }), q(1500), ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/choose Intraday/);
  });
});

describe('MTF (margin trading): margin, loan, daily interest, pledge charges', () => {
  it('pays 25%, Upstox lends the rest; interest every calendar day at ₹20 per ₹40,000; pledge + unpledge when sold', () => {
    expect(mtfDailyInterest(70_000)).toBe(40);
    expect(mtfDailyInterest(40_000)).toBe(20);
    expect(mtfDailyInterest(0)).toBe(0);
    const fri = ctx({ today: '2026-11-13', now: T0 - 3 * 86_400_000 });
    const b = ok(placeOrder(newWallet(T0), buy({ product: 'mtf', marginPct: 0.25 }), q(1500, fri.now), fri));
    const cost = b.fill!.price * 100;
    expect(b.wallet.cash).toBeCloseTo(WALLET_START - cost * 0.25, 2);
    expect(b.wallet.holdings[0]).toMatchObject({ product: 'mtf', interest: 0, interestDate: '2026-11-13' });
    const funded = cost * 0.75;
    // Friday → Monday: 3 days of interest
    const mon = processWallet(b.wallet, { [K]: q(1520) }, ctx());
    expect(mon.wallet.holdings[0]!.interest).toBe(3 * mtfDailyInterest(funded));
    expect(mon.wallet.cash).toBeCloseTo(b.wallet.cash - 3 * mtfDailyInterest(funded), 2);
    const s = ok(placeOrder(mon.wallet, buy({ side: 'sell', product: 'mtf' }), q(1520), ctx()));
    const sp = s.fill!.price * 100;
    expect(s.fill!.charges).toBeCloseTo(mtfCharges(cost, sp), 1);
    expect(s.fill!.interest).toBe(3 * mtfDailyInterest(funded));
    expect(s.fill!.pnl).toBeCloseTo(sp - cost - mtfCharges(cost, sp) - 3 * mtfDailyInterest(funded), 1);
    expect(s.wallet.cash).toBeCloseTo(WALLET_START + s.fill!.pnl!, 1);
  });

  it('a big fall forces a sale (margin shortfall); MTF is refused for stocks Upstox does not lend on', () => {
    const b = ok(placeOrder(newWallet(T0), buy({ product: 'mtf', marginPct: 0.25 }), q(1500), ctx()));
    const s = walletSummary(b.wallet, { [K]: q(1350) }, '2026-11-16');
    expect(s.holdings[0]!.shortfall).toBeGreaterThan(0);
    expect(processWallet(b.wallet, { [K]: q(1350) }, ctx()).events).toHaveLength(0);
    expect(processWallet(b.wallet, { [K]: q(1250) }, ctx()).events[0]!.fill.reason).toBe('margin');
    const no = placeOrder(newWallet(T0), buy({ product: 'mtf', marginPct: 1 }), q(1500), ctx());
    expect(no.ok).toBe(false);
  });
});

describe('order types: Limit, SL, SL-M, IOC, after-market orders', () => {
  it('a limit buy never pays more than the limit, even with slippage', () => {
    const r = ok(placeOrder(newWallet(T0), buy({ type: 'limit', limitPrice: 1500 }), q(1499.95), ctx()));
    expect(r.fill!.price).toBeLessThanOrEqual(1500);
  });

  it('SL buy: waits for the price to RISE to the trigger, then buys at the limit or lower', () => {
    expect(placeOrder(newWallet(T0), buy({ type: 'sl', trigger: 1490, limitPrice: 1495 }), q(1500), ctx()).ok).toBe(false); // trigger below price
    expect(placeOrder(newWallet(T0), buy({ type: 'sl', trigger: 1510, limitPrice: 1505 }), q(1500), ctx()).ok).toBe(false); // limit below trigger
    const r = ok(placeOrder(newWallet(T0), buy({ type: 'sl', trigger: 1510, limitPrice: 1512 }), q(1500), ctx()));
    expect(r.order.status).toBe('open');
    expect(processWallet(r.wallet, { [K]: q(1505) }, ctx()).events).toHaveLength(0);
    const jumped = processWallet(r.wallet, { [K]: q(1515) }, ctx()); // triggered but above the limit: waits
    expect(jumped.events).toHaveLength(0);
    expect(jumped.wallet.orders[0]).toMatchObject({ status: 'open', triggered: true });
    const fill = processWallet(jumped.wallet, { [K]: q(1511) }, ctx());
    expect(fill.events[0]!.fill.price).toBeLessThanOrEqual(1512);
  });

  it('SL-M sell (a stop-loss for shares you hold): at the trigger it sells at the market price', () => {
    const b = ok(placeOrder(newWallet(T0), buy(), q(1500), ctx()));
    expect(placeOrder(b.wallet, buy({ side: 'sell', type: 'slm', trigger: 1510 }), q(1500), ctx()).ok).toBe(false); // above the price
    const sl = ok(placeOrder(b.wallet, buy({ side: 'sell', type: 'slm', trigger: 1480 }), q(1500), ctx()));
    expect(processWallet(sl.wallet, { [K]: q(1485) }, ctx()).events).toHaveLength(0);
    const hit = processWallet(sl.wallet, { [K]: q(1478) }, ctx());
    expect(hit.events[0]!.fill).toMatchObject({ side: 'sell', qty: 100 });
    expect(hit.events[0]!.why).toMatch(/stop-loss trigger/);
  });

  it('IOC: fills at once or is cancelled at once', () => {
    const miss = ok(placeOrder(newWallet(T0), buy({ type: 'limit', limitPrice: 1490, validity: 'ioc' }), q(1500), ctx()));
    expect(miss.order.status).toBe('cancelled');
    expect(miss.wallet.cash).toBe(WALLET_START);
    const hit = ok(placeOrder(newWallet(T0), buy({ type: 'limit', limitPrice: 1505, validity: 'ioc' }), q(1500), ctx()));
    expect(hit.order.status).toBe('filled');
  });

  it('an after-market limit order (placed on Sunday) works on Monday and expires after Monday’s close', () => {
    const sun = ctx({ today: '2026-11-15', open: false, t: 12 * 60, now: T0 - 86_400_000 });
    const r = ok(placeOrder(newWallet(T0), buy({ type: 'limit', limitPrice: 1480 }), q(1500, sun.now), sun));
    expect(r.order).toMatchObject({ status: 'open', amo: true });
    const sunLater = processWallet(r.wallet, {}, ctx({ today: '2026-11-15', open: false, t: 20 * 60 }));
    expect(sunLater.wallet.orders[0]!.status).toBe('open');
    const mon = processWallet(sunLater.wallet, { [K]: q(1495) }, ctx({ t: 556 }));
    expect(mon.wallet.orders[0]).toMatchObject({ status: 'open', date: '2026-11-16' });
    expect(mon.wallet.orders[0]!.amo).toBe(false);
    const after = processWallet(mon.wallet, { [K]: q(1495) }, ctx({ open: false, t: 16 * 60 }));
    expect(after.wallet.orders[0]!.status).toBe('cancelled');
  });

  it('cash set aside for an open Intraday limit buy is only its margin', () => {
    const r = ok(placeOrder(newWallet(T0), buy({ type: 'limit', limitPrice: 1450, product: 'intraday', marginPct: 0.2 }), q(1500), ctx()));
    expect(reservedCash(r.wallet, {})).toBeCloseTo(1450 * 100 * 0.2, 2);
  });
});

describe('Convert (like Upstox), balances and charges', () => {
  it('Intraday → Delivery pays the rest now and keeps it overnight; Delivery bought today → Intraday frees money', () => {
    const b = ok(placeOrder(newWallet(T0), buy({ product: 'intraday', marginPct: 0.2 }), q(1500), ctx()));
    const cost = b.fill!.price * 100;
    const c = convertPosition(b.wallet, K, 'intraday', 'delivery', ctx());
    if (!c.ok) throw new Error(c.error);
    expect(c.wallet.cash).toBeCloseTo(WALLET_START - cost, 1);
    expect(c.wallet.holdings[0]!.product).toBeUndefined(); // Delivery
    expect(processWallet(c.wallet, { [K]: q(1500) }, ctx({ t: AUTO_SQUARE_OFF_T })).events).toHaveLength(0);
    const back = convertPosition(c.wallet, K, 'delivery', 'intraday', ctx(), 0.2);
    if (!back.ok) throw new Error(back.error);
    expect(back.wallet.cash).toBeCloseTo(WALLET_START - cost * 0.2, 1);
    expect(back.wallet.holdings[0]).toMatchObject({ product: 'intraday', sellByClose: true });
    const poor: WalletState = { ...b.wallet, cash: b.wallet.cash - 900_000 };
    expect(convertPosition(poor, K, 'intraday', 'delivery', ctx()).ok).toBe(false);
  });

  it('every trade records the balance after it; Delivery holdings are kept apart from Intraday ones', () => {
    let w = newWallet(T0);
    const a = ok(placeOrder(w, buy({ qty: 10 }), q(1500), ctx()));
    w = a.wallet;
    const b = ok(placeOrder(w, buy({ qty: 10, product: 'intraday', marginPct: 0.2 }), q(1500), ctx()));
    w = b.wallet;
    expect(w.holdings.map((h) => h.product ?? 'delivery').sort()).toEqual(['delivery', 'intraday']);
    expect(a.fill!.cashAfter).toBeCloseTo(WALLET_START - a.fill!.price * 10, 2);
    expect(b.fill!.cashAfter).toBeCloseTo(a.fill!.cashAfter! - b.fill!.price * 10 * 0.2, 2);
    const wrong = placeOrder(w, buy({ side: 'sell', qty: 20 }), q(1500), ctx());
    expect(wrong.ok).toBe(false);
  });

  it('estimated charges by product: Intraday < Delivery; MTF adds pledging', () => {
    const d = estimateCharges('delivery', 100, 1500);
    const i = estimateCharges('intraday', 100, 1500);
    const m = estimateCharges('mtf', 100, 1500);
    expect(i).toBeLessThan(d);
    expect(m - d).toBeCloseTo(47.2, 1);
    expect(d).toBeCloseTo(deliveryCharges(150_000, 150_000), 1);
  });
});

describe('your case: an MTF order placed on Sunday for 50 POWERINDIA', () => {
  const PI = 'NSE_EQ|INE07Y701011';
  const sunday = ctx({ today: '2026-11-15', open: false, t: 13 * 60 + 31, now: T0 - 86_400_000 + 3 * 3600_000 });
  const order: OrderRequest = { key: PI, symbol: 'POWERINDIA', side: 'buy', qty: 50, type: 'market', product: 'mtf', marginPct: 0.25 };

  it('waits for Monday’s opening price; the money set aside (25% margin + 1%) counts as used margin, like Upstox', () => {
    const r = ok(placeOrder(newWallet(sunday.now), order, q(31_595, sunday.now), sunday));
    expect(r.order).toMatchObject({ status: 'open', atOpen: true, product: 'mtf', refPrice: 31_595 });
    expect(r.wallet.cash).toBe(WALLET_START);
    const s = walletSummary(r.wallet, { [PI]: q(31_595, sunday.now) }, '2026-11-15');
    expect(s.free).toBeCloseTo(WALLET_START - 31_595 * 1.01 * 50 * 0.25, 0); // ₹6,01,113 as on your screen
    expect(s.blocked).toBeCloseTo(398_887, 0);
    expect(s.used).toBeCloseTo(398_887, 0);
    expect(s.value).toBe(0); // nothing bought yet
    expect(s.total).toBe(WALLET_START);
    // after an app restart, before any price has loaded, the money stays set aside (price when placed)
    expect(walletSummary(r.wallet, {}, '2026-11-15').free).toBeCloseTo(s.free, 0);
  });

  it('buys at Monday’s open: margin used, position shown, interest from Tuesday, sale with charges and interest', () => {
    const r = ok(placeOrder(newWallet(sunday.now), order, q(31_595, sunday.now), sunday));
    const mon = processWallet(r.wallet, { [PI]: q(31_800) }, ctx({ t: 555 }));
    expect(mon.events[0]!.fill).toMatchObject({ side: 'buy', qty: 50, product: 'mtf' });
    const price = mon.events[0]!.fill.price;
    const cost = price * 50;
    expect(mon.wallet.cash).toBeCloseTo(WALLET_START - cost * 0.25, 1);
    expect(mon.events[0]!.fill.cashAfter).toBe(mon.wallet.cash);
    const s = walletSummary(mon.wallet, { [PI]: q(31_800) }, '2026-11-16');
    expect(s.blocked).toBe(0);
    expect(s.used).toBeCloseTo(cost * 0.25, 1);
    expect(s.value).toBeCloseTo(cost * 0.25 + (31_800 - price) * 50, 1);
    expect(s.holdings[0]!.funded).toBeCloseTo(cost * 0.75, 1);
    const perDay = mtfDailyInterest(cost * 0.75);
    expect(perDay).toBe(Math.ceil((cost * 0.75) / 40_000) * 20); // ₹600 a day on a ₹11.9 lakh loan
    const tue = processWallet(mon.wallet, { [PI]: q(32_000) }, ctx({ today: '2026-11-17', now: T0 + 86_400_000 }));
    expect(tue.wallet.cash).toBeCloseTo(mon.wallet.cash - perDay, 1);
    const wedCtx = ctx({ today: '2026-11-18', now: T0 + 2 * 86_400_000 });
    const sell = ok(placeOrder(tue.wallet, { ...order, side: 'sell' }, q(32_500, wedCtx.now), wedCtx));
    expect(sell.fill!.interest).toBe(2 * perDay);
    expect(sell.fill!.pnl).toBeCloseTo(sell.fill!.price * 50 - cost - sell.fill!.charges! - 2 * perDay, 1);
    expect(sell.wallet.cash).toBeCloseTo(WALLET_START + sell.fill!.pnl!, 1);
    expect(walletSummary(sell.wallet, {}, '2026-11-18').used).toBe(0);
    // "Today" on Tuesday counts the interest taken that day; a sale the same day does not count it twice
    const tueSum = walletSummary(tue.wallet, { [PI]: { ...q(32_000), prevClose: 32_000 } }, '2026-11-17');
    expect(tueSum.todayPnl).toBeCloseTo(-perDay, 1);
    expect(walletSummary(sell.wallet, {}, '2026-11-18').todayPnl).toBeCloseTo(sell.fill!.pnl!, 1);
  });
});
