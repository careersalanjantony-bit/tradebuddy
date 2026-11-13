import { createLogger } from '../lib/log';
import { registerSecrets } from '../lib/redact';
import { clearNotification, notify } from '../notify/chrome';
import { getAuth, setLocal } from '../storage/local';
import type { AnalyticsTokenState, AuthState } from '../storage/schema';
import type { TokenResult } from './oauth';
import { tokenExpiryFor } from './token';

/** Reads and changes the stored Upstox session (chrome.storage.local `auth`). */

const log = createLogger('session');

export async function saveNewSession(token: TokenResult, now = Date.now()): Promise<AuthState> {
  const prev = await getAuth();
  const next: AuthState = {
    status: 'logged_in',
    accessToken: token.accessToken,
    issuedAt: now,
    expiresAt: tokenExpiryFor(now),
    ...(token.extendedToken ? { extendedToken: token.extendedToken } : {}),
    ...(token.userId ? { userId: token.userId } : {}),
    ...(token.userName ? { userName: token.userName } : {}),
    ...(prev.analytics ? { analytics: prev.analytics } : {}),
  };
  registerSecrets([token.accessToken, token.extendedToken]);
  await setLocal('auth', next);
  await clearNotification('login-reminder');
  await clearNotification('session-expired');
  log.info('Logged in to Upstox', { userId: next.userId, expiresAt: new Date(next.expiresAt!).toISOString() });
  return next;
}

/**
 * The daily token is no longer usable (03:30 expiry or a 401). Tokens are deleted.
 * `notifyOwner`: show a Chrome notification (used for 401s during the day, not for the silent 03:30 expiry).
 */
export async function markSessionExpired(reason: string, opts: { notifyOwner: boolean; now?: number } = { notifyOwner: false }): Promise<void> {
  const prev = await getAuth();
  if (prev.status !== 'logged_in') return;
  const next: AuthState = {
    status: 'expired',
    expiredAt: opts.now ?? Date.now(),
    lastError: reason,
    ...(prev.userId ? { userId: prev.userId } : {}),
    ...(prev.userName ? { userName: prev.userName } : {}),
    ...(prev.analytics ? { analytics: prev.analytics } : {}),
  };
  await setLocal('auth', next);
  log.warn(`Upstox session ended: ${reason}`);
  if (opts.notifyOwner) {
    await notify('session-expired', {
      title: 'Upstox session ended',
      message: 'Open Swing Trade Assistant and click "Log in to Upstox" again.',
    });
  }
}

export async function clearSession(): Promise<void> {
  const prev = await getAuth();
  await setLocal('auth', { status: 'logged_out', ...(prev.analytics ? { analytics: prev.analytics } : {}) });
  log.info('Logged out of Upstox');
}

export async function setAnalyticsState(state: AnalyticsTokenState): Promise<void> {
  const prev = await getAuth();
  const changed = prev.analytics?.status !== state.status;
  await setLocal('auth', { ...prev, analytics: state });
  if (changed && state.status === 'invalid') {
    log.warn('Analytics Token was rejected by Upstox', { error: state.error });
    await notify('analytics-invalid', {
      title: 'Upstox Analytics Token not accepted',
      message: 'Generate a new Analytics Token in Upstox Developer Apps and paste it into Settings.',
    });
  }
  if (changed && state.status === 'valid') await clearNotification('analytics-invalid');
}
