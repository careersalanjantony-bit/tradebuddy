/*
 * TradeBuddy background checker — runs in Android's background scheduler about every 15 minutes,
 * also when the app is closed (Capacitor Background Runner: a small JavaScript engine without
 * screens; only fetch, timers, CapacitorKV and CapacitorNotifications are available).
 *
 * What it does in market hours, only when the app itself is NOT running (the app does all of this
 * live and better while it runs):
 *   1. Practice shares: checks the take-profit and sell-if-falls prices (and the 3:10 pm day-trade
 *      exit). A hit is written down with its price and time; the app sells the practice shares at
 *      that price the next time it opens, and a notification tells you now.
 *   2. Rising fast: stocks up from the open, above the day's average price, with clearly more
 *      buyers than sellers → at most 3 alerts a day, each stock once.
 *   3. Morning reminder at about 9:15 if the app was not opened yet today.
 * Read-only: it only reads prices from Upstox. It never places an order.
 * Plain JavaScript on purpose (no imports, no build step): the background engine runs this file as is.
 */

var API = 'https://api.upstox.com';
var IST_MS = 5.5 * 3600 * 1000;
var CHANNEL = 'trade-alerts';

function kvGet(key, fallback) {
  try {
    var r = CapacitorKV.get(key);
    var v = r && r.value;
    return v ? JSON.parse(v) : fallback;
  } catch (e) {
    return fallback;
  }
}
function kvSet(key, value) {
  CapacitorKV.set(key, JSON.stringify(value));
}

/** IST date (YYYY-MM-DD), minutes since midnight and weekday (0 = Sunday). */
function istParts(now) {
  var d = new Date(now + IST_MS);
  return { date: d.toISOString().slice(0, 10), t: d.getUTCHours() * 60 + d.getUTCMinutes(), weekday: d.getUTCDay() };
}

