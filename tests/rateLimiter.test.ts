import { describe, expect, it } from 'vitest';
import { RateLimiter, UPSTOX_LIMITS } from '../src/upstox/rateLimiter';

describe('RateLimiter (40/s, 450/min, 1800/30min)', () => {
  it('allows a burst of 40 per second, then makes the 41st wait', () => {
    const rl = new RateLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < 40; i++) expect(rl.tryAcquire(t0 + i)).toBe(0);
    const wait = rl.tryAcquire(t0 + 40);
    expect(wait).toBe(t0 + 1000 - (t0 + 40) + 1); // until the first request leaves the 1 s window
    expect(rl.tryAcquire(t0 + 40 + wait)).toBe(0);
  });

  it('enforces the per-minute window', () => {
    const rl = new RateLimiter();
    let t = 0;
    // 450 requests at 10/s → 45 s; none blocked by the 1 s window
    for (let i = 0; i < 450; i++) {
      expect(rl.tryAcquire(t)).toBe(0);
      t += 100;
    }
    const wait = rl.waitTime(t);
    expect(wait).toBe(60_000 - t + 1); // first request (at 0) must leave the minute window
  });

  it('enforces the 30-minute window', () => {
    const windows = UPSTOX_LIMITS.map((w) => (w.ms === 30 * 60_000 ? { ...w, max: 5 } : w));
    const rl = new RateLimiter(windows);
    for (let i = 0; i < 5; i++) expect(rl.tryAcquire(i * 120_000)).toBe(0);
    expect(rl.waitTime(5 * 120_000)).toBe(30 * 60_000 - 5 * 120_000 + 1);
  });

  it('reports usage and survives a restart via snapshot', () => {
    const rl = new RateLimiter();
    for (let i = 0; i < 7; i++) rl.record(10_000 + i * 200);
    const usage = rl.usage(11_300);
    expect(usage.map((u) => u.used)).toEqual([5, 7, 7]); // last second: 10,400..11,200 → 5
    const restored = new RateLimiter(UPSTOX_LIMITS, rl.snapshot());
    expect(restored.usage(11_300)).toEqual(usage);
  });

  it('forgets requests older than 30 minutes', () => {
    const rl = new RateLimiter(UPSTOX_LIMITS, [0, 1, 2]);
    expect(rl.usage(30 * 60_000 + 10).map((u) => u.used)).toEqual([0, 0, 0]);
    expect(rl.snapshot()).toEqual([]);
  });
});
