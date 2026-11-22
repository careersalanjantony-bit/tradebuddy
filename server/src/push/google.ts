import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * Google service-account sign-in for FCM HTTP v1, with Node's own crypto (no Firebase SDK):
 * a short JWT signed with the service account's private key is exchanged for an OAuth access token
 * (scope firebase.messaging), cached until shortly before it expires.
 *
 * The key file lives on the server only (FIREBASE_SERVICE_ACCOUNT_FILE, e.g.
 * /etc/tradebuddy/firebase-service-account.json, readable by root and the service). It is never
 * logged, never returned by the API and never in the repository.
 */

export const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

export interface ServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
}

export class CredentialError extends Error {
  override name = 'CredentialError';
}

/** Reads and checks a service-account JSON file. The message of an error never contains the key. */
export function parseServiceAccount(raw: unknown): ServiceAccount {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (o.type !== 'service_account') throw new CredentialError('not a service-account key (type must be "service_account")');
  const str = (k: string) => (typeof o[k] === 'string' && (o[k] as string).trim() ? (o[k] as string) : null);
  const projectId = str('project_id');
  const clientEmail = str('client_email');
  const privateKey = str('private_key');
  if (!projectId || !clientEmail || !privateKey) throw new CredentialError('the key file lacks project_id, client_email or private_key');
  if (!/-----BEGIN PRIVATE KEY-----/.test(privateKey)) throw new CredentialError('private_key is not a PEM private key');
  const tokenUri = str('token_uri') ?? 'https://oauth2.googleapis.com/token';
  if (!/^https:\/\/oauth2\.googleapis\.com\//.test(tokenUri)) throw new CredentialError('token_uri must be Google\'s OAuth address');
  return { projectId, clientEmail, privateKey, tokenUri };
}

export function loadServiceAccount(path: string): ServiceAccount {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new CredentialError(`cannot read ${path}: ${(err as NodeJS.ErrnoException).code ?? 'error'}`);
  }
  try {
    return parseServiceAccount(JSON.parse(text));
  } catch (err) {
    if (err instanceof CredentialError) throw err;
    throw new CredentialError(`${path} is not valid JSON`);
  }
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString('base64url');

/** The signed sign-in request (RS256 JWT), valid one hour. */
export function signJwt(sa: ServiceAccount, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iss: sa.clientEmail, scope: FCM_SCOPE, aud: sa.tokenUri, iat, exp: iat + 3600 }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${head}.${body}`);
  return `${head}.${body}.${b64url(signer.sign(sa.privateKey))}`;
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export class AccessTokenSource {
  private token: string | null = null;
  private expiresAt = 0;
  private pending: Promise<string> | null = null;

  constructor(
    private readonly sa: ServiceAccount,
    private readonly fetchFn: FetchFn = (u, i) => fetch(u, i),
    private readonly now: () => number = Date.now,
  ) {}

  /** A valid access token (from the cache while it has more than 2 minutes left). */
  async get(): Promise<string> {
    if (this.token && this.now() < this.expiresAt - 120_000) return this.token;
    this.pending ??= this.fetchToken().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  /** Forget the cached token (Google said it is no longer accepted). */
  invalidate(): void {
    this.token = null;
    this.expiresAt = 0;
  }

  private async fetchToken(): Promise<string> {
    const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signJwt(this.sa, this.now()) });
    const res = await this.fetchFn(this.sa.tokenUri, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(), signal: AbortSignal.timeout(15_000) });
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || typeof json.access_token !== 'string') throw new CredentialError(`Google sign-in failed (HTTP ${res.status}${json.error ? `, ${json.error}` : ''})`);
    this.token = json.access_token;
    this.expiresAt = this.now() + (json.expires_in ?? 3600) * 1000;
    return this.token;
  }
}
