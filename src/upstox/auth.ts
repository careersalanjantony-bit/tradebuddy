import { createLogger } from '../lib/log';
import { getSecrets, updateSecrets } from '../storage/local';
import { getSession, removeSession, setSession } from '../storage/session';
import { upstoxRequest } from './client';
import { friendlyMessage, loginErrorMessage, UpstoxError } from './errors';
import { buildAuthorizeUrl, parseRedirect, parseTokenResponse, randomState, REDIRECT_PATH, STATE_MAX_AGE_MS, tokenRequestBody } from './oauth';
import { clearSession, saveNewSession, setAnalyticsState } from './session';

/**
 * AuthManager (spec §7.1), service-worker side.
 *
 * Login is split in two because the Upstox login window can stay open for minutes (PIN, OTP) and an
 * MV3 service worker may be stopped meanwhile:
 *   1. page → `auth:begin`    : SW builds the authorize URL with a random `state` (kept in storage.session)
 *   2. page runs chrome.identity.launchWebAuthFlow (the page stays alive while the owner logs in)
 *   3. page → `auth:complete` : SW checks `state`, exchanges the single-use code, stores the tokens
 */

const log = createLogger('auth');

export function redirectUri(): string {
  return chrome.identity.getRedirectURL(REDIRECT_PATH);
}

export async function beginLogin(now = Date.now()): Promise<{ url: string; redirectUri: string }> {
  const { upstoxApiKey, upstoxApiSecret } = await getSecrets();
  if (!upstoxApiKey || !upstoxApiSecret) {
    throw new Error('Enter your Upstox API key and API secret in Settings first.');
  }
  const state = randomState();
  const uri = redirectUri();
  await setSession('pendingLogin', { state, redirectUri: uri, createdAt: now });
  log.info('Login started');
  return { url: buildAuthorizeUrl({ clientId: upstoxApiKey, redirectUri: uri, state }), redirectUri: uri };
}

export async function completeLogin(redirectedTo: string, now = Date.now()): Promise<{ userName?: string; userId?: string; expiresAt: number }> {
  const pending = await getSession('pendingLogin');
  await removeSession('pendingLogin'); // single use, whatever happens next
  if (!pending) throw new Error('No login was in progress. Click "Log in to Upstox" again.');
  if (now - pending.createdAt > STATE_MAX_AGE_MS) throw new Error('The login took longer than 10 minutes. Click "Log in to Upstox" again.');

  const parsed = parseRedirect(redirectedTo, { redirectUri: pending.redirectUri, state: pending.state });
  if (!parsed.ok) {
    log.warn(`Login redirect rejected: ${parsed.reason}`);
    throw new Error(parsed.message);
  }

  const { upstoxApiKey, upstoxApiSecret } = await getSecrets();
  if (!upstoxApiKey || !upstoxApiSecret) throw new Error('API key or secret missing in Settings.');

  try {
    const body = await upstoxRequest<unknown>('/v2/login/authorization/token', {
      method: 'POST',
      tokenKind: 'none',
      form: tokenRequestBody({ code: parsed.code, clientId: upstoxApiKey, clientSecret: upstoxApiSecret, redirectUri: pending.redirectUri }),
      attempts: 1, // the code is single-use: never retry
      raw: true,
    });
    const token = parseTokenResponse(body);
    const auth = await saveNewSession(token, now);
    return { ...(auth.userName ? { userName: auth.userName } : {}), ...(auth.userId ? { userId: auth.userId } : {}), expiresAt: auth.expiresAt! };
  } catch (err) {
    log.error('Token exchange failed', { error: err });
    throw new Error(loginErrorMessage(err, pending.redirectUri));
  }
}

export async function logout(): Promise<void> {
  try {
    await upstoxRequest('/v2/logout', { method: 'DELETE', tokenKind: 'account', attempts: 1 });
  } catch (err) {
    // Best effort: the local session is cleared regardless.
    if (!(err instanceof UpstoxError && err.kind === 'not_logged_in')) log.warn('Upstox logout call failed', { error: err });
  }
  await clearSession();
}

export interface ProfileSummary {
  userId?: string;
  userName?: string;
}

/** GET /v2/user/profile with the daily token. */
export async function testConnection(): Promise<ProfileSummary> {
  try {
    const p = await upstoxRequest<{ user_id?: string; user_name?: string }>('/v2/user/profile', { tokenKind: 'account', attempts: 2 });
    return { ...(p.user_id ? { userId: p.user_id } : {}), ...(p.user_name ? { userName: p.user_name } : {}) };
  } catch (err) {
    throw new Error(friendlyMessage(err, redirectUri()));
  }
}

/**
 * Checks an Analytics Token by calling a market-data endpoint (holidays) with it.
 * Returns the holidays payload so the caller can store it.
 */
export async function testAnalyticsToken(token?: string): Promise<unknown> {
  const saved = (await getSecrets()).upstoxAnalyticsToken;
  const t = token?.trim() || saved;
  if (!t) throw new Error('No Analytics Token saved.');
  const isNew = t !== saved;
  try {
    const data = await upstoxRequest<unknown>('/v2/market/holidays', { tokenKind: 'market', analyticsTokenOverride: t, attempts: 2 });
    // Save a new token only after it worked, so a wrong paste never replaces a working token.
    if (isNew) {
      await updateSecrets({ upstoxAnalyticsToken: t });
      log.info('Analytics Token saved');
    }
    await setAnalyticsState({ status: 'valid', checkedAt: Date.now() });
    return data;
  } catch (err) {
    if (err instanceof UpstoxError && err.kind === 'auth') {
      if (!isNew) await setAnalyticsState({ status: 'invalid', checkedAt: Date.now(), error: err.message });
      throw new Error(
        `Upstox did not accept ${isNew ? 'this' : 'the saved'} Analytics Token. Copy it again, or generate a new one in Upstox Developer Apps → Analytics.`,
      );
    }
    throw new Error(friendlyMessage(err));
  }
}
