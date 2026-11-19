import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlertDetail } from '../src/alerts/history';
import { priceKeys, watchKey } from '../src/background/scanList';
import { pollOne } from '../src/data/quotes';
import { headlineOf, headOf, linesOf } from '../src/ui/alertCard';
import { PRICE_FRESH_MS, priceView } from '../src/ui/priceView';
import { installChromeMock } from './chromeMock';

/**
 * App v1.20 — the redesigned alert card (what it says, line by line) and the order window's live price:
 * a stock opened from the Intraday list (not followed by the app) gets its own price, is kept live while
 * on screen, and a stale or missing price is never shown as if it were live.
 */

const buyDetail: AlertDetail = { symbol: 'CHOICEIN', key: 'NSE_EQ|INE0CHOICE1', side: 'buy', source: 'Breakout (live, not confirmed)', entry: 719.25, stop: 714.7, targets: [728.35, 733], qty: 15, risk: 98, score: 85, scoreKind: 'score', reasons: [] };
const sellDetail: AlertDetail = { ...buyDetail, symbol: 'SHORTCO', side: 'sell', source: 'Intraday scanner', entry: 500, stop: 505, targets: [490, 485], qty: 20, risk: 100, score: 88, event: 'new' };

describe('alert card', () => {
  it('a BUY card: headline, then entry, stop-loss, targets, quantity and maximum risk on separate lines', () => {
    expect(headOf({ id: 'alert:bo-x', title: 'CHOICEIN: breaking out' }, buyDetail)).toEqual({ kicker: 'NEW BUY OPPORTUNITY', tone: 'buy' });
    expect(linesOf(buyDetail)).toEqual([
      ['Entry', '₹719.25'],
      ['Stop-loss', '₹714.70'],
      ['Targets', '₹728.35 / ₹733.00'],
      ['Quantity', '15 shares'],
      ['Maximum risk', '₹98 incl. est. charges'],
    ]);
  });

  it('a SELL card says short-sell and labels the buy-back stop', () => {
    expect(headOf({ id: 'alert:intraday-short-x', title: '🔻 Intraday SELL SHORTCO' }, sellDetail)).toEqual({ kicker: 'NEW SHORT-SELL OPPORTUNITY', tone: 'sell' });
    expect(linesOf(sellDetail).slice(0, 3)).toEqual([
      ['Sell first at', '₹500.00'],
      ['Stop-loss (buy back above)', '₹505.00'],
      ['Targets', '₹490.00 / ₹485.00'],
    ]);
  });

  it('the alert’s own words are kept, without repeating the symbol, price and score', () => {
    expect(headlineOf('CHOICEIN: breaking out (live, not confirmed) · score 60', buyDetail)).toBe('breaking out (live, not confirmed)');
    expect(headlineOf('Intraday SELL SHORTCO at ₹500.00 · score 88', sellDetail)).toBe('Intraday SELL');
    expect(headlineOf('Rising now: CHOICEIN', buyDetail)).toBe('Rising now');
    expect(headlineOf('CHOICEIN likely to keep rising · 72% chance', buyDetail)).toBe('likely to keep rising');
    expect(headlineOf('Log in to Upstox', null)).toBe('Log in to Upstox');
  });

  it('follow-ups and plain alerts get their own headline', () => {
    const a = { id: 'alert:intraday-tgt-x', title: '🎯 x' };
    expect(headOf(a, { ...sellDetail, event: 't1' }).kicker).toBe('TARGET 1 REACHED');
    expect(headOf(a, { ...buyDetail, event: 'target' })).toEqual({ kicker: 'TARGET REACHED', tone: 'ok' });
    expect(headOf(a, { ...buyDetail, event: 'stop' })).toEqual({ kicker: 'STOP-LOSS HIT', tone: 'warn' });
    expect(headOf(a, { ...buyDetail, event: 'invalid' })).toEqual({ kicker: 'SIGNAL INVALIDATED', tone: 'warn' });
    expect(headOf({ id: 'login-reminder', title: 'Log in to Upstox' }, null).kicker).toBe('UPSTOX');
    expect(headOf({ id: 'alert:wallet-sold-1', title: 'Sold' }, null).kicker).toBe('PRACTICE MONEY');
    expect(headOf({ id: 'x', title: 'y' }, { ...buyDetail, source: 'Auto-trader · Swing' }).kicker).toBe('AUTO-TRADER · BOUGHT');
  });
});

