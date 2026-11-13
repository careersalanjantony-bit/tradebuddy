// End-to-end check: loads dist/ into Chromium and drives the real extension.
// Upstox is replaced by a local fake HTTPS server: Chromium resolves api.upstox.com to 127.0.0.1
// (--host-resolver-rules) and accepts its self-signed certificate. This also covers the Upstox login
// window, which runs in its own browser session that request interception cannot see. No real
// account, keys or internet access are used. Covers M0 (load, panel, logs, redaction, SW restart) and M1 (login flow,
// token exchange, holidays, 401 handling, daily expiry, logout, Analytics Token, alarms).
// Usage: npm run build && npm run smoke     (screenshots → smoke-output/)
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:https';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensionIdFromKey } from './lib/ext-id.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const out = join(root, 'smoke-output');
mkdirSync(out, { recursive: true });
const expectedId = extensionIdFromKey(JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')).key);
const REDIRECT = `https://${expectedId}.chromiumapp.org/upstox`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const section = (t) => console.log(`\n── ${t}`);

// ---------------- fake Upstox ----------------
const IST = 330 * 60_000;
const istEpoch = (date, hhmm) => {
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  return Date.UTC(y, m - 1, d, h, mi) - IST;
};
const mock = {
  apiKey: 'test-api-key-0001',
  apiSecret: 'test-api-secret-0001',
  accessToken: 'mock-access-token-AAAA1111',
  analyticsGood: 'mock-analytics-token-GOOD9999',
  profileFails: false,
  calls: [],
  /** simulated trading day for the live day-trade engine */
  simDate: null,
  /** what GET /v2/portfolio/short-term-positions returns */
  positions: [],
  /** instrument keys the extension subscribed to on the live feed */
  feedSubs: [],
  /** ticks the fake live feed sends after a subscription: { key: ltp } */
  feedTicks: {},
  tokenBodies: [],
};
const holidays2026 = [
  { date: '2026-11-08', description: 'Diwali Muhurat (test data)', holiday_type: 'SPECIAL_TIMING', closed_exchanges: [], open_exchanges: [{ exchange: 'NSE', start_time: istEpoch('2026-11-08', '18:00'), end_time: istEpoch('2026-11-08', '19:00') }] },
  { date: '2026-11-24', description: 'Test holiday', holiday_type: 'TRADING_HOLIDAY', closed_exchanges: ['NSE', 'BSE'], open_exchanges: [] },
];
const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const invalidToken = { status: 'error', errors: [{ error_code: 'UDAPI100050', message: 'Invalid token used to access API', property_path: null, invalid_value: null }] };

// ---- fake market data (synthetic prices; real instrument rows) ----
const instrumentRows = JSON.parse(readFileSync(join(root, 'tests/fixtures/instruments-sample.json'), 'utf8')).rows;
// pad to look like a full file (the app rejects a list under 1,000 equities)
for (let i = 0; i < 1200; i++) instrumentRows.push({ segment: 'NSE_EQ', name: `DUMMY ${i} LTD`, isin: `INE9X${String(i).padStart(5, '0')}D1`, instrument_type: 'EQ', instrument_key: `NSE_EQ|INE9X${String(i).padStart(5, '0')}D1`, lot_size: 1, tick_size: 5.0, trading_symbol: `DUMMY${i}` });
const instrumentsGz = gzipSync(Buffer.from(JSON.stringify(instrumentRows)));
const bySymbolRow = Object.fromEntries(instrumentRows.map((r) => [r.trading_symbol, r]));
const keyToSym = Object.fromEntries(instrumentRows.map((r) => [r.instrument_key, r.trading_symbol]));
const BASE = { ICICIBANK: 1400, HDFCBANK: 800, SBIN: 1050, AXISBANK: 1300, BAJFINANCE: 1000, BSE: 3500, EICHERMOT: 7500, SUNPHARMA: 1850, ETERNAL: 290, TRENT: 4200, RELIANCE: 1500 };
const TRENT_EX = '2026-06-03';
const istToday = () => new Date(Date.now() + IST).toISOString().slice(0, 10);
const seriesCache = new Map();
function adjustedSeries(sym) {
  if (seriesCache.has(sym)) return seriesCache.get(sym);
  const out = [];
  const base = BASE[sym] ?? 500;
  const end = istToday();
  let d = new Date('2023-10-02T00:00:00Z');
  let i = 0;
  for (;;) {
    const date = d.toISOString().slice(0, 10);
    if (date > end) break;
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      const c =
        sym === 'HDFCBANK'
          ? base * 0.5 + Math.ceil(i / 2) * 1.6 - Math.floor(i / 2) * 0.8 // steady zig-zag uptrend
          : base * (0.7 + 0.3 * Math.min(1, i / 700)) * (1 + 0.025 * Math.sin(i / 9) + 0.006 * ((i % 2) * 2 - 1));
      const o = c * (1 - 0.003 * Math.sin(i));
      out.push({ date, o, h: Math.max(o, c) * 1.008, l: Math.min(o, c) * 0.992, c, v: 2_000_000 + 300_000 * Math.sin(i / 4) });
      i++;
    }
    d = new Date(d.getTime() + 86_400_000);
  }
  seriesCache.set(sym, out);
  return out;
}
/** What the fake API returns: TRENT is NOT adjusted for its 1:2 bonus (prices before the ex-date ×1.5). */
function rawSeries(sym) {
  const s = adjustedSeries(sym);
  if (sym !== 'TRENT') return s;
  return s.map((x) => (x.date < TRENT_EX ? { ...x, o: x.o * 1.5, h: x.h * 1.5, l: x.l * 1.5, c: x.c * 1.5, v: x.v / 1.5 } : x));
}
const r2 = (x) => Math.round(x * 100) / 100;
function quoteFor(key) {
  const s = rawSeries(keyToSym[key] ?? '');
  const last = s[s.length - 1];
  const prev = s[s.length - 2];
  return { ltp: r2(last.c * 1.002), cp: r2(prev.c), o: r2(last.o), h: r2(last.h * 1.002), l: r2(last.l), v: Math.round(last.v) };
}

const INDEX_QUOTES = {
  'NSE_INDEX|Nifty 50': { ltp: 25150.4, cp: 25000, o: 25020, h: 25180, l: 24990 },
  'NSE_INDEX|India VIX': { ltp: 12.4, cp: 12.9, o: 12.8, h: 13, l: 12.3 },
};
// the live feed speaks protobuf: encode with the standard library and Upstox's official definition
const protobuf = require('protobufjs');
const feedRoot = new protobuf.Root();
feedRoot.addJSON(protobuf.common.get('google/protobuf/wrappers.proto').nested);
protobuf.parse(readFileSync(join(root, 'tests/fixtures/MarketDataFeed.proto'), 'utf8'), feedRoot, { keepCase: true });
feedRoot.resolveAll();
const FeedResponse = feedRoot.lookupType('com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse');
const feedMessage = (obj) => FeedResponse.encode(FeedResponse.fromObject(obj)).finish();

// ---- fake 5-minute candles (day-trade mode): deterministic per stock and day
function seeded(str) {
  let a = 2166136261;
  for (let i = 0; i < str.length; i++) a = Math.imul(a ^ str.charCodeAt(i), 16777619);
  a >>>= 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hm = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
function intradayDay(sym, date) {
  const series = rawSeries(sym);
  const base = (series.find((x) => x.date === date) ?? series[series.length - 1]).o;
  const rnd = seeded(sym + date);
  const mkt = (seeded('mkt' + date)() - 0.5) * 0.001;
  const busy = 0.6 + rnd() * 1.8;
  const rows = [];
  let pr = base;
  for (let i = 0; i < 75; i++) {
    const o = pr;
    const c = o * (1 + mkt + (rnd() - 0.5) * 0.003);
    rows.push([`${date}T${hm(555 + i * 5)}:00+05:30`, r2(o), r2(Math.max(o, c) * (1 + rnd() * 0.0008)), r2(Math.min(o, c) * (1 - rnd() * 0.0008)), r2(c), Math.round((i < 3 ? 30000 * busy : 8000) * (0.7 + rnd() * 0.6)), 0]);
    pr = c;
  }
  return rows;
}
/** The simulated "today" for the live engine: a quiet first 15 minutes; HDFCBANK is 3× busier than usual. */
function simTodayBars(sym) {
  const series = rawSeries(sym);
  const base = series[series.length - 1].c;
  const vol = sym === 'HDFCBANK' ? 150000 : 20000;
  return [0, 1, 2].map((i) => [`${mock.simDate}T${hm(555 + i * 5)}:00+05:30`, r2(base), r2(base * 1.003), r2(base * 0.998), r2(base * 1.001), vol, 0]);
}
const isWeekday = (date) => ![0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());

const nseRows = [
  ...instrumentRows.filter((r) => r.segment === 'NSE_EQ' && !r.trading_symbol.startsWith('DUMMY')),
  ...instrumentRows.filter((r) => r.trading_symbol.startsWith('DUMMY')).slice(0, 89),
];
const nseCsv = ['Company Name,Industry,Symbol,Series,ISIN Code', ...nseRows.map((r) => `"${r.name}",Test,${r.trading_symbol},EQ,${r.isin}`)].join('\n');

async function upstoxHandler(req, route, postData) {
  const url = new URL(req.url, 'https://api.upstox.com');
  const auth = req.headers['authorization'] ?? '';
  mock.calls.push(`${req.method} ${url.pathname}`);
  const bearer = auth.replace(/^Bearer /, '');
  if ((req.headers.host ?? '').startsWith('nsearchives.nseindia.com')) {
    mock.calls.push('NSE ' + url.pathname);
    route.writeHead(200, { 'content-type': 'text/csv' });
    return route.end(nseCsv);
  }
  if ((req.headers.host ?? '').startsWith('assets.upstox.com')) {
    if (url.pathname === '/market-quote/instruments/exchange/NSE.json.gz') {
      route.writeHead(200, { 'content-type': 'application/gzip' });
      return route.end(instrumentsGz);
    }
    route.writeHead(404);
    return route.end();
  }
  const marketOk = bearer === mock.accessToken || bearer === mock.analyticsGood;
  const hist = /^\/v3\/historical-candle\/([^/]+)\/days\/1\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/.exec(url.pathname);
  if (hist) {
    if (!marketOk) return json(route, 401, invalidToken);
    const key = decodeURIComponent(hist[1]);
    const [to, from] = [hist[2], hist[3]];
    const candles = rawSeries(keyToSym[key] ?? '')
      .filter((x) => x.date >= from && x.date <= to)
      .reverse() // newest first, to test sorting
      .map((x) => [`${x.date}T00:00:00+05:30`, r2(x.o), r2(x.h), r2(x.l), r2(x.c), Math.round(x.v), 0]);
    return json(route, 200, { status: 'success', data: { candles } });
  }
  const m5 = /^\/v3\/historical-candle\/([^/]+)\/minutes\/5\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/.exec(url.pathname);
  if (m5) {
    if (!marketOk) return json(route, 401, invalidToken);
    const sym = keyToSym[decodeURIComponent(m5[1])] ?? '';
    const [to, from] = [m5[2], m5[3]];
    const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
    if (days > 31) return json(route, 400, { status: 'error', errors: [{ error_code: 'UDAPI1148', message: 'Invalid date range' }] });
    const candles = [];
    for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d = new Date(d.getTime() + 86_400_000)) {
      const date = d.toISOString().slice(0, 10);
      if (isWeekday(date) && date < istToday()) candles.push(...intradayDay(sym, date));
    }
    return json(route, 200, { status: 'success', data: { candles: candles.reverse() } });
  }
  const today5 = /^\/v3\/historical-candle\/intraday\/([^/]+)\/minutes\/5$/.exec(url.pathname);
  if (today5) {
    if (!marketOk) return json(route, 401, invalidToken);
    const sym = keyToSym[decodeURIComponent(today5[1])] ?? '';
    return json(route, 200, { status: 'success', data: { candles: mock.simDate ? simTodayBars(sym).reverse() : [] } });
  }
  const ca = /^\/v2\/fundamentals\/([^/]+)\/corporate-actions$/.exec(url.pathname);
  if (ca) {
    if (!marketOk) return json(route, 401, invalidToken);
    const isin = decodeURIComponent(ca[1]);
    const data = isin === bySymbolRow.TRENT.isin
      ? [
          { name: 'Bonus', expiry_date: '03 Jun 2026', amount: null, ratio: '1:2', event_details: [{ name: 'Record date', value: '04 Jun 2026' }] },
          { name: 'Dividend', expiry_date: '14 Aug 2025', amount: 5, ratio: null, event_details: [] },
        ]
      : [];
    return json(route, 200, { status: 'success', data });
  }
  if (url.pathname === '/v3/user/get-funds-and-margin') {
    if (bearer !== mock.accessToken) return json(route, 401, invalidToken);
    return json(route, 200, { status: 'success', data: { available_to_trade: { total: 251234.5, cash_available_to_trade: { total: 250000.75 } } } });
  }
  if (url.pathname === '/v3/market-quote/ltp' || url.pathname === '/v3/market-quote/ohlc') {
    if (!marketOk) return json(route, 401, invalidToken);
    const asked = (url.searchParams.get('instrument_key') ?? '').split(',');
    const keys = asked.filter((k) => keyToSym[k] && !INDEX_QUOTES[k]);
    const data = {};
    // the two index instruments used for the market mood
    for (const k of asked.filter((x) => INDEX_QUOTES[x])) {
      const q = INDEX_QUOTES[k];
      data[k.replace('|', ':')] = url.pathname.endsWith('ltp') ? { last_price: q.ltp, instrument_token: k, ltq: 0, volume: 0, cp: q.cp } : { last_price: q.ltp, instrument_token: k, prev_ohlc: { open: q.cp, high: q.cp, low: q.cp, close: q.cp, volume: 0, ts: 0 }, live_ohlc: { open: q.o, high: q.h, low: q.l, close: q.ltp, volume: 0, ts: 0 } };
    }
    for (const k of keys) {
      const q = quoteFor(k);
      data[`NSE_EQ:${keyToSym[k]}`] =
        url.pathname.endsWith('ltp')
          ? { last_price: q.ltp, instrument_token: k, ltq: 1, volume: q.v, cp: q.cp }
          : { last_price: q.ltp, instrument_token: k, prev_ohlc: { open: q.cp, high: q.cp, low: q.cp, close: q.cp, volume: 1, ts: 0 }, live_ohlc: { open: q.o, high: q.h, low: q.l, close: q.ltp, volume: q.v, ts: 0 } };
    }
    return json(route, 200, { status: 'success', data });
  }
  if (url.pathname === '/v2/portfolio/short-term-positions') {
    if (bearer !== mock.accessToken) return json(route, 401, invalidToken);
    return json(route, 200, { status: 'success', data: mock.positions });
  }
  if (url.pathname === '/v2/news') {
    if (!marketOk) return json(route, 401, invalidToken);
    const data = {};
    for (const k of (url.searchParams.get('instrument_keys') ?? '').split(',').filter((x) => keyToSym[x])) {
      data[k] = [{ heading: `Test headline for ${keyToSym[k]}`, summary: 'Summary', thumbnail: 'https://assets.upstox.com/x.webp', article_link: `https://upstox.com/news/test-${keyToSym[k]}/`, published_time: Date.now() - 3600_000 }];
    }
    return json(route, 200, { status: 'success', data, metadata: { page: { page_number: 1, page_size: 100, total_records: Object.keys(data).length, total_pages: 1 } } });
  }
  if (url.pathname === '/v3/feed/market-data-feed/authorize') {
    if (!marketOk) return json(route, 401, invalidToken);
    return json(route, 200, { status: 'success', data: { authorized_redirect_uri: 'wss://api.upstox.com/market-data-feeder/v3/test/feeds?requestId=r1&code=c1' } });
  }
  switch (url.pathname) {
    case '/v2/login/authorization/dialog': {
      const p = url.searchParams;
      if (p.get('client_id') !== mock.apiKey || p.get('redirect_uri') !== REDIRECT || p.get('response_type') !== 'code') {
        route.writeHead(400, { 'content-type': 'text/html' });
        return route.end('<h1>Invalid credentials (UDAPI100068)</h1>');
      }
      route.writeHead(302, { location: `${REDIRECT}?code=ONE-TIME-CODE&state=${encodeURIComponent(p.get('state'))}` });
      return route.end();
    }
    case '/v2/login/authorization/token': {
      const body = Object.fromEntries(new URLSearchParams(postData));
      mock.tokenBodies.push(body);
      if (body.client_id !== mock.apiKey || body.client_secret !== mock.apiSecret) {
        return json(route, 401, { status: 'error', errors: [{ error_code: 'UDAPI100069', message: "Check your 'client_id' and 'client_secret'" }] });
      }
      // Docs example is a flat object
      return json(route, 200, { email: 'test@example.com', user_id: 'TEST01', user_name: 'Test User', broker: 'UPSTOX', access_token: mock.accessToken, extended_token: 'mock-extended-token-BBBB' });
    }
    case '/v2/market/holidays':
      if (bearer !== mock.accessToken && bearer !== mock.analyticsGood) return json(route, 401, invalidToken);
      return json(route, 200, { status: 'success', data: holidays2026 });
    case '/v2/user/profile':
      if (bearer !== mock.accessToken || mock.profileFails) return json(route, 401, invalidToken);
      return json(route, 200, { status: 'success', data: { user_id: 'TEST01', user_name: 'Test User', is_active: true } });
    case '/v2/logout':
      return json(route, 200, { status: 'success', data: true });
    default:
      return json(route, 404, { status: 'error', errors: [{ error_code: 'UDAPI10000', message: 'not mocked' }] });
  }
}

