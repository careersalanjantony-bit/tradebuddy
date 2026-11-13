import type { AuthState } from '../storage/schema';
import { nextIstTime } from '../lib/time';

/**
 * Upstox access tokens are valid "until 3:30 AM the following day, regardless of when generated";
 * a token made at 02:30 expires at 03:30 the same day. Docs do not name the timezone; we use IST.
 * (VERIFY against a real expiry — see docs/VERIFIED.md.)
 */
export const TOKEN_EXPIRY_HHMM = '03:30';

export function tokenExpiryFor(issuedAt: number): number {
  return nextIstTime(issuedAt, TOKEN_EXPIRY_HHMM)!;
}

/** True when the stored session is logged in and its expiry time has passed. */
export function isSessionExpiredByTime(auth: AuthState, now: number): boolean {
  return auth.status === 'logged_in' && auth.expiresAt !== undefined && now >= auth.expiresAt;
}

/** Logged in with a token that has not reached its expiry time. */
export function hasLiveSession(auth: AuthState | undefined, now: number): boolean {
  return !!auth && auth.status === 'logged_in' && !!auth.accessToken && (auth.expiresAt === undefined || now < auth.expiresAt);
}
