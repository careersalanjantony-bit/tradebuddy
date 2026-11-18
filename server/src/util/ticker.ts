import { createLogger } from '../../../src/lib/log';
import { errorMessage } from '../../../src/lib/serialize';

/**
 * A repeating server task: runs every `everyMs`, never two runs at once, remembers its last result for
 * the health check, and can be stopped (waiting for a run in progress to finish).
 */

export interface TickerStatus {
  name: string;
  everyMs: number;
  runs: number;
  failures: number;
  running: boolean;
  lastRunAt: number | null;
  lastOkAt: number | null;
  lastResult: string | null;
  lastError: string | null;
}

const log = createLogger('task');

export class Ticker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private current: Promise<void> | null = null;
  private stopped = true;
  private failing = false;
  private s: TickerStatus;

  constructor(
    name: string,
    everyMs: number,
    private readonly fn: () => Promise<string | void>,
    private readonly initialDelayMs = 0,
  ) {
    this.s = { name, everyMs, runs: 0, failures: 0, running: false, lastRunAt: null, lastOkAt: null, lastResult: null, lastError: null };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(this.initialDelayMs);
  }

  /** Runs once now (also used by tests); a run already in progress is joined, not repeated. */
  runNow(): Promise<void> {
    this.current ??= this.run().finally(() => {
      this.current = null;
    });
    return this.current;
  }

  /** Stops repeating; resolves when a run in progress ends (or after `waitMs`). */
  async stop(waitMs = 5_000): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.current) await Promise.race([this.current, new Promise((r) => setTimeout(r, waitMs).unref?.())]);
  }

  status(): TickerStatus {
    return { ...this.s, running: this.current !== null };
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.runNow().finally(() => this.schedule(this.s.everyMs));
    }, ms);
    this.timer.unref?.();
  }

  private async run(): Promise<void> {
    const started = Date.now();
    this.s.runs++;
    this.s.lastRunAt = started;
    try {
      const r = await this.fn();
      this.s.lastOkAt = Date.now();
      this.s.lastResult = r ?? 'ok';
      if (this.failing) log.info(`Task ${this.s.name} works again`);
      this.failing = false;
      this.s.lastError = null;
    } catch (err) {
      this.s.failures++;
      this.s.lastError = errorMessage(err);
      // the same error every few seconds would flood the log: only the first of a series
      if (!this.failing) log.warn(`Task ${this.s.name} failed`, { error: this.s.lastError });
      this.failing = true;
    }
  }
}
