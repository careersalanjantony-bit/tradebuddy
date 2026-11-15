import { getCalendar, refreshCalendar, refreshCalendarIfNeeded } from '../data/calendarSync';
import { createLogger } from '../lib/log';
import { errorMessage } from '../lib/serialize';
import { notify } from '../notify/chrome';
import { getAuth, getLocal, setLocal } from '../storage/local';
import type { JobState } from '../storage/schema';
import { UpstoxError } from '../upstox/errors';
import { markSessionExpired } from '../upstox/session';
import { isSessionExpiredByTime } from '../upstox/token';
import { ensureInstruments, eodDue, keysWithoutHistory, morningDue, pollAndEvaluate, runEndOfDay, syncAllTracked } from './dataJobs';
import { ensureUniverse } from '../data/universe';
import { ensureScanLists } from './scanList';
import { ensureIntraday } from './dayJobs';
import { loginReminderDue, nextRun, type JobName } from './schedule';
import { learnIfDue } from './mlJobs';

/**
 * chrome.alarms scheduler (spec §17). Every job records its last run; next fire times are computed
 * in IST and re-set after each run. Missed jobs are caught up at startup.
 * Later milestones add: instruments-refresh, feed-watchdog, portfolio-sync, eod-candles, scans…
 */

const log = createLogger('scheduler');
export const JOBS: JobName[] = ['token-expiry', 'login-reminder', 'holidays-refresh', 'instruments-refresh', 'morning-recheck', 'eod-candles'];
export const POLL_ALARM = 'quotes-poll';

export function isJob(name: string): name is JobName {
  return (JOBS as string[]).includes(name);
}

async function patchJob(name: JobName, patch: Partial<JobState>): Promise<void> {
  const all = (await getLocal('scheduleState')) ?? {};
  await setLocal('scheduleState', { ...all, [name]: { ...all[name], ...patch } });
}

async function getJob(name: JobName): Promise<JobState> {
  return ((await getLocal('scheduleState')) ?? {})[name] ?? {};
}

export async function scheduleJob(name: JobName, now = Date.now()): Promise<void> {
  const when = nextRun(name, now, await getCalendar());
  if (when === null) {
    await chrome.alarms.clear(name);
    return;
  }
  await chrome.alarms.create(name, { when });
  await patchJob(name, { nextRunAt: when });
}

export async function scheduleAll(): Promise<void> {
  for (const j of JOBS) await scheduleJob(j);
  // Price polling every 30 s (Chrome's minimum); the job itself skips when the market is closed.
  const poll = await chrome.alarms.get(POLL_ALARM);
  if (!poll) await chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.5, delayInMinutes: 0.5 });
}

/** Handles the 30-second price poll alarm. */
export async function runPoll(): Promise<void> {
  try {
    await pollAndEvaluate(false);
  } catch (err) {
    log.warn('Price poll failed', { error: err });
  }
}

async function showLoginReminder(now: number): Promise<boolean> {
  const [cal, auth, job] = await Promise.all([getCalendar(), getAuth(), getJob('login-reminder')]);
  if (!loginReminderDue(now, cal, auth, job.lastNotifiedAt)) return false;
  await notify('login-reminder', {
    title: 'Log in to Upstox',
    message: 'Market opens at 09:15. Open Swing Trade Assistant and click "Log in to Upstox".',
    requireInteraction: true,
  });
  await patchJob('login-reminder', { lastNotifiedAt: now });
  return true;
}

export async function runJob(name: JobName, now = Date.now()): Promise<void> {
  await patchJob(name, { lastRunAt: now });
  try {
    switch (name) {
      case 'token-expiry': {
        const auth = await getAuth();
        if (isSessionExpiredByTime(auth, now)) await markSessionExpired('Daily expiry (03:30 IST)', { notifyOwner: false, now });
        break;
      }
      case 'login-reminder':
        await showLoginReminder(now);
        break;
      case 'instruments-refresh':
        await ensureInstruments(true, now);
        break;
      case 'morning-recheck':
        try {
          const r = await syncAllTracked(now);
          log.info(`Morning re-check: history updated for ${r.ok} stocks`);
          await pollAndEvaluate(false, now);
        } catch (err) {
          if (err instanceof UpstoxError && err.kind === 'not_logged_in') throw new Error('Not logged in (no Analytics Token)');
          throw err;
        }
        break;
      case 'eod-candles':
        try {
          await runEndOfDay(now);
          // the evening is when the newest day is in the history: learn again
          void learnIfDue(now).catch(() => undefined);
        } catch (err) {
          if (err instanceof UpstoxError && err.kind === 'not_logged_in') {
            log.warn('End-of-day sync skipped: not logged in and no Analytics Token');
            throw new Error('Not logged in (no Analytics Token)');
          }
          throw err;
        }
        break;
      case 'holidays-refresh':
        try {
          await refreshCalendar();
        } catch (err) {
          if (err instanceof UpstoxError && err.kind === 'not_logged_in') {
            log.info('Holiday refresh skipped: not logged in and no Analytics Token (will retry after login)');
          } else throw err;
        }
        break;
    }
    await patchJob(name, { lastSuccessAt: Date.now() });
  } catch (err) {
    await patchJob(name, { lastError: errorMessage(err) });
    log.warn(`Job ${name} failed`, { error: err });
  } finally {
    await scheduleJob(name);
  }
}

/** At service-worker startup: expire stale sessions, show a missed reminder, refresh holidays if due. */
export async function catchUp(now = Date.now()): Promise<void> {
  const auth = await getAuth();
  if (isSessionExpiredByTime(auth, now)) await markSessionExpired('Daily expiry (03:30 IST)', { notifyOwner: false, now });
  await showLoginReminder(now);
  await refreshCalendarIfNeeded(now);
  try {
    await ensureInstruments(false, now);
  } catch (err) {
    log.warn('Instrument list download failed', { error: err });
  }
  try {
    await ensureUniverse(false, now);
    // app v1.11: the five lists the Day Trade scanners watch (NSE, weekly; bundled copy as fallback)
    await ensureScanLists(false, now).catch((err: unknown) => log.info('Scan lists check skipped', { reason: String(err) }));
    const missing = await keysWithoutHistory();
    if (missing.length) {
      log.info(`${missing.length} studied stock(s) have no history yet — downloading in the background`);
      void syncAllTracked(now).catch((err: unknown) => log.info('History download waits for a login or an Analytics Token', { reason: String(err) }));
    }
  } catch (err) {
    log.warn('Index list check failed', { error: err });
  }
  await ensureIntraday(now).catch((err: unknown) => log.info('5-minute history check skipped', { reason: String(err) }));
  // Prices right away (e.g. evening install or browser restart: the last session's closing prices).
  await pollAndEvaluate(false, now).catch((err: unknown) => log.info('Startup price fetch skipped', { reason: String(err) }));
  if (await morningDue(now)) {
    log.info('Catching up the 09:20 re-check');
    await runJob('morning-recheck', now);
  }
  if (await eodDue(now)) {
    log.info('Catching up the end-of-day sync (Chrome was not running at 16:00)');
    await runJob('eod-candles', now);
  }
}
