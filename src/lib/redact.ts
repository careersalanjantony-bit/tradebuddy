/**
 * Secret redaction for logs and error messages (spec §16).
 * Never log secrets or tokens: Authorization, x-api-key, bot tokens, OAuth `code`, client secrets.
 *
 * Three layers:
 *  1. Object keys whose (normalised) name is sensitive have their value replaced.
 *  2. String patterns (Bearer tokens, Telegram bot URLs, sensitive query params, Anthropic keys).
 *  3. Exact known secret values registered at runtime (e.g. the stored API keys).
 */

export const REDACTED = '[REDACTED]';

/** Keys are compared after lower-casing and removing `_` and `-`. */
const SENSITIVE_KEYS = new Set([
  'authorization',
  'xapikey',
  'apikey',
  'apisecret',
  'clientsecret',
  'secret',
  'accesstoken',
  'extendedtoken',
  'refreshtoken',
  'token',
  'bottoken',
  'telegrambottoken',
  'upstoxapikey',
  'upstoxapisecret',
  'upstoxanalyticstoken',
  'analyticstoken',
  'claudeapikey',
  'password',
  'passphrase',
  'code',
]);

export function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(normaliseKey(key));
}

const QUERY_PARAMS = ['code', 'client_secret', 'access_token', 'extended_token', 'token', 'api_key', 'apikey'];

const STRING_RULES: Array<[RegExp, string]> = [
  // Authorization: Bearer <token>
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{6,}/gi, `$1 ${REDACTED}`],
  // Telegram bot token in URLs: /bot123456:ABC-xyz/...
  [/\bbot\d{3,}:[A-Za-z0-9_-]{10,}/g, `bot${REDACTED}`],
  // Anthropic API keys
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, REDACTED],
  // Sensitive query/form parameters: ?code=...&client_secret=...
  [new RegExp(`([?&](?:${QUERY_PARAMS.join('|')})=)[^&#\\s"']+`, 'gi'), `$1${REDACTED}`],
  // "x-api-key: value" / "authorization: value" written as text
  // (skips values already handled: "[REDACTED]" or a "Bearer/Basic <token>" pair)
  [/\b(x-api-key|authorization)(["']?\s*[:=]\s*["']?)(?!\[REDACTED\]|(?:Bearer|Basic)\s)[^\s"',}]+/gi, `$1$2${REDACTED}`],
  // Basic auth credentials
  [/\b(Basic)\s+[A-Za-z0-9+/=]{8,}/g, `$1 ${REDACTED}`],
];

/** Known secret values (registered at runtime). Only values of length >= 8 are tracked. */
const knownSecrets = new Set<string>();

export function registerSecrets(values: Iterable<string | null | undefined>): void {
  for (const v of values) {
    if (typeof v === 'string' && v.length >= 8) knownSecrets.add(v);
  }
}

export function clearKnownSecrets(): void {
  knownSecrets.clear();
}

export function redactString(input: string): string {
  let out = input;
  for (const secret of knownSecrets) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  for (const [re, replacement] of STRING_RULES) {
    out = out.replace(re, replacement);
  }
  return out;
}

/**
 * Deep-redacts any JSON-like value. Returns a new value; never mutates input.
 * Handles cycles, Headers, URLSearchParams, Maps and Errors.
 */
export function redact<T>(value: T): T {
  return redactInner(value, new WeakMap()) as T;
}

function redactInner(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);

  if (typeof Headers !== 'undefined' && value instanceof Headers) {
    const obj: Record<string, string> = {};
    value.forEach((v, k) => {
      obj[k] = isSensitiveKey(k) ? REDACTED : redactString(v);
    });
    return obj;
  }
  if (typeof URLSearchParams !== 'undefined' && value instanceof URLSearchParams) {
    const obj: Record<string, string> = {};
    value.forEach((v, k) => {
      obj[k] = isSensitiveKey(k) ? REDACTED : redactString(v);
    });
    return obj;
  }
  if (value instanceof Error) {
    const out: Record<string, unknown> = { name: value.name, message: redactString(value.message) };
    if (value.stack) out.stack = redactString(value.stack);
    seen.set(value, out);
    const extra = value as unknown as Record<string, unknown>;
    for (const k of Object.keys(extra)) {
      out[k] = isSensitiveKey(k) ? REDACTED : redactInner(extra[k], seen);
    }
    if ('cause' in value && value.cause !== undefined) out.cause = redactInner(value.cause, seen);
    return out;
  }
  if (value instanceof Map) {
    const obj: Record<string, unknown> = {};
    seen.set(value, obj);
    for (const [k, v] of value) {
      const key = String(k);
      obj[key] = isSensitiveKey(key) ? REDACTED : redactInner(v, seen);
    }
    return obj;
  }
  if (Array.isArray(value)) {
    const arr: unknown[] = [];
    seen.set(value, arr);
    for (const item of value) arr.push(redactInner(item, seen));
    return arr;
  }
  const out: Record<string, unknown> = {};
  seen.set(value, out);
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(k) && v !== null && v !== undefined && v !== '') out[k] = REDACTED;
    else out[k] = redactInner(v, seen);
  }
  return out;
}
