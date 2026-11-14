import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The background checker (public/runners/background.js) runs in Android's background engine. Here it
 * runs in Node with the same three globals faked: CapacitorKV, CapacitorNotifications, fetch.
 */
const kv = new Map<string, string>();
const shown: Array<{ title: string; body: string }> = [];
const g = globalThis as Record<string, unknown>;
g.CapacitorKV = { get: (k: string) => ({ value: kv.get(k) ?? '' }), set: (k: string, v: string) => kv.set(k, v), remove: (k: string) => kv.delete(k) };
g.CapacitorNotifications = { schedule: (list: Array<{ title: string; body: string }>) => shown.push(...list) };
const handlers: Record<string, (resolve: (v?: unknown) => void, reject: (e: unknown) => void, args: unknown) => unknown> = {};
g.addEventListener = (name: string, fn: (typeof handlers)[string]) => (handlers[name] = fn);
// load the plain script the way the background engine does (not as a module)
const mod: { exports: unknown } = { exports: {} };
new Function('module', readFileSync(new URL('../public/runners/background.js', import.meta.url), 'utf8'))(mod);
const runner = mod.exports as { check: (now: number) => Promise<string>; istParts: (now: number) => { date: string; t: number; weekday: number } };

const at = (hhmm: string) => Date.parse(`2026-11-16T${hhmm}:00+05:30`); // a Monday
const K = 'NSE_EQ|INE002A01018';
let ltp = 1500;
const quotes: Record<string, unknown> = {};

function sync(cfg: Record<string, unknown>) {
  return new Promise((resolve, reject) => handlers.sync!(resolve, reject, cfg));
}
function drain(): Promise<{ hits: Array<{ key: string; price: number; reason: string }> }> {
  return new Promise((resolve, reject) => handlers.drain!(resolve as (v?: unknown) => void, reject, {})) as Promise<{ hits: Array<{ key: string; price: number; reason: string }> }>;
}

beforeEach(async () => {
  kv.clear();
  shown.length = 0;
  ltp = 1500;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = new URL(url);
      if (u.pathname === '/v3/market-quote/ltp') return new Response(JSON.stringify({ status: 'success', data: { 'NSE_EQ:RELIANCE': { instrument_token: K, last_price: ltp } } }));
      if (u.pathname === '/v2/market-quote/quotes') return new Response(JSON.stringify({ status: 'success', data: quotes }));
      return new Response('{}', { status: 404 });
    }),
  );
  await sync({ enabled: true, rising: true, token: 'tok', holidays: [], universe: [K], holdings: [{ key: K, symbol: 'RELIANCE', qty: 10, avgPrice: 1500, stop: 1480, target: 1530, sellByClose: false }], appActiveAt: 0, lastOpenDate: '2026-11-16' });
});

