/**
 * Service worker entry (MV3).
 *
 * Rules:
 *  - Register every event listener synchronously at the top level.
 *  - Keep state in storage, not in globals: the worker can be stopped at any moment.
 *  - Never call broker write endpoints (no orders, no GTT create/modify). Read-only.
 */
import { refreshCalendar, refreshCalendarIfNeeded, storeHolidays } from '../data/calendarSync';
import { createLogger } from '../lib/log';
import { initLogging } from '../lib/logSetup';
import { errorMessage } from '../lib/serialize';
import { DB_VERSION, getDb } from '../storage/db';
import { chromeLocalKV } from '../storage/kv';
import { LOCAL_SCHEMA_VERSION, runLocalMigrations } from '../storage/migrations';
import type { BackgroundStatus } from '../shared/messages';
import { beginLogin, completeLogin, logout, redirectUri, testAnalyticsToken, testConnection } from '../upstox/auth';
import { apiUsage } from '../upstox/client';
import { friendlyMessage, UpstoxError } from '../upstox/errors';
import { upstoxRequest } from '../upstox/client';
import { parseFunds } from '../advisor/capital';
import { registerRouter, type Handlers } from './router';
import { notify } from '../notify/chrome';
import { playSound, toneJustPlayed } from '../notify/sound';
import { catchUp, isJob, POLL_ALARM, runJob, runPoll, scheduleAll } from './scheduler';
import { checkPracticeTrades, practiceBuy, practiceReset, practiceSell } from './practiceJobs';
import { dayClose, dayReset, dayTake, dayTick, ensureIntraday, syncIntradayAll } from './dayJobs';
import { ensureFeed } from './feed';
import { refreshNews } from './newsJobs';
import { syncPortfolio } from './portfolioJobs';
import { announce, checkNewPicks, ensureInstruments, fastPoll, pollAndEvaluate, runEndOfDay, syncAllTracked, syncStock } from './dataJobs';
import { invalidateStockCache } from '../data/stockData';
import { ensureUniverse } from '../data/universe';
import { markAlertsSeen, mutateAlerts, recentAlertLog, updateBadge } from '../alerts/engine';
import { newId } from '../alerts/rules';
import { ignoreGap } from '../data/corporateActions';
import { deletePlan, savePlan, updatePlan } from '../planner/plans';
import { getSettings, updateSettings } from '../storage/local';
import { getSession, setSession } from '../storage/session';
import { walletCancel, walletConvert, walletOrder, walletReset, walletUpdate } from './walletJobs';
import { WALLET_START } from '../wallet/wallet';
import { learnIfDue, learnNow } from './mlJobs';
import { walletCover, walletShort } from './walletJobs';
import { scanShorts } from './shortJobs';
import { scanBreakouts, testBreakouts } from './breakoutJobs';
import { testBreakoutsIfDue } from './breakoutJobs';
import { checkForUpdate, startUpdateChecks } from './updateJobs';
import { botReset, botSetEnabled, runBot, suggestIdeas } from './botJobs';
import { analyzeShort, trainShortModelIfDue } from './shortJobs';
import { startNewsChecks } from './newsJobs';

initLogging('background');
const log = createLogger('bg');
const startedAt = Date.now();
let startupError: string | undefined;
let isReady = false;

async function startup(): Promise<void> {
  try {
    const mig = await runLocalMigrations(chromeLocalKV);
    if (mig.newerThanCode) {
      log.warn(`Stored data schema v${mig.from} is newer than this build (v${LOCAL_SCHEMA_VERSION}). Nothing was migrated.`);
    } else if (mig.applied.length) {
      log.info(`Storage migrated v${mig.from} → v${mig.to}`, { applied: mig.applied });
    }
    await getDb(); // runs IndexedDB upgrades
    // A fresh worker has no download running: clear "downloading…" left over by a stopped one
    // (the catch-up below restarts the download if something is still missing).
    for (const k of ['syncProgress', 'intradayProgress'] as const) {
      const p = await getSession(k);
      if (p?.running) await setSession(k, { ...p, running: false, at: Date.now() });
    }
    // The toolbar button opens the popup; the popup has an "Open side panel" button.
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
    await scheduleAll();
    await updateBadge();
    isReady = true;
    log.info('Service worker started', { version: chrome.runtime.getManifest().version, localSchema: mig.to, dbVersion: DB_VERSION });
  } catch (err) {
    startupError = errorMessage(err);
    log.error('Startup failed', { error: err });
    throw err;
  }
}

