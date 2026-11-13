import { DEFAULT_AUTH, DEFAULT_SETTINGS } from './defaults';
import { chromeLocalKV, type KV } from './kv';
import { applyPatch, mergeWithDefaults, type DeepPartial } from './merge';
import type { AuthState, LocalKey, LocalStore, Secrets, Settings } from './schema';

/**
 * Typed access to chrome.storage.local. All persistent state goes through here:
 * MV3 service workers restart at any time, so nothing important may live only in globals.
 */

let kv: KV = chromeLocalKV;

/** Tests only: swap the backing store. */
export function __setKV(next: KV): void {
  kv = next;
}

export async function getLocal<K extends LocalKey>(key: K): Promise<LocalStore[K] | undefined> {
  const res = await kv.get([key]);
  return res[key] as LocalStore[K] | undefined;
}

export async function setLocal<K extends LocalKey>(key: K, value: LocalStore[K]): Promise<void> {
  await kv.set({ [key]: value });
}

export async function getSettings(): Promise<Settings> {
  return mergeWithDefaults(DEFAULT_SETTINGS, await getLocal('settings'));
}

export async function updateSettings(patch: DeepPartial<Settings>): Promise<Settings> {
  const next = mergeWithDefaults(DEFAULT_SETTINGS, applyPatch(await getSettings(), patch));
  await setLocal('settings', next);
  return next;
}

export async function getSecrets(): Promise<Secrets> {
  return (await getLocal('secrets')) ?? {};
}

/** Empty string or null removes a secret. */
export async function updateSecrets(patch: { [K in keyof Secrets]?: string | null }): Promise<Secrets> {
  const next: Secrets = { ...(await getSecrets()) };
  for (const [k, v] of Object.entries(patch) as Array<[keyof Secrets, string | null | undefined]>) {
    if (v === undefined) continue;
    if (v === null || v.trim() === '') delete next[k];
    else next[k] = v.trim();
  }
  await setLocal('secrets', next);
  return next;
}

export async function getAuth(): Promise<AuthState> {
  return (await getLocal('auth')) ?? { ...DEFAULT_AUTH };
}

/** Subscribe to changes of one chrome.storage.local key. Returns an unsubscribe function. */
export function onLocalChanged<K extends LocalKey>(
  key: K,
  cb: (newValue: LocalStore[K] | undefined, oldValue: LocalStore[K] | undefined) => void,
): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'local') return;
    const ch = changes[key];
    if (ch) cb(ch.newValue as LocalStore[K] | undefined, ch.oldValue as LocalStore[K] | undefined);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
