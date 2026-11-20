import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * API authentication: `Authorization: Bearer <TB_API_TOKEN>`. The comparison takes the same time
 * whatever the token, and an address that keeps sending wrong tokens is turned away for a while.
 */

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

export function bearerMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  if (!m) return false;
  return timingSafeEqual(digest(m[1]!), digest(token));
}

/** Wrong tokens per address: after `max` within `windowMs`, refuse until the window passes. */
export class FailureLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max = 20,
    private readonly windowMs = 10 * 60_000,
  ) {}

  blocked(ip: string, now = Date.now()): boolean {
    return this.recent(ip, now).length >= this.max;
  }

  fail(ip: string, now = Date.now()): void {
    const list = this.recent(ip, now);
    list.push(now);
    this.hits.set(ip, list);
    if (this.hits.size > 10_000) this.hits.clear(); // a flood of addresses must not use up memory
  }

  private recent(ip: string, now: number): number[] {
    const list = (this.hits.get(ip) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length) this.hits.set(ip, list);
    else this.hits.delete(ip);
    return list;
  }
}
