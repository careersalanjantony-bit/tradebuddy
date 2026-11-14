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
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.map': 'application/json', '.json': 'application/json' };
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
    const data = {};
    // other NSE companies (the Nifty 500 breadth): about one in three up
    for (const k of keys) if (!symOf[k] && k.startsWith('NSE_EQ|INE')) data[`NSE_EQ:${k.slice(7)}`] = { last_price: hashPct(k) < 0.32 ? 101 : 99, instrument_token: k, ltq: 1, volume: 1000, cp: 100 };
    for (const k of keys) if (symOf[k]) data[`NSE_EQ:${symOf[k]}`] = { last_price: priceOf(k), instrument_token: k, ltq: 1, volume: 100000, cp: (BASE[symOf[k]] ?? 500) };
    return route.fulfill(json({ status: 'success', data }));
  }
  if (url.pathname === '/v3/market-quote/ohlc') {
    const data = {};
    for (const k of keys) {
      if (!symOf[k]) continue;
      const b = BASE[symOf[k]] ?? 500;
      data[`NSE_EQ:${symOf[k]}`] = { last_price: priceOf(k), instrument_token: k, prev_ohlc: { open: b, high: b, low: b, close: b, volume: 1, ts: 0 }, live_ohlc: { open: b * 1.002, high: priceOf(k) * 1.001, low: b * 0.999, close: priceOf(k), volume: 900000, ts: 0 } };
    }
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
  if (url.pathname.startsWith('/v3/historical-candle')) return route.fulfill(json({ status: 'success', data: { candles: [] } }));
  if (url.pathname.startsWith('/v2/fundamentals')) return route.fulfill(json({ status: 'success', data: [] }));
  if (/\/order|gtt/i.test(url.pathname)) mock.calls.push('ORDER-LIKE ' + url.pathname);
  return route.fulfill(json({ status: 'error', errors: [{ error_code: 'X', message: 'not in the fake' }] }, 404));
}

const browser = await chromium.launch();
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
await page.route('https://github.com/careersalanjantony-bit/tradebuddy/releases/**', (route) => {
  const v = mock.updateVersion;
  if (!v || !route.request().url().includes('/latest/download/latest.json')) return route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: 'Not Found' });
  return route.fulfill(json({ version: v, date: '2026-11-16', apk: `https://github.com/careersalanjantony-bit/tradebuddy/releases/download/v${v}/TradeBuddy-${v}.apk`, size: 14680064, sha256: 'b'.repeat(64), notes: ['Update the app from inside the app', 'Sell-first ideas look clearer', 'Safer signing key'] }));
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

