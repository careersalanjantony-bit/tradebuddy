import { createLogger } from '../lib/log';
import { errorMessage } from '../lib/serialize';
import { callBackground } from '../shared/messages';

const log = createLogger('login');

export type LoginResult = { ok: true; userName?: string; expiresAt: number } | { ok: false; message: string };

/**
 * Runs the Upstox login from an extension page (side panel or tab). The page stays alive while the
 * owner types ID, PIN and OTP in Upstox's own window; the service worker only builds the URL and
 * exchanges the code. Must not be used from the popup (it closes when the login window opens).
 */
export async function loginWithUpstox(): Promise<LoginResult> {
  let url: string;
  let redirectUri: string;
  try {
    ({ url, redirectUri } = await callBackground('auth:begin'));
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }

  let redirectedTo: string | undefined;
  try {
    redirectedTo = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
  } catch (err) {
    const msg = errorMessage(err);
    log.warn('Login window ended without a result', { reason: msg });
    if (/did not approve|closed|cancel/i.test(msg)) {
      return {
        ok: false,
        message:
          'The Upstox login window was closed before the login finished. If Upstox showed an error there, check the API key in Settings and that your Upstox app\'s redirect URL is exactly: ' +
          redirectUri,
      };
    }
    if (/could not be loaded/i.test(msg)) {
      return { ok: false, message: 'The Upstox login page could not be loaded. Check your internet connection and try again.' };
    }
    return { ok: false, message: `Login did not complete: ${msg}` };
  }
  if (!redirectedTo) return { ok: false, message: 'Login was cancelled.' };

  try {
    const r = await callBackground('auth:complete', { redirectUrl: redirectedTo });
    return { ok: true, expiresAt: r.expiresAt, ...(r.userName ? { userName: r.userName } : {}) };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}
