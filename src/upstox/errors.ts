/**
 * Upstox error handling. Error body (docs): {status:"error", errors:[{error_code, message, property_path, invalid_value}]}
 * camelCase variants (errorCode…) are deprecated but still read.
 */

export type UpstoxErrorKind =
  | 'auth' // token invalid/expired → log in again
  | 'not_logged_in' // no usable token
  | 'config' // API key / secret / redirect URL wrong
  | 'rate_limit'
  | 'client' // other 4xx
  | 'server' // 5xx
  | 'network'
  | 'timeout'
  | 'cancelled'
  | 'bad_response';

export class UpstoxError extends Error {
  override name = 'UpstoxError';
  constructor(
    message: string,
    readonly kind: UpstoxErrorKind,
    readonly httpStatus: number | null = null,
    readonly code: string | null = null,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }

  get retryable(): boolean {
    return this.kind === 'server' || this.kind === 'network' || this.kind === 'timeout' || this.kind === 'rate_limit';
  }
}

/** Codes meaning the token in use is not valid. */
export const AUTH_ERROR_CODES = new Set(['UDAPI100050', 'UDAPI100016']);
/** Codes meaning the app settings (key / secret / redirect) are wrong. */
export const CONFIG_ERROR_CODES = new Set(['UDAPI100068', 'UDAPI100069', 'UDAPI100070']);

export function firstError(body: unknown): { code: string | null; message: string | null } {
  const errs = (body as { errors?: unknown })?.errors;
  if (Array.isArray(errs) && errs.length) {
    const e = errs[0] as Record<string, unknown> | null | undefined;
    const code = e?.error_code ?? e?.errorCode;
    const message = e?.message;
    return { code: typeof code === 'string' ? code : null, message: typeof message === 'string' ? message : null };
  }
  return { code: null, message: null };
}

export function parseRetryAfter(header: string | null | undefined, now = Date.now()): number | null {
  if (!header?.trim()) return null;
  const ms = Number(header) * 1000;
  if (Number.isFinite(ms)) return Math.max(0, ms);
  const t = Date.parse(header);
  return Number.isFinite(t) ? Math.max(0, t - now) : null;
}

/**
 * Message for a failed login (token exchange). Upstox's own reason is shown when it is not one of the
 * known app-settings errors — e.g. "No segments for these users are active" (account problem, seen
 * on 11 Nov 2026), which is NOT an expired session.
 */
export function loginErrorMessage(err: unknown, redirectUrl?: string): string {
  if (err instanceof UpstoxError && err.code !== 'UDAPI100057' && !(err.code && CONFIG_ERROR_CODES.has(err.code)) && err.message && !/^HTTP \d+$/.test(err.message)) {
    if (/segment/i.test(err.message) && /(not|no).*active|inactive|reactivat/i.test(err.message)) {
      return `Upstox refused the login because the trading segments of your Upstox account are not active: "${err.message}" Reactivate them in the Upstox app or on upstox.com (Profile / Account → Segments), then log in here again.`;
    }
    return `Upstox refused the login: "${err.message}"${err.code ? ` (${err.code})` : ''}.`;
  }
  return friendlyMessage(err, redirectUrl);
}

export function errorFromResponse(status: number, body: unknown, retryAfter?: string | null): UpstoxError {
  const { code, message } = firstError(body);
  const msg = message ?? `HTTP ${status}`;
  if (status === 429 || code === 'UDAPI100099') return new UpstoxError(msg, 'rate_limit', status, code, parseRetryAfter(retryAfter));
  if (code && CONFIG_ERROR_CODES.has(code)) return new UpstoxError(msg, 'config', status, code);
  if (status === 401 || (code && AUTH_ERROR_CODES.has(code))) return new UpstoxError(msg, 'auth', status, code);
  if (status >= 500) return new UpstoxError(msg, 'server', status, code);
  return new UpstoxError(msg, 'client', status, code);
}

/** Plain-English message for the owner (beginner-friendly). */
export function friendlyMessage(err: unknown, redirectUrl?: string): string {
  if (!(err instanceof UpstoxError)) return err instanceof Error ? err.message : String(err);
  const redirect = redirectUrl ? ` It must be exactly: ${redirectUrl}` : '';
  switch (err.code) {
    case 'UDAPI100068':
      return `Upstox did not accept the API key or the redirect URL. Check the API key in Settings, and the redirect URL in your Upstox app.${redirect}`;
    case 'UDAPI100069':
      return 'The API key or API secret is wrong. Copy both again from Upstox Developer Apps into Settings.';
    case 'UDAPI100070':
      return `The redirect URL in your Upstox app does not match.${redirect}`;
    case 'UDAPI100057':
      return 'The login code was not accepted (it can be used only once). Click Log in again.';
  }
  switch (err.kind) {
    case 'auth':
      return 'Your Upstox session is no longer valid. Please log in again.';
    case 'not_logged_in':
      return err.message;
    case 'config':
      return `Upstox rejected the app settings: ${err.message}`;
    case 'rate_limit':
      return 'Too many requests to Upstox. The extension is waiting before trying again.';
    case 'network':
      return 'Could not reach Upstox. Check your internet connection.';
    case 'timeout':
      return 'Upstox did not answer in time. It will be retried.';
    case 'server':
      return `Upstox had a server problem (${err.httpStatus}). It will be retried.`;
    default:
      return `Upstox error${err.code ? ` ${err.code}` : ''}: ${err.message}`;
  }
}
