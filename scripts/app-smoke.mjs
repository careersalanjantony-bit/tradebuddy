#!/usr/bin/env node
/**
 * App smoke test: runs the built app (dist/) in a phone-sized Chromium with a simulated live market.
 * Every Upstox / NSE request is answered by a fake inside this script (page.route), so nothing
 * reaches the internet and no real account is needed. The page clock is set to a Monday at 10:30 IST.
 *
 *   npm run build && node scripts/app-smoke.mjs
 */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const out = join(root, 'smoke-output');
mkdirSync(out, { recursive: true });

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// ---------- static server for dist/
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.map': 'application/json', '.json': 'application/json', '.ogg': 'audio/ogg' };
const server = createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = join(dist, p === '/' ? 'index.html' : p);
  if (!f.startsWith(dist) || !existsSync(f)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': TYPES[extname(f)] ?? 'application/octet-stream' }).end(readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

// ---------- fake market
const rows = JSON.parse(readFileSync(join(root, 'tests/fixtures/instruments-sample.json'), 'utf8')).rows;
const eq = rows.filter((r) => r.instrument_type === 'EQ');
// the app refuses a list with fewer than 1,000 companies (a broken download): pad the sample with filler companies
const allRows = [...rows, ...Array.from({ length: 1100 }, (_, i) => ({ ...eq[0], name: `FILLER ${i}`, trading_symbol: `FILL${i}`, isin: `INF${String(i).padStart(9, '0')}`, instrument_key: `NSE_EQ|INF${String(i).padStart(9, '0')}`, exchange_token: String(90000 + i) }))];
const symOf = Object.fromEntries(eq.map((r) => [r.instrument_key, r.trading_symbol]));
const BASE = { ICICIBANK: 1400, HDFCBANK: 800, SBIN: 1050, AXISBANK: 1300, BAJFINANCE: 1000, BSE: 3500, EICHERMOT: 7500, SUNPHARMA: 1850, ETERNAL: 290, TRENT: 4200, RELIANCE: 1500 };
const mock = { calls: [], move: 0 };
/** the page's clock: Monday 16 Nov 2026, 10:30 IST (market open) */
const PAGE_START = Date.parse('2026-11-16T05:00:00Z');
const FALL = 'SUNPHARMA';
const fallKey = () => eq.find((r) => r.trading_symbol === FALL).instrument_key;
/** SUNPHARMA's falling morning: down 0.30%, up 0.15% in turns, heavier volume on the falling candles */
function fallCandles() {
  const b = BASE[FALL];
  const out = [];
  let c = b * 1.002;
  for (let i = 0; i < 15; i++) {
    const o = c;
    c = i === 0 ? o : o * (i % 2 ? 1.0015 : 0.997);
    const hh = String(9 + Math.floor((15 + i * 5) / 60)).padStart(2, '0');
    const mm = String((15 + i * 5) % 60).padStart(2, '0');
    out.push([`2026-11-16T${hh}:${mm}:00+05:30`, o, Math.max(o, c) * 1.0005, Math.min(o, c) * 0.9995, c, i % 2 || i === 0 ? 10000 : 30000, 0]);
  }
  mock.fallLast = c;
  return out.reverse();
}
/**
 * App v1.9 breakout stock: a Nifty 50 company with no other role in this test (Adani Enterprises, in
 * the app's built-in Nifty 50 list). Its morning climbs slowly with pullbacks under a high of ₹200.45;
 * the test then lifts the price above it with a burst of volume, and the live engine must alert at once.
 */
const BREAK = 'NSE_EQ|INE423A01024';
const BREAK_SYM = 'ADANIENT';
allRows.push({ ...eq[0], name: 'Adani Enterprises Ltd.', trading_symbol: BREAK_SYM, isin: 'INE423A01024', instrument_key: BREAK, exchange_token: '99999' });
/** app v1.20: a company the app does not follow (in no list, not held) — opened in the order window from the Intraday list */
const LONE = 'NSE_EQ|INE0RPGTEST1';
allRows.push({ ...eq[0], name: 'RPG Test Sciences', trading_symbol: 'RPGTEST', isin: 'INE0RPGTEST1', instrument_key: LONE, exchange_token: '99998' });
mock.breakPrice = 200.3;
mock.breakVol = 1_000_000;
const BREAK_CLOSES = [199.0, 199.4, 199.1, 199.6, 199.3, 199.8, 199.5, 200.0, 199.7, 200.2, 199.9, 200.3, 200.0, 200.3, 200.1];
function breakCandles() {
  const out = BREAK_CLOSES.map((c, i) => {
    const o = i === 0 ? 198.8 : BREAK_CLOSES[i - 1];
    const m = 15 + i * 5;
    const hh = String(9 + Math.floor(m / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    return [`2026-11-16T${hh}:${mm}:00+05:30`, o, Math.max(o, c) + 0.15, Math.min(o, c) - 0.15, c, i === 0 ? 80_000 : 40_000, 0];
  });
  return out.reverse();
}
/** app v1.15: ten earlier market days of the breakout stock, 10,000 shares per 5 minutes (inside the asked range) */
function breakHistory(pathname) {
  const m = /minutes\/5\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})/.exec(decodeURIComponent(pathname));
  if (!m) return [];
  const [, to, from] = m;
  const out = [];
  for (let back = 1; back <= 16; back++) {
    const d = new Date(Date.UTC(2026, 10, 16 - back));
    const wd = d.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const date = d.toISOString().slice(0, 10);
    if (date < from || date > to) continue;
    for (let i = 0; i < 75; i++) {
      const mm = 15 + i * 5;
      const hh = String(9 + Math.floor(mm / 60)).padStart(2, '0');
      out.push([`${date}T${hh}:${String(mm % 60).padStart(2, '0')}:00+05:30`, 199, 199.4, 198.6, 199, 10_000, 0]);
    }
  }
  return out.reverse();
}
const hashPct = (k) => ([...k].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7) % 1000) / 1000;
const priceOf = (key) => {
  if (symOf[key] === FALL) return Math.round((mock.fallPrice ?? BASE[FALL] * 0.988) * 20) / 20;
  const b = BASE[symOf[key]] ?? 500;
  return Math.round(b * (1.012 + mock.move) * 20) / 20;
};
const json = (body, status = 200) => ({ status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });

async function upstox(route) {
  const req = route.request();
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,DELETE' } });
  const url = new URL(req.url());
  mock.calls.push(`${req.method()} ${url.pathname}`);
  const keys = (url.searchParams.get('instrument_key') ?? '').split(',').filter(Boolean);
  if (url.pathname === '/v2/market/holidays') return route.fulfill(json({ status: 'success', data: [] }));
  if (url.pathname === '/v3/market-quote/ltp') {
    // app v1.20: Upstox failing for one stock (the order window must say so and offer Retry)
    if (mock.ltpFail && keys.includes(mock.ltpFail)) return route.fulfill(json({ status: 'error', errors: [{ error_code: 'UDAPI100500', message: 'Something went wrong' }] }, 500));
    const data = {};
    // other NSE companies (the Nifty 500 breadth): about one in three up
    for (const k of keys) if (!symOf[k] && k !== BREAK && k.startsWith('NSE_EQ|INE')) data[`NSE_EQ:${k.slice(7)}`] = { last_price: hashPct(k) < 0.32 ? 101 : 99, instrument_token: k, ltq: 1, volume: 1000, cp: 100 };
    for (const k of keys) if (symOf[k]) data[`NSE_EQ:${symOf[k]}`] = { last_price: priceOf(k), instrument_token: k, ltq: 1, volume: 100000, cp: (BASE[symOf[k]] ?? 500) };
    if (keys.includes(BREAK)) data[`NSE_EQ:${BREAK_SYM}`] = { last_price: mock.breakPrice, instrument_token: BREAK, ltq: 1, volume: mock.breakVol, cp: 199.5 };
    mock.ltpCalls = (mock.ltpCalls ?? 0) + 1;
    if (keys.includes(BREAK)) mock.breakSeen = (mock.breakSeen ?? 0) + 1;
    mock.lastLtpKeys = keys.length;
    return route.fulfill(json({ status: 'success', data }));
  }
  if (url.pathname === '/v3/market-quote/ohlc') {
    const data = {};
    if (keys.includes(BREAK)) data[`NSE_EQ:${BREAK_SYM}`] = { last_price: mock.breakPrice, instrument_token: BREAK, prev_ohlc: { open: 199, high: 200, low: 198.5, close: 199.5, volume: 1, ts: 0 }, live_ohlc: { open: 198.8, high: Math.max(200.45, mock.breakPrice), low: 198.65, close: mock.breakPrice, volume: mock.breakVol, ts: 0 } };
    for (const k of keys) {
      if (!symOf[k]) continue;
      const b = BASE[symOf[k]] ?? 500;
      data[`NSE_EQ:${symOf[k]}`] = { last_price: priceOf(k), instrument_token: k, prev_ohlc: { open: b, high: b, low: b, close: b, volume: 1, ts: 0 }, live_ohlc: { open: b * 1.002, high: priceOf(k) * 1.001, low: b * 0.999, close: priceOf(k), volume: 900000, ts: 0 } };
    }
    return route.fulfill(json({ status: 'success', data }));
  }
  if (url.pathname === '/v3/market-quote/quotes') {
    // app v1.16: the pre-open call auction — [gap %, waiting buy, waiting sell, matched quantity]
    const PRE = { RELIANCE: [3.0, 70000, 30000, 60000], BSE: [4.5, 40000, 40000, 30000], TRENT: [2.2, 52000, 28000, 20000], ETERNAL: [1.4, 90000, 60000, 400000], ICICIBANK: [-0.6, 20000, 50000, 10000] };
    const data = {};
    for (const k of keys) {
      if (!symOf[k]) continue;
      const b = BASE[symOf[k]] ?? 500;
      const g = PRE[symOf[k]] ?? [(hashPct(k) - 0.5) * 1.2, 10000, 10000, 5000];
      const on = !!mock.preopen;
      data[`NSE_EQ:${symOf[k]}`] = { instrument_token: k, symbol: symOf[k], last_price: b, prev_close_price: b, volume: 0, total_buy_quantity: g[1], total_sell_quantity: g[2], indicative_equilibrium_price: on ? Math.round(b * (1 + g[0] / 100) * 20) / 20 : 0, indicative_equilibrium_quantity: on ? g[3] : 0, indicative_imbalance_quantity_total: on ? g[1] - g[2] : 0, indicative_imbalance_quantity_market: 0, reference_price: b };
    }
    mock.fullQuoteCalls = (mock.fullQuoteCalls ?? 0) + 1;
    return route.fulfill(json({ status: 'success', data }));
  }
  if (url.pathname === '/v2/market-quote/quotes') {
    const data = {};
    keys.forEach((k, i) => {
      if (!symOf[k]) return;
      const b = BASE[symOf[k]] ?? 500;
      const up = i % 2 === 0;
      data[`NSE_EQ:${symOf[k]}`] = { instrument_token: k, symbol: symOf[k], last_price: priceOf(k), volume: 2_000_000, average_price: up ? b * 1.006 : b * 1.02, net_change: priceOf(k) - b, total_buy_quantity: up ? 70000 : 20000, total_sell_quantity: up ? 30000 : 80000, ohlc: { open: b * 1.002, high: b * 1.015, low: b * 0.998, close: priceOf(k) } };
    });
    return route.fulfill(json({ status: 'success', data }));
  }
  if (url.pathname === '/v2/news') {
    const data = {};
    (url.searchParams.get('instrument_keys') ?? '').split(',').filter((x) => symOf[x]).forEach((k, i) => {
      data[k] = [{ heading: i % 2 === 0 ? `${symOf[k]} net profit rises 20%, beats estimates` : `${symOf[k]}: SEBI imposes penalty`, summary: '', article_link: 'https://upstox.com/news/x', published_time: PAGE_START - 3600_000 }];
    });
    return route.fulfill(json({ status: 'success', data }));
  }
  if (url.pathname.startsWith('/v3/historical-candle/intraday/') && decodeURIComponent(url.pathname).includes(fallKey())) return route.fulfill(json({ status: 'success', data: { candles: fallCandles() } }));
  if (url.pathname.startsWith('/v3/historical-candle/intraday/') && decodeURIComponent(url.pathname).includes(BREAK)) return route.fulfill(json({ status: 'success', data: { candles: breakCandles() } }));
  if (url.pathname.startsWith('/v3/historical-candle/') && !url.pathname.includes('/intraday/') && decodeURIComponent(url.pathname).includes(BREAK) && url.pathname.includes('/minutes/5/')) return route.fulfill(json({ status: 'success', data: { candles: breakHistory(url.pathname) } }));
  if (url.pathname.startsWith('/v3/historical-candle')) return route.fulfill(json({ status: 'success', data: { candles: [] } }));
  if (url.pathname.startsWith('/v2/fundamentals')) return route.fulfill(json({ status: 'success', data: [] }));
  if (/\/order|gtt/i.test(url.pathname)) mock.calls.push('ORDER-LIKE ' + url.pathname);
  return route.fulfill(json({ status: 'error', errors: [{ error_code: 'X', message: 'not in the fake' }] }, 404));
}

// PW_CHANNEL=msedge (or chrome) runs the test in an installed browser instead of Playwright's own download
const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.clock.install({ time: new Date(PAGE_START) }); // Monday 10:30 IST
await page.route('https://api.upstox.com/**', upstox);
await page.route('https://assets.upstox.com/**', (route) =>
  route.fulfill({ status: 200, headers: { 'content-type': 'application/octet-stream', 'access-control-allow-origin': '*' }, body: gzipSync(Buffer.from(JSON.stringify(allRows))) }),
);
const nifty50Csv = ['Company Name,Industry,Symbol,Series,ISIN Code', ...eq.map((r) => `${r.name},X,${r.trading_symbol},EQ,${r.isin}`), ...allRows.slice(rows.length, rows.length + 40).map((r) => `${r.name},X,${r.trading_symbol},EQ,${r.isin}`)].join('\n');
await page.route('https://nsearchives.nseindia.com/**', (route) =>
  route.request().url().includes('ind_nifty50list.csv')
    ? route.fulfill({ status: 200, headers: { 'content-type': 'text/csv', 'access-control-allow-origin': '*' }, body: nifty50Csv })
    : route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: '' }),
);
// in-app updates: no release yet until the test publishes a pretend 9.9.9
await page.route('https://raw.githubusercontent.com/careersalanjantony-bit/tradebuddy/**', (route) => {
  const v = mock.updateVersion;
  if (!v || !route.request().url().includes('/updates/latest.json')) return route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: 'Not Found' });
  return route.fulfill(json({ version: v, date: '2026-11-16', apk: `https://raw.githubusercontent.com/careersalanjantony-bit/tradebuddy/updates/TradeBuddy-${v}.apk`, size: 14680064, sha256: 'b'.repeat(64), notes: ['Update the app from inside the app', 'Sell-first ideas look clearer', 'Safer signing key'] }));
});
const revealAll = () => page.evaluate(() => document.querySelectorAll('[data-rv]').forEach((el) => el.classList.add('in'))).catch(() => undefined);
const until = async (fn, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};

