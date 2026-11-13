import { describe, expect, it } from 'vitest';
import { buildAuthorizeUrl, parseRedirect, parseTokenResponse, randomState, tokenRequestBody } from '../src/upstox/oauth';

const redirectUri = 'https://joalpejfcchnfbcjacmijbmmbmmnobio.chromiumapp.org/upstox';

describe('authorize URL', () => {
  it('has the documented endpoint and parameters', () => {
    const u = new URL(buildAuthorizeUrl({ clientId: 'key-123', redirectUri, state: 'abc' }));
    expect(u.origin + u.pathname).toBe('https://api.upstox.com/v2/login/authorization/dialog');
    expect(Object.fromEntries(u.searchParams)).toEqual({ response_type: 'code', client_id: 'key-123', redirect_uri: redirectUri, state: 'abc' });
  });
  it('random state is URL-safe and unique', () => {
    const a = randomState();
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(randomState()).not.toBe(a);
  });
});

describe('parseRedirect', () => {
  const exp = { redirectUri, state: 'S1' };
  it('accepts a matching redirect', () => {
    expect(parseRedirect(`${redirectUri}?code=mk404x&state=S1`, exp)).toEqual({ ok: true, code: 'mk404x' });
  });
  it('rejects a state mismatch', () => {
    expect(parseRedirect(`${redirectUri}?code=x&state=OTHER`, exp)).toMatchObject({ ok: false, reason: 'state_mismatch' });
    expect(parseRedirect(`${redirectUri}?code=x`, exp)).toMatchObject({ ok: false, reason: 'state_mismatch' });
  });
  it('rejects a missing code, an error, a wrong address and garbage', () => {
    expect(parseRedirect(`${redirectUri}?state=S1`, exp)).toMatchObject({ ok: false, reason: 'no_code' });
    expect(parseRedirect(`${redirectUri}?error=access_denied&state=S1`, exp)).toMatchObject({ ok: false, reason: 'denied' });
    expect(parseRedirect('https://evil.example/upstox?code=x&state=S1', exp)).toMatchObject({ ok: false, reason: 'wrong_redirect' });
    expect(parseRedirect('not a url', exp)).toMatchObject({ ok: false, reason: 'bad_url' });
  });
});

describe('token exchange', () => {
  it('builds the documented form body', () => {
    const b = tokenRequestBody({ code: 'c', clientId: 'k', clientSecret: 's', redirectUri });
    expect(Object.fromEntries(b)).toEqual({ code: 'c', client_id: 'k', client_secret: 's', redirect_uri: redirectUri, grant_type: 'authorization_code' });
  });
  it('parses the flat response from the docs', () => {
    const r = parseTokenResponse({ email: 'e', user_id: 'AB1234', user_name: 'Alan', access_token: 'tok', extended_token: 'ext' });
    expect(r).toEqual({ accessToken: 'tok', extendedToken: 'ext', userId: 'AB1234', userName: 'Alan' });
  });
  it('also accepts a {status, data} wrapped response', () => {
    expect(parseTokenResponse({ status: 'success', data: { access_token: 'tok' } })).toEqual({ accessToken: 'tok' });
  });
  it('throws when there is no access token', () => {
    expect(() => parseTokenResponse({ status: 'success', data: {} })).toThrow(/access_token/);
    expect(() => parseTokenResponse(null)).toThrow();
  });
});