console.log('── Day trade tab: rising now, buyers meter, learning');
await page.click('.bottom-nav [data-nav="daytrade"]');
const rising = await until(async () => (await page.$$('[data-testid="rising-now"] .holding')).length > 0, 30000);
const risingText = ((await page.textContent('[data-testid="rising-now"]').catch(() => '')) ?? '').replace(/\s+/g, ' ');
check('"Rising now" lists stocks with the buyers meter', rising && /Buyers strong|More buyers/.test(risingText), risingText.slice(0, 200));
check('"Rising now" says it is a list to watch, not a signal', risingText.includes('not a buy signal'));
check('the self-learning line is on the Day trade tab', ((await page.textContent('[data-testid="learning-line"]').catch(() => '')) ?? '').includes('Self-learning'));
check('page slides in from the side of the tab (Day trade is right of Home)', await page.evaluate(() => !!document.querySelector('main.page.from-right, main.page.from-left')));
check("Day trade starts with today's plan, the current step highlighted (10:30 = buy ideas)", ((await page.textContent('[data-testid="day-plan"] .plan-step.now').catch(() => '')) ?? '').includes('Buy ideas'));
check('the past test and how-it-works are folded away under one line', !!(await page.$('[data-testid="day-details"]')) && !(await page.$eval('[data-testid="day-details"]', (e) => e.hasAttribute('open'))));
await revealAll(); await page.screenshot({ animations: 'disabled', path: join(out, 'app-daytrade.png'), fullPage: true });
await page.click('.bottom-nav [data-nav="account"]');
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
check('Home: greeting, market open pill, the best-idea card and the rising-now carousel',((await page.textContent('.home-head')) ?? '').includes('Good') && ((await page.textContent('[data-testid="market-pill"]')) ?? '').includes('Market open') && !!(await page.$('[data-testid="best-idea"]')) && !!(await page.$('[data-testid="rising-carousel"] .rise-tile')));
check('dark theme by default', await page.evaluate(() => getComputedStyle(document.body).backgroundColor === 'rgb(11, 15, 20)'), await page.evaluate(() => getComputedStyle(document.body).backgroundColor));
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
check('bottom bar has 6 tabs including News and Me', (await page.$$('.bottom-nav button')).length === 6 && !!(await page.$('.bottom-nav [data-nav="news"]')) && !!(await page.$('.bottom-nav [data-nav="account"]')));
await page.click('.bottom-nav [data-nav="news"]');
await page.waitForSelector('[data-testid="news-screen"]', { timeout: 10000 });
const newsOk = await until(async () => (await page.$$('[data-testid="news-screen"] .news-item')).length > 0, 15000);
const reasons = await page.$$eval('[data-testid="news-screen"] .news-item', (els) => els.map((e) => e.getAttribute('data-reason')));
const risingKeys = await page.evaluate(async () => ((await chrome.storage.session.get('flow')).flow?.rising ?? []).map((r) => r.key));
const newsKeysUsed = await page.evaluate(async () => Object.keys((await chrome.storage.session.get('news')).news?.targets ?? {}));
check('News only for stocks that matter today: rising now first, each with its reason', newsOk && reasons.length > 0 && reasons.every((r) => ['idea', 'rising', 'pick', 'holding', 'trade'].includes(r)) && risingKeys.every((k) => newsKeysUsed.includes(k)), `${reasons.join(',')} · ${newsKeysUsed.length} stocks asked`);
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

console.log('── Breadth + sell-first');
await page.click('.bottom-nav [data-nav="daytrade"]');
await page.waitForSelector('[data-testid="breadth"]', { timeout: 20000 }).catch(() => {});
const brText = ((await page.textContent('[data-testid="breadth"]').catch(() => '')) ?? '').replace(/\s+/g, ' ');
check('breadth card: Nifty 500 up vs down with what it means for today', brText.includes('Are more stocks rising or falling?') && /\d+ Nifty 500 up/.test(brText) && brText.includes('Day trade:'), brText.slice(0, 160));
mock.fallPrice = mock.fallLast ?? BASE[FALL] * 0.988;
await page.evaluate(() => chrome.runtime.sendMessage({ __swing: true, type: 'quotes:refresh', payload: undefined }));
await page.waitForTimeout(800);
await page.click('[data-testid="shorts-refresh"]');
const idea = await until(async () => !!(await page.$(`[data-testid="falling-now"] .short-idea[data-symbol="${FALL}"]`)), 20000);
const ideaText = ((await page.textContent(`[data-testid="falling-now"] .short-idea[data-symbol="${FALL}"]`).catch(() => '')) ?? '').replace(/\s+/g, ' ');
const si = await page.evaluate(async () => (await chrome.storage.session.get('shortIdeas')).shortIdeas?.ideas?.[0]);
check('Falling now: the falling stock appears with a score, sell price, buy-back price, two targets and quantity for ₹50 risk', idea && si?.plan?.risk <= 50 && si.plan.stop > si.plan.entry && si.plan.t2 < si.plan.t1 && ideaText.includes('Target 2') && ideaText.includes('after charges'), si ? `score ${si.score}, ${si.plan.qty} @ ${si.plan.entry} stop ${si.plan.stop} t1 ${si.plan.t1} t2 ${si.plan.t2}, risk ${si.plan.risk}` : 'none');
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