console.log('── First start: guide');
await page.goto(base);
await page.waitForSelector('[data-testid="guide"]', { timeout: 20000 });
check('the first-start guide opens by itself', ((await page.textContent('[data-testid="guide-title"]')) ?? '').includes('Welcome'));
await revealAll(); await page.screenshot({ animations: 'disabled', path: join(out, 'app-guide.png') });
let steps = 1;
while (await page.$('[data-testid="guide-next"]')) {
  await page.click('[data-testid="guide-next"]');
  steps++;
}
check('the guide has 7 short steps and ends on "Start practising"', steps === 7 && !!(await page.$('[data-testid="guide-done"]')), `${steps} steps`);

// set up: Analytics Token + the sample stocks as the list (no real Upstox account needed)
await page.evaluate(async (keys) => {
  const s = (await chrome.storage.local.get('settings')).settings;
  await chrome.storage.local.set({ secrets: { upstoxAnalyticsToken: 'fake-analytics-token' }, watchlist: keys, settings: { ...s, scanner: { ...s.scanner, universe: 'nifty50' }, dayTrade: { ...s.dayTrade, enabled: true }, risk: { ...s.risk, capitalInr: 200000 } } });
}, eq.map((r) => r.instrument_key));
// app v1.15: ten earlier days of 5-minute prices for the breakout stock, stored the way the app stores
// them (its history download starts with a login, which this test does not do): its "usual volume"
await page.evaluate(async (key) => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('swing-assistant');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const tx = db.transaction('intraday', 'readwrite');
  const st = tx.objectStore('intraday');
  for (let back = 1; back <= 16; back++) {
    const d = new Date(Date.UTC(2026, 10, 16 - back));
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    const n = 75;
    st.put({ key, date: d.toISOString().slice(0, 10), t: Array.from({ length: n }, (_, i) => 555 + i * 5), o: Array(n).fill(199), h: Array(n).fill(199.4), l: Array(n).fill(198.6), c: Array(n).fill(199), v: Array(n).fill(10_000) });
  }
  await new Promise((res, rej) => {
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
  db.close();
}, BREAK);
await page.click('[data-testid="guide-done"]');

console.log('── Login: profile + PIN');
await page.waitForSelector('[data-testid="profile-setup"]', { timeout: 10000 });
check('after the guide: create a profile (stays on the phone)', ((await page.textContent('[data-testid="profile-setup"]')) ?? '').includes('Create your profile'));
await page.fill('[data-field="profile-name"]', 'Alan Joy');
await page.click('[data-testid="profile-next"]');
const typePin = async (pin) => {
  for (const d of pin) await page.click(`.pinpad [data-key="${d}"]`);
  await page.waitForTimeout(250);
};
await typePin('2580');
await typePin('2580');
await page.waitForSelector('[data-testid="wallet"]', { timeout: 10000 });
const acct = await page.evaluate(async () => (await chrome.storage.local.get('account')).account);
check('profile saved with only a salted hash of the PIN', acct?.name === 'Alan Joy' && acct.pin?.hash?.length === 64 && !JSON.stringify(acct).includes('2580'), acct ? `hash ${acct.pin?.hash?.slice(0, 8)}…` : 'none');
check('after the guide: Practice tab with ₹10,00,000', ((await page.textContent('[data-testid="wallet-total"]')) ?? '').replace(/\s/g, '') === '₹10,00,000');
check('the guide does not come back', await page.evaluate(async () => (await chrome.storage.local.get('settings')).settings.ui.guideSeen === true));

console.log('── Live prices');
const priced = await until(async () => page.evaluate(async () => Object.keys((await chrome.storage.session.get('quotes')).quotes ?? {}).length >= 10), 25000);
check('live prices arrive for the studied stocks (market open, Analytics Token)', priced);

console.log('── Practice money: buy');
await page.click('[data-testid="practice-buy"]');
await page.waitForSelector('[data-testid="trade-sheet"]');
await page.fill('[data-field="trade-search"]', 'RELI');
await page.click('.results .result');
await page.fill('[data-field="trade-qty"]', '100');
await page.click('details summary');
await page.fill('[data-field="trade-stop"]', '1500');
await page.fill('[data-field="trade-target"]', '1560');
await page.check('[data-field="trade-sellbyclose"]');
await revealAll(); await page.screenshot({ animations: 'disabled', path: join(out, 'app-buy-sheet.png') });
await page.click('[data-testid="trade-submit"]');
await page.waitForSelector('[data-testid="trade-msg"]', { timeout: 10000 });
const buyMsg = (await page.textContent('[data-testid="trade-msg"]')) ?? '';
check('Buy 100 RELIANCE fills at the live price ₹1,518 + 0.02% slippage, rounded up to 5 paise', buyMsg.includes('Bought 100 RELIANCE at ₹1,518.35'), buyMsg);
await page.waitForSelector('.holding[data-symbol="RELIANCE"]', { timeout: 8000 }).catch(() => {});
const holdText = ((await page.textContent('[data-testid="holdings"]')) ?? '').replace(/\s+/g, ' ');
check('the holding shows shares, buy price, take-profit and sell-if-falls prices in plain words', holdText.includes('100 shares') && holdText.includes('Take profit at ₹1,560') && holdText.includes('sell if it falls to ₹1,500') && holdText.includes('day trade'), holdText.slice(0, 160));
const cash = await page.evaluate(async () => (await chrome.storage.local.get('wallet')).wallet.cash);
check('cash went down by exactly the cost', Math.abs(cash - (1_000_000 - 151_835)) < 0.01, String(cash));

console.log('── Practice money: target reached → sold by itself');
mock.move = 0.03; // price rises to 1545 → above the 1560 target? 1500*1.042 = 1563
const sold = await until(async () => page.evaluate(async () => ((await chrome.storage.local.get('wallet')).wallet.fills ?? []).some((f) => f.side === 'sell' && f.reason === 'target')), 30000);
const fills = await page.evaluate(async () => (await chrome.storage.local.get('wallet')).wallet.fills);
const sale = fills.find((f) => f.side === 'sell');
check('the target sale happens by itself, with the result after intraday charges', sold && sale?.pnl > 0 && sale.charges > 50 && sale.charges < 150, sale ? `sold @ ${sale.price}, P&L ${sale.pnl}, charges ${sale.charges}` : 'no sale');
const notes = await page.evaluate(() => chrome.notifications.getAll());
check('a notification tells about the sale', Object.keys(notes).some((k) => k.startsWith('alert:wallet-')));
await page.waitForTimeout(800);
await revealAll(); await page.screenshot({ animations: 'disabled', path: join(out, 'app-practice.png'), fullPage: true });
const histText = ((await page.textContent('[data-testid="wallet-history"]')) ?? '').replace(/\s+/g, ' ');
check('history lists the buy and the sale with "take-profit"', histText.includes('Buy 100 RELIANCE') && histText.includes('Sell 100 RELIANCE') && histText.includes('take-profit'), histText.slice(0, 160));
const toastText = ((await page.textContent('.toasts').catch(() => '')) ?? '') + ' ' + ((await page.evaluate(() => document.querySelectorAll('.confetti i').length).catch(() => 0)) > 0 ? 'confetti' : '');
check('a profitable sale is celebrated (toast + confetti)', toastText.includes('Profit +₹') || toastText.includes('confetti'), toastText.trim().slice(0, 80));
const todayTxt = (await page.textContent('[data-testid="wallet-today"]')) ?? '';
check("today's profit shown", todayTxt.includes('+'), todayTxt);

console.log('── Selling by hand, limits');
mock.move = 0;
await page.click('[data-testid="practice-buy"]');
await page.fill('[data-field="trade-search"]', 'SBIN');
await page.click('.results .result');
await page.fill('[data-field="trade-qty"]', '10');
await page.click('[data-testid="trade-submit"]');
await page.waitForSelector('[data-testid="trade-msg"]');
await page.waitForSelector('.holding[data-symbol="SBIN"]', { timeout: 8000 }).catch(() => {});
await page.click('.holding[data-symbol="SBIN"] [data-testid="holding-sell"]');
await page.waitForSelector('[data-testid="trade-sheet"]');
await page.click('[data-testid="trade-submit"]');
await page.waitForSelector('[data-testid="trade-msg"]');
const sellMsg = (await page.textContent('[data-testid="trade-msg"]')) ?? '';
check('Sell from a holding: all shares sold at the live price', sellMsg.startsWith('Sold 10 SBIN'), sellMsg);
await page.waitForTimeout(1700);
await page.click('[data-testid="practice-buy"]');
await page.fill('[data-field="trade-search"]', 'EICHER');
await page.click('.results .result');
await page.fill('[data-field="trade-qty"]', '1000');
await page.click('[data-testid="trade-submit"]');
await page.waitForSelector('[data-testid="trade-msg"]');
const tooBig = (await page.textContent('[data-testid="trade-msg"]')) ?? '';
check('a buy bigger than the practice money is refused, in plain words', tooBig.includes('Not enough practice money'), tooBig);
await page.click('.sheet [aria-label="Close"]');

console.log('── Practice: Upstox-style order window (Delivery / Intraday / MTF)');
await page.waitForTimeout(400);
await page.click('[data-testid="practice-buy"]');
await page.fill('[data-field="trade-search"]', 'SBIN');
await page.click('.results .result');
const tabs = await page.$$eval('.product-tab', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
const types = await page.$$eval('[data-testid="order-types"] [data-type]', (els) => els.map((e) => e.getAttribute('data-type')));
check('the Buy window offers Delivery, Intraday with leverage and MTF, and Market / Limit / SL / SL-M orders', tabs.length === 3 && tabs[1].includes('5×') && tabs[2].includes('4×') && types.join(',') === 'market,limit,sl,slm', `${tabs.join(' | ')} · ${types.join(',')}`);
await page.click('.product-tab[data-product="intraday"]');
await page.fill('[data-field="trade-qty"]', '50');
const fundsText = ((await page.textContent('[data-testid="funds-box"]')) ?? '').replace(/\s+/g, ' ');
const freeBefore = await page.evaluate(async () => {
  const w = (await chrome.storage.local.get('wallet')).wallet;
  return w.cash;
});
check('Intraday shows the 20% margin (5×), what is free and the balance after this buy', fundsText.includes('Margin you pay (20%, 5×)') && fundsText.includes('Available now') && fundsText.includes('Balance after this buy'), fundsText.slice(0, 200));
await page.screenshot({ animations: 'disabled', path: join(out, 'app-order-intraday.png'), fullPage: true });
await page.click('[data-testid="trade-submit"]');
await page.waitForSelector('[data-testid="trade-msg"]');
const idMsg = (await page.textContent('[data-testid="trade-msg"]')) ?? '';
check('an Intraday buy fills and says the balance left', idMsg.startsWith('Bought 50 SBIN') && idMsg.includes('Intraday') && idMsg.includes('Balance now'), idMsg);
await page.waitForSelector('.holding[data-symbol="SBIN"][data-product="intraday"]', { timeout: 8000 }).catch(() => {});
const cashAfterIntraday = await page.evaluate(async () => (await chrome.storage.local.get('wallet')).wallet.cash);
const sbinFill = await page.evaluate(async () => ((await chrome.storage.local.get('wallet')).wallet.fills ?? []).filter((f) => f.symbol === 'SBIN' && f.product === 'intraday').pop());
check('only the margin left the cash (20% of the value)', sbinFill && Math.abs(freeBefore - cashAfterIntraday - sbinFill.price * 50 * 0.2) < 0.02, `${freeBefore} → ${cashAfterIntraday}`);
const idLine = ((await page.textContent('.holding[data-symbol="SBIN"][data-product="intraday"]').catch(() => '')) ?? '').replace(/\s+/g, ' ');
check('the position shows "Intraday 5×", its margin and when it closes', idLine.includes('Intraday 5×') && idLine.includes('closes by itself at 3:10 pm'), idLine.slice(0, 200));
const balRows = await page.$$eval('[data-testid="history-balance"]', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
check('History shows the balance after every trade', balRows.length >= 1 && balRows[0].startsWith('Balance after: ₹'), balRows.slice(0, 2).join(' | '));
await page.click('.holding[data-symbol="SBIN"][data-product="intraday"] [data-testid="convert-delivery"]');
const converted = await until(() => page.evaluate(async () => ((await chrome.storage.local.get('wallet')).wallet.holdings ?? []).some((h) => h.symbol === 'SBIN' && !h.product)), 5000);
const cashAfterConvert = await page.evaluate(async () => (await chrome.storage.local.get('wallet')).wallet.cash);
check('"Keep overnight (convert to Delivery)" pays the rest of the price', converted && Math.abs(cashAfterIntraday - cashAfterConvert - sbinFill.price * 50 * 0.8) < 0.05, `${cashAfterIntraday} → ${cashAfterConvert}`);
await page.waitForTimeout(400);
await page.click('[data-testid="practice-buy"]');
await page.fill('[data-field="trade-search"]', 'AXISBANK');
await page.click('.results .result');
await page.click('.product-tab[data-product="mtf"]');
await page.fill('[data-field="trade-qty"]', '20');
const mtfFunds = ((await page.textContent('[data-testid="funds-box"]')) ?? '').replace(/\s+/g, ' ');
check('MTF shows your 25% margin, what Upstox lends and the interest per day', mtfFunds.includes('Margin you pay (25%, 4×)') && mtfFunds.includes('Upstox lends') && /₹\d+\/day/.test(mtfFunds), mtfFunds.slice(0, 220));
await page.screenshot({ animations: 'disabled', path: join(out, 'app-order-mtf.png'), fullPage: true });
await page.click('[data-testid="trade-submit"]');
await page.waitForSelector('[data-testid="trade-msg"]');
await page.waitForSelector('.holding[data-symbol="AXISBANK"][data-product="mtf"]', { timeout: 8000 }).catch(() => {});
const mtfLine = ((await page.textContent('[data-testid="mtf-line"]').catch(() => '')) ?? '').replace(/\s+/g, ' ');
check('the MTF position shows what you paid, the loan and the interest a day', mtfLine.includes('You paid') && mtfLine.includes('Upstox lends') && mtfLine.includes('a day'), mtfLine);
await page.waitForTimeout(400);
await page.click('[data-testid="practice-buy"]');
await page.fill('[data-field="trade-search"]', 'ICICIBANK');
await page.click('.results .result');
await page.click('[data-type="sl"]');
await page.fill('[data-field="trade-qty"]', '5');
await page.fill('[data-field="trade-trigger"]', '1450');
await page.fill('[data-field="trade-limit"]', '1455');
await page.click('[data-testid="trade-submit"]');
await page.waitForSelector('[data-testid="trade-msg"]');
const slMsg = (await page.textContent('[data-testid="trade-msg"]')) ?? '';
await page.waitForSelector('[data-testid="open-order"]', { timeout: 8000 }).catch(() => {});
const ordersText = ((await page.textContent('[data-testid="open-orders"]').catch(() => '')) ?? '').replace(/\s+/g, ' ');
check('a stop-loss (SL) buy waits for its trigger and is listed in plain words', slMsg.includes('Stop-loss order placed') && ordersText.includes('stop-loss: trigger ₹1,450.00 → limit ₹1,455.00'), `${slMsg} | ${ordersText.slice(0, 160)}`);
const usedText = ((await page.textContent('[data-testid="wallet-funds"]').catch(() => '')) ?? '').replace(/\s+/g, ' ');
check('money kept for a waiting order is shown on the order ("keeps ₹7,275 aside") and counted in Used margin, like Upstox', ordersText.includes('keeps ₹7,275 aside') && usedText.includes('incl. ₹7,275 for orders'), `${ordersText.slice(0, 200)} | ${usedText}`);
await page.click('[data-testid="open-order"] .link-btn');
await page.waitForTimeout(300);
await revealAll();
await page.screenshot({ animations: 'disabled', path: join(out, 'app-practice-products.png'), fullPage: true });

console.log('── Day trade tab: rising now, learning');
await page.click('.bottom-nav [data-nav="daytrade"]');
check('Day trade is the raised centre button of the bottom bar and is marked as the current tab', await until(() => page.evaluate(() => { const b = document.querySelector('.bottom-nav [data-nav="daytrade"]'); return !!b && b.classList.contains('nav-center') && b.getAttribute('aria-current') === 'page'; }), 3000));
const rising = await until(async () => !!(await page.$('[data-testid="rising-now"]')), 15000);
const risingText = ((await page.textContent('[data-testid="rising-now"]').catch(() => '')) ?? '').replace(/\s+/g, ' ');
check('"Rising now — live" reads every stock on each live price, with a tag for whether it is likely to keep rising', rising && risingText.includes('read on each live price') && risingText.includes('likely to keep rising'), risingText.slice(0, 200));
check('"Rising now" says the tag is never a promise', risingText.includes('Never a promise'));
check('the self-learning line is on the Day trade tab', ((await page.textContent('[data-testid="learning-line"]').catch(() => '')) ?? '').includes('Self-learning'));
check("Day trade starts with today's plan, the current step highlighted (10:30 = buy ideas)", ((await page.textContent('[data-testid="day-plan"] .plan-step.now').catch(() => '')) ?? '').includes('Buy ideas'));
check('the past test and how-it-works are folded away under one line', !!(await page.$('[data-testid="day-details"]')) && !(await page.$eval('[data-testid="day-details"]', (e) => e.hasAttribute('open'))));
await revealAll(); await page.screenshot({ animations: 'disabled', path: join(out, 'app-daytrade.png'), fullPage: true });
await page.click('.topbar [data-nav="account"]');
await page.click('[data-go="learning"]');
await page.waitForSelector('[data-testid="learning-card"]');
await page.click('[data-testid="learn-now"]');
await page.waitForTimeout(1500);
const learnText = ((await page.textContent('[data-testid="learning-card"]')) ?? '').replace(/\s+/g, ' ');
check('Self-learning screen explains the unseen-days check and asks for history when there is none', learnText.includes('never seen') && learnText.includes('45 trading days'), learnText.slice(0, 120));
await revealAll(); await page.screenshot({ animations: 'disabled', path: join(out, 'app-learning.png'), fullPage: true });

console.log('── Home, news, layout');
await page.click('.bottom-nav [data-nav="today"]');
await page.waitForSelector('[data-testid="wallet-mini"]');
check('Home shows the practice money summary', ((await page.textContent('[data-testid="wallet-mini"]')) ?? '').includes('Practice money'));
await until(async () => !!(await page.$('[data-testid="rising-carousel"] .rise-tile')) && ((await page.textContent('[data-testid="market-pill"]').catch(() => '')) ?? '').includes('Market open'), 15000);
const homeOrder = await page.evaluate(() => [...document.querySelectorAll('[data-testid="home"] > section')].map((c) => c.getAttribute('data-testid')));
check('Home (DESIGN.md): the practice-money card comes first, then "🌱 Early Movers" — above Rising now and the best idea', homeOrder[0] === 'wallet-mini' && homeOrder[1] === 'early-movers' && homeOrder.indexOf('early-movers') < homeOrder.indexOf('best-idea'), JSON.stringify(homeOrder));
check('Home: greeting, market open pill, the best-idea card and the rising-now carousel',((await page.textContent('.home-head')) ?? '').includes('Good') && ((await page.textContent('[data-testid="market-pill"]')) ?? '').includes('Market open') && !!(await page.$('[data-testid="best-idea"]')) && !!(await page.$('[data-testid="rising-carousel"] .rise-tile')));
check('light theme by default (DESIGN.md canvas #F9F9FF)', await page.evaluate(() => getComputedStyle(document.body).backgroundColor === 'rgb(249, 249, 255)'), await page.evaluate(() => getComputedStyle(document.body).backgroundColor));
check('Home has the 4×2 shortcut grid', (await page.$$('[data-testid="quick-grid"] .quick')).length === 8);
await page.evaluate(() => chrome.runtime.sendMessage({ __swing: true, type: 'news:refresh', payload: undefined }));
const moods = await until(async () => (await page.$$('[data-testid="news"] [data-mood]')).length > 0, 15000);
const marks = await page.$$eval('[data-testid="news"] [data-mood]', (els) => els.map((e) => e.getAttribute('data-mood')));
check('News box marks headlines that read clearly good 👍 or bad 👎 (keyword check)', moods && marks.every((m) => m === 'good' || m === 'bad'), marks.join(','));
await revealAll(); await page.screenshot({ animations: 'disabled', path: join(out, 'app-home.png'), fullPage: true });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
check('no sideways scrolling on a phone screen', !overflow);
await page.setViewportSize({ width: 1280, height: 800 });
await page.waitForTimeout(300);
check('wide screens get the side menu instead of the bottom bar', await page.evaluate(() => getComputedStyle(document.querySelector('.side-nav')).display !== 'none' && getComputedStyle(document.querySelector('.bottom-nav')).display === 'none'));
await revealAll(); await page.screenshot({ animations: 'disabled', path: join(out, 'app-wide.png') });

console.log('── News tab');
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
check('bottom bar has 5 tabs (Home, Stocks, Day trade, News, Practice); alerts and Me are in the top bar', (await page.$$('.bottom-nav button')).length === 5 && !!(await page.$('.bottom-nav [data-nav="news"]')) && !!(await page.$('.topbar [data-nav="account"]')) && !!(await page.$('.topbar [data-nav="alerts"]')));
await page.click('.bottom-nav [data-nav="news"]');
await page.waitForSelector('[data-testid="news-screen"]', { timeout: 10000 });
const newsOk = await until(async () => (await page.$$('[data-testid="news-screen"] .news-item')).length > 0, 15000);
const reasons = await page.$$eval('[data-testid="news-screen"] .news-item', (els) => els.map((e) => e.getAttribute('data-reason')));
const risingKeys = await page.evaluate(async () => ((await chrome.storage.session.get('flow')).flow?.rising ?? []).map((r) => r.key));
const newsKeysUsed = await page.evaluate(async () => Object.keys((await chrome.storage.session.get('news')).news?.targets ?? {}));
check('News: the stocks that matter today first (ideas / rising), then the rest of the list, each with its reason', newsOk && reasons.length > 0 && ['idea', 'rising'].includes(reasons[0]) && reasons.every((r) => ['idea', 'rising', 'falling', 'pick', 'holding', 'trade', 'mover', 'market'].includes(r)) && risingKeys.every((k) => newsKeysUsed.includes(k)), `${reasons.join(',')} · ${newsKeysUsed.length} stocks asked`);
const savedNews = await page.evaluate(async () => ((await chrome.storage.local.get('newsCache')).newsCache?.items ?? []).length);
check('the headlines are also saved on the phone (shown after a restart or on a closed day)', savedNews > 0, `${savedNews} saved`);
await page.click('.filter-chip[data-filter="rising"]');
const afterFilter = await page.$$eval('[data-testid="news-screen"] .news-item', (els) => els.map((e) => e.getAttribute('data-reason')));
check('the "Rising now" chip shows only rising stocks', afterFilter.length > 0 && afterFilter.every((r) => r === 'rising'));
await page.screenshot({ animations: 'disabled', path: join(out, 'app-news.png') });

console.log('── Stocks tab');
await page.click('.bottom-nav [data-nav="watchlist"]');
await page.waitForSelector('[data-testid="stock-chips"]', { timeout: 10000 });
await until(async () => (await page.$$('.stock-card')).length >= 10, 10000);
const allCards = (await page.$$('.stock-card')).length;
await page.click('.filter-chip[data-filter="rising"]');
await page.waitForTimeout(400);
const risingCards = (await page.$$('.stock-card')).length;
check('Stocks: cards with one-tap filter chips', allCards >= 10 && risingCards > 0 && risingCards <= allCards, `${allCards} → ${risingCards}`);
await page.screenshot({ animations: 'disabled', path: join(out, 'app-stocks.png') });
// app v1.12: no index to pick — all five are studied; "Show only" just narrows the view
await page.click('.filter-chip[data-filter="all"]');
const listInfo = async () => ((await page.textContent('[data-testid="list-info"]').catch(() => '')) ?? '').replace(/\s+/g, ' ');
const studied = Number((/of ([\d,]+) stocks/.exec(await listInfo())?.[1] ?? '0').replace(/,/g, ''));
const viewOpts = await page.$$eval('select[data-field="index-view"] option', (els) => els.map((e) => e.textContent.trim()));
const tagged = await page.$$eval('.stock-card [data-testid="row-index"]', (els) => els.length);
await page.selectOption('select[data-field="index-view"]', 'nifty50');
const n50 = await until(async () => /^\d+ of /.test(await listInfo()) && Number(/^(\d+) of/.exec(await listInfo())[1]) <= 60, 6000);
const n50Text = await listInfo();
const n50Tags = await page.$$eval('.stock-card [data-testid="row-index"]', (els) => [...new Set(els.map((e) => e.textContent.trim()))]);
await page.selectOption('select[data-field="index-view"]', 'all');
const segText = ((await page.textContent('.segmented').catch(() => '')) ?? '').replace(/\s+/g, ' ');
check('Stocks tab studies all five indices at once (no index to choose); "Show only" narrows the view to one index', studied > 450 && viewOpts.length === 6 && viewOpts[0].startsWith('All five (') && segText.includes('All five indices') && tagged > 0 && n50 && n50Tags.length === 1 && n50Tags[0] === 'Nifty 50' && !(await page.$('select[data-field="list"]')), `${studied} studied · ${viewOpts.join(' | ')} · Nifty 50 view: ${n50Text.slice(0, 40)} ${JSON.stringify(n50Tags)}`);

console.log('── Breadth + sell-first');
await page.click('.bottom-nav [data-nav="daytrade"]');
await page.waitForSelector('[data-testid="breadth"]', { timeout: 20000 }).catch(() => {});
const brText = ((await page.textContent('[data-testid="breadth"]').catch(() => '')) ?? '').replace(/\s+/g, ' ');
check('breadth card: Nifty 500 up vs down with what it means for today', brText.includes('Are more stocks rising or falling?') && /\d+ Nifty 500 up/.test(brText) && brText.includes('Day trade:'), brText.slice(0, 160));
mock.fallPrice = mock.fallLast ?? BASE[FALL] * 0.988;
await page.evaluate(() => chrome.runtime.sendMessage({ __swing: true, type: 'quotes:refresh', payload: undefined }));
await page.waitForTimeout(800);
await page.click('[data-testid="shorts-refresh"]');
// app v1.11: Falling now checks the whole scan list (~535 stocks), so the scan can take a little longer
const idea = await until(async () => !!(await page.$(`[data-testid="falling-now"] .short-idea[data-symbol="${FALL}"]`)), 45000);
const ideaText = ((await page.textContent(`[data-testid="falling-now"] .short-idea[data-symbol="${FALL}"]`).catch(() => '')) ?? '').replace(/\s+/g, ' ');
const si = await page.evaluate(async () => (await chrome.storage.session.get('shortIdeas')).shortIdeas?.ideas?.[0]);
check('Falling now: the falling stock appears with a score, sell price, buy-back price, two targets and quantity for ₹50 risk', idea && si?.plan?.risk <= 50 && si.plan.stop > si.plan.entry && si.plan.t2 < si.plan.t1 && ideaText.includes('Target 2') && ideaText.includes('after charges'), si ? `${idea ? '' : 'card not shown; '}score ${si.score}, ${si.plan.qty} @ ${si.plan.entry} stop ${si.plan.stop} t1 ${si.plan.t1} t2 ${si.plan.t2}, risk ${si.plan.risk}` : 'none');
// app v1.11: all five indices, each stock once, with the index on every card
const scanText = ((await page.textContent('[data-testid="scan-coverage"]').catch(() => '')) ?? '').replace(/\s+/g, ' ');
const scanN = Number((/Scanning ([\d,]+) stocks/.exec(scanText)?.[1] ?? '0').replace(/,/g, ''));
const scanDb = await page.evaluate(async () => (await chrome.storage.session.get('scanUniverse')).scanUniverse);
check('Day trade scans all five indices, each stock once (Nifty 50, 100, Midcap 100, Smallcap 100, Nifty 500)', scanN > 450 && scanDb?.count === scanN && !(await page.$('[data-testid="scan-scope-switch"]')) && ['Nifty 50', 'Nifty 100', 'Midcap 100', 'Smallcap 100', 'Nifty 500'].every((w) => scanText.includes(w)) && !/\d\.00/.test(scanText), scanText.slice(0, 200));
const fallTag = ((await page.textContent(`.short-idea[data-symbol="${FALL}"] [data-testid="index-tag"]`).catch(() => '')) ?? '').trim();
check('the Falling-now idea shows which index the stock is in', fallTag === 'Nifty 50', fallTag || 'no tag');
const fallStatus = ((await page.textContent('[data-testid="falling-status"]').catch(() => '')) ?? '').replace(/\s+/g, ' ');
check('Falling now says how many stocks it checked (none skipped silently)', /Checked [\d,]+ stocks at \d\d:\d\d: [\d,]+ falling below today's open/.test(fallStatus) && !/\d\.00/.test(fallStatus), fallStatus);
check('each idea says why in plain words', (await page.$$(`.short-idea[data-symbol="${FALL}"] .reason-pill`)).length >= 2);
await revealAll();
await page.screenshot({ animations: 'disabled', path: join(out, 'app-shorts.png'), fullPage: true });
await page.click(`.short-idea[data-symbol="${FALL}"] [data-testid="short-practice"]`);
const opened = await until(() => page.evaluate(async () => ((await chrome.storage.local.get('wallet')).wallet.shorts ?? []).length === 1), 8000);
check('practice sell-first opens a short in the wallet (pretend money)', opened);
// between target 1 and target 2 of the trade actually opened (the list may have been re-scanned since)
const held = await page.evaluate(async () => (await chrome.storage.local.get('wallet')).wallet.shorts?.[0]);
mock.fallPrice = (held.t1 + held.t2) / 2;
const t1 = await until(() => page.evaluate(async () => ((await chrome.storage.local.get('wallet')).wallet.fills ?? []).some((f) => f.short && f.reason === 't1')), 30000);
const sh = await page.evaluate(async () => (await chrome.storage.local.get('wallet')).wallet.shorts?.[0]);
const shFills = await page.evaluate(async () => ((await chrome.storage.local.get('wallet')).wallet.fills ?? []).filter((f) => f.short).map((f) => `${f.side}:${f.qty}@${f.price}:${f.reason}`).join(' '));
check('target 1: half bought back by itself, the rest can no longer lose', t1 && sh?.t1Done && sh.stop === sh.entry, sh ? `${sh.qty} left, stop ${sh.stop}` : `closed — ${shFills}`);
await page.click('.bottom-nav [data-nav="practice"]');
await page.waitForSelector('[data-testid="shorts-held"]', { timeout: 10000 }).catch(() => {});
const heldText = ((await page.textContent('[data-testid="shorts-held"]').catch(() => '')) ?? '').replace(/\s+/g, ' ');
check('Practice tab lists the sell-first trade still open', heldText.includes(FALL), heldText.slice(0, 120));
await page.click('[data-testid="short-cover"]').catch(() => {});
const covered = await until(() => page.evaluate(async () => ((await chrome.storage.local.get('wallet')).wallet.shorts ?? []).length === 0), 8000);
check('"Buy back now" closes the rest of the sell-first trade', covered);
mock.fallPrice = undefined;

console.log('── Rising now (live)');
await page.click('.bottom-nav [data-nav="daytrade"]');
await page.waitForSelector('[data-testid="rising-now"]', { timeout: 15000 }).catch(() => {});
const riseOrder = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('section.card')].map((c) => c.getAttribute('data-testid'));
  return { rise: cards.indexOf('rising-now'), signals: cards.indexOf('day-signals'), falling: cards.indexOf('falling-now'), breakouts: cards.indexOf('breakouts') };
});
check('"📈 Rising now — live" is the first idea card on Day trade; "Breakout Today" is switched off and gone', riseOrder.rise >= 0 && riseOrder.rise < riseOrder.signals && (riseOrder.falling === -1 || riseOrder.rise < riseOrder.falling) && riseOrder.breakouts === -1, JSON.stringify(riseOrder));
// a learned check stored the way the app stores it (its maths is covered by the unit tests; here: the screen and the alert)
const RISE_MODEL = {
  version: 'rise-v1',
  model: { scaler: { mean: Array(17).fill(0), std: Array(17).fill(1) }, logistic: { w: Array(17).fill(0), b: 0 }, boosted: { base: 0, lr: 0.1, trees: [] } },
  report: { version: 'rise-v1', at: 1, trainDays: 84, testDays: 36, testFrom: '2026-09-28', testTo: '2026-11-13', samples: 61234, base: { n: 9000, win: 0.31, avgNetPct: -0.04 }, auc: 0.61, bands: [{ lo: 0, hi: 1, n: 9000, win: 0.62, avgNetPct: 0.12 }], strongFrom: 0.4, fadeTo: -1, old: { n: 2400, win: 0.29, avgNetPct: -0.07 }, strong: { n: 900, win: 0.62, avgNetPct: 0.12 }, early: { n: 300, win: 0.58, avgNetPct: 0.09 }, importance: [{ name: 'volume now vs usual', weight: 0.1 }, { name: 'last 15 minutes', weight: 0.08 }, { name: 'vs day average price', weight: 0.05 }] },
};
await page.evaluate(async (m) => chrome.storage.local.set({ riseModel: m }), RISE_MODEL);
let riseFound = false;
for (let i = 0; i < 8 && !riseFound; i++) {
  mock.breakPrice = 200.85;
  mock.breakVol += 100_000;
  await page.evaluate(() => chrome.runtime.sendMessage({ __swing: true, type: 'quotes:refresh', payload: undefined }));
  await page.evaluate(() => chrome.runtime.sendMessage({ __swing: true, type: 'rise:scan', payload: undefined }));
  riseFound = await until(async () => /Likely to keep rising/.test((await page.textContent(`[data-testid="rising-now"] .rise-item[data-symbol="${BREAK_SYM}"]`).catch(() => '')) ?? ''), 6000);
}
const riseText = ((await page.textContent(`.rise-item[data-symbol="${BREAK_SYM}"]`).catch(() => '')) ?? '').replace(/\s+/g, ' ');
check(
  'a rising stock is listed live with its tag ("Likely to keep rising" and how often similar moments did), reasons, and a quick-trade plan (take profit +0.6%, stop −0.4%, sell by)',
  riseFound && riseText.includes('Likely to keep rising') && /62\/100/.test(riseText) && riseText.includes('Quick trade') && riseText.includes('take profit') && riseText.includes('sell by'),
  riseText.slice(0, 220),
);
const riseModelText = ((await page.textContent('[data-testid="rise-model"]').catch(() => '')) ?? '').replace(/\s+/g, ' ');
check('the learned check says how it did on days it never saw, next to the old Rising-today list (never "100%")', riseModelText.includes('tested on the newest 36') && riseModelText.includes('the old Rising-today list: 29%') && riseModelText.includes('62%') && !/100%/.test(riseModelText), riseModelText.slice(0, 220));
// app v1.20 card: the symbol on its own line, the alert's words under it
const riseBanner = await until(async () => new RegExp(`${BREAK_SYM}[\\s\\S]*likely to keep rising`).test((await page.textContent('.alert-banners').catch(() => '')) ?? ''), 6000);
check('the alert pops up inside the app at the top (with the chosen tone)', riseBanner);
await page.screenshot({ animations: 'disabled', path: join(out, 'app-alert-banner.png') });
await page.click('.alert-banner-close').catch(() => {});
await page.$eval(`.rise-item[data-symbol="${BREAK_SYM}"]`, (el) => el.scrollIntoView({ block: 'center' })).catch(() => {});
await revealAll();
await page.screenshot({ animations: 'disabled', path: join(out, 'app-rising.png') });
await page.click(`.rise-item[data-symbol="${BREAK_SYM}"] [data-testid="rise-practice"]`);
const riseSheet = await until(async () => ((await page.textContent('[data-testid="trade-sheet"]').catch(() => '')) ?? '').includes(BREAK_SYM), 5000);
check('"Practice buy" opens the buy panel for it (Intraday, with its stop-loss and take-profit)', riseSheet && ((await page.textContent('[data-testid="trade-sheet"]').catch(() => '')) ?? '').includes('Intraday'));
await page.click('[data-testid="trade-submit"]').catch(() => {});
await until(async () => /Bought|bought|placed|Order/i.test((await page.textContent('[data-testid="trade-msg"]').catch(() => '')) ?? ''), 5000);
const riseBuyMsg = ((await page.textContent('[data-testid="trade-msg"]').catch(() => '')) ?? '').replace(/\s+/g, ' ');
const riseBought = await page.evaluate(async (k) => ((await chrome.storage.local.get('wallet')).wallet?.holdings ?? []).some((h) => h.key === k), 'NSE_EQ|INE423A01024');
await page.keyboard.press('Escape').catch(() => {});
await page.click('.sheet-backdrop', { position: { x: 10, y: 10 } }).catch(() => {});
const heldOk = await until(async () => {
  await page.evaluate(() => chrome.runtime.sendMessage({ __swing: true, type: 'rise:scan', payload: undefined }));
  const txt = ((await page.textContent(`[data-testid="rise-held"]`).catch(() => '')) ?? '').replace(/\s+/g, ' ');
  const at = txt.indexOf(`${BREAK_SYM}practice`);
  return at >= 0 && /Likely to keep rising — keep, sell if it drops to ₹|Unclear — keep a tight stop|Slowing/.test(txt.slice(at, at + 220));
}, 10000);
const riseHeldText = ((await page.textContent('[data-testid="rise-held"]').catch(() => '')) ?? '').replace(/\s+/g, ' ');
check('"Your stocks now": the stock bought from the Rising card (practice) gets keep / protect / take-the-profit advice with a price', heldOk && riseBought && new RegExp(`${BREAK_SYM}practice`).test(riseHeldText), `bought ${riseBought} (${riseBuyMsg.slice(0, 100)}) · ${riseHeldText.slice(riseHeldText.indexOf(BREAK_SYM) >= 0 ? riseHeldText.indexOf(BREAK_SYM) : 0).slice(0, 160)}`);
console.log('── Early Movers (on Home since v1.16)');
check('Day trade points to Early Movers on Home (no second, crowded copy)', !!(await page.$('[data-testid="early-moved"]')) && !(await page.$('[data-testid="early-movers"]')));
await page.click('[data-testid="early-moved"]');
await page.waitForSelector('[data-testid="early-movers"]', { timeout: 8000 }).catch(() => {});
const moversTop = await page.evaluate(() => [...document.querySelectorAll('[data-testid="home"] > section')].map((c) => c.getAttribute('data-testid'))[1]);
check('the link opens Home with Early Movers right under the practice-money card', moversTop === 'early-movers', String(moversTop));
const liveTab = await page.getAttribute('[data-movers-tab="live"]', 'class').catch(() => '');
// app v1.20.1: the 9:00 → 9:20 timeline and its status line are gone; the Intraday filters are always there
const timelineGone = !(await page.$('[data-testid="movers-steps"]')) && !(await page.$('[data-testid="movers-phase"]'));
const homeChips = await page.$$eval('[data-testid="early-movers"] [data-testid="intraday-filters"] .chip', (els) => els.map((e) => e.textContent.trim().replace(/\s+\d+$/, ''))).catch(() => []);
check('market open: the Intraday tab is shown, no timeline, and the five filters right under its header', (liveTab ?? '').includes('on') && timelineGone && homeChips.join(',') === 'All,BUY,SELL,WAIT,NO TRADE', `${timelineGone ? 'no timeline' : 'timeline still there'} · ${homeChips.join(',')}`);
const moneyLine = ((await page.textContent('[data-testid="movers-money"]').catch(() => '')) ?? '').replace(/\s+/g, ' ');
await page.click('[data-testid="movers-money"]');
const moneyText = ((await page.textContent('[data-testid="early-money"]').catch(() => '')) ?? '').replace(/\s+/g, ' ');
check('it works with ₹10,000 capital and at most ₹50 risk per trade including all charges (one line; tap to change)', moneyLine.includes('₹10,000') && moneyLine.includes('₹50') && moneyText.includes('including brokerage and all charges'), moneyLine.slice(0, 120));
await page.click('[data-testid="movers-money"]');
let earlyFound = false;
for (let i = 0; i < 10 && !earlyFound; i++) {
  mock.breakPrice = 200.85;
  mock.breakVol += 100_000;
  await page.evaluate(() => chrome.runtime.sendMessage({ __swing: true, type: 'quotes:refresh', payload: undefined }));
  await page.evaluate(() => chrome.runtime.sendMessage({ __swing: true, type: 'rise:scan', payload: undefined }));
  earlyFound = await until(async () => !!(await page.$(`[data-testid="early-movers"] .early-item[data-symbol="${BREAK_SYM}"]`)), 5000);
}
const earlyRow = await page.evaluate(async () => (await chrome.storage.session.get('early')).early?.rows?.[0] ?? null);
const rowLine = ((await page.textContent(`.early-item[data-symbol="${BREAK_SYM}"] .mv-row`).catch(() => '')) ?? '').replace(/\s+/g, ' ');
check('each stock is ONE short line (symbol, stage, plan in a few words, price, % and score) — details only on tap', earlyFound && rowLine.includes(BREAK_SYM) && /sh, risk ₹\d+/.test(rowLine) && !(await page.$(`.early-item[data-symbol="${BREAK_SYM}"] [data-testid="early-detail"]`)), rowLine.slice(0, 160));
await page.click(`.early-item[data-symbol="${BREAK_SYM}"] .mv-row`).catch(() => {});
await page.waitForSelector(`.early-item[data-symbol="${BREAK_SYM}"] [data-testid="early-detail"]`, { timeout: 4000 }).catch(() => {});
const earlyText = ((await page.textContent(`.early-item[data-symbol="${BREAK_SYM}"]`).catch(() => '')) ?? '').replace(/\s+/g, ' ');
check(
  'an early mover is listed with name, NSE symbol, price, % change, catalyst, relative volume, VWAP, RSI, EMA 9, breakout price, entry, stop-loss, targets and score',
  earlyFound && ['NSE: ADANIENT', 'Rel. volume', 'VWAP', 'RSI (5-min)', 'EMA 9 (5-min)', 'Breakout above', 'Entry', 'Stop-loss', 'Targets', 'score', '📰'].every((w) => earlyText.includes(w)),
  earlyRow ? `${earlyRow.symbol} ${earlyRow.stage} score ${earlyRow.score}, ${earlyRow.size.qty} sh risk ₹${earlyRow.size.risk} · rvol ${earlyRow.rvolDay?.toFixed(1)}` : earlyText.slice(0, 200),
);
check('setups and breakouts are told apart (🌱 setup / 🚀 breakout / ✅ confirmed)', !!earlyRow && ['setup', 'breakout', 'confirmed'].includes(earlyRow.stage) && /🌱 Setup|🚀 Breakout|✅ Confirmed/.test(rowLine), earlyRow?.stage ?? 'none');
check('the quantity keeps the ₹50 limit with all charges and fits the ₹10,000 capital', !!earlyRow && earlyRow.size.ok && earlyRow.size.risk <= 50 && earlyRow.size.value <= 10_000 && earlyText.includes('incl.') && earlyText.includes('charges'), earlyRow ? `${earlyRow.size.qty} shares, ₹${earlyRow.size.value}, risk ₹${earlyRow.size.risk} (charges ₹${earlyRow.size.charges})` : 'none');
const instText = ((await page.textContent(`.early-item[data-symbol="${BREAK_SYM}"] [data-testid="early-inst"]`).catch(() => '')) ?? '').replace(/\s+/g, ' ');
check('institutional signs are shown only when there is data — FII/DII clearly marked as not available', instText.includes('FII/DII: not available') && /bulk\/block deal|deal (BUY|SELL)/i.test(instText), instText.slice(0, 160));
const earlyBanner = await until(async () => /ADANIENT: (breaking out|setup forming|breakout confirmed)/.test((await page.textContent('.alert-banners').catch(() => '')) ?? '') || (await page.evaluate(async () => ((await chrome.storage.session.get('earlyAlerted')).earlyAlerted?.sent ?? []).length > 0)), 6000);
check('an Early Movers alert goes out (sound + in-app banner), each stage once', earlyBanner, JSON.stringify(await page.evaluate(async () => (await chrome.storage.session.get('earlyAlerted')).earlyAlerted?.sent ?? [])));
await page.$eval(`.early-item[data-symbol="${BREAK_SYM}"]`, (el) => el.scrollIntoView({ block: 'center' })).catch(() => {});
await revealAll();
await page.screenshot({ animations: 'disabled', path: join(out, 'app-early.png') });
await page.click('[data-testid="movers-more"] summary').catch(() => {});
const limitsText = ((await page.textContent('[data-testid="early-limits"]').catch(() => '')) ?? '').replace(/\s+/g, ' ');
check('"More" holds the data limits: pre-open IEP indicative, live feed, Upstox news (no results database), NSE end-of-day files, FII/DII unavailable, score is not a chance', ['IEP', 'indicative', 'Upstox', 'no results database', 'NSE end-of-day files', 'FII / DII activity:', 'not available', 'not a chance of rising'].every((w) => limitsText.includes(w)), limitsText.slice(0, 220));
const testText = ((await page.textContent('[data-testid="early-test"]').catch(() => '')) ?? '').replace(/\s+/g, ' ');
check('…and the past test and the pre-open record (written each morning from now on — no past pre-open data exists)', /Past test/.test(testText) && /Pre-open record:/.test(testText) && /only honest test/.test(testText), testText.slice(0, 200));
const riseSent = await page.evaluate(async () => (await chrome.storage.session.get('riseAlerted')).riseAlerted?.keys ?? []);
check('each "likely to keep rising" alert is sent once a day per stock', riseSent.filter((k) => k === 'NSE_EQ|INE423A01024').length === 1, JSON.stringify(riseSent));
mock.breakPrice = 200.3;

console.log('── In-app updates');
mock.updateVersion = '9.9.9';
await page.evaluate(() => chrome.runtime.sendMessage({ __swing: true, type: 'update:check', payload: undefined }));
await page.click('.bottom-nav [data-nav="today"]');
const banner = await until(async () => !!(await page.$('[data-testid="update-banner"]')), 8000);
const bannerText = ((await page.textContent('[data-testid="update-banner"]').catch(() => '')) ?? '').replace(/\s+/g, ' ');
check('Home shows "New version 9.9.9 is ready" with what is new and an Update now button', banner && bannerText.includes('New version 9.9.9 is ready') && bannerText.includes('Update the app from inside the app') && bannerText.includes('Update now · 14.0 MB'), bannerText.slice(0, 160));
await page.screenshot({ animations: 'disabled', path: join(out, 'app-update.png') });

console.log('── Auto-trader (₹50 lakh, trades by itself)');
mock.move = 0;
mock.fallPrice = undefined;
await page.evaluate(() => chrome.runtime.sendMessage({ __swing: true, type: 'quotes:refresh', payload: undefined }));
await page.evaluate(() => chrome.runtime.sendMessage({ __swing: true, type: 'bot:run', payload: undefined }));
await page.waitForSelector('[data-testid="bot-mini"]', { timeout: 10000 }).catch(() => {});
const miniText = ((await page.textContent('[data-testid="bot-mini"]').catch(() => '')) ?? '').replace(/\s+/g, ' ');
check('Home shows the auto-trader card (money, today, open trades, what it learned from)', miniText.includes('Auto-trader') && /₹\d{2},\d{2},\d{3}/.test(miniText) && miniText.includes('learned from'), miniText.slice(0, 140));
await page.click('[data-testid="bot-mini"]');
await page.waitForSelector('[data-testid="bot-view"]', { timeout: 10000 }).catch(() => {});
const botTraded = await until(async () => {
  await page.evaluate(() => chrome.runtime.sendMessage({ __swing: true, type: 'bot:run', payload: undefined }));
  return (await page.$$('[data-testid="bot-trade"]')).length >= 1;
}, 25000);
const botState = await page.evaluate(async () => (await chrome.storage.local.get('bot')).bot);
const heroText = ((await page.textContent('[data-testid="bot-hero"]').catch(() => '')) ?? '').replace(/\s+/g, ' ');
check('Auto-trader: ₹50 lakh of pretend money, trading by itself in market hours', botState?.wallet?.startCash === 5000000 && heroText.includes('Trading by itself'), heroText.slice(0, 120));
const openBot = (botState?.trades ?? []).filter((t) => t.status === 'open');
check(
  'it opened trades by itself — each with a safety net, a target, reasons; protected: at most 10 stocks for ₹50 lakh, each at most 15% of the money, same-day buys as Intraday (no borrowing), at most 3% at risk per trade',
  botTraded && openBot.length > 0 && openBot.length <= 10 && openBot.reduce((sum, t) => sum + t.qty * t.entry, 0) <= 5e6 + 1 && openBot.every((t) => t.qty * t.entry <= 0.15 * 5e6 * 1.01 && t.riskRupees <= 0.03 * 5e6 + 100 && t.stop0 !== t.entry && t.reasons.length > 0 && t.sizeWhy && (t.strategy === 'swing' || t.side === 'short' || t.product === 'intraday')),
  openBot.map((t) => `${t.side} ${t.qty} ${t.symbol} @${t.entry} (${t.strategy}, ${Math.round(t.chance * 100)}%, risk ₹${t.riskRupees})`).join('; '),
);
check('each open trade moves live on a bar: safety net ← price → target', !!(await page.$('[data-testid="bot-trade"] .trade-track .mark.now')));
const copyBtn = await page.$('[data-testid="bot-copy"]');
if (copyBtn) await copyBtn.click();
const copyText = ((await page.textContent('[data-testid="bot-copy-steps"]').catch(() => '')) ?? '').replace(/\s+/g, ' ');
check('each open auto-trade has "Copy in Upstox" with the exact order steps (you place it yourself)', !!copyBtn && /Upstox → .+ → (Buy|Sell) → (Intraday|Delivery) → \d+ shares → Limit ₹/.test(copyText) && copyText.includes('Stop-loss') && copyText.includes('never sends orders'), copyText.slice(0, 200));
// make one trade finish: the falling stock drops to its 2nd target, or the others jump up
const botShort = openBot.find((t) => t.side === 'short' && t.symbol === FALL);
if (botShort) mock.fallPrice = botShort.target - 1;
else mock.move = 0.08;
const learned = await until(async () => {
  await page.evaluate(() => chrome.runtime.sendMessage({ __swing: true, type: 'quotes:refresh', payload: undefined }));
  return page.evaluate(async () => {
    const b = (await chrome.storage.local.get('bot')).bot;
    return (b?.trades ?? []).some((t) => t.status === 'closed') && b.brain.n >= 1;
  });
}, 25000);
const botAfter = await page.evaluate(async () => (await chrome.storage.local.get('bot')).bot);
const firstClosed = (botAfter?.trades ?? []).find((t) => t.status === 'closed');
check('a finished trade is settled after charges and the brain learns from it (win/loss, R, a lesson)', learned && firstClosed && typeof firstClosed.pnl === 'number' && typeof firstClosed.r === 'number' && botAfter.log.some((l) => l.kind === 'learn'), firstClosed ? `${firstClosed.symbol} ${firstClosed.exitWhy} ${firstClosed.pnl} (${firstClosed.r} R) — ${firstClosed.lesson}` : 'none');
await page.waitForTimeout(600);
const learnedText = ((await page.textContent('[data-testid="bot-learned"]').catch(() => '')) ?? '').replace(/\s+/g, ' ');
check('"What it has learned" shows its record and each kind of trade', learnedText.includes('finished trades') && learnedText.includes('Rising today') && learnedText.includes('Top picks'), learnedText.slice(0, 160));
check('"What it did" lists its decisions with times', (await page.$$('[data-testid="bot-log"] .timeline li')).length >= 2);
// app v1.13: protection, past test, amount, copy in Upstox
const protText = ((await page.textContent('[data-testid="bot-protect"]').catch(() => '')) ?? '').replace(/\s+/g, ' ');
check(
  '"Protect my money" is on: keep the profit from +0.4%, daily loss limit −1%, few-days picks at most 30%, quick exit after 45 min, with today’s levels and the past test',
  (await page.isChecked('[data-testid="bot-protect-switch"]')) && ['Keep the profit from', 'Daily loss limit', 'Few-days picks at most', 'going nowhere'].every((w) => protText.includes(w)) && !!(await page.$('[data-protect="dayLossPct-1"].on')) && /Keeps the profit once the day is up|Today's best|Stopped for today/.test(protText) && /Past test/i.test(protText),
  protText.slice(0, 260),
);
await page.click('[data-protect="dayLossPct-2"]');
check('a protection level can be changed (daily loss limit −2%)', await until(() => page.evaluate(async () => (await chrome.storage.local.get('bot')).bot?.rules?.dayLossPct === 2), 5000));
await page.click('[data-protect="dayLossPct-1"]');
const totalNow = await page.evaluate(async () => (await chrome.storage.local.get('bot')).bot.wallet.startCash);
const newAmount = Math.round(totalNow / 1000) * 1000 + 100000;
await page.fill('[data-field="bot-set-amount"]', String(newAmount));
await page.click('[data-testid="bot-set-amount"]');
const amountMsg = await until(async () => /Done — it now trades with/.test((await page.textContent('[data-testid="bot-amount-msg"]').catch(() => '')) ?? ''), 8000);
const botAmt = await page.evaluate(async () => (await chrome.storage.local.get('bot')).bot);
const amtText = ((await page.textContent('[data-testid="bot-amount-msg"]').catch(() => '')) ?? '').replace(/\s+/g, ' ');
check('"Amount to auto-trade": set to a new amount — the money changes, open trades and learning are kept', amountMsg && botAmt.trades.length >= (botAfter?.trades?.length ?? 0) && botAmt.brain.n >= 1 && botAmt.log.some((l) => /Amount set to/.test(l.text)), amtText);
await page.click('[data-testid="bot-upstox-funds"]');
const fundsMsg = await until(async () => /Log in to Upstox|available to trade/.test((await page.textContent('[data-testid="bot-amount-msg"]').catch(() => '')) ?? ''), 8000);
check('"Use my Upstox balance" reads the balance (read only) — or says to log in first', fundsMsg, ((await page.textContent('[data-testid="bot-amount-msg"]').catch(() => '')) ?? '').slice(0, 120));
await revealAll();
await page.screenshot({ animations: 'disabled', path: join(out, 'app-bot.png'), fullPage: true });
mock.move = 0;
mock.fallPrice = undefined;

console.log('── Practice: Sell is always on, with suggestions');
mock.move = 0;
mock.fallPrice = undefined;
await page.click('.bottom-nav [data-nav="today"]');
await page.waitForSelector('[data-testid="home-greeting"]', { timeout: 8000 }).catch(() => {});
await until(async () => ((await page.textContent('[data-testid="home-greeting"]').catch(() => '')) ?? '').includes('Alan'), 4000);
const greet = ((await page.textContent('[data-testid="home-greeting"]').catch(() => '')) ?? '').trim();
const motto = ((await page.textContent('[data-testid="motto"]').catch(() => '')) ?? '').trim();
check('Home: "Good morning Alan!" and a short motivation line under it', greet.startsWith('Good morning Alan!') && motto.length > 5 && motto.length <= 40, `${greet} / ${motto}`);
await page.click('.bottom-nav [data-nav="practice"]');
await page.click('[data-tab="me"]').catch(() => {});
await page.waitForSelector('[data-testid="practice-sell"]', { timeout: 8000 });
check('the Sell button is on even without shares', !(await page.$eval('[data-testid="practice-sell"]', (b) => b.disabled)));
// a fresh "Falling now" scan at the falling stock's own price (earlier steps moved it around)
mock.fallPrice = mock.fallLast ?? BASE[FALL] * 0.988;
await page.evaluate(() => chrome.runtime.sendMessage({ __swing: true, type: 'quotes:refresh', payload: undefined }));
await page.evaluate(() => chrome.runtime.sendMessage({ __swing: true, type: 'shorts:scan', payload: undefined }));
await page.click('[data-testid="practice-sell"]');
await until(async () => (await page.$$('[data-testid="suggestion"].sell')).length > 0, 20000);
const sellSugs = await page.$$eval('[data-testid="suggestion"].sell', (els) => els.map((e) => e.getAttribute('data-symbol')));
check('Sell shows sell-first suggestions from the analysis (chance, plan, reasons)', sellSugs.length > 0, sellSugs.join(', '));
const pick = sellSugs.includes(FALL) ? FALL : sellSugs[0];
await page.click(`[data-testid="suggestion"][data-symbol="${pick}"]`);
await page.waitForSelector('[data-testid="sell-first-note"]', { timeout: 5000 }).catch(() => {});
const sfNote = !!(await page.$('[data-testid="sell-first-note"]'));
const sfFields = await page.evaluate(() => ['short-stop', 'short-t1', 'short-t2', 'trade-qty'].map((f) => document.querySelector(`[data-field="${f}"]`)?.value ?? ''));
await page.click('[data-testid="trade-submit"]');
const soldFirst = await until(() => page.evaluate(async (sym) => ((await chrome.storage.local.get("wallet")).wallet.shorts ?? []).some((x) => x.symbol === sym), pick), 8000);
check('choosing a suggestion fills a sell-first plan (buy-back price, targets, quantity) and selling first works', sfNote && sfFields.every((v) => Number(v) > 0) && soldFirst, `${pick}: ${sfFields.join(' / ')}`);
await page.evaluate(async (sym) => {
  const w = (await chrome.storage.local.get('wallet')).wallet;
  const x = (w.shorts ?? []).find((p) => p.symbol === sym);
  if (x) await chrome.runtime.sendMessage({ __swing: true, type: 'wallet:cover', payload: { key: x.key } });
}, pick);
await page.waitForTimeout(800);
await page.keyboard.press('Escape').catch(() => {});
await page.evaluate(() => document.querySelector('.sheet-backdrop')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
await page.waitForTimeout(400);
await page.click('[data-testid="practice-buy"]').catch(() => {});
await until(async () => (await page.$$('[data-testid="suggestion"].buy')).length > 0, 20000);
const buySugs = await page.$$eval('[data-testid="suggestion"].buy', (els) => els.map((e) => e.getAttribute('data-symbol')));
check('Buy shows suggested buys ranked by the analysis', buySugs.length > 0, buySugs.join(', '));
await revealAll();
await page.screenshot({ animations: 'disabled', path: join(out, 'app-suggestions.png') });
await page.evaluate(() => document.querySelector('.sheet-backdrop')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

console.log('── Stocks: for short selling');
await page.click('.bottom-nav [data-nav="watchlist"]');
await page.waitForSelector('[data-filter="short"]', { timeout: 10000 }).catch(() => {});
await page.click('[data-filter="short"]');
await page.waitForSelector('[data-testid="short-sell-list"]', { timeout: 10000 }).catch(() => {});
const ssText = ((await page.textContent('[data-testid="short-sell-list"]').catch(() => '')) ?? '').replace(/\s+/g, ' ');
check('Stocks → "For short selling": ranked by a measured chance, with an honest note (no 80–90% promises)', ssText.includes('Stocks for short selling') && ssText.includes('No study can find stocks that fall 80–90%'), ssText.slice(0, 160));

console.log('── Sell-first analysis + remembered filters and scroll');
// the short filter is still chosen from the section above; open the falling stock's sell-first view
await page.evaluate((k) => (location.hash = `/stock/${encodeURIComponent(`${k}~short`)}`), fallKey());
await page.waitForSelector('[data-testid="short-analysis"]', { timeout: 10000 }).catch(() => {});
const saReady = await until(async () => ((await page.textContent('[data-testid="short-analysis"]').catch(() => '')) ?? '').includes('Live plan'), 15000);
const saText = ((await page.textContent('[data-testid="short-analysis"]').catch(() => '')) ?? '').replace(/\s+/g, ' ');
check(
  'a short-selling stock opens its full sell-first analysis: entry, stop-loss, two targets, quantity, risk : reward, RSI, VWAP, volume, trend, news',
  saReady && ['Sell first at', 'Stop-loss', 'Target 1', 'Target 2', 'Quantity', 'Risk : reward', 'RSI 14', 'VWAP', 'Volume', 'Trend', 'News'].every((t) => saText.includes(t)) && /1 : \d/.test(saText),
  saText.slice(0, 220),
);
check('the stock page has a Buy view / Sell-first view switch, opened on Sell-first', (await page.getAttribute('[data-testid="stock-view"] [data-view="short"]', 'aria-selected')) === 'true');
await revealAll();
await page.screenshot({ animations: 'disabled', path: join(out, 'app-short-analysis.png'), fullPage: true });
await page.goBack();
await page.waitForSelector('[data-testid="short-sell-list"]', { timeout: 8000 }).catch(() => {});
check('back on Stocks, the chosen filter is remembered (For short selling)', !!(await page.$('[data-testid="short-sell-list"]')) && (await page.getAttribute('.filter-chip[data-filter="short"]', 'class'))?.includes('on'));
// scroll position: All stocks, scroll down, open a stock, come back
await page.click('.filter-chip[data-filter="all"]');
await page.waitForSelector('[data-testid="auto-list"] .stock-card, [data-testid="auto-list"] [role="button"], [data-testid="auto-list"] > *', { timeout: 8000 }).catch(() => {});
await page.waitForTimeout(600);
const before = await page.evaluate(() => `page ${document.documentElement.scrollHeight}, rows ${document.querySelectorAll('[data-testid="auto-list"] > *').length}`);
const target = await page.evaluate(() => {
  const max = document.documentElement.scrollHeight - window.innerHeight;
  const y = Math.max(0, Math.min(900, max - 50));
  window.scrollTo(0, y);
  return y;
});
await page.waitForTimeout(400);
const atOpen = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('[data-testid="auto-list"] > *')];
  const r = rows.find((el) => el.getBoundingClientRect().top > 120);
  r?.setAttribute('data-smoke-open', '1');
  return { y: window.scrollY, rowTop: r ? Math.round(r.getBoundingClientRect().top) : null, sym: r?.getAttribute('data-symbol') ?? r?.textContent?.slice(0, 12) ?? '' };
});
// where the list really is when the stock opens (Playwright may scroll a little to click it)
await page.evaluate(() =>
  document.addEventListener(
    'click',
    () => {
      const r = document.querySelector('[data-smoke-open="1"]');
      window.__atLeave = { y: window.scrollY, rowTop: r ? Math.round(r.getBoundingClientRect().top) : null, cards: document.querySelectorAll('[data-testid="alert-banner"]').length, space: getComputedStyle(document.documentElement).getPropertyValue('--alert-space').trim() };
    },
    { once: true, capture: true },
  ),
);
await page.click('[data-smoke-open="1"]').catch(() => {});
await page.waitForTimeout(700);
const onStock = await page.evaluate(() => location.hash.startsWith('#/stock/'));
const leftAt = await page.evaluate(() => window.__atLeave ?? null);
if (leftAt) Object.assign(atOpen, leftAt);
await page.goBack();
// the same row back at (about) the same place on the screen
const restored = await until(
  () =>
    page.evaluate((want) => {
      const rows = [...document.querySelectorAll('[data-testid="auto-list"] > *')];
      const r = rows.find((el) => (el.getAttribute('data-symbol') ?? el.textContent?.slice(0, 12) ?? '') === want.sym);
      return !!r && want.rowTop !== null && Math.abs(r.getBoundingClientRect().top - want.rowTop) < 40 && window.scrollY > 100;
    }, atOpen),
  6000,
);
const backY = await page.evaluate((sym) => {
  const r = [...document.querySelectorAll('[data-testid="auto-list"] > *')].find((el) => (el.getAttribute('data-symbol') ?? el.textContent?.slice(0, 12) ?? '') === sym);
  return `${window.scrollY} (page ${document.documentElement.scrollHeight}, row at ${r ? Math.round(r.getBoundingClientRect().top) : 'none'}, alert cards ${document.querySelectorAll('[data-testid="alert-banner"]').length}, space ${getComputedStyle(document.documentElement).getPropertyValue('--alert-space').trim() || '0'}, hash ${location.hash}, filter ${localStorage.getItem('tb:stocks.filter')})`;
}, atOpen.sym);
check('opening a stock and coming back keeps the list where you were (scroll position)', target > 100 && onStock && restored, `scrolled to ${target} (${before}); opened ${atOpen.sym.trim()} with the list at ${atOpen.y}, row at ${atOpen.rowTop} (alert cards ${atOpen.cards ?? '?'}, space ${atOpen.space || '0'}); back at ${backY}`);