function notifyId(text) {
  var h = 0;
  for (var i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  return Math.abs(h) % 2000000000;
}

function notify(id, title, body) {
  CapacitorNotifications.schedule([{ id: notifyId(id), title: title, body: body, largeBody: body, channelId: CHANNEL, smallIcon: 'ic_stat_tradebuddy', autoCancel: true }]);
}

function rupees(x) {
  return '₹' + Number(x).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function getJson(path, token) {
  var res = await fetch(API + path, { method: 'GET', headers: { Accept: 'application/json', Authorization: 'Bearer ' + token } });
  var body = await res.json();
  if (!res.ok || !body || body.status === 'error') throw new Error('Upstox ' + res.status);
  return body.data || {};
}

/** last price per instrument key (LTP v3, up to 500 keys) */
async function lastPrices(keys, token) {
  var out = {};
  for (var i = 0; i < keys.length; i += 500) {
    var part = keys.slice(i, i + 500);
    var data = await getJson('/v3/market-quote/ltp?instrument_key=' + encodeURIComponent(part.join(',')), token);
    Object.keys(data).forEach(function (k) {
      var q = data[k];
      if (q && q.instrument_token && q.last_price > 0) out[q.instrument_token] = q.last_price;
    });
  }
  return out;
}

/** "Rising fast" candidates from the full market quote (same idea as the app's list, without volume history). */
function risingFast(data) {
  var rows = [];
  Object.keys(data).forEach(function (k) {
    var q = data[k];
    if (!q || !q.instrument_token || !(q.last_price > 0)) return;
    var open = q.ohlc && q.ohlc.open;
    var vwap = q.average_price;
    var prev = typeof q.net_change === 'number' ? q.last_price - q.net_change : null;
    var buy = q.total_buy_quantity || 0;
    var sell = q.total_sell_quantity || 0;
    if (!open || !vwap || !prev || buy + sell <= 0) return;
    var fromOpen = (q.last_price / open - 1) * 100;
    var change = (q.last_price / prev - 1) * 100;
    var buyShare = buy / (buy + sell);
    if (fromOpen < 1 || q.last_price < vwap * 1.002 || buyShare < 0.6 || change > 5) return;
    rows.push({ key: q.instrument_token, symbol: q.symbol || k.split(':')[1] || k, ltp: q.last_price, fromOpen: fromOpen, change: change, buyShare: buyShare, score: fromOpen + (buyShare - 0.5) * 10 - Math.max(0, change - 3) });
  });
  rows.sort(function (a, b) {
    return b.score - a.score;
  });
  return rows;
}

async function check(now) {
  var cfg = kvGet('cfg', null);
  if (!cfg || !cfg.enabled || !cfg.token) return 'not set up';
  var p = istParts(now);
  if (p.weekday === 0 || p.weekday === 6 || (cfg.holidays || []).indexOf(p.date) >= 0) return 'market closed';
  // the app is running: it alerts live, nothing to do here
  if (cfg.appActiveAt && now - cfg.appActiveAt < 6 * 60 * 1000) return 'app running';

  var sent = kvGet('sent', { date: '', ids: [], rising: 0 });
  if (sent.date !== p.date) sent = { date: p.date, ids: [], rising: 0 };

  // 3. morning reminder
  if (p.t >= 9 * 60 + 5 && p.t <= 9 * 60 + 45 && sent.ids.indexOf('morning') < 0 && cfg.lastOpenDate !== p.date) {
    notify('morning-' + p.date, 'Market opens at 9:15', 'Open TradeBuddy to start today’s live buy ideas and alerts.');
    sent.ids.push('morning');
  }
  if (p.t < 9 * 60 + 15 || p.t > 15 * 60 + 30) {
    kvSet('sent', sent);
    return 'outside market hours';
  }

  // 1. practice shares
  var hits = kvGet('hits', []);
  var done = {};
  hits.forEach(function (h) {
    done[h.key] = true;
  });
  var holdings = (cfg.holdings || []).filter(function (h) {
    return !done[h.key];
  });
  if (holdings.length) {
    var prices = await lastPrices(
      holdings.map(function (h) {
        return h.key;
      }),
      cfg.token,
    );
    holdings.forEach(function (h) {
      var ltp = prices[h.key];
      if (!ltp) return;
      var reason = null;
      if (h.stop && ltp <= h.stop) reason = 'stop';
      else if (h.target && ltp >= h.target) reason = 'target';
      else if (h.sellByClose && p.t >= 15 * 60 + 10) reason = 'day-end';
      if (!reason) return;
      hits.push({ key: h.key, price: ltp, at: now, reason: reason });
      var pnl = (ltp - h.avgPrice) * h.qty;
      var what = reason === 'stop' ? 'fell to your sell-if-falls price' : reason === 'target' ? 'reached your take-profit price' : 'day trade closed at 3:10 pm';
      notify('bg-hit-' + h.key + '-' + p.date, 'Practice: ' + h.symbol + ' ' + what, 'Sold ' + h.qty + ' at about ' + rupees(ltp) + ' (' + (pnl >= 0 ? '+' : '−') + rupees(Math.abs(pnl)) + ' before charges). Pretend money — open TradeBuddy to see it.');
    });
    kvSet('hits', hits);
  }

  // 2. rising fast
  if (cfg.rising && sent.rising < 3 && p.t >= 9 * 60 + 30 && p.t <= 14 * 60 + 30 && (cfg.universe || []).length) {
    var keys = cfg.universe;
    var rows = [];
    for (var i = 0; i < keys.length; i += 500) {
      var data = await getJson('/v2/market-quote/quotes?instrument_key=' + encodeURIComponent(keys.slice(i, i + 500).join(',')), cfg.token);
      rows = rows.concat(risingFast(data));
    }
    rows.sort(function (a, b) {
      return b.score - a.score;
    });
    var top = rows.filter(function (r) {
      return sent.ids.indexOf('rise-' + r.key) < 0;
    })[0];
    if (top) {
      notify('bg-rise-' + top.key + '-' + p.date, '📈 Rising fast: ' + top.symbol + ' +' + top.fromOpen.toFixed(1) + '% since the open', 'More buyers than sellers (' + Math.round(top.buyShare * 100) + '% of waiting orders are buys) and above the day’s average price. A possible buy idea — check it in TradeBuddy first; quick rises often fall back.');
      sent.ids.push('rise-' + top.key);
      sent.rising++;
    }
  }
  kvSet('sent', sent);
  return 'checked';
}

// the scheduled check (capacitor.config.ts → BackgroundRunner.event)
addEventListener('checkMarket', async function (resolve, reject, args) {
  try {
    var r = await check(Date.now());
    console.log('TradeBuddy background check: ' + r);
    resolve();
  } catch (e) {
    console.error('TradeBuddy background check failed: ' + e);
    resolve();
  }
});

// the app hands over what the checker needs (token, stocks, practice shares, holidays, switches)
addEventListener('sync', function (resolve, reject, args) {
  try {
    var prev = kvGet('cfg', {});
    var next = Object.assign({}, prev, args || {});
    kvSet('cfg', next);
    resolve({ ok: true });
  } catch (e) {
    reject(String(e));
  }
});

// the app collects the practice sales found while it was closed
addEventListener('drain', function (resolve, reject, args) {
  try {
    var hits = kvGet('hits', []);
    kvSet('hits', []);
    resolve({ hits: hits });
  } catch (e) {
    reject(String(e));
  }
});

// for tests (Node): expose the pieces
if (typeof module !== 'undefined') module.exports = { check: check, risingFast: risingFast, istParts: istParts };