const ready = startup();
ready.catch(() => undefined); // logged above; keep the rejection from being "unhandled"
// Missed jobs (expiry, reminder, holidays). Separate from `ready` because it may call Upstox.
ready.then(() => catchUp()).catch((err: unknown) => log.warn('Startup catch-up failed', { error: err }));
// Self-learning: learn again when the last learning is a day old (a minute after start, so the screens come first).
ready.then(() => setTimeout(() => void learnIfDue().catch(() => undefined), 60_000)).catch(() => undefined);
// app v1.9: the breakout rule's past test (also redone after each learning run)
ready.then(() => setTimeout(() => void testBreakoutsIfDue().catch(() => undefined), 90_000)).catch(() => undefined);
// News: last time's headlines at once, then a download every 15 / 45 minutes (app v1.7).
ready.then(() => startNewsChecks()).catch(() => undefined);
// In-app updates: look for a newer TradeBuddy on start and every 6 hours.
ready.then(() => startUpdateChecks()).catch(() => undefined);
// Per-stock short-selling chance: train once a day (a little after start, then hourly checks).
ready
  .then(() => {
    setTimeout(() => void trainShortModelIfDue().catch(() => undefined), 40_000);
    setInterval(() => void trainShortModelIfDue().catch(() => undefined), 3600_000);
  })
  .catch(() => undefined);

chrome.runtime.onInstalled.addListener((details) => {
  void ready.finally(() =>
    log.info(`Extension ${details.reason}`, { previousVersion: details.previousVersion, version: chrome.runtime.getManifest().version }),
  );
});

chrome.runtime.onStartup.addListener(() => {
  log.info('Browser started');
});

chrome.alarms.onAlarm.addListener((alarm) => {
  void ready.then(() => {
    if (alarm.name === POLL_ALARM) return runPoll();
    if (isJob(alarm.name)) return runJob(alarm.name);
    log.warn(`Unknown alarm "${alarm.name}" cleared`);
    return chrome.alarms.clear(alarm.name).then(() => undefined);
  });
});

/** Clicking any of our notifications opens the side panel (or, if Chrome refuses, a tab with the app). */
chrome.notifications.onClicked.addListener((id) => {
  void (async () => {
    await chrome.notifications.clear(id);
    const win = await chrome.windows.getLastFocused().catch(() => undefined);
    try {
      if (win?.id === undefined) throw new Error('no window');
      await chrome.sidePanel.open({ windowId: win.id });
    } catch {
      await chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/sidepanel.html#/settings') });
    }
  })();
});

const status = (): BackgroundStatus => ({
  version: chrome.runtime.getManifest().version,
  extensionId: chrome.runtime.id,
  startedAt,
  localSchemaVersion: LOCAL_SCHEMA_VERSION,
  dbVersion: DB_VERSION,
  ready: isReady,
  ...(startupError ? { startupError } : {}),
});

