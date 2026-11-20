import type { DatabaseSync } from 'node:sqlite';
import { createLogger } from '../../../src/lib/log';
import { errorMessage } from '../../../src/lib/serialize';

/**
 * chrome.alarms on the server (milestone 3), kept in SQLite so the app's schedule survives restarts.
 *
 *  - The app's own scheduler (src/background/scheduler.ts) creates its alarms here exactly as on the
 *    phone: the daily jobs at IST times computed by src/background/schedule.ts and the 30-second price poll.
 *  - An alarm that came due while the server was off fires once when it starts (like Chrome);
 *    a repeating alarm then continues at its own rhythm — missed repeats are not fired in a burst.
 *  - Never twice at once: while an alarm's work is still running, that alarm is skipped (a repeating
 *    one simply waits for its next time). `stop()` waits for running work.
 */

export interface Alarm {
  name: string;
  scheduledTime: number;
  periodInMinutes?: number;
}

export type AlarmListener = (alarm: Alarm) => unknown;

const log = createLogger('alarms');

export class AlarmScheduler {
  private readonly listeners = new Set<AlarmListener>();
  private readonly running = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** alarms skipped because the previous run of the same alarm was still going */
  skipped = 0;
  fired = 0;

  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {}

  /** The chrome.alarms object the shared code calls. */
  readonly api = {
    create: async (name: string, info: { when?: number; delayInMinutes?: number; periodInMinutes?: number } = {}): Promise<void> => this.create(name, info),
    get: async (name: string): Promise<Alarm | undefined> => this.get(name),
    getAll: async (): Promise<Alarm[]> => this.getAll(),
    clear: async (name: string): Promise<boolean> => this.clear(name),
    clearAll: async (): Promise<boolean> => {
      this.db.prepare('DELETE FROM alarms').run();
      return true;
    },
    onAlarm: {
      addListener: (l: AlarmListener) => void this.listeners.add(l),
      removeListener: (l: AlarmListener) => void this.listeners.delete(l),
      hasListener: (l: AlarmListener) => this.listeners.has(l),
    },
  };

  create(name: string, info: { when?: number; delayInMinutes?: number; periodInMinutes?: number }): void {
    const period = info.periodInMinutes && info.periodInMinutes > 0 ? info.periodInMinutes : null;
    const when = info.when ?? this.now() + (info.delayInMinutes ?? period ?? 0) * 60_000;
    this.db.prepare('INSERT INTO alarms (name, scheduled_time, period_minutes) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET scheduled_time = excluded.scheduled_time, period_minutes = excluded.period_minutes').run(name, Math.round(when), period);
  }

  get(name: string): Alarm | undefined {
    const r = this.db.prepare('SELECT name, scheduled_time, period_minutes FROM alarms WHERE name = ?').get(name) as { name: string; scheduled_time: number; period_minutes: number | null } | undefined;
    return r ? toAlarm(r) : undefined;
  }

  getAll(): Alarm[] {
    return (this.db.prepare('SELECT name, scheduled_time, period_minutes FROM alarms ORDER BY scheduled_time').all() as Array<{ name: string; scheduled_time: number; period_minutes: number | null }>).map(toAlarm);
  }

  clear(name: string): boolean {
    return Number(this.db.prepare('DELETE FROM alarms WHERE name = ?').run(name).changes) > 0;
  }

  start(tickMs = 1_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), tickMs);
    this.timer.unref?.();
  }

  /** Fires every alarm that is due now. Returns the names fired. */
  tick(): string[] {
    const now = this.now();
    const due = this.db.prepare('SELECT name, scheduled_time, period_minutes FROM alarms WHERE scheduled_time <= ? ORDER BY scheduled_time').all(now) as Array<{ name: string; scheduled_time: number; period_minutes: number | null }>;
    const fired: string[] = [];
    for (const r of due) {
      const alarm = toAlarm(r);
      // the next time first (a repeating alarm keeps its rhythm; a one-off is used up)
      if (r.period_minutes) {
        const step = r.period_minutes * 60_000;
        const next = r.scheduled_time + Math.max(1, Math.ceil((now - r.scheduled_time + 1) / step)) * step;
        this.db.prepare('UPDATE alarms SET scheduled_time = ? WHERE name = ?').run(next, r.name);
      } else {
        this.db.prepare('DELETE FROM alarms WHERE name = ? AND scheduled_time = ?').run(r.name, r.scheduled_time);
      }
      if (this.running.has(r.name)) {
        this.skipped++;
        log.info(`Alarm ${r.name}: the previous run is still going — skipped this time`);
        continue;
      }
      fired.push(r.name);
      this.fired++;
      const work = Promise.all([...this.listeners].map(async (l) => l(alarm)))
        .then(() => undefined)
        .catch((err: unknown) => log.warn(`Alarm ${r.name} failed`, { error: errorMessage(err) }))
        .finally(() => this.running.delete(r.name));
      this.running.set(r.name, work);
    }
    return fired;
  }

  /** Stops firing; waits (up to `waitMs`) for alarm work still running. */
  async stop(waitMs = 10_000): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.running.size) await Promise.race([Promise.all([...this.running.values()]), new Promise((r) => setTimeout(r, waitMs).unref?.())]);
  }

  runningNames(): string[] {
    return [...this.running.keys()];
  }
}

function toAlarm(r: { name: string; scheduled_time: number; period_minutes: number | null }): Alarm {
  return { name: r.name, scheduledTime: r.scheduled_time, ...(r.period_minutes ? { periodInMinutes: r.period_minutes } : {}) };
}
