import { fastPoll } from '../../../src/background/dataJobs';
import { testBreakoutsIfDue } from '../../../src/background/breakoutJobs';
import { testProtect } from '../../../src/background/botTest';
import { earlyTick } from '../../../src/background/earlyJobs';
import { INTRADAY_EVERY_MS, intradayTick, testIntradayIfDue } from '../../../src/background/intradayJobs';
import { learnIfDue } from '../../../src/background/mlJobs';
import { refreshNews, restoreNews } from '../../../src/background/newsJobs';
import { preopenTick } from '../../../src/background/preopenJobs';
import { trainRisingIfDue } from '../../../src/background/risingJobs';
import { catchUp, isJob, POLL_ALARM, refreshIntradayHistory, retryDailyHistory, runJob, runPoll, scheduleAll } from '../../../src/background/scheduler';
import { trainShortModelIfDue } from '../../../src/background/shortJobs';
import { createLogger } from '../../../src/lib/log';
import { getSession, setSession } from '../../../src/storage/session';
import type { Alarm, AlarmScheduler } from './alarms';
import { Ticker } from '../util/ticker';

/**
 * Milestone 3 — the app's own intelligence, running on the server. This is what
 * src/background/index.ts does on the phone, without its Chrome listeners and message router:
 *
 *  1. clear "downloading…" flags left by a stopped run;
 *  2. the app's alarm schedule (src/background/scheduler.ts scheduleAll): token expiry, login reminder,
 *     holidays, instruments, the 09:20 re-check, the end-of-day history + learning, and the 30-second
 *     price poll with every check that follows it (alerts, practice money, auto-trader, day-trade
 *     signals, breakouts, Rising now, Falling now, news, flow, breadth — dataJobs.afterQuotes);
 *  3. catch-up and restarts of incomplete historical downloads (scheduler.catchUp);
 *  4. the timers the phone runs: Early Movers every minute, pre-open every 10 s, the Intraday scanner
 *     every 15 s (app v1.19) with its daily past test, news every 30 s, the
 *     learning and past tests when due — plus the fast price check the open screen drives on a phone
 *     (dataJobs.fastPoll: every few seconds in market hours, nothing while the live feed delivers).
 *
 * Every job keeps its own "is it due?" checks, so running them as often as here cannot repeat work.
 * Read-only towards Upstox: none of these jobs places, changes or cancels an order.
 */

const log = createLogger('engine');

export interface Intelligence {
  tasks: Ticker[];
  /** finished start-up (schedule set); catch-up runs on in the background */
  ready: Promise<void>;
  stop(): Promise<void>;
}

export interface IntelligenceOptions {
  scheduler: AlarmScheduler;
  now?: () => number;
  /** tests: create the tasks but do not start the timers */
  startTasks?: boolean;
}

export function startIntelligence(o: IntelligenceOptions): Intelligence {
  const now = o.now ?? Date.now;
  const onAlarm = (alarm: Alarm): Promise<void> | undefined => {
    if (alarm.name === POLL_ALARM) return runPoll();
    if (isJob(alarm.name)) return runJob(alarm.name, now());
    log.warn(`Unknown alarm "${alarm.name}" cleared`);
    o.scheduler.clear(alarm.name);
    return undefined;
  };
  o.scheduler.api.onAlarm.addListener(onAlarm);

  const tasks: Ticker[] = [
    new Ticker('daily-history', 60_000, () => retryDailyHistory(now()), 60_000),
    new Ticker('intraday-history', 60_000, () => refreshIntradayHistory(now()), 60_000),
    // the phone's open screen asks for prices every ~2 s; fastPoll paces itself (and rests while the feed delivers)
    new Ticker('fast-prices', 3_000, async () => (await fastPoll(now())).skipped ?? 'polled', 5_000),
    new Ticker('early-movers', 60_000, async () => void earlyTick(now()), 20_000),
    new Ticker('pre-open', 10_000, async () => `${await preopenTick(now())} listed`, 12_000),
    // app v1.19: the Intraday scanner (every NSE EQ stock, 9:15–3:15; returns at once outside) and its past test
    new Ticker('intraday', INTRADAY_EVERY_MS, async () => `${await intradayTick(now())} classified`, 15_000),
    new Ticker('intraday-test', 3_600_000, async () => void (await testIntradayIfDue(now())), 100_000),
    new Ticker('news', 30_000, async () => `${await refreshNews(now())} headlines`, 6_000),
    // learning and past tests: each decides itself whether it is due (once a day, outside market hours…)
    new Ticker('learning', 3_600_000, async () => void (await learnIfDue(now())), 60_000),
    new Ticker('rising-model', 3_600_000, async () => void (await trainRisingIfDue(now())), 150_000),
    new Ticker('short-model', 3_600_000, async () => `${await trainShortModelIfDue(now())}`, 40_000),
    new Ticker('breakout-test', 6 * 3_600_000, async () => void (await testBreakoutsIfDue(now())), 90_000),
    new Ticker('protect-test', 6 * 3_600_000, async () => void (await testProtect(now())), 120_000),
  ];

  let catching: Promise<void> = Promise.resolve();
  const ready = (async () => {
    for (const k of ['syncProgress', 'intradayProgress'] as const) {
      const p = await getSession(k);
      if (p?.running) await setSession(k, { ...p, running: false, at: now() });
    }
    await restoreNews().catch(() => undefined);
    await scheduleAll();
    o.scheduler.start();
    if (o.startTasks !== false) for (const t of tasks) t.start();
    log.info(`Trading intelligence started: ${o.scheduler.getAll().length} scheduled jobs, ${tasks.length} repeating tasks`);
    // anything missed while the server was off (it may call Upstox: not awaited by the start-up)
    catching = catchUp(now()).catch((err: unknown) => log.warn('Start-up catch-up failed', { error: err }));
  })();

  return {
    tasks,
    ready,
    async stop() {
      o.scheduler.api.onAlarm.removeListener(onAlarm);
      const wait = new Promise((r) => setTimeout(r, 10_000).unref?.());
      await Promise.all([o.scheduler.stop(), ...tasks.map((t) => t.stop()), Promise.race([catching, wait])]);
    },
  };
}