console.log('── Me: account, lock');
await page.click('.topbar [data-nav="account"]');
await page.waitForSelector('[data-testid="account"]', { timeout: 10000 });
const accText = ((await page.textContent('[data-testid="account"]')) ?? '').replace(/\s+/g, ' ');
check('Me: profile, practice record, Upstox connection, security, look, alerts, data', ['Alan Joy', 'Your practice record', 'Best trade', 'Upstox connection', 'App lock', 'Look', 'Alerts', 'Your data', 'Copy backup'].every((t) => accText.includes(t)), accText.slice(0, 120));
const updText = ((await page.textContent('[data-testid="account-update"]').catch(() => '')) ?? '').replace(/\s+/g, ' ');
check('Me: App updates card shows your version, that 9.9.9 is ready, and Check now', /You have version \d+\.\d+\.\d+/.test(updText) && updText.includes('Version 9.9.9 is ready') && updText.includes('Check now'), updText.slice(0, 140));
mock.updateVersion = undefined;
await page.click('[data-theme-choice="light"]');
check('theme switches to light', await until(() => page.evaluate(() => document.documentElement.getAttribute('data-theme') === 'light'), 5000));
await page.click('[data-theme-choice="dark"]');
await revealAll();
await page.screenshot({ animations: 'disabled', path: join(out, 'app-account.png'), fullPage: true });
await page.click('[data-testid="lock-now"]');
await page.waitForSelector('[data-testid="lock-screen"]', { timeout: 5000 });
check('"Lock now" shows the lock screen with "Good morning Alan!" and hides the app', ((await page.textContent('[data-testid="lock-screen"]')) ?? '').includes('Good morning Alan!') && (await page.evaluate(() => getComputedStyle(document.querySelector('.content')).visibility)) === 'hidden');
await page.screenshot({ animations: 'disabled', path: join(out, 'app-lock.png') });
for (const d of '1111') await page.click(`.lock-screen [data-key="${d}"]`);
await page.waitForTimeout(600);
check('a wrong PIN does not open the app', !!(await page.$('[data-testid="lock-screen"]')));
for (const d of '2580') await page.click(`.lock-screen [data-key="${d}"]`);
check('the right PIN opens it', await until(async () => !(await page.$('[data-testid="lock-screen"]')), 8000));