const handlers: Handlers = {
  ping: async () => ({ now: Date.now(), startedAt }),
  'status:get': async () => status(),
  'auth:begin': async () => beginLogin(),
  'auth:complete': async ({ redirectUrl }) => {
    const r = await completeLogin(redirectUrl);
    // Fresh login: holidays, then yesterday's candles (not published the same evening) for every stock.
    void refreshCalendarIfNeeded()
      .then(() => syncAllTracked())
      .then((s) => log.info(`After login: history updated for ${s.ok} stocks`))
      .then(() => setSession('intradayCheckedAt', 0))
      .then(() => ensureIntraday())
      .catch((err: unknown) => log.warn('History update after login failed', { error: err }));
    void syncPortfolio(Date.now(), true).catch(() => undefined);
    return r;
  },
  'auth:logout': async () => {
    await logout();
    return { done: true };
  },
  'auth:test': async () => testConnection(),
  'analytics:test': async ({ token }) => {
    const data = await testAnalyticsToken(token);
    const cal = await storeHolidays(data);
    return { year: cal.year, holidays: cal.holidays.length };
  },
  'calendar:refresh': async () => {
    try {
      const cal = await refreshCalendar();
      return { year: cal.year, holidays: cal.holidays.length };
    } catch (err) {
      throw new Error(friendlyMessage(err, redirectUri()));
    }
  },
  'diag:api': async () => ({ usage: await apiUsage() }),
  'funds:get': async () => {
    try {
      const data = await upstoxRequest<unknown>('/v3/user/get-funds-and-margin', { tokenKind: 'account', headers: { 'Api-Version': '3.0' }, attempts: 2 });
      return parseFunds(data, Date.now());
    } catch (err) {
      if (err instanceof UpstoxError && err.kind === 'not_logged_in') throw new Error('Log in to Upstox first (the balance needs the daily login), or type the amount.');
      throw new Error(friendlyMessage(err, redirectUri()));
    }
  },
  'diag:testAlert': async ({ sound }) => {
    await notify(`alert:test-${sound}:${Date.now()}`, {
      title: sound === 'stop' ? 'TEST — STOP HIT sound' : sound === 'target' ? 'TEST — TARGET sound' : 'TEST — alert sound',
      message: 'This is a test from Diagnostics. Real alerts look like this.',
    });
    // on screen the alert itself already played the chosen tone (app v1.9): no second sound
    return { played: toneJustPlayed() || (await playSound(sound, true)) };
  },
  'instruments:refresh': async () => ({ count: await ensureInstruments(true) }),
  'universe:refresh': async ({ force }) => {
    const u = await ensureUniverse(!!force);
    // download history for any new stocks without blocking the reply
    void syncAllTracked()
      .then(() => setSession('intradayCheckedAt', 0))
      .then(() => ensureIntraday())
      .catch((err: unknown) => log.info('History download for the studied list waits for a login or an Analytics Token', { reason: String(err) }));
    return { index: u?.index ?? 'watchlist', count: u?.members.length ?? 0, source: u?.source ?? 'none' };
  },
  'stock:sync': async ({ key }) => {
    try {
      return await syncStock(key);
    } catch (err) {
      throw new Error(friendlyMessage(err, redirectUri()));
    }
  },
  'stocks:syncAll': async () => {
    try {
      return await syncAllTracked();
    } catch (err) {
      throw new Error(friendlyMessage(err, redirectUri()));
    }
  },
  /** Panel opened: fetch prices now if they are due (no-op otherwise). */
  'quotes:auto': async () => {
    try {
      // panel opened: also look at the Upstox account and the headlines (each has its own pacing)
      void syncPortfolio().catch(() => undefined);
      void refreshNews().catch(() => undefined);
      return await pollAndEvaluate(false);
    } catch (err) {
      return { polled: 0, skipped: friendlyMessage(err, redirectUri()) };
    }
  },
  'quotes:fast': async () => {
    try {
      return await fastPoll();
    } catch (err) {
      return { polled: 0, skipped: friendlyMessage(err, redirectUri()) };
    }
  },
  'quotes:refresh': async () => {
    try {
      return await pollAndEvaluate(true);
    } catch (err) {
      throw new Error(friendlyMessage(err, redirectUri()));
    }
  },
  'eod:run': async () => {
    try {
      return await runEndOfDay();
    } catch (err) {
      throw new Error(friendlyMessage(err, redirectUri()));
    }
  },
  'picks:check': async () => ({ announced: await checkNewPicks() }),
  'plans:save': async ({ plan }) => {
    const saved = await savePlan(plan);
    return { id: saved.id, ticket: saved.ticket };
  },
  'plans:update': async ({ id, patch }) => {
    await updatePlan(id, patch);
    return { done: true };
  },
  'practice:buy': async ({ plan }) => {
    try {
      return await practiceBuy(plan);
    } catch (err) {
      throw new Error(friendlyMessage(err, redirectUri()));
    }
  },
  'practice:sell': async ({ id }) => {
    try {
      return await practiceSell(id);
    } catch (err) {
      throw new Error(friendlyMessage(err, redirectUri()));
    }
  },
  'practice:reset': async () => ({ removed: await practiceReset() }),
  'wallet:order': async (req) => {
    const r = await walletOrder(req);
    // a newly bought stock needs prices at once
    void pollAndEvaluate(true).catch(() => undefined);
    return r;
  },
  'ml:learn': async () => {
    const r = await learnNow();
    return r ? { samples: r.samples, passed: r.passed } : { samples: 0, passed: false };
  },
  'wallet:short': async (req) => {
    const r = await walletShort(req);
    void pollAndEvaluate(true).catch(() => undefined);
    return r;
  },
  'wallet:cover': async ({ key }) => walletCover(key),
  'shorts:scan': async () => ({ ideas: await scanShorts(Date.now(), true) }),
  'breakouts:scan': async () => ({ found: await scanBreakouts(Date.now()) }),
  'breakouts:test': async () => {
    await testBreakouts(Date.now());
    return { done: true };
  },
  'update:check': async () => checkForUpdate(Date.now(), true),
  'bot:run': async () => ({ ok: !!(await runBot(Date.now(), true)) }),
  'ideas:suggest': async ({ side }) => suggestIdeas(side),
  'shorts:analyze': async ({ key }) => analyzeShort(key),
  'shorts:model': async () => ({ trained: await trainShortModelIfDue(Date.now(), true) }),
  'bot:enable': async ({ enabled }) => (await botSetEnabled(enabled), { ok: true }),
  'bot:reset': async ({ forget, startCash }) => (await botReset(forget, startCash), { ok: true }),
  'wallet:cancel': async ({ id }) => {
    await walletCancel(id);
    return { done: true };
  },
  'wallet:convert': async ({ key, from, to }) => {
    await walletConvert(key, from, to);
    return { done: true };
  },
  'wallet:update': async ({ key, patch, product }) => {
    await walletUpdate(key, patch, product);
    return { done: true };
  },
  'wallet:reset': async ({ startCash }) => {
    await walletReset(startCash && startCash > 0 ? startCash : WALLET_START);
    return { done: true };
  },
  'practice:check': async () => checkPracticeTrades(),
  'daytrade:enable': async ({ enabled }) => {
    await updateSettings({ dayTrade: { enabled } });
    if (enabled) void syncIntradayAll().catch((err: unknown) => log.info('5-minute history waits for a login or an Analytics Token', { reason: String(err) }));
    return { enabled };
  },
  'daytrade:sync': async () => {
    try {
      return await syncIntradayAll();
    } catch (err) {
      throw new Error(friendlyMessage(err, redirectUri()));
    }
  },
  'daytrade:take': async (req) => {
    try {
      const t = await dayTake(req);
      return { id: t.id, entry: t.entry };
    } catch (err) {
      throw new Error(friendlyMessage(err, redirectUri()));
    }
  },
  'daytrade:close': async ({ id, price }) => {
    try {
      return await dayClose(id, price);
    } catch (err) {
      throw new Error(friendlyMessage(err, redirectUri()));
    }
  },
  'daytrade:reset': async () => ({ removed: await dayReset() }),
  'daytrade:tick': async ({ now }) => dayTick(now ?? Date.now()),
  'portfolio:sync': async () => syncPortfolio(Date.now(), true),
  'feed:connect': async () => ({ state: await ensureFeed(Date.now(), true) }),
  'news:refresh': async () => ({ count: await refreshNews(Date.now(), true) }),
  'plans:delete': async ({ id }) => {
    await deletePlan(id);
    return { done: true };
  },
  'alerts:add': async ({ rule }) => {
    if (!(rule.level > 0)) throw new Error('Enter a price level.');
    const { alerts } = await getSettings();
    const id = newId('al');
    await mutateAlerts((all) => [
      ...all,
      { ...rule, id, active: true, createdAt: Date.now(), firedCount: 0, cooldownMinutes: alerts.cooldownMinutes },
    ]);
    return { id };
  },
  'alerts:update': async ({ id, patch }) => {
    // re-activating clears the remembered side, so a new cross is needed
    await mutateAlerts((all) => all.map((r) => (r.id === id ? { ...r, ...patch, ...(patch.active ? { side: undefined } : {}) } : r)));
    return { done: true };
  },
  'alerts:delete': async ({ id }) => {
    await mutateAlerts((all) => all.filter((r) => r.id !== id));
    return { done: true };
  },
  'alerts:seen': async () => {
    await markAlertsSeen();
    return { done: true };
  },
  'alerts:log': async ({ limit }) => ({ entries: await recentAlertLog(limit ?? 100) }),
  'gaps:ignore': async ({ key, date }) => {
    await ignoreGap(key, date);
    invalidateStockCache(key);
    announce('candles', key);
    return { done: true };
  },
  'diag:selfTest': async () => {
    const t = createLogger('selftest');
    t.debug('Debug entry (only stored when Settings → Logging is "debug")');
    t.info('Info entry from the service worker', { startedAt });
    t.warn('Warning entry (test)');
    t.error('Error entry (test)', { error: new Error('Example error — not a real problem') });
    t.info('Redaction check: secrets below must show [REDACTED]', {
      headers: { Authorization: 'Bearer abcdef1234567890', 'x-api-key': 'sk-ant-test-0000000000' },
      url: 'https://api.upstox.com/v2/login/authorization/token?code=ABC123&client_id=public-id',
      telegram: 'https://api.telegram.org/bot123456789:AAExampleExampleExample/sendMessage',
    });
    return { written: 5 };
  },
};

registerRouter(handlers, ready);