describe('order window price', () => {
  const now = Date.parse('2026-11-19T05:00:00Z');
  it('shows a live price only when it is fresh; closed market = last traded price', () => {
    expect(priceView({ ltp: 512.4, fetchedAt: now - 5_000 }, true, now, false, null)).toEqual({ ltp: 512.4, state: 'live', text: '₹512.40' });
    expect(priceView({ ltp: 512.4, fetchedAt: now - PRICE_FRESH_MS - 1 }, true, now, true, null)).toMatchObject({ ltp: null, state: 'loading', text: 'updating price…' });
    expect(priceView({ ltp: 512.4, fetchedAt: now - 3 * 3600_000 }, false, now, false, null)).toMatchObject({ ltp: 512.4, state: 'closed' });
    expect(priceView(undefined, true, now, true, null)).toMatchObject({ ltp: null, state: 'loading', text: 'price loading…' });
    expect(priceView(undefined, true, now, false, 'Upstox did not answer within 12 seconds.')).toMatchObject({ ltp: null, state: 'error' });
    expect(priceView({ ltp: 512.4, fetchedAt: now - 120_000 }, true, now, false, 'timeout')).toMatchObject({ ltp: null, state: 'error' }); // never the stale number
  });
});

describe('a stock on screen gets its own live price', () => {
  let chrome: ReturnType<typeof installChromeMock>;
  const calls: string[] = [];
  const RPG = 'NSE_EQ|INE105A01035';
  beforeEach(async () => {
    chrome = installChromeMock();
    await chrome.storage.local.set({ secrets: { upstoxAnalyticsToken: 'test-token' } });
    calls.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = decodeURIComponent(String(url));
        calls.push(u);
        const ok = (data: unknown) => new Response(JSON.stringify({ status: 'success', data }), { status: 200 });
        if (u.includes('/v3/market-quote/ltp')) return ok({ 'NSE_EQ:RPGLIFE': { instrument_token: RPG, last_price: 2_150.5, volume: 12_000, cp: 2_120 } });
        if (u.includes('/v3/market-quote/ohlc')) return ok({ 'NSE_EQ:RPGLIFE': { instrument_token: RPG, last_price: 2_150.5, live_ohlc: { open: 2_125, high: 2_160, low: 2_118, volume: 12_000 } } });
        return new Response('{}', { status: 404 });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('fetches the one stock, stores its price, and keeps it in the price list while on screen', async () => {
    const now = Date.now();
    expect(await priceKeys(now)).not.toContain(RPG); // not followed by the app
    const q = await pollOne(RPG, now);
    expect(q).toMatchObject({ key: RPG, ltp: 2_150.5, prevClose: 2_120, open: 2_125 });
    expect(((await chrome.storage.session.get('quotes')).quotes as Record<string, { ltp: number }>)[RPG]!.ltp).toBe(2_150.5);
    expect(calls.every((u) => u.includes(`instrument_key=${RPG}`))).toBe(true); // exactly this stock (symbol mapping by instrument key)
    await watchKey(RPG, now);
    expect(await priceKeys(now + 60_000)).toContain(RPG); // polled and in the live feed while open
    expect(await priceKeys(now + 11 * 60_000)).not.toContain(RPG); // forgotten 10 minutes after the last look
    expect(calls.filter((u) => /\/order|\/gtt/i.test(u))).toEqual([]);
  });

  it('no price from Upstox: null, nothing invented', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'success', data: {} }), { status: 200 })));
    expect(await pollOne(RPG)).toBeNull();
    expect((await chrome.storage.session.get('quotes')).quotes).toBeUndefined();
  });
});