console.log('── Scrolling + navbar');
await page.click('.bottom-nav [data-nav="today"]');
await page.waitForSelector('[data-testid="home"]');
await page.waitForTimeout(800); // the tab switch scrolls to the top first
const scrolled = await page.evaluate(async () => {
  window.scrollTo(0, 600);
  await new Promise((r) => setTimeout(r, 400));
  return window.scrollY;
});
const scrollInfo = await page.evaluate(() => { const se = document.scrollingElement; const cs = (el) => { const c = getComputedStyle(el); return `${c.overflow}/${c.overflowY}/${c.height}/${c.position}`; }; return `sh ${se.scrollHeight} ch ${se.clientHeight} html ${cs(document.documentElement)} body ${cs(document.body)} app ${cs(document.querySelector('.app'))} content ${cs(document.querySelector('.content'))}`; });
check('the page scrolls', scrolled > 100, `scrollY ${scrolled} ${scrollInfo}`);
const shown = await page.evaluate(() => [...document.querySelectorAll('.screen > *')].every((el) => Number(getComputedStyle(el).opacity) > 0.99));
check('cards on the screen are fully visible (no hidden-until-scrolled cards)', shown);
const navInfo = await page.evaluate(() => { const c = document.querySelector('.bottom-nav .nav-center .ic').getBoundingClientRect(); const h = document.querySelector('.bottom-nav [data-nav="today"] .ic').getBoundingClientRect(); return { raise: h.top - c.top, current: document.querySelector('.bottom-nav [aria-current="page"]')?.getAttribute('data-nav') }; });
check('the Day trade circle is raised above the other tabs and Home is marked as the current tab', navInfo.raise > 10 && navInfo.current === 'today', JSON.stringify(navInfo));

