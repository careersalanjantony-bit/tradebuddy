import { afterEach, describe, expect, it } from 'vitest';
import { clearKnownSecrets, isSensitiveKey, redact, REDACTED, redactString, registerSecrets } from '../src/lib/redact';

afterEach(() => clearKnownSecrets());

describe('isSensitiveKey', () => {
  it('matches secret-bearing keys in any casing/separator style', () => {
    for (const k of ['Authorization', 'x-api-key', 'X-Api-Key', 'client_secret', 'access_token', 'extended_token', 'accessToken', 'code', 'telegramBotToken', 'upstoxApiSecret']) {
      expect(isSensitiveKey(k), k).toBe(true);
    }
  });
  it('does not match harmless keys that merely contain a sensitive word', () => {
    for (const k of ['instrument_token', 'errorCode', 'error_code', 'trading_symbol', 'tokenExpiresAt', 'isin']) {
      expect(isSensitiveKey(k), k).toBe(false);
    }
  });
});

describe('redactString', () => {
  it('redacts bearer tokens', () => {
    expect(redactString('Authorization: Bearer eyJhbGciOi.abc.def')).toBe(`Authorization: Bearer ${REDACTED}`);
  });
  it('redacts telegram bot tokens in URLs', () => {
    expect(redactString('https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendMessage')).toBe(
      `https://api.telegram.org/bot${REDACTED}/sendMessage`,
    );
  });
  it('redacts sensitive query parameters but keeps others', () => {
    const out = redactString('https://x/cb?code=abc123&state=xyz&client_secret=s3cr3t');
    expect(out).toBe(`https://x/cb?code=${REDACTED}&state=xyz&client_secret=${REDACTED}`);
  });
  it('redacts Anthropic keys', () => {
    expect(redactString('key sk-ant-api03-AbCdEf123456_-x used')).toBe(`key ${REDACTED} used`);
  });
  it('redacts header-style text', () => {
    expect(redactString('x-api-key: abcdef123')).toBe(`x-api-key: ${REDACTED}`);
  });
  it('redacts registered known secrets anywhere', () => {
    registerSecrets(['my-upstox-secret-value', 'short', undefined]);
    expect(redactString('failed with my-upstox-secret-value inside')).toBe(`failed with ${REDACTED} inside`);
    expect(redactString('short stays')).toBe('short stays'); // < 8 chars is not tracked
  });
  it('leaves normal text alone', () => {
    const s = 'TRENT close ₹4,210.50 on 2026-11-06, SMA200 2794.7';
    expect(redactString(s)).toBe(s);
  });
});

describe('redact (deep)', () => {
  it('redacts nested objects, arrays and keeps structure', () => {
    const input = {
      url: 'https://api.upstox.com/v2/login/authorization/token',
      headers: { Authorization: 'Bearer abc.def.ghi', Accept: 'application/json' },
      body: { code: 'ONE-TIME', client_id: 'public', client_secret: 'xyz', grant_type: 'authorization_code' },
      list: [{ access_token: 't1' }, 'Bearer zzzzzzzz'],
      instrument_token: 'NSE_EQ|INE002A01018',
    };
    const out = redact(input);
    expect(out.headers.Authorization).toBe(REDACTED);
    expect(out.headers.Accept).toBe('application/json');
    expect(out.body.code).toBe(REDACTED);
    expect(out.body.client_secret).toBe(REDACTED);
    expect(out.body.client_id).toBe('public');
    expect((out.list[0] as { access_token: string }).access_token).toBe(REDACTED);
    expect(out.list[1]).toBe(`Bearer ${REDACTED}`);
    expect(out.instrument_token).toBe('NSE_EQ|INE002A01018');
    // input untouched
    expect(input.headers.Authorization).toBe('Bearer abc.def.ghi');
  });
  it('handles Headers and URLSearchParams', () => {
    const h = new Headers({ Authorization: 'Bearer abcdefgh', 'x-api-key': 'k-123456789', accept: 'json' });
    expect(redact(h)).toEqual({ authorization: REDACTED, 'x-api-key': REDACTED, accept: 'json' });
    const p = new URLSearchParams({ code: 'abc', redirect_uri: 'https://x.chromiumapp.org/upstox' });
    expect(redact(p)).toEqual({ code: REDACTED, redirect_uri: 'https://x.chromiumapp.org/upstox' });
  });
  it('handles cycles without throwing', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    const out = redact(a) as Record<string, unknown>;
    expect(out.name).toBe('a');
    expect(out.self).toBe(out);
  });
  it('redacts error messages', () => {
    const out = redact(new Error('401 with Bearer abcdefghijk')) as unknown as { message: string };
    expect(out.message).toBe(`401 with Bearer ${REDACTED}`);
  });
  it('keeps empty/null sensitive values as-is (nothing to hide)', () => {
    expect(redact({ access_token: null, code: '' })).toEqual({ access_token: null, code: '' });
  });
});
