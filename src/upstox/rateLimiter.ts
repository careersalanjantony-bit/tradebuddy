/**
 * Sliding-window rate limiter. Upstox standard limits: 50/s, 500/min, 2000/30 min per API per user.
 * We stay under them (spec §7.2): 40/s, 450/min, 1800/30 min.
 */

export interface RateWindow {
  ms: number;
  max: number;
  label: string;
}

export const UPSTOX_LIMITS: RateWindow[] = [
  { ms: 1_000, max: 40, label: 'per second' },
  { ms: 60_000, max: 450, label: 'per minute' },
  { ms: 30 * 60_000, max: 1800, label: 'per 30 min' },
];

export const DEFAULT_HISTORICAL_REQUESTS_PER_MINUTE = 30;
export const MAX_HISTORICAL_REQUESTS_PER_MINUTE = UPSTOX_LIMITS[1]!.max;

export function historicalWindows(requestsPerMinute: number): RateWindow[] {
  if (!Number.isInteger(requestsPerMinute) || requestsPerMinute < 1 || requestsPerMinute > MAX_HISTORICAL_REQUESTS_PER_MINUTE) {
    throw new RangeError(`Historical requests per minute must be an integer from 1 to ${MAX_HISTORICAL_REQUESTS_PER_MINUTE}`);
  }
  return UPSTOX_LIMITS.map((w) => w.ms === 60_000 ? { ...w, max: requestsPerMinute } : w);
}

export class RateLimiter {
  private stamps: number[];
  private readonly longest: number;

  constructor(
    private readonly windows: RateWindow[] = UPSTOX_LIMITS,
    timestamps: number[] = [],
  ) {
    this.longest = Math.max(...windows.map((w) => w.ms));
    this.stamps = [...timestamps].sort((a, b) => a - b);
  }

  private prune(now: number): void {
    const cutoff = now - this.longest;
    let i = 0;
    while (i < this.stamps.length && this.stamps[i]! <= cutoff) i++;
    if (i) this.stamps.splice(0, i);
  }

  /** Requests made inside each window ending at `now`. */
  private countSince(from: number): { count: number; firstIdx: number } {
    // stamps are sorted; binary search the first stamp > from
    let lo = 0;
    let hi = this.stamps.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.stamps[mid]! > from) hi = mid;
      else lo = mid + 1;
    }
    return { count: this.stamps.length - lo, firstIdx: lo };
  }

  /** Milliseconds until one more request is allowed (0 = now). */
  waitTime(now: number): number {
    this.prune(now);
    let wait = 0;
    for (const w of this.windows) {
      const { count, firstIdx } = this.countSince(now - w.ms);
      if (count >= w.max) {
        // the request that must drop out of the window before we may go
        const blocking = this.stamps[firstIdx + (count - w.max)]!;
        wait = Math.max(wait, blocking + w.ms - now + 1);
      }
    }
    return wait;
  }

  record(now: number): void {
    this.stamps.push(now);
  }

  /** Try to take a slot; returns 0 if taken, otherwise ms to wait. */
  tryAcquire(now: number): number {
    const w = this.waitTime(now);
    if (w === 0) this.record(now);
    return w;
  }

  usage(now: number): Array<{ label: string; used: number; max: number }> {
    this.prune(now);
    return this.windows.map((w) => ({ label: w.label, used: this.countSince(now - w.ms).count, max: w.max }));
  }

  snapshot(): number[] {
    return [...this.stamps];
  }
}
