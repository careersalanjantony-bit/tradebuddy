import type { AccessTokenSource, ServiceAccount } from './google';

/**
 * One message to one phone over FCM HTTP v1
 * (POST https://fcm.googleapis.com/v1/projects/{project}/messages:send). The answer is sorted into
 * what the outbox must do: done, the phone's token is no longer valid (stop sending to it), try again
 * later (Google busy / rate limit / network), or a message Google refuses (do not repeat it).
 */

export interface PushMessage {
  /** the phone's FCM registration token */
  token: string;
  title: string;
  body: string;
  /** string values only (FCM rule); read by the app when the notification is tapped */
  data: Record<string, string>;
  /** the app's Android notification channel (keeps the alert tone the phone chose) */
  channelId?: string | null;
  ttlSeconds: number;
  /** same tag = a newer notification replaces an older one on the phone */
  tag: string;
}

export type SendResult =
  | { ok: true; messageId: string }
  | { ok: false; kind: 'invalid-token' | 'retry' | 'bad-message'; error: string; retryAfterMs?: number };

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export class FcmClient {
  constructor(
    private readonly sa: ServiceAccount,
    private readonly tokens: Pick<AccessTokenSource, 'get' | 'invalidate'>,
    private readonly fetchFn: FetchFn = (u, i) => fetch(u, i),
  ) {}

  get projectId(): string {
    return this.sa.projectId;
  }

  async send(m: PushMessage): Promise<SendResult> {
    let access: string;
    try {
      access = await this.tokens.get();
    } catch (err) {
      return { ok: false, kind: 'retry', error: `sign-in: ${err instanceof Error ? err.message : String(err)}` };
    }
    const message = {
      token: m.token,
      notification: { title: m.title.slice(0, 200), body: m.body.slice(0, 1000) },
      data: m.data,
      android: {
        priority: 'HIGH',
        ttl: `${m.ttlSeconds}s`,
        notification: { tag: m.tag, ...(m.channelId ? { channel_id: m.channelId } : {}), icon: 'ic_stat_tradebuddy', color: '#10B981' },
      },
    };
    let res: Response;
    try {
      res = await this.fetchFn(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.sa.projectId)}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ message }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      return { ok: false, kind: 'retry', error: `network: ${err instanceof Error ? err.message : String(err)}` };
    }
    const json = (await res.json().catch(() => ({}))) as { name?: string; error?: { status?: string; message?: string; details?: Array<{ errorCode?: string }> } };
    if (res.ok && typeof json.name === 'string') return { ok: true, messageId: json.name };
    return classify(res.status, json.error, res.headers.get('retry-after'), () => this.tokens.invalidate());
  }
}

export function classify(status: number, error: { status?: string; message?: string; details?: Array<{ errorCode?: string }> } | undefined, retryAfter: string | null, invalidateAuth: () => void): SendResult {
  const code = error?.details?.find((d) => d.errorCode)?.errorCode ?? error?.status ?? '';
  const text = `HTTP ${status}${code ? ` ${code}` : ''}${error?.message ? `: ${error.message.slice(0, 200)}` : ''}`;
  const after = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : undefined;
  if (status === 401) {
    invalidateAuth();
    return { ok: false, kind: 'retry', error: text };
  }
  // review fix: only Google's UNREGISTERED says the PHONE's token is gone. A bare 404 (e.g. a wrong
  // Firebase project id) is a server setup problem — treating it as an invalid token would wipe the
  // token of every paired phone at once.
  if (code === 'UNREGISTERED') return { ok: false, kind: 'invalid-token', error: text };
  if (code === 'SENDER_ID_MISMATCH') return { ok: false, kind: 'invalid-token', error: text };
  if (status === 400 && /registration token/i.test(error?.message ?? '')) return { ok: false, kind: 'invalid-token', error: text };
  // 403 other than a sender mismatch: the service account lacks a permission — retried (with growing
  // pauses) so pushes resume by themselves once the Firebase setup is fixed
  // (a 404 without UNREGISTERED is a setup problem too — e.g. a wrong project id)
  if (status === 429 || status === 403 || status === 404 || status >= 500 || code === 'UNAVAILABLE' || code === 'INTERNAL' || code === 'QUOTA_EXCEEDED') return { ok: false, kind: 'retry', error: text, ...(after !== undefined ? { retryAfterMs: after } : {}) };
  return { ok: false, kind: 'bad-message', error: text };
}
