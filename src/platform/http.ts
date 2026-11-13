import { Capacitor, CapacitorHttp } from '@capacitor/core';

/**
 * Network requests for the app. In the Android app, requests go through the phone's own HTTP stack
 * (Capacitor native HTTP): the app page runs at https://localhost, and Upstox/NSE do not allow
 * cross-site requests from web pages (CORS). In a desktop browser (development and tests) the normal
 * fetch is used.
 *
 * Returns a standard `Response`, so callers work the same everywhere.
 */

export interface AppFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | URLSearchParams | null;
  signal?: AbortSignal;
  /** native only: connect + read timeout (the web version uses `signal`) */
  timeoutMs?: number;
}

export const isNative = (): boolean => Capacitor.isNativePlatform();

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function nativeFetch(url: string, init: AppFetchInit): Promise<Response> {
  const headers = { ...(init.headers ?? {}) };
  let data: unknown;
  if (init.body != null) {
    const ct = Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
    const text = typeof init.body === 'string' ? init.body : init.body.toString();
    // The native layer encodes form bodies itself from an object.
    data = ct.includes('application/x-www-form-urlencoded') ? Object.fromEntries(new URLSearchParams(text)) : text;
  }
  const req = CapacitorHttp.request({
    url,
    method: init.method ?? 'GET',
    headers,
    ...(data !== undefined ? { data } : {}),
    responseType: 'arraybuffer',
    connectTimeout: init.timeoutMs ?? 15_000,
    readTimeout: init.timeoutMs ?? 30_000,
    disableRedirects: false,
  });
  const res = await (init.signal
    ? Promise.race([
        req,
        new Promise<never>((_, reject) => {
          if (init.signal!.aborted) reject(new DOMException('Aborted', 'AbortError'));
          init.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        }),
      ])
    : req);
  let bytes: Uint8Array;
  if (typeof res.data === 'string') {
    try {
      bytes = base64ToBytes(res.data);
    } catch {
      bytes = new TextEncoder().encode(res.data);
    }
  } else if (res.data instanceof ArrayBuffer) {
    bytes = new Uint8Array(res.data);
  } else if (res.data == null) {
    bytes = new Uint8Array();
  } else {
    bytes = new TextEncoder().encode(JSON.stringify(res.data));
  }
  const outHeaders = new Headers();
  for (const [k, v] of Object.entries(res.headers ?? {})) {
    try {
      outHeaders.set(k, String(v));
    } catch {
      /* skip invalid header names */
    }
  }
  // 204/304 may not carry a body
  const nullBody = res.status === 204 || res.status === 304;
  return new Response(nullBody ? null : (bytes as BodyInit), { status: res.status, headers: outHeaders });
}

export function appFetch(url: string | URL, init: AppFetchInit = {}): Promise<Response> {
  const u = typeof url === 'string' ? url : url.toString();
  if (isNative()) return nativeFetch(u, init);
  return fetch(u, {
    method: init.method ?? 'GET',
    headers: init.headers ?? {},
    body: init.body ?? null,
    ...(init.signal ? { signal: init.signal } : {}),
    credentials: 'omit',
    cache: 'no-store',
  });
}
