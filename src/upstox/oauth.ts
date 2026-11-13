/**
 * Upstox OAuth 2.0 authorization-code flow (docs checked 9 Nov 2026, see docs/VERIFIED.md).
 * Pure helpers; the flow itself runs in auth.ts (service worker) and ui/login.ts (page).
 */

export const UPSTOX_API = 'https://api.upstox.com';
export const AUTHORIZE_URL = `${UPSTOX_API}/v2/login/authorization/dialog`;
export const TOKEN_URL = `${UPSTOX_API}/v2/login/authorization/token`;
export const REDIRECT_PATH = 'upstox';
/** A login must complete within this time after it was started. */
export const STATE_MAX_AGE_MS = 10 * 60_000;

export function buildAuthorizeUrl(p: { clientId: string; redirectUri: string; state: string }): string {
  const q = new URLSearchParams({ response_type: 'code', client_id: p.clientId, redirect_uri: p.redirectUri, state: p.state });
  return `${AUTHORIZE_URL}?${q.toString()}`;
}

export function randomState(bytes = 24): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let s = '';
  for (const b of buf) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export type RedirectResult =
  | { ok: true; code: string }
  | { ok: false; reason: 'bad_url' | 'wrong_redirect' | 'denied' | 'no_code' | 'state_mismatch'; message: string };

/** Checks the URL Upstox redirected to: right place, matching state, a code present. */
export function parseRedirect(redirectedTo: string, expected: { redirectUri: string; state: string }): RedirectResult {
  let url: URL;
  try {
    url = new URL(redirectedTo);
  } catch {
    return { ok: false, reason: 'bad_url', message: 'Upstox returned an invalid address.' };
  }
  const want = new URL(expected.redirectUri);
  if (url.origin !== want.origin || url.pathname !== want.pathname) {
    return { ok: false, reason: 'wrong_redirect', message: 'Upstox sent the login to a different address than expected.' };
  }
  const p = url.searchParams;
  const err = p.get('error');
  if (err) {
    return { ok: false, reason: 'denied', message: `Upstox login was not completed: ${p.get('error_description') ?? err}` };
  }
  if (p.get('state') !== expected.state) {
    return { ok: false, reason: 'state_mismatch', message: 'Security check failed (state mismatch). Please click Log in again.' };
  }
  const code = p.get('code');
  if (!code) return { ok: false, reason: 'no_code', message: 'Upstox did not return a login code. Please try again.' };
  return { ok: true, code };
}

export function tokenRequestBody(p: { code: string; clientId: string; clientSecret: string; redirectUri: string }): URLSearchParams {
  return new URLSearchParams({
    code: p.code,
    client_id: p.clientId,
    client_secret: p.clientSecret,
    redirect_uri: p.redirectUri,
    grant_type: 'authorization_code',
  });
}

export interface TokenResult {
  accessToken: string;
  extendedToken?: string;
  userId?: string;
  userName?: string;
}

/** The docs show a flat response; accept `{data: …}` too in case it is wrapped like other endpoints. */
export function parseTokenResponse(json: unknown): TokenResult {
  const root = (json ?? {}) as Record<string, unknown>;
  const src = (typeof root.access_token === 'string' ? root : (root.data as Record<string, unknown> | undefined)) ?? {};
  const accessToken = src.access_token;
  if (typeof accessToken !== 'string' || !accessToken) throw new Error('Upstox token response has no access_token');
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const out: TokenResult = { accessToken };
  const ext = str(src.extended_token);
  const uid = str(src.user_id);
  const uname = str(src.user_name);
  if (ext) out.extendedToken = ext;
  if (uid) out.userId = uid;
  if (uname) out.userName = uname;
  return out;
}
