import { describe, expect, it } from 'vitest';
import { errorFromResponse, friendlyMessage, loginErrorMessage, parseRetryAfter, UpstoxError } from '../src/upstox/errors';

const body = (code: string, message = 'msg') => ({ status: 'error', errors: [{ error_code: code, message, property_path: null, invalid_value: null }] });

describe('errorFromResponse', () => {
  it('401 and invalid-token codes are auth errors', () => {
    expect(errorFromResponse(401, body('UDAPI100050')).kind).toBe('auth');
    expect(errorFromResponse(400, body('UDAPI100050')).kind).toBe('auth');
    expect(errorFromResponse(401, null).kind).toBe('auth');
  });
  it('app-setting codes are config errors (even with 401)', () => {
    for (const c of ['UDAPI100068', 'UDAPI100069', 'UDAPI100070']) expect(errorFromResponse(401, body(c)).kind).toBe('config');
  });
  it('429 is a retryable rate-limit error with Retry-After', () => {
    const e = errorFromResponse(429, body('UDAPI100099'), '2');
    expect(e.kind).toBe('rate_limit');
    expect(e.retryAfterMs).toBe(2000);
    expect(e.retryable).toBe(true);
  });
  it('5xx is retryable, other 4xx is not', () => {
    expect(errorFromResponse(503, null).retryable).toBe(true);
    const e = errorFromResponse(400, body('UDAPI1088', 'Invalid date'));
    expect(e).toMatchObject({ kind: 'client', code: 'UDAPI1088', message: 'Invalid date', httpStatus: 400 });
    expect(e.retryable).toBe(false);
  });
  it('reads deprecated camelCase errorCode', () => {
    expect(errorFromResponse(400, { errors: [{ errorCode: 'UDAPI100050', message: 'x' }] }).code).toBe('UDAPI100050');
  });
});

describe('parseRetryAfter', () => {
  it('handles seconds, dates and junk', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6_000);
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });
});

describe('friendlyMessage', () => {
  const url = 'https://id.chromiumapp.org/upstox';
  it('explains setup problems in plain words', () => {
    expect(friendlyMessage(errorFromResponse(401, body('UDAPI100069')))).toMatch(/API key or API secret is wrong/);
    expect(friendlyMessage(errorFromResponse(400, body('UDAPI100070')), url)).toContain(url);
    expect(friendlyMessage(errorFromResponse(401, body('UDAPI100050')))).toMatch(/log in again/);
    expect(friendlyMessage(new UpstoxError('x', 'network'))).toMatch(/internet/);
  });
});

describe('loginErrorMessage (real case, 11 Nov 2026)', () => {
  const withMsg = (status: number, message: string, code?: string) => errorFromResponse(status, { status: 'error', errors: [{ ...(code ? { error_code: code } : {}), message }] });
  it('shows Upstox\'s own reason instead of "session no longer valid"', () => {
    const m = loginErrorMessage(withMsg(401, 'No segments for these users are active. Manual reactivation is recommended from Upstox app/web.'));
    expect(m).toMatch(/segments of your Upstox account are not active/);
    expect(m).toContain('No segments for these users are active');
    expect(m).not.toMatch(/session is no longer valid/);
    expect(loginErrorMessage(withMsg(403, 'Something else', 'UDAPI199999'))).toBe('Upstox refused the login: "Something else" (UDAPI199999).');
  });
  it('keeps the plain-words messages for known app-settings errors', () => {
    expect(loginErrorMessage(withMsg(401, 'Check your client_id', 'UDAPI100069'))).toMatch(/API key or API secret is wrong/);
    expect(loginErrorMessage(new Error('boom'))).toBe('boom');
  });
});