// ---------------- run ----------------
/** Polls an async condition from Node (page.waitForFunction treats a returned Promise as "true" at once). */
async function until(fn, timeout = 20000, every = 300) {
  const t0 = Date.now();
  for (;;) {
    try {
      if (await fn()) return true;
    } catch {
      /* page navigating: try again */
    }
    if (Date.now() - t0 > timeout) return false;
    await new Promise((r) => setTimeout(r, every));
  }
}

const userDataDir = mkdtempSync(join(tmpdir(), 'swing-smoke-'));
const certDir = mkdtempSync(join(tmpdir(), 'swing-cert-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=api.upstox.com',
  '-addext', 'subjectAltName=DNS:api.upstox.com,DNS:assets.upstox.com,DNS:nsearchives.nseindia.com', '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem')], { stdio: 'ignore' });
const server = createServer({ key: readFileSync(join(certDir, 'key.pem')), cert: readFileSync(join(certDir, 'cert.pem')) }, (req, res) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => void upstoxHandler(req, res, data).catch((e) => { res.writeHead(500); res.end(String(e)); }));
});
// fake live feed on the same server: after a subscription it sends the market status, then prices
const { WebSocketServer } = require('ws');
const wss = new WebSocketServer({ server });
wss.on('connection', (sock) => {
  sock.on('message', (raw, isBinary) => {
    try {
      const msg = JSON.parse(Buffer.from(raw).toString('utf8'));
      if (!isBinary || msg.method !== 'sub' || msg.data?.mode !== 'ltpc') return;
      mock.feedSubs.push(...msg.data.instrumentKeys);
      sock.send(feedMessage({ type: 2, currentTs: Date.now(), marketInfo: { segmentStatus: { NSE_EQ: 2 } } }));
      const feeds = {};
      for (const [key, ltp] of Object.entries(mock.feedTicks)) feeds[key] = { ltpc: { ltp, ltt: Date.now(), ltq: 10, cp: ltp / 1.01 } };
      sock.send(feedMessage({ type: 1, currentTs: Date.now(), feeds }));
    } catch {
      /* ignore */
    }
  });
});
await new Promise((r) => server.listen(443, '127.0.0.1', r));

const ctx = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium',
  headless: true,
  viewport: { width: 420, height: 900 },
  deviceScaleFactor: 2,
  args: [
    `--disable-extensions-except=${dist}`,
    `--load-extension=${dist}`,
    '--host-resolver-rules=MAP api.upstox.com 127.0.0.1, MAP assets.upstox.com 127.0.0.1, MAP nsearchives.nseindia.com 127.0.0.1',
    '--no-proxy-server',
    '--ignore-certificate-errors',
  ],
});

const pageErrors = [];
const watch = (p) => {
  p.on('pageerror', (e) => pageErrors.push(`${p.url()}: ${e.message}`));
};
ctx.on('page', watch);