describe('background checker (app closed)', () => {
  it('app v1.9: a breakout above yesterday’s high with heavy volume → one alert with the plan, on the chosen tone’s channel', async () => {
    const calls: Array<{ title: string; body: string; channelId?: string }> = [];
    (g.CapacitorNotifications as { schedule: (l: typeof calls) => void }).schedule = (list) => {
      calls.push(...list);
      shown.push(...list);
    };
    await sync({ rising: false, channel: 'alerts-coins', breakoutRisk: 100, levels: { [K]: { ph: 1500, av: 1_000_000 } } });
    // 11:00 = 105 of 375 minutes: 1.5× usual needs 420,000 shares; this one has 800,000
    quotes['NSE_EQ:RELIANCE'] = { instrument_token: K, symbol: 'RELIANCE', last_price: 1504, volume: 800_000, average_price: 1496, net_change: 14, total_buy_quantity: 70_000, total_sell_quantity: 30_000, ohlc: { open: 1492, high: 1505, low: 1488, close: 1490 } };
    ltp = 1500;
    expect(await runner.check(at('11:00'))).toBe('checked');
    const bo = calls.filter((n) => n.title.startsWith('🚀 Breakout: RELIANCE'));
    expect(bo).toHaveLength(1);
    expect(bo[0]!.title).toContain('above yesterday’s high ₹1,500.00');
    expect(bo[0]!.body).toMatch(/stop-loss ₹1,49\d\.\d\d · target 1 ₹1,5\d\d\.\d\d · target 2/);
    expect(bo[0]!.channelId).toBe('alerts-coins');
    // the same stock is not announced twice the same day
    expect(await runner.check(at('11:30'))).toBe('checked');
    expect(calls.filter((n) => n.title.startsWith('🚀'))).toHaveLength(1);
    delete quotes['NSE_EQ:RELIANCE'];
  });

  it('app v1.9: no breakout alert when the volume is ordinary, the price ran too far, or it is below the day’s average', () => {
    const base = { instrument_token: K, symbol: 'RELIANCE', last_price: 1504, volume: 800_000, average_price: 1496, net_change: 14, total_buy_quantity: 70_000, total_sell_quantity: 30_000, ohlc: { open: 1492, high: 1505, low: 1488, close: 1490 } };
    const levels = { [K]: { ph: 1500, av: 1_000_000 } };
    const find = (q: Record<string, unknown>) => (runner as unknown as { breakouts: (d: unknown, l: unknown, t: number, r: number) => unknown[] }).breakouts({ x: { ...base, ...q } }, levels, 660, 100);
    expect(find({})).toHaveLength(1);
    expect(find({ volume: 300_000 })).toHaveLength(0);
    expect(find({ last_price: 1515, ohlc: { open: 1492, high: 1516, low: 1488, close: 1490 } })).toHaveLength(0); // 1 % above: too late
    expect(find({ average_price: 1506 })).toHaveLength(0);
    expect(find({ total_buy_quantity: 30_000, total_sell_quantity: 70_000 })).toHaveLength(0);
  });

  it('reads IST time correctly', () => {
    expect(runner.istParts(at('10:30'))).toEqual({ date: '2026-11-16', t: 630, weekday: 1 });
  });

  it('take-profit reached → alert now, sale recorded at that price for the app', async () => {
    ltp = 1531;
    expect(await runner.check(at('11:00'))).toBe('checked');
    expect(shown[0]!.title).toContain('RELIANCE reached your take-profit price');
    const { hits } = await drain();
    expect(hits).toEqual([expect.objectContaining({ key: K, price: 1531, reason: 'target' })]);
    expect((await drain()).hits).toEqual([]);
  });

  it('nothing to do when the price is in between; stays quiet while the app itself runs', async () => {
    expect(await runner.check(at('11:00'))).toBe('checked');
    expect(shown).toHaveLength(0);
    await sync({ appActiveAt: at('10:58') });
    ltp = 1470;
    expect(await runner.check(at('11:00'))).toBe('app running');
    expect(shown).toHaveLength(0);
  });

  it('weekends, holidays and night: nothing; morning reminder once if the app was not opened', async () => {
    expect(await runner.check(Date.parse('2026-11-15T11:00:00+05:30'))).toBe('market closed');
    await sync({ holidays: ['2026-11-16'] });
    expect(await runner.check(at('11:00'))).toBe('market closed');
    await sync({ holidays: [], lastOpenDate: '2026-11-13' });
    expect(await runner.check(at('09:10'))).toBe('outside market hours');
    expect(await runner.check(at('09:12'))).toBe('outside market hours');
    expect(shown.filter((n) => n.title.includes('Market opens'))).toHaveLength(1);
  });

  it('rising fast: strong buyers above the average price → one alert per stock, max 3 a day', async () => {
    quotes['NSE_EQ:TRENT'] = { instrument_token: 'NSE_EQ|INE849A01020', symbol: 'TRENT', last_price: 4300, net_change: 60, average_price: 4270, ohlc: { open: 4245 }, total_buy_quantity: 70000, total_sell_quantity: 30000 };
    quotes['NSE_EQ:SBIN'] = { instrument_token: 'NSE_EQ|INE062A01020', symbol: 'SBIN', last_price: 1000, net_change: -5, average_price: 1004, ohlc: { open: 1003 }, total_buy_quantity: 20000, total_sell_quantity: 80000 };
    await sync({ holdings: [] });
    await runner.check(at('10:00'));
    await runner.check(at('10:15'));
    const rise = shown.filter((n) => n.title.includes('Rising fast'));
    expect(rise).toHaveLength(1);
    expect(rise[0]!.title).toContain('TRENT');
    expect(rise[0]!.body).toContain('check it in TradeBuddy first');
  });

  it('switched off → does nothing', async () => {
    await sync({ enabled: false });
    ltp = 1531;
    expect(await runner.check(at('11:00'))).toBe('not set up');
    expect(shown).toHaveLength(0);
  });
});
