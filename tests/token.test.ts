import { describe, expect, it } from 'vitest';
import { istEpoch } from '../src/lib/time';
import { hasLiveSession, isSessionExpiredByTime, tokenExpiryFor } from '../src/upstox/token';

describe('Upstox token expiry (03:30 IST the following day)', () => {
  it('a token made in the evening expires at 03:30 next morning', () => {
    expect(tokenExpiryFor(istEpoch('2026-11-09', '16:58'))).toBe(istEpoch('2026-11-10', '03:30'));
  });
  it('docs example: 8 PM Tuesday → 3:30 AM Wednesday', () => {
    expect(tokenExpiryFor(istEpoch('2026-11-10', '20:00'))).toBe(istEpoch('2026-11-11', '03:30'));
  });
  it('docs example: 2:30 AM Wednesday → 3:30 AM the same Wednesday', () => {
    expect(tokenExpiryFor(istEpoch('2026-11-11', '02:30'))).toBe(istEpoch('2026-11-11', '03:30'));
  });
  it('a token made exactly at 03:30 lasts until the next day', () => {
    expect(tokenExpiryFor(istEpoch('2026-11-11', '03:30'))).toBe(istEpoch('2026-11-12', '03:30'));
    expect(tokenExpiryFor(istEpoch('2026-11-11', '03:29', 59))).toBe(istEpoch('2026-11-11', '03:30'));
  });
});

describe('session state', () => {
  const expiresAt = istEpoch('2026-11-10', '03:30');
  const auth = { status: 'logged_in' as const, accessToken: 't', expiresAt };
  it('is live before expiry and expired after', () => {
    expect(hasLiveSession(auth, expiresAt - 1)).toBe(true);
    expect(hasLiveSession(auth, expiresAt)).toBe(false);
    expect(isSessionExpiredByTime(auth, expiresAt)).toBe(true);
    expect(isSessionExpiredByTime(auth, expiresAt - 1)).toBe(false);
  });
  it('is not live when logged out or without a token', () => {
    expect(hasLiveSession({ status: 'logged_out' }, 0)).toBe(false);
    expect(hasLiveSession({ status: 'logged_in' }, 0)).toBe(false);
    expect(hasLiveSession(undefined, 0)).toBe(false);
  });
});