console.log('── Settings: alerts');
await page.goto(`${base}#/settings`);
await page.waitForSelector('[data-testid="alert-settings"]', { timeout: 10000 });
const switches = await page.$$eval('[data-testid="alert-settings"] input.switch', (els) => els.map((e) => e.checked));
check('Alerts card: day-trade BUY / SELL ideas, Early Movers, auto-trader trades, Rising now, sell-first ideas, new top picks, closed-app checks and sounds — all on by default (no breakouts)', switches.length === 8 && switches.every(Boolean) && !!(await page.$('[data-alert="bot"]')) && !!(await page.$('[data-alert="early"]')) && !(await page.$('[data-alert="breakouts"]')), JSON.stringify(switches));
await page.click('[data-alert="rising"] input.switch');
check('a switch changes the setting', await until(() => page.evaluate(async () => (await chrome.storage.local.get('settings')).settings.notifications.rising === false), 5000));
await revealAll(); await page.screenshot({ animations: 'disabled', path: join(out, 'app-settings.png') });
const studyText = ((await page.textContent('[data-testid="study-all"]').catch(() => '')) ?? '').replace(/\s+/g, ' ');
check('Settings: "Companies to study" is all five indices — nothing to choose', /All five indices — Nifty 50, Nifty 100, Midcap 100, Smallcap 100 and Nifty 500 together \(\d+ companies, each once\)/.test(studyText) && !(await page.$('select[data-field="universe"]')), studyText);
const tones = await page.$$eval('[data-testid="tone-settings"] .tone-row', (els) => els.map((e) => e.getAttribute('data-tone')));
check('Notification tone: several money sounds (+ the phone’s own), "Cash register" chosen at first', tones.length >= 7 && tones.includes('coins') && tones.includes('jackpot') && (await page.getAttribute('[data-tone="cash"] .tone-pick', 'aria-checked')) === 'true', tones.join(', '));
await page.click('[data-tone="coins"] .tone-pick');
const toneSet = await until(() => page.evaluate(async () => (await chrome.storage.local.get('settings')).settings.notifications.tone === 'coins'), 5000);
const toneNow = await page.evaluate(async () => (await chrome.storage.local.get('settings')).settings.notifications.tone);
const coinsOn = await until(async () => (await page.getAttribute('[data-tone="coins"] .tone-pick', 'aria-checked')) === 'true' && (await page.$('[data-tone="coins"].on')) !== null, 4000);
check('choosing a tone saves it (and plays it)', toneSet && coinsOn, `tone ${toneNow}`);
const toneFile = await page.evaluate(async () => (await fetch('sounds/tone_coins.ogg')).ok);
check('the tone files are part of the app', toneFile);
await page.$eval('[data-testid="tone-settings"]', (el) => el.scrollIntoView({ block: 'start' }));
await revealAll(); await page.screenshot({ animations: 'disabled', path: join(out, 'app-tones.png') });

