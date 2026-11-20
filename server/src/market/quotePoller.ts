import { pollDue, type MarketCalendar } from '../../../src/data/calendar';
import { createLogger } from '../../../src/lib/log';
import { UpstoxError } from '../../../src/upstox/errors';

/**
 * Prices over the Upstox REST API, with the app's own functions (src/data/quotes.ts):
 *  - a full poll (price + the day's open / high / low / volume) every 30 s — the phone's alarm cadence;
 *  - between those, a light poll (last prices) every few seconds, but only while the live feed is not
 *    delivering — the phone's 2-second fallback;
 *  - when the market is closed: once, for the last session's closing prices (the app's `pollDue`).
 * The app's rate limiter sits inside every request, so this cannot exceed Upstox's limits.
 */

export interface QuotePollerDeps {
  calendar(): Promise<MarketCalendar | null>;
  lastPoll(): Promise<{ at: number; ok: boolean } | undefined>;
  keys(): Promise<string[]>;
  feedFresh(now: number): boolean;
  pollFull(keys: string[], now: number): Promise<unknown>;
  pollLight(keys: string[], now: number): Promise<unknown>;
  now?: () => number;
}

export interface QuotePollerHealth {
  lastResult: string | null;
  lastFullAt: number | null;
  lastLightAt: number | null;
  fullPolls: number;
  lightPolls: number;
  failures: number;
  lastError: string | null;
  waitingUntil: number | null;
}

export const NOT_LOGGED_IN_WAIT_MS = 5 * 60_000;
const log = createLogger('quote-poller');

export class QuotePoller {
  private h: QuotePollerHealth = { lastResult: null, lastFullAt: null, lastLightAt: null, fullPolls: 0, lightPolls: 0, failures: 0, lastError: null, waitingUntil: null };

  constructor(
    private readonly deps: QuotePollerDeps,
    private readonly fullEveryMs = 30_000,
    private readonly lightEveryMs = 5_000,
  ) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** One check; returns what it did: 'full' | 'light' | 'feed' | 'closed' | 'no keys' | 'waiting'. */
  async check(): Promise<string> {
    const now = this.now();
    const result = await this.decide(now);
    this.h.lastResult = result;
    return result;
  }

  private async decide(now: number): Promise<string> {
    if (this.h.waitingUntil !== null && now < this.h.waitingUntil) return 'waiting';
    this.h.waitingUntil = null;
    if (!pollDue(now, await this.deps.calendar(), await this.deps.lastPoll())) return 'closed';
    const keys = await this.deps.keys();
    if (!keys.length) return 'no keys';
    const fullDue = this.h.lastFullAt === null || now - this.h.lastFullAt >= this.fullEveryMs;
    const lightDue = !this.deps.feedFresh(now) && (this.h.lastLightAt === null || now - this.h.lastLightAt >= this.lightEveryMs);
    if (!fullDue && !lightDue) return 'feed';
    try {
      if (fullDue) {
        await this.deps.pollFull(keys, now);
        this.h.lastFullAt = now;
        this.h.fullPolls++;
      } else {
        await this.deps.pollLight(keys, now);
        this.h.lastLightAt = now;
        this.h.lightPolls++;
      }
      this.h.lastError = null;
      return fullDue ? 'full' : 'light';
    } catch (err) {
      this.h.failures++;
      this.h.lastError = err instanceof Error ? err.message : String(err);
      if (err instanceof UpstoxError && err.kind === 'not_logged_in') {
        // no (valid) Analytics Token: asking again every few seconds would not help
        this.h.waitingUntil = now + NOT_LOGGED_IN_WAIT_MS;
        log.warn('Upstox prices need a valid Analytics Token (UPSTOX_ANALYTICS_TOKEN) — trying again in 5 minutes');
        return 'waiting';
      }
      // keep the cadence after an error instead of hammering the API
      if (fullDue) this.h.lastFullAt = now;
      else this.h.lastLightAt = now;
      throw err;
    }
  }

  health(): QuotePollerHealth {
    return { ...this.h };
  }
}