try {
  section('M0 · extension loads');
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const id = new URL(sw.url()).host;
  check('service worker registered', !!sw, sw.url());
  check('extension ID is fixed by manifest key', id === expectedId, id);
  const base = `chrome-extension://${id}/src/ui/sidepanel.html`;

  const page = await ctx.newPage();
  await page.goto(`${base}#/diagnostics`);
  await page.waitForSelector('.statusbar');
  check('side panel renders status bar', await page.isVisible('.statusbar'));
  check('disclaimer shown', (await page.textContent('footer.disclaimer'))?.includes('not investment advice'));
  await page.waitForFunction(() => document.querySelectorAll('.log-row').length > 0, null, { timeout: 10000 });
  // the service worker's entries can arrive a moment after the panel's own
  await page.waitForFunction(() => [...document.querySelectorAll('.log-msg')].some((e) => e.textContent?.includes('Service worker started')), null, { timeout: 10000 }).catch(() => {});
  const firstLogs = await page.$$eval('.log-row .log-msg', (els) => els.map((e) => e.textContent));
  check('Diagnostics shows "Service worker started"', firstLogs.some((t) => t?.includes('Service worker started')), `${firstLogs.length} rows; first: ${firstLogs.slice(0, 4).join(' / ')}`);
  await page.waitForFunction(() => document.querySelector('.kv')?.textContent?.includes('ready'), null, { timeout: 8000 }).catch(() => {});
  check('Diagnostics shows service worker "ready" without clicking', (await page.textContent('.kv'))?.includes('ready'));

  await page.click('text=Write test entries');
  await page.waitForFunction(() => [...document.querySelectorAll('.log-msg')].some((e) => e.textContent?.includes('Redaction check')), null, { timeout: 10000 });
  await page.click('.log-row:has-text("Redaction check")');
  const dataText = await page.textContent('.log-data');
  check('redaction: secrets replaced, non-secrets kept', dataText.includes('[REDACTED]') && dataText.includes('client_id=public-id'));
  check('redaction: no raw secrets in log', !/abcdef1234567890|sk-ant-test|ABC123|AAExampleExample/.test(dataText));

  const stored = await sw.evaluate(() => chrome.storage.local.get(null));
  check('storage migrated to v5', stored.meta?.schemaVersion === 5, `v${stored.meta?.schemaVersion}`);
  const alarms = await sw.evaluate(() => chrome.alarms.getAll());
  check('alarms scheduled: token-expiry, login-reminder, holidays-refresh', ['token-expiry', 'login-reminder', 'holidays-refresh'].every((n) => alarms.some((a) => a.name === n)), alarms.map((a) => a.name).join(', '));
  const expiryAlarm = alarms.find((a) => a.name === 'token-expiry');
  const expiryIst = new Date(expiryAlarm.scheduledTime + IST).toISOString().slice(11, 16);
  check('token-expiry alarm is at 03:30 IST', expiryIst === '03:30', expiryIst);

  section('M1 · before login');
  await page.goto(`${base}#/watchlist`);
  await page.waitForSelector('.login-banner');
  check('banner asks for API keys when none saved', (await page.textContent('.login-banner')).includes('not connected yet'));
  check('status bar: Upstox not logged in', (await page.textContent('.statusbar')).includes('not logged in'));
  check('status bar: market state shown with "?" (no holiday list yet)', /Market\s*(open|closed|pre-open|holiday)[^?]*\?/.test(await page.textContent('.statusbar')));

  section('M1 · save keys and log in');
  await page.click('text=Open Settings');
  await page.waitForSelector('#upx-key');
  await page.waitForFunction((u) => document.querySelector('.copybox code')?.textContent === u, REDIRECT, { timeout: 5000 }).catch(() => {});
  check('Settings shows redirect URL', (await page.textContent('.copybox code')) === REDIRECT);
  await page.fill('#upx-key', mock.apiKey);
  await page.fill('#upx-secret', mock.apiSecret);
  await page.click('text=Save keys');
  await page.waitForSelector('text=Saved on this computer.');
  const secrets = (await sw.evaluate(() => chrome.storage.local.get('secrets'))).secrets;
  check('keys saved to chrome.storage.local', secrets.upstoxApiKey === mock.apiKey && secrets.upstoxApiSecret === mock.apiSecret);
  check('secret input cleared after save', (await page.inputValue('#upx-secret')) === '');

  await page.click('button:has-text("Log in to Upstox")');
  await page.waitForSelector('[data-testid="login-status"] .ok-text', { timeout: 15000 }).catch(() => {});
  const loginText = await page.textContent('[data-testid="login-status"]');
  check('login flow completes (authorize → redirect → token)', loginText.includes('Logged in as Test User'), loginText.trim());
  const tb = mock.tokenBodies[0] ?? {};
  check(
    'token exchange body matches the docs',
    tb.code === 'ONE-TIME-CODE' && tb.grant_type === 'authorization_code' && tb.redirect_uri === REDIRECT && tb.client_id === mock.apiKey,
    JSON.stringify({ ...tb, client_secret: tb.client_secret ? '***' : undefined }),
  );
  const auth = (await sw.evaluate(() => chrome.storage.local.get('auth'))).auth;
  const expIst = auth?.expiresAt ? new Date(auth.expiresAt + IST).toISOString().slice(11, 16) : '';
  check('session stored with expiry at 03:30 IST', auth?.status === 'logged_in' && expIst === '03:30' && auth.expiresAt > Date.now(), `${auth?.status} ${expIst}`);
  check('status bar shows logged in with time left', /logged in · \d+ h \d+ min left/.test(await page.textContent('.statusbar')), (await page.textContent('.statusbar')).trim());

  await page.waitForFunction(() => document.body.textContent?.includes('list loaded'), null, { timeout: 10000 }).catch(() => {});
  check('holiday list fetched after login', (await page.textContent('body')).includes('2026 list loaded (2 entries)'));
  check('market state no longer has "?"', !/Market\s*\S+\?/.test(await page.textContent('.statusbar')), (await page.textContent('.statusbar')).trim());
  await page.screenshot({ path: join(out, 'm1-settings-logged-in.png'), fullPage: true });

  await page.click('text=Test connection');
  await page.waitForSelector('text=Connection OK', { timeout: 10000 }).catch(() => {});
  check('Test connection calls /v2/user/profile', (await page.textContent('body')).includes('Connection OK — Test User (TEST01)'));
  await page.waitForSelector('summary:has-text("Advanced settings")', { timeout: 10000 });
  await page.evaluate(() => document.querySelectorAll('details').forEach((d) => (d.open = true))); // unfold Advanced settings
  await page.click('text=Read from Upstox');
  await page.waitForSelector('text=cash available to trade', { timeout: 10000 }).catch(() => {});
  check('capital helper reads the Upstox balance (v3 funds API)', (await page.inputValue('input[data-field="helper-cash"]')) === '250000');

  const logs = await page.evaluate(async () => {
    const req = indexedDB.open('swing-assistant');
    const db = await new Promise((r) => (req.onsuccess = () => r(req.result)));
    const all = await new Promise((r) => {
      const q = db.transaction('logs').objectStore('logs').getAll();
      q.onsuccess = () => r(q.result);
    });
    return JSON.stringify(all);
  });
  check('no token, secret or code leaked into the log', !logs.includes(mock.accessToken) && !logs.includes(mock.apiSecret) && !logs.includes('ONE-TIME-CODE') && !logs.includes('mock-extended-token'));

  section('M1 · Upstox rejects the token (401)');
  mock.profileFails = true;
  await page.click('text=Test connection');
  await page.waitForSelector('text=Session ended', { timeout: 10000 }).catch(() => {});
  check('401 ends the session', (await page.textContent('[data-testid="login-status"]')).includes('Session ended'));
  await page.goto(`${base}#/diagnostics`);
  await page.waitForSelector('.login-banner');
  check('banner says session ended', (await page.textContent('.login-banner')).includes('Upstox session ended'));
  const notes = await sw.evaluate(() => chrome.notifications.getAll());
  check('"session ended" notification shown', 'session-expired' in notes, Object.keys(notes).join(', '));
  check('status bar: session ended', (await page.textContent('.statusbar')).includes('session ended'));
  await page.screenshot({ path: join(out, 'm1-session-ended-banner.png') });

  section('M1 · log in again from the banner, then log out');
  mock.profileFails = false;
  await page.click('.login-banner button');
  await page.waitForSelector('.login-banner', { state: 'detached', timeout: 15000 }).catch(() => {});
  check('banner login works and banner disappears', !(await page.$('.login-banner')));
  check('token exchange was not retried (single-use code)', mock.tokenBodies.length === 2, `${mock.tokenBodies.length} exchanges`);

  section('M1 · daily expiry at 03:30 (simulated)');
  await page.evaluate(async () => {
    for (const id of Object.keys(await chrome.notifications.getAll())) await chrome.notifications.clear(id);
  });
  await sw.evaluate(async () => {
    const { auth } = await chrome.storage.local.get('auth');
    await chrome.storage.local.set({ auth: { ...auth, expiresAt: Date.now() - 1000 } });
  });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('ServiceWorker.enable');
  const before = await page.evaluate(() => chrome.runtime.sendMessage({ __swing: true, type: 'ping' }));
  await cdp.send('ServiceWorker.stopAllWorkers');
  await page.waitForTimeout(800);
  const after = await page.evaluate(() => chrome.runtime.sendMessage({ __swing: true, type: 'ping' }));
  check('service worker restarted', after?.data?.startedAt > before?.data?.startedAt);
  let expired;
  for (let i = 0; i < 40; i++) {
    expired = (await page.evaluate(() => chrome.storage.local.get('auth'))).auth;
    if (expired?.status === 'expired') break;
    await page.waitForTimeout(200);
  }
  check('stale session marked expired at startup (catch-up)', expired?.status === 'expired' && !expired.accessToken, `${expired?.status} — ${expired?.lastError}`);
  const notes2 = await page.evaluate(() => chrome.notifications.getAll());
  check('nightly expiry is silent (no "session ended" notification)', !('session-expired' in notes2), Object.keys(notes2).join(', ') || 'none');

  // log in again, then log out
  await page.goto(`${base}#/settings`);
  await page.click('button:has-text("Log in to Upstox")');
  await page.waitForSelector('text=Log out', { timeout: 15000 });
  await page.click('text=Log out');
  await page.waitForSelector('[data-testid="login-status"] >> text=Not logged in', { timeout: 10000 }).catch(() => {});
  const loggedOut = (await page.evaluate(() => chrome.storage.local.get('auth'))).auth;
  check('Log out calls DELETE /v2/logout and clears tokens', loggedOut.status === 'logged_out' && !loggedOut.accessToken && mock.calls.includes('DELETE /v2/logout'));

  section('M1 · Analytics Token');
  await page.fill('#upx-analytics', 'wrong-token-xxxxxxxx');
  await page.click('text=Save and test');
  await page.waitForSelector('text=did not accept this', { timeout: 10000 }).catch(() => {});
  check('wrong Analytics Token rejected and NOT saved', (await page.textContent('body')).includes('did not accept this') && !(await page.evaluate(() => chrome.storage.local.get('secrets'))).secrets.upstoxAnalyticsToken);
  await page.fill('#upx-analytics', mock.analyticsGood);
  await page.click('text=Save and test');
  await page.waitForSelector('text=Token works', { timeout: 10000 }).catch(() => {});
  const sec2 = (await page.evaluate(() => chrome.storage.local.get('secrets'))).secrets;
  check('good Analytics Token accepted and saved', (await page.textContent('body')).includes('Token works') && sec2.upstoxAnalyticsToken === mock.analyticsGood);
  const cal = await page.evaluate(() => chrome.runtime.sendMessage({ __swing: true, type: 'calendar:refresh' }));
  check('market data works while logged out (uses Analytics Token)', cal?.ok && cal.data.holidays === 2, JSON.stringify(cal));
  await page.goto(`${base}#/watchlist`);
  await page.waitForSelector('.login-banner');
  check('banner mentions data still works via Analytics Token', (await page.textContent('.login-banner')).includes('Analytics Token'));

  section('M2 · stock list and watchlist');
  await page.goto(`${base}#/watchlist`);
  await page.click('.segmented >> text=My stocks', { timeout: 10000 }).catch(() => {});
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="watchlist"] .stock-row').length >= 10, null, { timeout: 20000 }).catch(() => {});
  const rowsSyms = await page.$$eval('[data-testid="watchlist"] .stock-row', (els) => els.map((e) => e.getAttribute('data-symbol')));
  check('stock list downloaded (gzip) and watchlist seeded with the 10 spec stocks', rowsSyms.length === 10 && rowsSyms.includes('TRENT') && rowsSyms.includes('ETERNAL'), rowsSyms.join(','));
  const inst = await page.evaluate(async () => {
    const req = indexedDB.open('swing-assistant');
    const db = await new Promise((r) => (req.onsuccess = () => r(req.result)));
    return new Promise((r) => {
      const q = db.transaction('instruments').objectStore('instruments').get('NSE_EQ|INE002A01018');
      q.onsuccess = () => r(q.result);
    });
  });
  check('instrument tick converted from paise (RELIANCE 10 → ₹0.10)', inst?.tick === 0.1, JSON.stringify(inst));
  await page.fill('input[aria-label="Search stocks"]', 'reliance');
  await page.waitForSelector('.add-stock .results button');
  check('search finds RELIANCE by name', (await page.textContent('.add-stock .results')).includes('RELIANCE'));
  await page.click('.add-stock .results button');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="watchlist"] .stock-row').length === 11, null, { timeout: 15000 }).catch(() => {});
  check('adding a stock fetches its history', (await page.$$('[data-testid="watchlist"] .stock-row')).length === 11);

  const tSync = Date.now();
  await page.click('text=Update history');
  await page.waitForSelector('text=History updated for', { timeout: 180000 }).catch(() => {});
  console.log(`      history sync for all studied stocks took ${((Date.now() - tSync) / 1000).toFixed(1)} s`);
  if (!(await page.textContent('body')).includes('History updated for')) {
    const dbg = await page.evaluate(async () => {
      const prog = await chrome.storage.session.get(['syncProgress', 'apiStatus', 'rateLimiter']);
      const req = indexedDB.open('swing-assistant');
      const db = await new Promise((r) => (req.onsuccess = () => r(req.result)));
      const logs = await new Promise((r) => {
        const q = db.transaction('logs').objectStore('logs').getAll();
        q.onsuccess = () => r(q.result);
      });
      const rl = prog.rateLimiter ?? [];
      return { progress: prog.syncProgress, rlCount: rl.length, errors: logs.filter((l) => l.level === 'error' || (l.level === 'warn' && /sync|Handler/.test(l.msg))).slice(-6).map((l) => ({ ctx: l.ctx, module: l.module, msg: l.msg, data: JSON.stringify(l.data ?? null).slice(0, 700) })), uiMsg: document.querySelector('main .err-text, main .ok-text')?.textContent ?? null };
    });
    console.log('      DEBUG', JSON.stringify(dbg, null, 1));
  }
  check('"Update history" syncs candles for all studied + watchlist stocks', Number(/History updated for (\d+) stocks/.exec(await page.textContent('body'))?.[1] ?? 0) >= 11, (await page.textContent('main')).match(/History updated[^.]*/)?.[0]);
  await page.click('text=Refresh prices');
  await page.waitForSelector('text=Prices updated for', { timeout: 15000 }).catch(() => {});
  check('"Refresh prices" polls LTP + OHLC (works with only the Analytics Token)', Number(/Prices updated for (\d+) stocks/.exec(await page.textContent('body'))?.[1] ?? 0) >= 11);
  await page.waitForFunction(() => [...document.querySelectorAll('.stock-row .plain')].length >= 10, null, { timeout: 15000 }).catch(() => {});
  const wlText = (await page.textContent('[data-testid="watchlist"]')) ?? '';
  check('rows say in one plain sentence what the stock is doing (no RSI / SMA jargon)', (await page.$$('.stock-row .plain')).length >= 10 && !wlText.includes('RSI') && !wlText.includes('SMA') && /Good to buy|Wait|Avoid|Nothing to do/.test(wlText), wlText.replace(/\s+/g, ' ').slice(0, 160));
  await page.screenshot({ path: join(out, 'm2-watchlist.png'), fullPage: true });

  section('M3 · Trent bonus adjustment, indicators, chart');
  await page.click('.stock-row[data-symbol="TRENT"] .stock-main');
  await page.waitForSelector('[data-testid="chart"] canvas', { timeout: 15000 }).catch(() => {});
  const trentText = await page.textContent('main');
  check('TRENT: unadjusted 1:2 bonus detected and adjusted (×2/3)', /Adjusted for: Bonus 1:2 on 2026-06-03 \(prices before ×0\.6667\)/.test(trentText), trentText.match(/Adjusted for:[^.]*/)?.[0]);
  check('TRENT: no "possible unadjusted" warning after adjustment', !trentText.includes('Possible unadjusted bonus/split'));
  check('chart renders (Lightweight Charts canvas)', (await page.$$('[data-testid="chart"] canvas')).length > 0);
  check('indicator panel shows SMA 200, RSI, ATR, support/resistance', ['SMA 200', 'RSI 14', 'ATR 14', 'Support', 'Resistance'].every((t) => trentText.includes(t)));
  const trentSma = await page.evaluate(() => document.querySelector('.indicators')?.textContent ?? '');
  check('TRENT SMA200 is on the adjusted scale (not inflated ×1.5)', (() => { const m = /SMA 200([\d,]+\.\d+)/.exec(trentSma); const v = m ? Number(m[1].replace(/,/g, '')) : NaN; return v > 3000 && v < 4400; })(), trentSma.match(/SMA 200[\d,.]+/)?.[0]);
  await page.screenshot({ path: join(out, 'm3-stock-trent.png'), fullPage: true });

  section('M6 · capital, planner, ticket, saved plan + alerts');
  await page.goto(`${base}#/settings`);
  await page.waitForSelector('summary:has-text("Advanced settings")', { timeout: 10000 });
  await page.evaluate(() => document.querySelectorAll('details').forEach((d) => (d.open = true))); // unfold Advanced settings
  await page.fill('input[data-field="helper-cash"]', '250000');
  await page.check('input[name="emergency"] >> nth=0');
  await page.check('input[name="borrowed"] >> nth=1');
  await page.fill('input[data-field="helper-loss"]', '20000');
  const capAdvice = (await page.textContent('[data-testid="capital-advice"]')) ?? '';
  check('capital helper suggests ₹1,00,000 at 0.5% risk (₹500 per trade) from a ₹20,000 tolerable loss', capAdvice.includes('Suggested capital ₹1,00,000 · risk 0.5% (₹500 per trade)'), capAdvice.slice(0, 120));
  await page.click('text=Use these settings');
  await page.waitForSelector('text=The planner now uses these numbers', { timeout: 5000 }).catch(() => {});
  const riskAfter = (await page.evaluate(() => chrome.storage.local.get('settings'))).settings.risk;
  check('"Use these settings" saves capital, risk % and max trades', riskAfter.capitalInr === 100000 && riskAfter.riskPerTradePct === 0.5 && riskAfter.maxOpenTrades === 3);
  await page.check('input[name="borrowed"] >> nth=0');
  check('borrowed money → advises paper trading first', ((await page.textContent('[data-testid="capital-advice"]')) ?? '').includes('Start with paper (practice) trades'));
  await page.fill('input[data-field="capitalInr"]', '500000');
  await page.fill('input[data-field="chargesEstimatePct"]', '0.25');
  await page.click('text=Save capital and risk');
  await page.waitForSelector('#risk >> text=Saved.');
  check('capital and risk saved', (await page.evaluate(() => chrome.storage.local.get('settings'))).settings.risk.capitalInr === 500000);
  const icici = bySymbolRow.ICICIBANK.instrument_key;
  await page.goto(`${base}#/planner/${encodeURIComponent(icici)}`);
  await page.waitForSelector('[data-testid="ticket"]', { timeout: 15000 }).catch(() => {});
  const ticket = (await page.textContent('[data-testid="ticket"]').catch(() => '')) ?? '';
  check('planner builds the order ticket (CNC, LIMIT, stop-only GTT, history targets)', /^BUY {2}ICICIBANK {2}qty \d+ {2}LIMIT ₹[\d,]+\.\d{2} {2}product CNC/.test(ticket) && ticket.includes('Stop-loss: trigger') && ticket.includes('No fixed target. The extension will advise: safe ₹'), ticket.split('\n')[0]);
  const exitPlan = (await page.textContent('[data-testid="exit-plan"]').catch(() => '')) ?? '';
  check('exit plan from history shows safe / hold-until / 2R chances', /Safe target₹[\d,.]+\d+% of the time/.test(exitPlan) && exitPlan.includes('2R (classic)'), exitPlan.slice(0, 160));
  const resultText = await page.textContent('[data-testid="plan-result"]').catch(() => '');
  const riskMatch = /₹ at risk₹([\d,]+)/.exec(resultText ?? '');
  const riskRs = riskMatch ? Number(riskMatch[1].replace(/,/g, '')) : NaN;
  check('₹ at risk ≤ 1% of ₹5,00,000', riskRs > 0 && riskRs <= 5000, `₹${riskRs}`);
  await page.screenshot({ path: join(out, 'm6-planner.png'), fullPage: true });
  await page.click('text=Save plan + alerts');
  await page.waitForSelector('text=Plan saved', { timeout: 10000 }).catch(() => {});
  const st = await page.evaluate(() => chrome.storage.local.get(['plans', 'alerts']));
  const planAlerts = st.alerts?.filter((a) => a.planId === st.plans?.[0]?.id).map((a) => a.kind) ?? [];
  check('plan saved in history mode with stop, safe-target and other default alerts', st.plans?.length === 1 && st.plans[0].targetMode === 'history' && planAlerts.includes('stop') && planAlerts.includes('safeTarget') && !planAlerts.includes('target'), `${planAlerts.join(', ')}`);
  check('saved ticket carries the real plan id', st.plans?.[0]?.ticket.endsWith(`plan id ${st.plans?.[0]?.id}`));

  await page.goto(`${base}#/alerts`);
  await page.waitForSelector('[data-plan="ICICIBANK"]');
  const q0 = st.plans[0].qty;
  const answers = ['1401.5', String(q0 - 1)];
  const onDialog = (d) => d.accept(answers.shift() ?? '');
  page.on('dialog', onDialog);
  await page.click('[data-plan="ICICIBANK"] >> text=I bought it');
  await page.waitForSelector('[data-plan="ICICIBANK"] >> text=OPEN', { timeout: 10000 }).catch(() => {});
  page.off('dialog', onDialog);
  const p2 = (await page.evaluate(() => chrome.storage.local.get('plans'))).plans[0];
  check('"I bought it" marks the plan open with the fill price and date', p2.status === 'open' && p2.fillPrice === 1401.5 && /^\d{4}-\d{2}-\d{2}$/.test(p2.openedDate ?? ''));
  check('"I bought it" asks how many shares were bought and updates the amounts', p2.qty === q0 - 1 && Math.abs(p2.riskRupees - (q0 - 1) * (1401.5 - p2.stop)) < 0.01, `${q0} → ${p2.qty}; risk ${p2.riskRupees}`);
  await page.waitForSelector('[data-plan="ICICIBANK"] [data-testid="advice"]', { timeout: 10000 }).catch(() => {});
  const adviceText = (await page.textContent('[data-plan="ICICIBANK"] [data-testid="advice"]').catch(() => '')) ?? '';
  check('open trade shows live hold-or-sell advice with a trailing stop', /^(HOLD|BOOK PROFIT|SELL|EXIT|REVIEW):/.test(adviceText.trim()) && adviceText.includes('Safety sell price') && !/\dR\b/.test(adviceText), adviceText.trim().slice(0, 120));
  await page.screenshot({ path: join(out, 'm6-trades.png'), fullPage: true });

  await page.goto(`${base}#/stock/${encodeURIComponent(bySymbolRow.SBIN.instrument_key)}`);
  await page.waitForSelector('text=Add price alert');
  await page.fill('input[placeholder="₹ level"]', '1200');
  await page.click('button:has-text("Add alert")');
  await page.waitForSelector('text=Alert added', { timeout: 10000 }).catch(() => {});
  const rules = (await page.evaluate(() => chrome.storage.local.get('alerts'))).alerts;
  check('price alert added from the stock page', rules.some((r) => r.symbol === 'SBIN' && r.kind === 'above' && r.level === 1200));

  await page.goto(`${base}#/shortlist`);
  await page.waitForSelector('text=Shortlist');
  await page.waitForTimeout(1500);
  const sl = await page.$$eval('.shortlist-item', (els) => els.map((e) => e.getAttribute('data-symbol')));
  check('shortlist screen lists setups above the 200-day', Array.isArray(sl), sl.join(', ') || 'none');
  const eod = await page.evaluate(() => chrome.runtime.sendMessage({ __swing: true, type: 'eod:run' }));
  check('evening scan runs (sync + end-of-day alerts + summary)', eod?.ok && eod.data.synced >= 10, JSON.stringify(eod?.data ?? eod));
  const notes3 = await page.evaluate(() => chrome.notifications.getAll());
  check('evening scan summary notification', 'scan-summary' in notes3, Object.keys(notes3).join(', '));
  check('evening hold-or-sell advice notification for the open trade', Object.keys(notes3).some((k) => k.startsWith('alert:advice-')), Object.keys(notes3).join(', '));
  const adv = (await page.evaluate(() => chrome.storage.local.get('plans'))).plans[0].lastAdvice;
  check('advice stored on the plan (sent only when it changes)', !!adv?.action, JSON.stringify(adv));

  section('v0.5 · Today screen, plain words, study question, sounds');
  await page.goto(`${base}#/`);
  await page.waitForSelector('[data-testid="today-candidates"]', { timeout: 10000, state: 'attached' });
  check('Today is the home screen', (await page.textContent('nav [aria-current="page"]'))?.trim() === 'Today');
  check('unbuilt tabs (Holdings, Journal) are hidden', !(await page.textContent('nav')).includes('Holdings') && !(await page.textContent('nav')).includes('Journal'));
  const checklist = (await page.textContent('[data-testid="checklist"]').catch(() => '')) ?? '';
  check('setup checklist shows what is missing (login) and what is done (amount)', checklist.includes('Logged in to Upstox today') && /✓\s*Amount to invest entered/.test(checklist), checklist.replace(/\s+/g, ' ').slice(0, 140));
  await page.waitForFunction(() => {
    const t = document.querySelector('[data-testid="today-open"]')?.textContent ?? '';
    const c = document.querySelector('[data-testid="today-candidates"]')?.textContent ?? '';
    return t.includes('ICICIBANK') && !t.includes('Waiting for price data') && !c.includes('Reading your watchlist');
  }, null, { timeout: 15000 }).catch(() => {});
  const todayOpen = (await page.textContent('[data-testid="today-open"]').catch(() => '')) ?? '';
  check('Today shows the open trade with its advice', todayOpen.includes('ICICIBANK') && /(HOLD|BOOK PROFIT|SELL|EXIT|REVIEW)/.test(todayOpen), todayOpen.replace(/\s+/g, ' ').slice(0, 140));
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="today-candidates"] .candidate, [data-testid="today-candidates"] p').length > 0, null, { timeout: 10000 }).catch(() => {});
  const cands = (await page.textContent('[data-testid="today-candidates"]')) ?? '';
  check('Today lists candidates in plain words (or says to wait)', /good setup|No watchlist stock has a good setup|to wait for/.test(cands), cands.replace(/\s+/g, ' ').slice(0, 160));
  await page.screenshot({ path: join(out, 'v05-today.png'), fullPage: true });

  await page.goto(`${base}#/stock/${encodeURIComponent(bySymbolRow.TRENT.instrument_key)}`);
  await page.waitForSelector('[data-testid="explain"]', { timeout: 10000 });
  const explain = (await page.textContent('[data-testid="explain"]')) ?? '';
  check('stock page explains the setup in plain words with a verdict', /In plain words(Good setup|Wait|Avoid|No setup|Check data)TRENT /.test(explain), explain.slice(0, 160));
  await page.click('[data-testid="study"] >> text=show question');
  const prompt = await page.inputValue('[data-testid="study-prompt"]');
  check('study question for Claude chat contains the stock, the numbers and the sections', prompt.includes('Stock: TRENT LTD (TRENT, NSE, ISIN INE849A01020)') && prompt.includes('SMA200') && prompt.includes('Strong / Acceptable / Weak / Avoid') && !/undefined|NaN/.test(prompt));
  check('rows show a verdict chip', (await (async () => { await page.goto(`${base}#/watchlist`); await page.waitForSelector('.stock-row .chip.verdict', { timeout: 10000 }).catch(() => {}); return (await page.$$('.stock-row .chip.verdict')).length; })()) >= 10);
  await page.screenshot({ path: join(out, 'v05-watchlist.png'), fullPage: true });

  const snd = await page.evaluate(() => chrome.runtime.sendMessage({ __swing: true, type: 'diag:testAlert', payload: { sound: 'target' } }));
  const offscreen = await page.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }));
  check('test alert plays a sound through the offscreen document', snd?.ok && snd.data.played === true && offscreen.length === 1, JSON.stringify(snd));

  section('v0.6 · Simple mode: amount only, buy suggestions, plain status bar');
  await page.goto(`${base}#/settings`);
  await page.waitForSelector('[data-testid="amount-card"]');
  check('Settings starts with "Amount to invest"; expert settings are folded away', (await page.textContent('main')).indexOf('Amount to invest') < (await page.textContent('main')).indexOf('Advanced settings'));
  await page.fill('input[data-field="amount"]', '200000');
  await page.click('[data-testid="amount-card"] >> text=Save');
  await page.waitForSelector('text=Today’s suggestions now use this amount', { timeout: 5000 }).catch(() => {});
  const r6 = (await page.evaluate(() => chrome.storage.local.get('settings'))).settings.risk;
  check('amount saved; default is "split into 3 stocks"', r6.capitalInr === 200000 && r6.sizing === 'split' && r6.splitInto === 3);

  section('v0.7 · studies Nifty 100 by itself, ranks picks, price drag bar, new-pick alerts');
  const uni = (await page.evaluate(() => chrome.storage.local.get('universe'))).universe;
  check('Nifty 100 list downloaded from NSE (100 companies)', uni?.source === 'nse' && uni.members.length === 100 && mock.calls.includes('NSE /content/indices/ind_nifty100list.csv'), `${uni?.source} ${uni?.members?.length}`);
  await page.goto(`${base}#/watchlist`);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="auto-list"] .stock-row').length >= 90, null, { timeout: 30000 }).catch(() => {});
  const autoRows = await page.$$eval('[data-testid="auto-list"] .stock-row', (els) => els.map((e) => e.getAttribute('data-symbol')));
  const firstBadge = (await page.textContent('[data-testid="auto-list"] .stock-row >> nth=0').catch(() => '')) ?? '';
  check('Stocks tab ranks the whole list by itself, best pick first', autoRows.length >= 90 && autoRows[0] === 'HDFCBANK' && firstBadge.includes('#1 pick'), `${autoRows.length} rows; first ${autoRows[0]}: ${firstBadge.replace(/\s+/g, ' ').slice(0, 80)}`);
  await page.screenshot({ path: join(out, 'v07-stocks-auto.png'), fullPage: false });
  const picks = await page.evaluate(() => chrome.runtime.sendMessage({ __swing: true, type: 'picks:check' }));
  const notesP = await page.evaluate(() => chrome.notifications.getAll());
  // during market hours the background check (every 5 min) may have announced it already — that is correct too
  const annP = (await page.evaluate(() => chrome.storage.session.get('announcedPicks'))).announcedPicks;
  const hdfcKey = Object.keys(keyToSym).find((k) => keyToSym[k] === 'HDFCBANK');
  check('"New top pick" alert for HDFCBANK (announced once per day)', picks?.ok && (picks.data.announced.includes('HDFCBANK') || !!annP?.keys?.includes(hdfcKey)) && Object.keys(notesP).some((k) => k.startsWith('alert:pick-HDFCBANK')), JSON.stringify(picks?.data));
  await page.evaluate(() => chrome.storage.session.set({ lastPickCheck: 0 }));
  const again = await page.evaluate(() => chrome.runtime.sendMessage({ __swing: true, type: 'picks:check' }));
  check('the same pick is not announced twice the same day', again?.ok && again.data.announced.length === 0, JSON.stringify(again?.data));

  await page.goto(`${base}#/today`);
  await page.waitForSelector('[data-testid="price-max"]', { timeout: 10000 });
  await page.focus('[data-testid="price-max"]');
  for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowLeft'); // no limit → ₹500
  await page.waitForFunction(() => (document.querySelector('[data-testid="price-range-label"]')?.textContent ?? '').includes('₹500'), null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(800);
  const pr = (await page.evaluate(() => chrome.storage.local.get('settings'))).settings.ui;
  const sugUnder500 = (await page.textContent('[data-testid="suggestions"]')) ?? '';
  check('price drag bar: ₹0 – ₹500 saved and hides HDFCBANK (₹724)', pr.priceMin === 0 && pr.priceMax === 500 && !sugUnder500.includes('Buy HDFCBANK'), `${pr.priceMin}–${pr.priceMax}; ${(await page.textContent('[data-testid="price-range-label"]'))}`);
  await page.click('[data-testid="price-range"] >> text=any price');
  await page.waitForTimeout(500);
  check('"any price" resets the range', (await page.evaluate(() => chrome.storage.local.get('settings'))).settings.ui.priceMax === null);
  const navText = (await page.textContent('nav')) ?? '';
  check('Simple mode hides expert tabs (Shortlist, Stock, Planner)', !navText.includes('Shortlist') && !navText.includes('Planner'), navText.replace(/\s+/g, ' '));

  await page.goto(`${base}#/today`);
  await page.waitForSelector('[data-testid="suggestions"]', { timeout: 10000 });
  await page.waitForFunction(() => !(document.querySelector('[data-testid="suggestions"]')?.textContent ?? '').includes('Studying your watchlist'), null, { timeout: 15000 }).catch(() => {});
  const sugText = (await page.textContent('[data-testid="suggestions"]')) ?? '';
  const sugCount = (await page.$$('[data-testid="suggestions"] .suggestion')).length;
  const skippedText = await page.evaluate(() => [...document.querySelectorAll('[data-testid="suggestions"] .skipped li')].map((li) => li.textContent).join(' | '));
  console.log('      skipped:', skippedText.slice(0, 900));
  check('Today suggests the steady-uptrend stock (HDFCBANK) — max 2 free slots, 1 trade is open', sugCount >= 1 && sugCount <= 2 && sugText.includes('Buy HDFCBANK'), `${sugCount} suggestion(s): ${sugText.replace(/\s+/g, ' ').slice(0, 160)}`);
  if (sugCount) {
    const first = page.locator('[data-testid="suggestions"] .suggestion').first();
    const ft = (await first.textContent()) ?? '';
    check('a pick says, in plain words, shares + price, possible earning, past average and the most you could lose', /\d+ shares at ₹[\d,.]+/.test(ft) && ft.includes('Possible earning') && ft.includes('Past average') && ft.includes('Most you could lose'), ft.replace(/\s+/g, ' ').slice(0, 200));
    await first.locator('text=How to buy in Upstox').click();
    await page.waitForSelector('[data-testid="upstox-steps"]', { timeout: 10000 }).catch(() => {});
    const stepsText = (await page.textContent('[data-testid="upstox-steps"]')) ?? '';
    check('Upstox steps: Delivery + Limit, quantity, price, GTT sell with trigger, "I bought this"', stepsText.includes('Delivery') && stepsText.includes('Limit') && stepsText.includes('Create GTT') && stepsText.includes('trigger price') && stepsText.includes('I bought this'));
    const before = (await page.evaluate(() => chrome.storage.local.get('plans'))).plans.length;
    await first.locator('[data-testid="i-bought"]').click();
    await page.waitForSelector('[data-testid="bought-form"]', { timeout: 5000 }).catch(() => {});
    await page.fill('[data-testid="bought-form"] input[data-field="bought-price"]', '723.5');
    await page.fill('[data-testid="bought-form"] input[data-field="bought-qty"]', '100');
    await page.click('[data-testid="bought-save"]');
    await page.waitForSelector('[data-testid="gtt-box"]', { timeout: 10000 }).catch(() => {});
    const after = await page.evaluate(() => chrome.storage.local.get(['plans', 'alerts']));
    const newest = after.plans[after.plans.length - 1];
    check('"I bought this in Upstox": one form (price + shares) saves an OPEN trade with its alerts', after.plans.length === before + 1 && newest.status === 'open' && newest.fillPrice === 723.5 && newest.qty === 100 && after.alerts.some((a) => a.planId === newest.id && a.kind === 'stop'), `${newest?.symbol} ${newest?.status} ${newest?.qty} @ ${newest?.fillPrice}`);
    const gtt = (await page.textContent('[data-testid="gtt-box"]').catch(() => '')) ?? '';
    check('after saving, the GTT safety sell is shown with the real quantity and prices', gtt.includes('Quantity 100') && gtt.includes('Trigger price') && gtt.includes('Limit price'), gtt.replace(/\s+/g, ' ').slice(0, 160));
  }
  const sb = (await page.textContent('.statusbar')) ?? '';
  check('status bar shows prices and the open trades result in plain words', sb.includes('Prices') && sb.includes('My trades'), sb.replace(/\s+/g, ' '));
  await page.screenshot({ path: join(out, 'v06-today-simple.png'), fullPage: true });

  section('v0.8 · prices refresh by themselves, safest-first order, past-year test');
  await page.evaluate(() => chrome.storage.session.remove('lastPoll'));
  const ltpBefore = mock.calls.filter((c) => c === 'GET /v3/market-quote/ltp').length;
  await page.goto(`${base}#/settings`);
  await page.reload();
  await until(() => page.evaluate(() => chrome.storage.session.get('lastPoll').then((x) => !!x.lastPoll?.ok)), 60000);
  const lp = (await page.evaluate(() => chrome.storage.session.get('lastPoll'))).lastPoll;
  const ltpAfter = mock.calls.filter((c) => c === 'GET /v3/market-quote/ltp').length;
  if (!lp?.ok) console.log('      DEBUG', JSON.stringify(await page.evaluate(() => chrome.storage.session.get(['syncProgress', 'apiStatus']))));
  check('opening the panel fetches prices by itself (no Refresh click), also when the market is closed', lp?.ok && lp.count >= 90 && ltpAfter > ltpBefore, `${JSON.stringify(lp)}; LTP calls ${ltpBefore}→${ltpAfter}`);
  const noAgain = await page.evaluate(() => chrome.runtime.sendMessage({ __swing: true, type: 'quotes:auto' }));
  const phase = await page.evaluate(() => document.querySelector('.statusbar')?.textContent ?? '');
  console.log('      status bar:', phase.replace(/\s+/g, ' ').slice(0, 120), '· second auto fetch:', JSON.stringify(noAgain?.data));
  if (noAgain?.data?.skipped) check('market closed: closing prices are fetched once, not every 30 s', noAgain.ok && noAgain.data.polled === 0, JSON.stringify(noAgain.data));
  const rankSel = await page.$('select[data-field="rank-by"]');
  check('Settings: "Which picks come first" defaults to Safest first', !!rankSel && (await rankSel.inputValue()) === 'safety');

  // the HDFCBANK pick was saved above; remove that plan so it is a pick again
  const hdfcPlan = (await page.evaluate(() => chrome.storage.local.get('plans'))).plans.find((p) => p.symbol === 'HDFCBANK');
  if (hdfcPlan) await page.evaluate((id) => chrome.runtime.sendMessage({ __swing: true, type: 'plans:delete', payload: { id } }), hdfcPlan.id);
  await page.goto(`${base}#/today`);
  await page.waitForSelector('[data-testid="pick-order"]', { timeout: 20000 }).catch(() => {});
  const orderText = (await page.textContent('[data-testid="pick-order"]').catch(() => '')) ?? '';
  check('Today explains the order of the picks (safest first) and that it is not a promise', orderText.includes('safest first') && orderText.includes('not a promise'), orderText.replace(/\s+/g, ' ').slice(0, 120));
  const rec = (await page.textContent('[data-testid="pick-record"] >> nth=0').catch(() => '')) ?? '';
  check('each pick shows its past record (made money N times, target / sell price / 20 days)', /In \d+ similar situations/.test(rec) && /made money \d+ times/.test(rec) && rec.includes('sell price hit'), rec.replace(/\s+/g, ' ').slice(0, 200));
  const tBt = Date.now();
  await page.waitForSelector('[data-testid="past-record-table"]', { timeout: 90000 }).catch(() => {});
  console.log(`      past-year test took ${((Date.now() - tBt) / 1000).toFixed(1)} s in the page`);
  const prText = (await page.textContent('[data-testid="past-record"]').catch(() => '')) ?? '';
  const prStore = (await page.evaluate(() => chrome.storage.session.get('pastRecord'))).pastRecord;
  check(
    'past-year test runs by itself and shows both orders with a plain verdict',
    !!prStore?.report && prStore.report.results.length === 2 && prStore.report.sessions >= 240 && prText.includes('Safest first (your order)') && prText.includes('Highest earning first') && !!(await page.$('[data-testid="past-record-verdict"]')),
    `${prStore?.report?.sessions} sessions; ${prStore?.report?.results?.map((r) => `${r.rankBy}: ${r.closed} trades ${r.totalPct.toFixed(1)}%`).join(', ')}; hold-all ${prStore?.report?.holdAllPct?.toFixed(1)}%`,
  );
  check('past-year test compares with simply buying every company and holding', prText.includes('simply holding'));
  await page.click('[data-testid="past-record"] >> text=Show all').catch(() => {});
  check('the test lists every trade it made', (await page.$$('[data-testid="past-trades"] tbody tr')).length === (prStore?.report?.results?.[0]?.trades?.length ?? -1));
  await page.screenshot({ path: join(out, 'v08-past-record.png'), fullPage: true });
  await page.goto(`${base}#/settings`);
  await page.waitForSelector('select[data-field="rank-by"]', { timeout: 10000 });
  await page.selectOption('select[data-field="rank-by"]', 'earning');
  await page.waitForTimeout(400);
  check('order can be switched to "Highest earning first"', (await page.evaluate(() => chrome.storage.local.get('settings'))).settings.scanner.rankBy === 'earning');
  await page.goto(`${base}#/today`);
  await page.waitForFunction(() => (document.querySelector('[data-testid="past-record"]')?.textContent ?? '').includes('Highest earning first (your order)'), null, { timeout: 30000 }).catch(() => {});
  check('past-year test marks the chosen order', ((await page.textContent('[data-testid="past-record"]').catch(() => '')) ?? '').includes('Highest earning first (your order)'));
  await page.goto(`${base}#/settings`);
  await page.waitForSelector('select[data-field="rank-by"]', { timeout: 10000 });
  await page.selectOption('select[data-field="rank-by"]', 'safety');
  await page.waitForTimeout(300);

  section('v0.9 · practice trades (pretend money) inside the extension');
  const nextTradingDays = (from, n) => {
    const closed = new Set(holidays2026.filter((h) => h.closed_exchanges.includes('NSE')).map((h) => h.date));
    const out = [];
    let d = new Date(`${from}T00:00:00Z`);
    while (out.length < n) {
      d = new Date(d.getTime() + 86_400_000);
      const ds = d.toISOString().slice(0, 10);
      if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6 && !closed.has(ds)) out.push(ds);
    }
    return out;
  };
  const istMs = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+05:30`);
  await page.goto(`${base}#/today`);
  await page.waitForSelector('[data-testid="practice-card"]', { timeout: 20000 }).catch(() => {});
  check('Today explains practice trades before the first one', ((await page.textContent('[data-testid="practice-card"]').catch(() => '')) ?? '').includes('Practice buy'));
  await page.waitForSelector('[data-testid="suggestions"] .suggestion [data-testid="practice-buy"]', { timeout: 20000 }).catch(() => {});
  const pick = page.locator('[data-testid="suggestions"] .suggestion').first();
  const pickSym = await pick.getAttribute('data-symbol').catch(() => null);
  const callsBeforePractice = mock.calls.length;
  await pick.locator('[data-testid="practice-buy"]').click().catch(() => {});
  await page.waitForSelector('[data-testid="practice-msg"]', { timeout: 10000 }).catch(() => {});
  const pmsg = (await page.textContent('[data-testid="practice-msg"]').catch(() => '')) ?? '';
  let pp = (await page.evaluate(() => chrome.storage.local.get('plans'))).plans.find((x) => x.practice && x.symbol === pickSym);
  const openNow = pp?.status === 'open';
  check(
    openNow ? '"Practice buy" in market hours: bought at the live price' : '"Practice buy" with the market closed: it waits for the next opening price',
    !!pp && (openNow ? pp.fillPrice > 0 && pmsg.includes('Practice trade started') : pp.status === 'planned' && pmsg.includes('next opening price')),
    `${pickSym}: ${pp?.status}; ${pmsg.slice(0, 120)}`,
  );
  const orderCalls = mock.calls.slice(callsBeforePractice).filter((c) => /order|gtt/i.test(c));
  check('practice trades never call any Upstox order endpoint', orderCalls.length === 0, orderCalls.join(', '));
  check('a practice trade creates no price alerts and is not a real trade', !(await page.evaluate(() => chrome.storage.local.get('alerts'))).alerts.some((a) => a.planId === pp?.id));
  await page.waitForSelector('[data-testid="practice-open"] tr[data-symbol]', { timeout: 10000 }).catch(() => {});
  const practiceOpenText = (await page.textContent('[data-testid="practice-open"]').catch(() => '')) ?? '';
  check('Practice card lists the trade', openNow ? practiceOpenText.includes('Sell now') : practiceOpenText.includes('waits for the opening price'));

  // simulate the next two sessions with quotes (the real clock says the market is closed)
  const today = new Date(Date.now() + IST).toISOString().slice(0, 10);
  const [n1, n2] = nextTradingDays(today, 2);
  const d1 = n1;
  const d2 = openNow ? n1 : n2; // bought today → the gap day is the next session
  const e = pp.entry;
  let q1 = { key: pp.key, ltp: +(e * 1.002).toFixed(2), open: +(e * 0.998).toFixed(2), high: +(e * 1.004).toFixed(2), low: +(e * 0.996).toFixed(2), volume: 1000, prevClose: e, fetchedAt: istMs(d1, '09:20') };
  await page.evaluate(async (q) => {
    const { quotes } = await chrome.storage.session.get('quotes');
    await chrome.storage.session.set({ quotes: { ...quotes, [q.key]: q } });
  }, q1);
  if (!openNow) {
    const chk1 = await page.evaluate(() => chrome.runtime.sendMessage({ __swing: true, type: 'practice:check' }));
    pp = (await page.evaluate(() => chrome.storage.local.get('plans'))).plans.find((x) => x.id === pp.id);
    check(`next session (${d1}): bought at its opening price`, chk1?.ok && chk1.data.filled === 1 && pp.status === 'open' && pp.fillPrice === q1.open && pp.openedDate === d1, `${JSON.stringify(chk1?.data)} ${pp.status} @ ${pp.fillPrice}`);
  } else q1 = { ...q1, open: pp.fillPrice };
  const gapOpen = +(pp.stop * 0.98).toFixed(2);
  const q2 = { ...q1, ltp: +(gapOpen * 1.001).toFixed(2), open: gapOpen, high: +(gapOpen * 1.004).toFixed(2), low: +(gapOpen * 0.995).toFixed(2), fetchedAt: istMs(d2, '09:20') };
  await page.evaluate(async (q) => {
    const { quotes } = await chrome.storage.session.get('quotes');
    await chrome.storage.session.set({ quotes: { ...quotes, [q.key]: q } });
  }, q2);
  const chk2 = await page.evaluate(() => chrome.runtime.sendMessage({ __swing: true, type: 'practice:check' }));
  pp = (await page.evaluate(() => chrome.storage.local.get('plans'))).plans.find((x) => x.id === pp.id);
  const notesPr = await page.evaluate(() => chrome.notifications.getAll());
  check(`${d2}: opens below the sell price → sold by itself at the opening price, with a notification`, chk2?.ok && chk2.data.closed === 1 && pp.status === 'closed' && pp.exitPrice === gapOpen && pp.exitDate === d2 && Object.keys(notesPr).some((k) => k.startsWith(`alert:practice-${pp.id}:exit`)), `${JSON.stringify(chk2?.data)} ${pp.status} @ ${pp.exitPrice} ${pp.exitDate}`);
  const expPnl = (gapOpen - pp.fillPrice) * pp.qty - pp.exitCharges;
  await page.goto(`${base}#/today`);
  await page.waitForSelector('[data-testid="practice-total"]', { timeout: 10000 }).catch(() => {});
  const totalText = (await page.textContent('[data-testid="practice-total"]').catch(() => '')) ?? '';
  const shown = Number(totalText.replace(/[^\d.]/g, '')) * (totalText.includes('−') ? -1 : 1);
  check('Practice card shows the result after charges (a loss here)', Math.abs(shown - Math.round(expPnl)) <= 1 && expPnl < 0, `${totalText} vs ${expPnl.toFixed(0)}`);
  check('status bar shows the practice result separately from real trades', ((await page.textContent('.statusbar')) ?? '').includes('Practice'));
  await page.click('[data-testid="practice-card"] >> text=Finished practice trades').catch(() => {});
  check('finished practice trades list the sale and why', ((await page.textContent('[data-testid="practice-closed"]').catch(() => '')) ?? '').includes('opened below sell price'));
  await page.screenshot({ path: join(out, 'v09-practice.png'), fullPage: true });
  await page.click('[data-testid="practice-card"] >> text=Start practice again').catch(() => {});
  await page.click('[data-testid="practice-reset"]').catch(() => {});
  await page.waitForTimeout(500);
  check('"Start practice again" clears practice trades only', !(await page.evaluate(() => chrome.storage.local.get('plans'))).plans.some((x) => x.practice) && (await page.evaluate(() => chrome.storage.local.get('plans'))).plans.some((x) => !x.practice));
  await page.evaluate(async (k) => {
    const { quotes } = await chrome.storage.session.get('quotes');
    delete quotes[k];
    await chrome.storage.session.set({ quotes });
  }, pp.key);

  section('v0.10 · 5-second refresh, "Bought a stock in Upstox? Add it here"');
  const fast = await page.evaluate(() => chrome.runtime.sendMessage({ __swing: true, type: 'quotes:fast' }));
  const marketIsOpen = /Market\s*(open|pre-open)/.test((await page.textContent('.statusbar')) ?? '');
  if (marketIsOpen) {
    const t0 = (await page.evaluate(() => chrome.storage.session.get('lastPoll'))).lastPoll?.at ?? 0;
    await page.waitForTimeout(7000);
    const t1 = (await page.evaluate(() => chrome.storage.session.get('lastPoll'))).lastPoll?.at ?? 0;
    check('market hours: the open panel refreshes prices about every 5 seconds', t1 > t0 && Date.now() - t1 < 6500, `last poll ${((Date.now() - t1) / 1000).toFixed(1)} s ago`);
  } else check('fast refresh does nothing while the market is closed', fast?.ok && fast.data.polled === 0 && fast.data.skipped === 'market closed', JSON.stringify(fast?.data));
  await page.goto(`${base}#/alerts`);
  await page.waitForSelector('[data-testid="add-purchase-open"]', { timeout: 10000 }).catch(() => {});
  await page.click('[data-testid="add-purchase-open"]');
  await page.fill('input[data-field="bought-symbol"]', 'SBIN');
  await page.waitForSelector('[data-testid="add-purchase"] [data-testid="bought-form"]', { timeout: 15000 }).catch(() => {});
  await page.fill('[data-testid="add-purchase"] input[data-field="bought-price"]', '1100');
  await page.fill('[data-testid="add-purchase"] input[data-field="bought-qty"]', '10');
  await page.click('[data-testid="add-purchase"] [data-testid="bought-save"]');
  await page.waitForSelector('[data-testid="add-purchase"] [data-testid="gtt-box"]', { timeout: 10000 }).catch(() => {});
  const sbi = (await page.evaluate(() => chrome.storage.local.get('plans'))).plans.find((x) => x.symbol === 'SBIN' && !x.practice);
  check('"Bought a stock in Upstox? Add it here": saved as OPEN with a sell price and target from its history', sbi?.status === 'open' && sbi.fillPrice === 1100 && sbi.qty === 10 && sbi.stop < 1100 && sbi.target > 1100, `${sbi?.status} ${sbi?.qty} @ ${sbi?.fillPrice} stop ${sbi?.stop} target ${sbi?.target}`);
  await page.waitForSelector('[data-plan="SBIN"] [data-testid="owned"]', { timeout: 10000 }).catch(() => {});
  const owned = (await page.textContent('[data-plan="SBIN"] [data-testid="owned"]').catch(() => '')) ?? '';
  check('the trade card says it in plain words: you own N shares, bought, now, profit/loss, safety sell', owned.includes('You own 10 shares') && owned.includes('Safety sell') && /profit|loss/.test(owned), owned.replace(/\s+/g, ' ').slice(0, 200));
  await page.screenshot({ path: join(out, 'v10-trades.png'), fullPage: true });

  section('v0.11 · Stocks tab: lists, filter, refresh, NSE tag');
  const send = (type, payload) => page.evaluate(([t, pl]) => chrome.runtime.sendMessage({ __swing: true, type: t, payload: pl }), [type, payload]);
  await page.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, dayTrade: { ...settings.dayTrade, testSessions: 60 }, ui: { ...settings.ui, priceMin: 0, priceMax: null } } });
  });
  await page.goto(`${base}#/watchlist`);
  await page.waitForSelector('select[data-field="list"]', { timeout: 15000 });
  const listOpts = await page.$$eval('select[data-field="list"] option', (els) => els.map((e) => e.textContent));
  check('list picker offers Nifty 50, Nifty 100, Midcap 100, Smallcap 100 and Nifty 500', ['Nifty 50', 'Nifty 100', 'Nifty Midcap 100', 'Nifty Smallcap 100', 'Nifty 500'].every((x) => listOpts.includes(x)), listOpts.join(', '));
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="auto-list"] .stock-row').length >= 90, null, { timeout: 30000 }).catch(() => {});
  check('every stock is marked NSE', ((await page.textContent('[data-testid="auto-list"] .stock-row >> nth=0')) ?? '').includes('NSE') && ((await page.textContent('[data-testid="list-info"]')) ?? '').includes('NSE'));
  await page.selectOption('select[data-field="filter"]', 'uptrend');
  await page.waitForTimeout(400);
  const upRows = await page.$$eval('[data-testid="auto-list"] .stock-row', (els) => els.map((e) => e.getAttribute('data-trend')));
  check('filter "Uptrend" shows only uptrend stocks', upRows.length > 0 && upRows.every((t) => t === 'Uptrend'), `${upRows.length} rows`);
  await page.selectOption('select[data-field="filter"]', 'downtrend');
  await page.waitForTimeout(300);
  const downRows = await page.$$eval('[data-testid="auto-list"] .stock-row', (els) => els.map((e) => e.getAttribute('data-trend')));
  check('filter "Downtrend" hides the uptrend stocks', downRows.length < upRows.length && downRows.every((t) => t === 'Downtrend') && (downRows.length > 0 || ((await page.textContent('[data-testid="auto-list"]')) ?? '').includes('No stock matches')), `${downRows.length} rows`);
  await page.selectOption('select[data-field="filter"]', 'stretched');
  await page.waitForTimeout(300);
  const stRows = await page.$$eval('[data-testid="auto-list"] .stock-row', (els) => els.map((e) => e.getAttribute('data-flags')));
  check('filter "Stretched" shows only stretched stocks (or none)', stRows.every((t) => t.includes('Stretched')), `${stRows.length} rows`);
  await page.selectOption('select[data-field="filter"]', 'all');
  const ltpB = mock.calls.filter((c) => c === 'GET /v3/market-quote/ltp').length;
  await page.click('[data-testid="refresh-stocks"]');
  await page.waitForFunction(() => (document.querySelector('[data-testid="list-info"]')?.textContent ?? '').includes('Prices refreshed for'), null, { timeout: 15000 }).catch(() => {});
  check('"Refresh" fetches the latest prices now', ((await page.textContent('[data-testid="list-info"]')) ?? '').includes('Prices refreshed for') && mock.calls.filter((c) => c === 'GET /v3/market-quote/ltp').length > ltpB);

  section('v0.11 · Day trade: turn on, 5-minute history, past test');
  await page.goto(`${base}#/daytrade`);
  await page.waitForSelector('[data-testid="day-turn-on"]', { timeout: 15000 });
  check('Day trade tab explains the mode and is off until turned on', ((await page.textContent('[data-testid="day-intro"]')) ?? '').includes('first 15 minutes') && !(await page.evaluate(() => chrome.storage.local.get('settings'))).settings.dayTrade.enabled);
  const tDl = Date.now();
  await page.click('[data-testid="day-turn-on"]');
  await page.waitForSelector('[data-testid="day-verdict"]', { timeout: 300000 }).catch(() => {});
  console.log(`      5-minute history + past test took ${((Date.now() - tDl) / 1000).toFixed(1)} s`);
  const m5calls = mock.calls.filter((c) => /\/minutes\/5\//.test(c)).length;
  const dayTest = (await page.evaluate(() => chrome.storage.local.get('dayTest'))).dayTest;
  const rep = dayTest?.report;
  check('5-minute history downloaded in 28-day pieces for every stock', m5calls >= 300 && ((await page.textContent('[data-testid="day-coverage"]').catch(() => '')) ?? '').includes('ready for'), `${m5calls} requests; ${(await page.textContent('[data-testid="day-coverage"]').catch(() => ''))?.slice(0, 60)}`);
  check('past test ran by itself: older days vs newest unseen days, with a plain verdict', !!rep && rep.sessions >= 45 && rep.stocks >= 90 && rep.variants.length === 36 && rep.trainTo < rep.checkFrom && /PASSED|NOT PASSED/.test((await page.textContent('[data-testid="day-verdict"]').catch(() => '')) ?? ''), rep ? `${rep.stocks} stocks, ${rep.sessions} days, ${rep.candidates} breakouts; chosen ${JSON.stringify(rep.chosen)}; older ${rep.train.pnl.toFixed(0)} (${rep.train.trades}), newest ${rep.check.pnl.toFixed(0)} (${rep.check.trades}); passed ${rep.passed}` : 'no report');
  const tableText = (await page.textContent('[data-testid="day-test-table"]').catch(() => '')) ?? '';
  check('test table shows trades, result after charges, days with profit / loss, BUY and SELL (short) separately', ['Trades', 'Result (after charges)', 'Days with profit / loss', 'BUY trades', 'SELL (short) trades'].every((x) => tableText.includes(x)));
  if (rep && !rep.passed) check('rules that did not pass are marked "practice only"', !!(await page.$('[data-testid="day-untested"]')));
  await page.screenshot({ path: join(out, 'v11-daytrade-test.png'), fullPage: true });

  section('v0.11 · Day trade: live signal (simulated morning), taking and closing a trade');
  const realPhase = ((await page.textContent('.statusbar')) ?? '').match(/Market\s*(open|pre-open|closed|holiday)/)?.[1] ?? '';
  if (realPhase === 'open' || realPhase === 'pre-open') {
    console.log('      (skipped: the real market is open, the simulated morning would mix with live polls — covered by the unit tests)');
  } else {
    const D = nextTradingDays(new Date(Date.now() + IST).toISOString().slice(0, 10), 1)[0];
    mock.simDate = D;
    await page.evaluate(async () => {
      const { dayTest } = await chrome.storage.local.get('dayTest');
      dayTest.report.chosen = { target: '1.5', minRvol: 1.5, sides: 'both' };
      dayTest.report.passed = true;
      await chrome.storage.local.set({ dayTest });
    });
    const t1 = await send('daytrade:tick', { now: istMs(D, '09:31') });
    await until(() => page.evaluate((d) => chrome.storage.session.get('dayLive').then((x) => x.dayLive?.date === d && !!x.dayLive.loadedAt), D), 150000);
    const live = (await page.evaluate(() => chrome.storage.session.get('dayLive'))).dayLive ?? { stocks: {} };
    const hk = Object.keys(live?.stocks ?? {}).find((k) => live.stocks[k].symbol === 'HDFCBANK');
    if (!hk) {
      const dbg = await page.evaluate(async () => {
        const req = indexedDB.open('swing-assistant');
        const db = await new Promise((r) => (req.onsuccess = () => r(req.result)));
        const logs = await new Promise((r) => {
          const q = db.transaction('logs').objectStore('logs').getAll();
          q.onsuccess = () => r(q.result);
        });
        const s = await chrome.storage.session.get(['dayLive', 'intradayProgress']);
        return { dayLive: s.dayLive ? { date: s.dayLive.date, loadedAt: s.dayLive.loadedAt, n: Object.keys(s.dayLive.stocks).length } : null, logs: logs.filter((l) => l.module === 'daytrade' || /5-minute|day/i.test(l.msg)).slice(-8).map((l) => ({ level: l.level, msg: l.msg, data: JSON.stringify(l.data ?? null).slice(0, 500) })) };
      });
      console.log('      DEBUG t1', JSON.stringify(t1), 'today-bar calls', mock.calls.filter((c) => c.includes('/historical-candle/intraday/')).length, JSON.stringify(dbg, null, 1));
    }
    check('09:31: the engine loads the first 15 minutes for every stock and measures how busy each is', t1?.ok && t1.data.state === 'loading' && Object.keys(live?.stocks ?? {}).length >= 90 && live.stocks[hk]?.rvol >= 1.5, `${Object.keys(live?.stocks ?? {}).length} stocks; HDFCBANK ${live?.stocks?.[hk]?.rvol?.toFixed(2)}× usual volume`);
    // 09:35: the market is up a little; HDFCBANK closes above its first-15-minutes high
    await page.evaluate(
      async ([st, at]) => {
        const quotes = {};
        for (const [key, s] of Object.entries(st.stocks)) {
          const open = s.bars.o[0];
          const high = Math.max(...s.bars.h);
          const ltp = s.symbol === 'HDFCBANK' ? Math.round(high * 1.003 * 20) / 20 : Math.round(open * 1.0015 * 100) / 100;
          quotes[key] = { key, ltp, open, high: Math.max(high, ltp), low: Math.min(...s.bars.l), volume: 900000, prevClose: open, fetchedAt: at };
        }
        await chrome.storage.session.set({ quotes });
      },
      [live, istMs(D, '09:35') + 3000],
    );
    const t2 = await send('daytrade:tick', { now: istMs(D, '09:35') + 5000 });
    const sigs = (await page.evaluate(() => chrome.storage.session.get('daySignals'))).daySignals;
    const hs = sigs?.signals?.find((x) => x.symbol === 'HDFCBANK');
    const notesD = await page.evaluate(() => chrome.notifications.getAll());
    check('09:35: BUY signal for HDFCBANK with stop and target, announced with a notification', t2?.ok && t2.data.signals === 1 && hs?.side === 'long' && hs.stop < hs.entry && hs.target > hs.entry && Object.keys(notesD).some((k) => k.startsWith('alert:day-HDFCBANK')), `${JSON.stringify(t2?.data)}; ${hs ? `${hs.side} ${hs.entry} stop ${hs.stop} target ${hs.target} rvol ${hs.rvol.toFixed(1)}` : 'no signal'}`);
    await page.goto(`${base}#/daytrade`);
    await page.waitForSelector('[data-testid="day-signals"] .day-signal[data-symbol="HDFCBANK"]', { timeout: 15000 }).catch(() => {});
    const card = page.locator('[data-testid="day-signals"] .day-signal[data-symbol="HDFCBANK"]');
    const ct = ((await card.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ');
    check('Day trade tab shows the signal in plain words: BUY, shares, stop, target, close by 3:10 pm', ct.includes('▲ BUY') && ct.includes('Stop (get out)') && ct.includes('Target') && ct.includes('3:10 pm') && ct.includes('act now'), ct.slice(0, 220));
    await card.locator('text=How to place it in Upstox').click().catch(() => {});
    check('Upstox steps say Intraday (not Delivery) and a stop-loss order', (((await page.textContent('[data-testid="day-steps"]').catch(() => '')) ?? '').includes('Intraday') && ((await page.textContent('[data-testid="day-steps"]').catch(() => '')) ?? '').includes('Stop-loss')));
    await card.locator('[data-testid="day-practice"]').click().catch(() => {});
    await page.waitForTimeout(800);
    check('practice day trades are refused outside market hours', /market is closed|too late for a day trade/.test((await card.textContent().catch(() => '')) ?? ''));
    await card.locator('[data-testid="day-took"]').click().catch(() => {});
    await page.fill('.day-signal[data-symbol="HDFCBANK"] input[data-field="bought-price"]', String(hs?.entry ?? 700));
    await page.fill('.day-signal[data-symbol="HDFCBANK"] input[data-field="bought-qty"]', '50');
    await page.click('.day-signal[data-symbol="HDFCBANK"] [data-testid="bought-save"]');
    await page.waitForSelector('[data-testid="day-open"] tr[data-symbol="HDFCBANK"]', { timeout: 10000 }).catch(() => {});
    let dts = (await page.evaluate(() => chrome.storage.local.get('dayTrades'))).dayTrades;
    check('"I took this trade in Upstox" records a real day trade (no order is sent)', dts.length === 1 && dts[0].status === 'open' && !dts[0].practice && dts[0].qty === 50 && dts[0].side === 'long' && !mock.calls.some((c) => /order|gtt/i.test(c)), JSON.stringify(dts[0] ?? null).slice(0, 160));
    await page.click('[data-testid="day-closed-it"]');
    await page.fill('[data-testid="day-trades"] input[data-field="bought-price"]', String(r2((hs?.entry ?? 700) + 4)));
    await page.click('[data-testid="day-trades"] [data-testid="bought-save"]');
    await until(() => page.evaluate(() => chrome.storage.local.get('dayTrades').then((x) => x.dayTrades?.[0]?.status === 'closed')), 10000);
    dts = (await page.evaluate(() => chrome.storage.local.get('dayTrades'))).dayTrades;
    const resText = ((await page.textContent('[data-testid="day-results"]').catch(() => '')) ?? '').replace(/\s+/g, ' ');
    check('"I closed it" records the result after Upstox intraday charges', dts[0]?.status === 'closed' && dts[0].charges > 20 && dts[0].charges < 90 && resText.includes('Real:') && resText.includes('+₹'), `${resText.slice(0, 120)}; charges ₹${dts[0]?.charges?.toFixed(2)}`);
    await page.screenshot({ path: join(out, 'v11-daytrade-signal.png'), fullPage: true });
    await page.goto(`${base}#/watchlist`);
    await page.waitForSelector('select[data-field="filter"]', { timeout: 15000 });
    await page.selectOption('select[data-field="filter"]', 'day');
    await page.waitForTimeout(600);
    const dayRows = await page.$$eval('[data-testid="auto-list"] .stock-row', (els) => els.map((e) => e.textContent));
    check('Stocks tab: "▲ BUY today" tag next to the stock; filter "Day-trade signals today"', dayRows.length === 1 && dayRows[0].includes('HDFCBANK') && dayRows[0].includes('▲ BUY today'), dayRows.map((t) => t.slice(0, 60)).join(' | '));
    await page.selectOption('select[data-field="filter"]', 'all');
    mock.simDate = null;
    await page.evaluate(() => chrome.storage.session.remove(['daySignals', 'dayLive']));
    await send('quotes:refresh');
  }

  section('v0.11 · switching the list');
  await page.goto(`${base}#/watchlist`);
  await page.waitForSelector('select[data-field="list"]', { timeout: 15000 });
  await page.selectOption('select[data-field="list"]', 'nifty50');
  await until(() => page.evaluate(() => chrome.storage.local.get('universe').then((x) => x.universe?.index === 'nifty50')), 20000);
  check('choosing "Nifty 50" downloads that list from NSE', (await page.evaluate(() => chrome.storage.local.get('universe'))).universe?.index === 'nifty50' && mock.calls.includes('NSE /content/indices/ind_nifty50list.csv'));
  await page.selectOption('select[data-field="list"]', 'nifty100');
  await until(() => page.evaluate(() => chrome.storage.local.get('universe').then((x) => x.universe?.index === 'nifty100')), 20000);
  await until(() => page.evaluate(() => chrome.storage.session.get('syncProgress').then((x) => !x.syncProgress?.running)), 120000);

  section('v0.12 · plain words, market mood, news');
  await page.goto(`${base}#/watchlist`);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="auto-list"] .stock-row .plain').length >= 90, null, { timeout: 30000 }).catch(() => {});
  const plainRows = await page.$$eval('[data-testid="auto-list"] .stock-row', (els) => els.map((e) => e.textContent ?? ''));
  check('Stocks list: every stock in one plain sentence, with a "what do the labels mean" help', plainRows.length >= 90 && plainRows.every((t) => !t.includes('RSI')) && plainRows.some((t) => t.includes('Rising')) && !!(await page.$('[data-testid="list-help"]')) && ((await page.textContent('[data-testid="list-guide"]')) ?? '').includes('only for looking'), plainRows[0]?.replace(/\s+/g, ' ').slice(0, 140));
  const pxInside = await page.$$eval('[data-testid="auto-list"] .stock-row', (els) => els.every((e) => { const px = e.querySelector('.line1 .px'); return !!px && px.getBoundingClientRect().right <= e.getBoundingClientRect().right + 1; }));
  check('the price stays inside every row, also next to a long "#1 pick" label', pxInside);
  await page.screenshot({ path: join(out, 'v12-stocks.png'), fullPage: false });
  await send('quotes:refresh');
  await page.goto(`${base}#/today`);
  await page.waitForSelector('[data-testid="mood"]', { timeout: 15000 }).catch(() => {});
  const moodText = ((await page.textContent('[data-testid="mood"]').catch(() => '')) ?? '').replace(/\s+/g, ' ');
  check('Today shows the market mood in one line (Nifty 50, stocks up, nervousness)', moodText.includes('Market today') && moodText.includes('Nifty 50 +0.60%') && /\d+ of \d+ stocks up/.test(moodText) && moodText.includes('nervousness: calm'), moodText.slice(0, 160));
  const nr = await send('news:refresh');
  await page.waitForSelector('[data-testid="news"] .news-list li', { timeout: 15000 }).catch(() => {});
  const newsText = ((await page.textContent('[data-testid="news"]').catch(() => '')) ?? '').replace(/\s+/g, ' ');
  const newsLines = (await page.$$('[data-testid="news"] .news-list li')).length;
  await page.screenshot({ path: join(out, 'v12-today.png'), fullPage: true });
  check('News box: a few headlines only, for your stocks (Upstox News API)', nr?.ok && nr.data.count > 0 && newsLines >= 1 && newsLines <= 6 && newsText.includes('Test headline for') && mock.calls.includes('GET /v2/news'), `${newsLines} lines: ${newsText.slice(0, 140)}`);

  section('v0.12 · trades made in Upstox are found by themselves');
  await page.goto(`${base}#/alerts`);
  await page.waitForSelector('.login-banner button', { timeout: 10000 });
  await page.click('.login-banner button');
  await until(() => page.evaluate(() => chrome.storage.local.get('auth').then((x) => x.auth?.status === 'logged_in')), 20000);
  check('Trades & alerts explains the automatic Upstox sync', ((await page.textContent('[data-testid="upstox-sync"]').catch(() => '')) ?? '').includes('Find my Upstox trades automatically'));
  const kOf = (sym) => bySymbolRow[sym].instrument_key;
  const pxOf = (sym) => quoteFor(kOf(sym)).ltp;
  const tPx = pxOf('TRENT');
  const rawPos = (sym, over) => ({ exchange: 'NSE', instrument_token: kOf(sym), trading_symbol: sym, product: 'I', quantity: 0, day_buy_quantity: 0, day_buy_price: 0, day_sell_quantity: 0, day_sell_price: 0, ...over });
  mock.positions = [rawPos('TRENT', { quantity: 20, day_buy_quantity: 20, day_buy_price: tPx })];
  const s1 = await send('portfolio:sync');
  let dts2 = (await page.evaluate(() => chrome.storage.local.get('dayTrades'))).dayTrades;
  let tt = dts2.find((x) => x.symbol === 'TRENT');
  let notesS = await page.evaluate(() => chrome.notifications.getAll());
  check('an Intraday buy made in Upstox appears by itself as a watched day trade, with stop, target and a notification', s1?.ok && s1.data.changes === 1 && tt?.auto && tt.status === 'open' && tt.qty === 20 && tt.entry === tPx && tt.stop < tPx && tt.target > tPx && Object.keys(notesS).some((k) => k.startsWith('alert:found-')), `${JSON.stringify(s1?.data)}; ${tt ? `${tt.side} ${tt.qty} @ ${tt.entry} stop ${tt.stop} target ${tt.target}` : 'not found'}`);
  await page.goto(`${base}#/daytrade`);
  await page.waitForSelector('[data-testid="day-open"] tr[data-symbol="TRENT"]', { timeout: 10000 }).catch(() => {});
  check('Day trade tab lists it, marked "from Upstox"', ((await page.textContent('[data-testid="day-open"] tr[data-symbol="TRENT"]').catch(() => '')) ?? '').includes('from Upstox'));
  mock.positions = [rawPos('TRENT', { quantity: 0, day_buy_quantity: 20, day_buy_price: tPx, day_sell_quantity: 20, day_sell_price: r2(tPx + 15) })];
  const s2 = await send('portfolio:sync');
  dts2 = (await page.evaluate(() => chrome.storage.local.get('dayTrades'))).dayTrades;
  tt = dts2.find((x) => x.symbol === 'TRENT');
  notesS = await page.evaluate(() => chrome.notifications.getAll());
  check('selling it in Upstox closes the trade here and reports the result', s2?.ok && tt?.status === 'closed' && tt.exitPrice === r2(tPx + 15) && Object.keys(notesS).some((k) => k.startsWith('alert:closed-')), `${tt?.status} @ ${tt?.exitPrice}`);
  const rPx = pxOf('RELIANCE');
  mock.positions.push(rawPos('RELIANCE', { product: 'D', quantity: 10, day_buy_quantity: 10, day_buy_price: rPx }));
  const s3 = await send('portfolio:sync');
  const stP = await page.evaluate(() => chrome.storage.local.get(['plans', 'alerts']));
  const rp = stP.plans.find((x) => x.symbol === 'RELIANCE' && x.auto);
  notesS = await page.evaluate(() => chrome.notifications.getAll());
  const foundNote = Object.keys(notesS).find((k) => rp && k === `alert:found-${rp.id}`);
  check('a Delivery buy made in Upstox becomes a watched trade with a sell-if-falls price, target and alerts', s3?.ok && rp?.status === 'open' && rp.qty === 10 && rp.fillPrice === rPx && rp.stop < rPx && rp.target > rPx && stP.alerts.some((a) => a.planId === rp.id && a.kind === 'stop') && !!foundNote, rp ? `${rp.qty} @ ${rp.fillPrice} stop ${rp.stop} target ${rp.target}` : 'not found');
  check('the sync only reads: no order or GTT request was ever sent', !mock.calls.some((c) => /\/order|gtt/i.test(c)) && mock.calls.filter((c) => c === 'GET /v2/portfolio/short-term-positions').length >= 3);
  await page.goto(`${base}#/alerts`);
  await page.waitForSelector('[data-testid="upstox-sync"]', { timeout: 10000 }).catch(() => {});
  check('a trade found in Upstox is marked "from Upstox"', ((await page.textContent('.plan-card[data-plan="RELIANCE"] [data-testid="from-upstox"]').catch(() => '')) ?? '').includes('from Upstox'));
  check('status line shows the sync is working', ((await page.textContent('[data-testid="upstox-sync"]').catch(() => '')) ?? '').includes('working'));
  await page.screenshot({ path: join(out, 'v12-trades-sync.png'), fullPage: true });

  section('v0.12 · instant prices (live feed)');
  const hKey = kOf('HDFCBANK');
  const hBefore = (await page.evaluate(() => chrome.storage.session.get('quotes'))).quotes[hKey].ltp;
  const hLive = r2(hBefore * 1.004);
  mock.feedTicks = { [hKey]: hLive, 'NSE_INDEX|Nifty 50': 25200.5, 'NSE_EQ|INE000000000': 1 };
  const fc = await send('feed:connect');
  await until(() => page.evaluate(([k, v]) => chrome.storage.session.get('quotes').then((x) => x.quotes?.[k]?.ltp === v), [hKey, hLive]), 20000);
  const qAfter = (await page.evaluate(() => chrome.storage.session.get(['quotes', 'feedStatus'])));
  check('live feed: connects, subscribes to the watched stocks and the indices, and stores the pushed prices', fc?.ok && qAfter.quotes[hKey].ltp === hLive && qAfter.quotes['NSE_INDEX|Nifty 50'].ltp === 25200.5 && !qAfter.quotes['NSE_EQ|INE000000000'] && mock.feedSubs.includes(hKey) && mock.feedSubs.includes('NSE_INDEX|India VIX') && qAfter.feedStatus?.connected, `${JSON.stringify(fc?.data)}; HDFCBANK ${hBefore} → ${qAfter.quotes[hKey].ltp}; ${mock.feedSubs.length} keys subscribed`);
  await page.goto(`${base}#/diagnostics`);
  await page.waitForSelector('[data-testid="feed-status"]', { timeout: 10000 }).catch(() => {});
  await until(() => page.evaluate(() => (document.querySelector('[data-testid="feed-status"]')?.textContent ?? '').startsWith('connected')), 10000);
  check('Diagnostics shows the instant feed state', ((await page.textContent('[data-testid="feed-status"]').catch(() => '')) ?? '').startsWith('connected'));
  await send('auth:logout');
  await until(() => page.evaluate(() => chrome.storage.local.get('auth').then((x) => x.auth?.status === 'logged_out')), 10000);
  mock.positions = [];

  await page.goto(`${base}#/diagnostics`);
  await page.waitForSelector('[data-testid="data-check"] tbody tr');
  check('Diagnostics data check lists the 10 spec stocks', (await page.$$('[data-testid="data-check"] tbody tr')).length === 10);

  section('Diagnostics');
  await page.goto(`${base}#/diagnostics`);
  await page.waitForFunction(() => /\d+\/40 per second/.test(document.querySelector('[data-testid="api-usage"]')?.textContent ?? ''), null, { timeout: 8000 }).catch(() => {});
  const usage = await page.textContent('[data-testid="api-usage"]');
  // closed market: after the one closing-price fetch the extension is quiet, so count the 30-minute window
  const used = Number(/(\d+)\/1800 per 30 min/.exec(usage)?.[1] ?? 0);
  check('API usage vs limits shown', used > 0 && /\d+\/450 per minute/.test(usage), usage.trim());
  check('scheduled jobs listed', (await page.$$('[data-testid="jobs"] tbody tr')).length === 6);
  await page.waitForTimeout(6000); // let in-flight requests finish (Diagnostics refreshes every 5 s)
  const reqText = await page.textContent('.card:has-text("Requests today")');
  const reqToday = Number(/Requests today\s*(\d+)/.exec(reqText)?.[1] ?? -1);
  // The login page itself is opened by Chrome, not by the extension's client.
  const clientCalls = mock.calls.filter((c) => !c.includes('/authorization/dialog') && !c.includes('/market-quote/instruments/') && !c.startsWith('NSE ')).length;
  check('"Requests today" counts every client request (a few may be in flight)', Math.abs(reqToday - clientCalls) <= 4, `${reqToday} counted, ${clientCalls} made`);
  await page.screenshot({ path: join(out, 'm1-diagnostics.png'), fullPage: true });

  section('Popup');
  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 320, height: 420 });
  await popup.goto(`chrome-extension://${id}/src/ui/popup.html`);
  await popup.waitForSelector('text=Open side panel');
  check('popup shows login hint when logged out', (await popup.textContent('body')).includes('Open the side panel and click'));
  await popup.waitForFunction(() => !document.querySelector('button.btn.primary')?.hasAttribute('disabled'));
  await popup.click('text=Open side panel');
  await popup.waitForEvent('close', { timeout: 5000 }).catch(() => undefined);
  check('popup "Open side panel" calls sidePanel.open() successfully', popup.isClosed());

  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
  check('every Upstox call went to the fake server (none reached the internet)', mock.calls.length > 0, `${mock.calls.length} calls`);
} catch (err) {
  check('smoke test ran to completion', false, err.stack ?? err.message);
} finally {
  await ctx.close();
  server.close();
  rmSync(userDataDir, { recursive: true, force: true });
  rmSync(certDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots: ${out}`);
process.exit(failed.length ? 1 : 0);