console.log('── Pre-open morning (Tue 17 Nov 2026, 9:06 IST) — a second phone');
{
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const p2 = await ctx2.newPage();
  p2.on('pageerror', (e) => errors.push(`pre-open phone: ${e.message}`));
  await p2.clock.install({ time: new Date(Date.parse('2026-11-17T03:36:00Z')) }); // Tue 9:06 IST
  mock.preopen = true;
  await p2.route('https://api.upstox.com/**', upstox);
  await p2.route('https://assets.upstox.com/**', (route) => route.fulfill({ status: 200, headers: { 'content-type': 'application/octet-stream', 'access-control-allow-origin': '*' }, body: gzipSync(Buffer.from(JSON.stringify(allRows))) }));
  await p2.route('https://nsearchives.nseindia.com/**', (route) =>
    route.request().url().includes('ind_nifty50list.csv') ? route.fulfill({ status: 200, headers: { 'content-type': 'text/csv', 'access-control-allow-origin': '*' }, body: nifty50Csv }) : route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: '' }),
  );
  await p2.route('https://raw.githubusercontent.com/**', (route) => route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: 'Not Found' }));
  await p2.goto(base);
  await p2.waitForSelector('[data-testid="guide"]', { timeout: 20000 });
  while (await p2.$('[data-testid="guide-next"]')) await p2.click('[data-testid="guide-next"]');
  await p2.evaluate(async () => {
    const s = (await chrome.storage.local.get('settings')).settings;
    await chrome.storage.local.set({ secrets: { upstoxAnalyticsToken: 'fake-analytics-token' }, settings: { ...s, dayTrade: { ...s.dayTrade, enabled: true } } });
  });
  await p2.click('[data-testid="guide-done"]');
  await p2.waitForSelector('[data-testid="profile-setup"]', { timeout: 10000 });
  await p2.fill('[data-field="profile-name"]', 'Alan Joy');
  await p2.click('[data-testid="profile-next"]');
  for (const pin of ['2580', '2580']) {
    for (const d of pin) await p2.click(`.pinpad [data-key="${d}"]`);
    await p2.waitForTimeout(250);
  }
  await p2.waitForSelector('[data-testid="wallet"]', { timeout: 10000 }).catch(() => {});
  await p2.click('.bottom-nav [data-nav="today"]');
  await p2.waitForSelector('[data-testid="early-movers"]', { timeout: 10000 }).catch(() => {});
  let ranked = false;
  for (let i = 0; i < 20 && !ranked; i++) {
    await p2.evaluate(() => chrome.runtime.sendMessage({ __swing: true, type: 'preopen:refresh', payload: undefined })).catch(() => undefined);
    ranked = await until(() => p2.evaluate(async () => ((await chrome.storage.session.get('preopen')).preopen?.rows ?? []).length >= 3), 3000);
  }
  const pre = await p2.evaluate(async () => (await chrome.storage.session.get('preopen')).preopen ?? null);
  check('9:06: the pre-open is read from Upstox Full Market Quotes V3 (IEP, matched quantity, buy / sell) and ranked', ranked && (mock.fullQuoteCalls ?? 0) > 0 && pre?.phase === 'ranking', pre ? `${pre.counts.withIep} with a pre-open price, ${pre.counts.listed} listed: ${pre.rows.map((r) => `${r.symbol} ${r.gapPct.toFixed(1)}% (${r.score})`).join(', ')}` : 'none');
  check('only stocks 1%+ above yesterday, best points first (ICICIBANK, below yesterday, is not there)', !!pre && pre.rows.every((r) => r.gapPct >= 1) && pre.rows.every((r, i, a) => i === 0 || a[i - 1].score >= r.score) && !pre.rows.some((r) => r.symbol === 'ICICIBANK'), pre?.rows.map((r) => r.symbol).join(','));
  check('v1.16.1: only stocks with buyers clearly ahead (60%+ of the waiting quantity) — BSE, +4.5% but 50/50, is left out and counted', !!pre && pre.rows.every((r) => r.buyShare === null || r.buyShare >= 0.6) && !pre.rows.some((r) => r.symbol === 'BSE') && (pre.counts.sellers ?? 0) >= 1, pre ? `left out for sellers: ${pre.counts.sellers}` : 'none');
  await until(async () => (await p2.$$('[data-testid="pre-item"]')).length >= 3, 8000);
  const preTab = (await p2.getAttribute('[data-movers-tab="pre"]', 'class').catch(() => '')) ?? '';
  const pill = ((await p2.textContent('[data-testid="movers-pill"]').catch(() => '')) ?? '').trim();
  const preStatus = ((await p2.textContent('[data-testid="pre-status"]').catch(() => '')) ?? '').replace(/\s+/g, ' ');
  check('Home before 9:15: the Pre-open tab is shown, marked PRE-OPEN, its list says it changes until 9:13', preTab.includes('on') && pill === 'PRE-OPEN' && /changes until 9:13/.test(preStatus), `${pill} · ${preStatus.slice(0, 80)}`);
  const watchText = ((await p2.textContent('[data-testid="pre-watch"]').catch(() => '')) ?? '').replace(/\s+/g, ' ');
  check('the list says plainly: a watch list, not buy signals — do not buy at 9:15, buy only a stock that turns ⚡ Holding gap', /A watch list, not buy signals/.test(watchText) && /Do not buy at 9:15/.test(watchText) && /⚡ Holding gap/.test(watchText), watchText.slice(0, 140));
  const firstLine = ((await p2.textContent('[data-testid="pre-item"] .mv-row').catch(() => '')) ?? '').replace(/\s+/g, ' ');
  check('each candidate is one line: rank, symbol, pre-open price, buyers %, gap and score', /^1/.test(firstLine.trim()) && /pre-open ₹/.test(firstLine) && /buyers \d+%/.test(firstLine) && /\+\d/.test(firstLine), firstLine.slice(0, 120));
  await p2.click('[data-testid="pre-item"] .mv-row');
  await p2.waitForSelector('[data-testid="pre-detail"]', { timeout: 4000 }).catch(() => {});
  const parts = await p2.$$eval('[data-testid="pre-parts"] .pre-part', (els) => els.map((e) => `${e.getAttribute('data-part')}:${(e.querySelector('b')?.textContent ?? '').trim()}`)).catch(() => []);
  const detail = ((await p2.textContent('[data-testid="pre-detail"]').catch(() => '')) ?? '').replace(/\s+/g, ' ');
  check('tap: the seven parts with their points (25 / 20 / 15 / 15 / 10 / 10 / 5) and the number behind each', parts.length === 7 && ['/25', '/20', '/15', '/15', '/10', '/10', '/5'].every((m, i) => parts[i]?.endsWith(m)), parts.join(' '));
  check('…the Upstox auction numbers (matched, unmatched, reference price) and a first size estimate within ₹50', /matched [\d,.]+( lakh)? shares at ₹/.test(detail) && /reference price ₹/.test(detail) && /keeps ₹\d+ risk incl\. charges/.test(detail) && Number((/keeps ₹(\d+) risk/.exec(detail) ?? [])[1] ?? 99) <= 50, detail.slice(0, 260));
  await revealAll();
  await p2.evaluate(() => document.querySelectorAll('[data-rv]').forEach((el) => el.classList.add('in'))).catch(() => undefined);
  await p2.$eval('[data-testid="early-movers"]', (el) => el.scrollIntoView({ block: 'start' })).catch(() => {});
  await p2.screenshot({ animations: 'disabled', path: join(out, 'app-preopen.png') });
  // 9:13:10 — the final top 10 is fixed
  await p2.clock.setSystemTime(new Date(Date.parse('2026-11-17T03:43:10Z')));
  let fixed = false;
  for (let i = 0; i < 10 && !fixed; i++) {
    await p2.evaluate(() => chrome.runtime.sendMessage({ __swing: true, type: 'preopen:refresh', payload: undefined })).catch(() => undefined);
    fixed = await until(() => p2.evaluate(async () => !!(await chrome.storage.session.get('preopen')).preopen?.final), 3000);
  }
  const fin = await p2.evaluate(async () => (await chrome.storage.session.get('preopen')).preopen ?? null);
  const notes2 = await p2.evaluate(() => chrome.notifications.getAll());
  const rec2 = await p2.evaluate(async () => (await chrome.storage.local.get('preopenRecord')).preopenRecord ?? []);
  check('9:13: the final list is fixed, one alert ("ready for 9:15") and the day is written to the record', fixed && Object.keys(notes2).includes('alert:preopen-final-2026-11-17') && rec2.length === 1 && rec2[0].rows.length === fin?.final?.rows.length, fin?.final ? fin.final.rows.map((r) => r.symbol).join(', ') : 'not fixed');
  await until(async () => /Final list, fixed at 09:13/.test((await p2.textContent('[data-testid="pre-status"]').catch(() => '')) ?? ''), 6000);
  const finText = ((await p2.textContent('[data-testid="pre-status"]').catch(() => '')) ?? '').replace(/\s+/g, ' ');
  check('Home shows "Final list, fixed at 09:13"', /Final list, fixed at 09:13/.test(finText), finText.slice(0, 100));
  await p2.screenshot({ animations: 'disabled', path: join(out, 'app-preopen-final.png') });
  // app v1.20.1: no Intraday stocks yet — the five filters are still shown, with 0
  await p2.click('[data-movers-tab="live"]');
  await p2.waitForSelector('[data-testid="intraday-filters"]', { timeout: 4000 }).catch(() => {});
  const emptyChips = await p2.$$eval('[data-testid="intraday-filters"] .chip', (els) => els.map((e) => e.textContent.trim())).catch(() => []);
  check('Intraday with no stocks yet: the filters are still there (All 0, BUY 0, SELL 0, WAIT 0, NO TRADE 0)', emptyChips.join(' | ') === 'All 0 | BUY 0 | SELL 0 | WAIT 0 | NO TRADE 0', emptyChips.join(' | '));
  const oneRow = await p2.$eval('[data-testid="intraday-filters"]', (el) => new Set([...el.children].map((c) => Math.round(c.getBoundingClientRect().top))).size === 1 && el.scrollWidth <= el.clientWidth + 1).catch(() => false);
  check('…all five in one row on a phone screen, nothing cut off', oneRow);
  await p2.screenshot({ animations: 'disabled', path: join(out, 'app-intraday-empty.png') });
  const overflow2 = await p2.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check('no sideways scrolling on the pre-open screen', !overflow2);
  mock.preopen = false;
  await ctx2.close();
}