console.log('── In-app updates');
mock.updateVersion = '9.9.9';
await page.evaluate(() => chrome.runtime.sendMessage({ __swing: true, type: 'update:check', payload: undefined }));
await page.click('.bottom-nav [data-nav="today"]');
const banner = await until(async () => !!(await page.$('[data-testid="update-banner"]')), 8000);
const bannerText = ((await page.textContent('[data-testid="update-banner"]').catch(() => '')) ?? '').replace(/\s+/g, ' ');
check('Home shows "New version 9.9.9 is ready" with what is new and an Update now button', banner && bannerText.includes('New version 9.9.9 is ready') && bannerText.includes('Update the app from inside the app') && bannerText.includes('Update now · 14.0 MB'), bannerText.slice(0, 160));
await page.screenshot({ animations: 'disabled', path: join(out, 'app-update.png') });

console.log('── Me: account, lock');
await page.click('.bottom-nav [data-nav="account"]');
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
check('"Lock now" shows the lock screen and hides the app', ((await page.textContent('[data-testid="lock-screen"]')) ?? '').includes('Welcome back, Alan') && (await page.evaluate(() => getComputedStyle(document.querySelector('.content')).visibility)) === 'hidden');
await page.screenshot({ animations: 'disabled', path: join(out, 'app-lock.png') });
for (const d of '1111') await page.click(`.lock-screen [data-key="${d}"]`);
await page.waitForTimeout(600);
check('a wrong PIN does not open the app', !!(await page.$('[data-testid="lock-screen"]')));
for (const d of '2580') await page.click(`.lock-screen [data-key="${d}"]`);
check('the right PIN opens it', await until(async () => !(await page.$('[data-testid="lock-screen"]')), 8000));

console.log('── Scrolling + navbar');
await page.click('.bottom-nav [data-nav="today"]');
await page.waitForSelector('[data-testid="home"]');
const scrolled = await page.evaluate(async () => {
  window.scrollTo(0, 600);
  await new Promise((r) => setTimeout(r, 400));
  return window.scrollY;
});
check('the page scrolls', scrolled > 100, `scrollY ${scrolled}`);
const shown = await until(() => page.evaluate(() => [...document.querySelectorAll('[data-rv]')].filter((el) => { const r = el.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; }).every((el) => el.classList.contains('in'))), 4000);
check('cards scrolled into view appear', shown);
const pill = await page.evaluate(() => { const n = document.querySelector('.bottom-nav .nav-pill').getBoundingClientRect(); const b = document.querySelector('.bottom-nav [data-nav="today"]').getBoundingClientRect(); return Math.abs((n.left + n.width / 2) - (b.left + b.width / 2)); });
check('the floating circle sits over the active tab', pill < 4, `${pill.toFixed(1)} px off`);

console.log('── Settings: alerts');
await page.goto(`${base}#/settings`);
await page.waitForSelector('[data-testid="alert-settings"]', { timeout: 10000 });
const switches = await page.$$eval('[data-testid="alert-settings"] input.switch', (els) => els.map((e) => e.checked));
check('Alerts card: buy ideas, rising fast, sell-first ideas, closed-app checks and sounds — all on by default', switches.length === 5 && switches.every(Boolean), JSON.stringify(switches));
await page.click('[data-alert="rising"] input.switch');
check('a switch changes the setting', await until(() => page.evaluate(async () => (await chrome.storage.local.get('settings')).settings.notifications.rising === false), 5000));
await revealAll(); await page.screenshot({ animations: 'disabled', path: join(out, 'app-settings.png') });

console.log('── Safety');
check('no order / GTT request was ever made', !mock.calls.some((c) => c.startsWith('ORDER-LIKE')), `${mock.calls.length} fake Upstox calls`);
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
server.close();
console.log(`\n${passed}/${passed + failed} checks passed. Screenshots: ${out}`);
process.exit(failed ? 1 : 0);