console.log('── Intraday BUY / SELL, alert cards and the order-window price (Mon 16 Nov 2026, 4:10 pm) — a third phone');
{
  const ctx3 = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const p3 = await ctx3.newPage();
  p3.on('pageerror', (e) => errors.push(`third phone: ${e.message}`));
  await p3.clock.install({ time: new Date(Date.parse('2026-11-16T10:40:00Z')) }); // 16:10 IST: market closed, the scanner is idle
  await p3.route('https://api.upstox.com/**', upstox);
  await p3.route('https://assets.upstox.com/**', (route) => route.fulfill({ status: 200, headers: { 'content-type': 'application/octet-stream', 'access-control-allow-origin': '*' }, body: gzipSync(Buffer.from(JSON.stringify(allRows))) }));
  await p3.route('https://nsearchives.nseindia.com/**', (route) =>
    route.request().url().includes('ind_nifty50list.csv') ? route.fulfill({ status: 200, headers: { 'content-type': 'text/csv', 'access-control-allow-origin': '*' }, body: nifty50Csv }) : route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: '' }),
  );
  await p3.route('https://raw.githubusercontent.com/**', (route) => route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: 'Not Found' }));
  await p3.goto(base);
  await p3.waitForSelector('[data-testid="guide"]', { timeout: 20000 });
  while (await p3.$('[data-testid="guide-next"]')) await p3.click('[data-testid="guide-next"]');
  await p3.evaluate(async () => {
    const s = (await chrome.storage.local.get('settings')).settings;
    await chrome.storage.local.set({ secrets: { upstoxAnalyticsToken: 'fake-analytics-token' }, settings: { ...s, dayTrade: { ...s.dayTrade, enabled: true } } });
  });
  await p3.click('[data-testid="guide-done"]');
  await p3.waitForSelector('[data-testid="profile-setup"]', { timeout: 10000 });
  await p3.fill('[data-field="profile-name"]', 'Alan Joy');
  await p3.click('[data-testid="profile-next"]');
  for (const pin of ['2580', '2580']) {
    for (const d of pin) await p3.click(`.pinpad [data-key="${d}"]`);
    await p3.waitForTimeout(250);
  }
  await p3.waitForSelector('[data-testid="wallet"]', { timeout: 10000 }).catch(() => {});
  // the scanner's last round of the day, as stored: one BUY, one SELL (sell first), one WAIT and one NO TRADE
  const k = (s) => eq.find((r) => r.trading_symbol === s).instrument_key;
  const at = Date.parse('2026-11-16T09:44:00Z'); // 15:14 IST
  const chk = (id, ok, text) => ({ id, ok, text });
  const base4 = { fromOpenPct: null, buyers: 0.4, ema21: null, breakoutT: null, valueCr: 80, at };
  const intraday = {
    date: '2026-11-16',
    at,
    universe: 2766,
    priced: 2766,
    candidates: 3,
    shortCandidates: 2,
    gate: null,
    shortGate: null,
    counts: { buy: 1, sell: 1, wait: 1, noTrade: 1 },
    rows: [
      { ...base4, key: k('HDFCBANK'), symbol: 'HDFCBANK', call: 'BUY', score: 85, why: 'momentum after a breakout at 10:05 — volume 2.1×, above VWAP', checks: [chk('vwap', true, 'above VWAP ₹806.10')], price: 812.4, changePct: 1.6, rvol: 2.1, vwap: 806.1, ema9: 810, orHigh: 808, breakoutT: 605, plan: { entry: 812.45, stop: 808.95, target: 819.45, rr: 2 }, size: { ok: true, qty: 12, value: 9749.4, risk: 48.5, charges: 6, reward: 78 } },
      { ...base4, key: k('SBIN'), symbol: 'SBIN', side: 'sell', call: 'SELL', score: 90, why: 'breakdown below the opening-range low ₹1,040.00 at 10:35 — selling volume 2.4×, below VWAP, weaker than NIFTY', checks: [chk('vwap', true, 'below VWAP ₹1,044.20'), chk('breakdown', true, 'broke below the opening-range low ₹1,040.00 at 10:35'), chk('confirm', true, 'confirmed: red 5-minute close and 1-minute candles below the level')], price: 1036.5, changePct: -1.9, rvol: 2.4, vwap: 1044.2, ema9: 1038.9, orHigh: 1052, plan: { entry: 1036.5, stop: 1040.75, t1: 1032.25, target: 1028, rr: 2 }, size: { ok: true, qty: 9, value: 9328.5, risk: 49.2, charges: 9.6, reward: 48 }, orLow: 1040, breakdownT: 635, level: 1040, rsi: 38, ema20: 1041.5, relNifty: -1.6, relSector: -1.1 },
      { ...base4, key: k('AXISBANK'), symbol: 'AXISBANK', side: 'sell', call: 'WAIT', score: 55, why: 'sell-first: waiting for a break below the opening-range low ₹1,290.00', checks: [chk('breakdown', false, 'not below the opening-range low ₹1,290.00')], price: 1291.2, changePct: -0.8, rvol: 1.2, vwap: 1295, ema9: 1293, orHigh: 1301, plan: { entry: 1289.95, stop: 1295.05, t1: 1284.85, target: 1279.75, rr: 2 }, size: { ok: true, qty: 7, value: 9029.65, risk: 45, charges: 9, reward: 40 }, orLow: 1290, breakdownT: null, level: null, rsi: 44, ema20: 1294, relNifty: -0.6, relSector: null },
      { ...base4, key: k('ICICIBANK'), symbol: 'ICICIBANK', call: 'NO TRADE', score: 40, why: 'below VWAP ₹1,412.00 — sellers in control', checks: [chk('vwap', false, 'below VWAP ₹1,412.00')], price: 1409, changePct: 1.1, rvol: 1.4, vwap: 1412, ema9: 1410, orHigh: 1415, plan: null, size: null },
    ],
  };
  await p3.evaluate((st) => chrome.storage.session.set({ intraday: st }), intraday);
  await p3.click('.bottom-nav [data-nav="today"]');
  await p3.waitForSelector('[data-movers-tab="live"]', { timeout: 10000 });
  await p3.click('[data-movers-tab="live"]');
  await p3.waitForSelector('[data-testid="intraday-filters"]', { timeout: 8000 }).catch(() => {});
  const chips = await p3.$$eval('[data-testid="intraday-filters"] .chip', (els) => els.map((e) => e.textContent.trim())).catch(() => []);
  check('Intraday: five filters with their live counts — All, BUY, SELL, WAIT, NO TRADE (they add up)', chips.join(' | ') === 'All 4 | BUY 1 | SELL 1 | WAIT 1 | NO TRADE 1', chips.join(' | '));
  const fits = await p3.$eval('[data-testid="intraday-filters"]', (el) => el.scrollWidth <= el.clientWidth + 1).catch(() => false);
  check('…all five fit in one row (nothing cut off)', fits);
  await p3.click('[data-intra-filter="SELL"]');
  const sellRows = await p3.$$eval('[data-testid="intraday-item"]', (els) => els.map((e) => `${e.getAttribute('data-symbol')}:${e.getAttribute('data-call')}`)).catch(() => []);
  check('the SELL filter shows only the SELL stock', sellRows.join(',') === 'SBIN:SELL', sellRows.join(','));
  const sellLine = ((await p3.textContent('[data-testid="intraday-item"] .mv-row').catch(() => '')) ?? '').replace(/\s+/g, ' ');
  check('a SELL row: SELL badge, price, change, score and "sell · stop · targets"', /SBIN\s*SELL/.test(sellLine) && /sell ₹1,036\.50 · stop ₹1,040\.75 · targets ₹1,032\.25 \/ ₹1,028\.00/.test(sellLine) && /−1\.9%/.test(sellLine) && /90/.test(sellLine), sellLine.slice(0, 160));
  await p3.click('[data-testid="intraday-item"] .mv-row');
  await p3.waitForSelector('[data-testid="intraday-detail"]', { timeout: 4000 }).catch(() => {});
  const sellDetail = ((await p3.textContent('[data-testid="intraday-detail"]').catch(() => '')) ?? '').replace(/\s+/g, ' ');
  check(
    'tap: the short-selling plan — sell first at, buy back above, target 1 and 2 below, shares, max loss with charges, risk : reward, RSI, vs NIFTY, reasons',
    ['Sell first at', 'Buy back if it rises to', 'Target 1 (half)', 'Target 2 (rest)', 'Max loss with charges', 'Risk : reward', 'RSI 14', 'vs NIFTY 50', 'broke below the opening-range low'].every((s) => sellDetail.includes(s)) && sellDetail.includes('Intraday only'),
    sellDetail.slice(0, 220),
  );
  await p3.click('[data-testid="intraday-sell-practice"]');
  await p3.waitForSelector('[data-testid="trade-sheet"]', { timeout: 4000 }).catch(() => {});
  const sheetSell = ((await p3.textContent('[data-testid="trade-sheet"]').catch(() => '')) ?? '').replace(/\s+/g, ' ');
  const sheetProduct = await p3.getAttribute('.product-tab.on', 'data-product').catch(() => null);
  check('"Sell first (practice)" opens the order window as an Intraday sell-first trade (never Delivery), with the buy-back price and both targets', sheetProduct === 'intraday' && sheetSell.includes('Sell first') && (await p3.inputValue('[data-field="short-stop"]').catch(() => '')) === '1040.75' && (await p3.inputValue('[data-field="short-t1"]').catch(() => '')) === '1032.25', `${sheetProduct} · ${sheetSell.slice(0, 120)}`);
  await p3.click('[data-testid="trade-sheet"] [aria-label="Close"]').catch(() => {});
  await p3.click('[data-testid="intraday-detail"] button:has-text("sell-first view")');
  await p3.waitForSelector('[data-testid="intraday-plan-card"]', { timeout: 6000 }).catch(() => {});
  const planCard = ((await p3.textContent('[data-testid="intraday-plan-card"]').catch(() => '')) ?? '').replace(/\s+/g, ' ');
  const shortView = await p3.getAttribute('[data-testid="stock-view"] [data-view="short"]', 'aria-selected').catch(() => null);
  check('…and its stock page opens in the Sell-first view with the scanner’s SELL plan (entry, stop, targets)', shortView === 'true' && planCard.includes('SELL') && planCard.includes('Sell first at') && planCard.includes('₹1,032.25'), planCard.slice(0, 160));
  await p3.screenshot({ animations: 'disabled', path: join(out, 'app-intraday-sell-stock.png') });

  // the order window for a company the app does not follow: its own price, an error with Retry when Upstox fails
  mock.ltpFail = LONE;
  await p3.evaluate((key) => window.dispatchEvent(new CustomEvent('tb-trade', { detail: { key, symbol: 'RPGTEST', side: 'buy' } })), LONE);
  await p3.waitForSelector('[data-testid="trade-price-error"]', { timeout: 15000 }).catch(() => {});
  const errText = ((await p3.textContent('[data-testid="trade-price-error"]').catch(() => '')) ?? '').trim();
  const shownWhileError = ((await p3.textContent('[data-testid="trade-price"]').catch(() => '')) ?? '').trim();
  check('Upstox failing: "live price unavailable", the reason and Retry — no number shown', /Retry/.test(errText) && shownWhileError === 'live price unavailable', `${shownWhileError} · ${errText.slice(0, 100)}`);
  mock.ltpFail = null;
  await p3.click('[data-testid="trade-price-retry"]');
  const gotPrice = await until(async () => /^₹(99|101)\.00$/.test(((await p3.textContent('[data-testid="trade-price"]').catch(() => '')) ?? '').trim()), 10000);
  const priceState = await p3.getAttribute('[data-testid="trade-price"]', 'data-state').catch(() => null);
  check('Retry: the price of a company the app does not follow arrives (market closed: the last traded price, said so)', gotPrice && priceState === 'closed' && ((await p3.textContent('[data-testid="trade-sheet"]').catch(() => '')) ?? '').includes('last traded price'), `${priceState}`);
  const watched = await p3.evaluate(async (key) => ((await chrome.storage.session.get('viewing')).viewing ?? {})[key] > Date.now(), LONE);
  check('…and it stays live while the window is open (added to the price list and the live feed for 10 minutes)', watched);
  await p3.click('[data-testid="trade-sheet"] [aria-label="Close"]').catch(() => {});

  // alert cards: a SELL card with its lines, under the top bar, pushing the page down, then stacking
  const sellAlert = { symbol: 'SBIN', key: k('SBIN'), side: 'sell', source: 'Intraday scanner', entry: 1036.5, stop: 1040.75, targets: [1032.25, 1028], qty: 9, risk: 49, score: 90, scoreKind: 'score', reasons: ['broke below the opening-range low'], closeBy: '3:15 pm', event: 'new' };
  const push = (id, title, detail) =>
    p3.evaluate(
      async ({ id, title, detail }) => {
        const h = (await chrome.storage.local.get('alertHistory')).alertHistory ?? { items: [], clearedAt: null, seen: {}, dismissed: {} };
        const rec = { id, title, message: 'Sell first, buy back later (Intraday only). A long message that would wrap on a phone screen and must not run past the card edges.', at: Date.now(), ...(detail ? { detail } : {}) };
        await chrome.storage.local.set({ alertHistory: { ...h, items: [rec, ...h.items] } });
        window.dispatchEvent(new CustomEvent('tb-alert', { detail: { id: rec.id, title: rec.title, message: rec.message, at: rec.at } }));
      },
      { id, title, detail },
    );
  await p3.click('.bottom-nav [data-nav="practice"]');
  // past the first 8 seconds after start (alerts then are catch-up work: Alerts tab only, no card)
  await p3.clock.fastForward(10_000);
  await p3.waitForTimeout(400);
  await p3.evaluate(() => window.scrollTo(0, 0));
  const topBefore = await p3.evaluate(() => document.querySelector('main')?.getBoundingClientRect().top ?? 0);
  await push('alert:intraday-short-smoke-1', '🔻 Intraday SELL SBIN at ₹1036.50 · score 90', sellAlert);
  await p3.waitForSelector('[data-testid="alert-banner"]', { timeout: 6000 }).catch(() => {});
  await until(async () => ((await p3.textContent('[data-testid="alert-lines"]').catch(() => '')) ?? '').includes('Sell first at'), 4000);
  await p3.waitForTimeout(500);
  const card = await p3.evaluate(() => {
    const el = document.querySelector('[data-testid="alert-banner"]');
    if (!el) return { missing: true, body: document.body.innerText.slice(0, 200), lines: [], kicker: '' };
    const r = el.getBoundingClientRect();
    const bar = document.querySelector('.topbar').getBoundingClientRect();
    const close = el.querySelector('.alert-banner-close').getBoundingClientRect();
    const prog = el.querySelector('.ab-progress').getBoundingClientRect();
    const main = document.querySelector('main').getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: window.innerWidth, barBottom: bar.bottom, closeW: close.width, closeH: close.height, closeRight: close.right, progIn: prog.left >= r.left && prog.right <= r.right && prog.bottom <= r.bottom, mainTop: main.top, kicker: el.querySelector('[data-testid="alert-kicker"]').textContent, lines: [...el.querySelectorAll('[data-testid="alert-lines"] dt')].map((d) => d.textContent), overflow: el.scrollWidth > el.clientWidth + 1 };
  });
  check('a SELL alert card: "NEW SHORT-SELL OPPORTUNITY", then sell-first price, stop-loss, targets, quantity and maximum risk on separate lines', card.kicker === 'NEW SHORT-SELL OPPORTUNITY' && card.lines.join('|') === 'Sell first at|Stop-loss (buy back above)|Targets|Quantity|Maximum risk', card.missing ? `no card: ${errors.slice(-2).join(' | ')} · ${card.body}` : `${card.kicker} · ${card.lines.join(', ')}`);
  check('…inside the screen (no sideways overflow), under the top bar, close button top-right with a big touch area, timer inside the card', card.left >= 0 && card.right <= card.w && !card.overflow && card.top >= card.barBottom - 1 && card.closeW >= 40 && card.closeH >= 40 && card.right - card.closeRight < 20 && card.progIn, JSON.stringify(card).slice(0, 200));
  check('…and the page moved down below it instead of being covered', card.mainTop >= card.bottom - 1 && card.mainTop > topBefore, `page top ${Math.round(topBefore)} → ${Math.round(card.mainTop)}, card bottom ${Math.round(card.bottom)}`);
  await p3.screenshot({ animations: 'disabled', path: join(out, 'app-alert-card-sell.png') });
  await push('alert:intraday-smoke-2', '⚡ Intraday BUY HDFCBANK at ₹812.45 · score 85', { ...sellAlert, symbol: 'HDFCBANK', side: 'buy', entry: 812.45, stop: 808.95, targets: [819.45], qty: 12 });
  await push('alert:intraday-smoke-3', '⚡ Intraday BUY AXISBANK at ₹1300.00 · score 80', { ...sellAlert, symbol: 'AXISBANK', side: 'buy', entry: 1300, stop: 1295, targets: [1310], qty: 7 });
  await until(async () => ((await p3.textContent('[data-testid="alert-more"]').catch(() => '')) ?? '').includes('+2 more'), 4000);
  const cardsShown = (await p3.$$('[data-testid="alert-banner"]')).length;
  const front = ((await p3.textContent('[data-testid="alert-kicker"]').catch(() => '')) ?? '').trim();
  check('three alerts at once: the newest card in front, "+2 more" waiting behind it (no pile of cards)', cardsShown === 1 && front === 'NEW BUY OPPORTUNITY' && ((await p3.textContent('[data-testid="alert-more"]').catch(() => '')) ?? '').includes('+2 more'), `${cardsShown} card(s), front ${front}`);
  await p3.screenshot({ animations: 'disabled', path: join(out, 'app-alert-card-stack.png') });
  await p3.click('[data-testid="alert-dismiss"]');
  await until(async () => ((await p3.textContent('[data-testid="alert-more"]').catch(() => '')) ?? '').includes('+1 more'), 4000);
  check('Dismiss slides the card away and the next one comes forward', ((await p3.textContent('[data-testid="alert-more"]').catch(() => '')) ?? '').includes('+1 more'));
  for (let i = 0; i < 3; i++) await p3.click('[data-testid="alert-dismiss"]').catch(() => {});
  const cleared = await until(async () => (await p3.$$('[data-testid="alert-banner"]')).length === 0, 4000);
  await p3.waitForTimeout(500);
  const space = await p3.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--alert-space').trim());
  check('all dismissed: no card left and the page moves back up', cleared && (space === '0px' || space === ''), `--alert-space ${space}`);
  const overflow3 = await p3.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check('no sideways scrolling with the new cards', !overflow3);
  await ctx3.close();
}

console.log('── Safety');
check('no order / GTT request was ever made', !mock.calls.some((c) => c.startsWith('ORDER-LIKE')), `${mock.calls.length} fake Upstox calls`);
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
server.close();
console.log(`\n${passed}/${passed + failed} checks passed. Screenshots: ${out}`);
process.exit(failed ? 1 : 0);
