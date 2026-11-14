/**
 * The app's own login (app v1.3): a profile and an optional app lock with a PIN and the phone's
 * fingerprint. There is no online account — no server, nothing leaves the phone. The PIN is never
 * stored: only a salted PBKDF2 hash (150,000 rounds of SHA-256), so it cannot be read back.
 * The lock keeps other people out of the app's screens; it does not encrypt the stored data.
 */

export interface AccountState {
  v: 1;
  name: string;
  /** avatar colour (one of AVATAR_COLORS) */
  color: string;
  createdAt: number;
  pin: { salt: string; hash: string; rounds: number } | null;
  /** unlock with the fingerprint / face as well as the PIN */
  biometric: boolean;
  /** lock again after this many minutes away (0 = at once, -1 = never) */
  lockAfterMin: number;
}

export const AVATAR_COLORS = ['#6d5dfc', '#3ba3ff', '#22c55e', '#f59e0b', '#ec4899', '#14b8a6'];
export const PIN_LENGTH = 4;
const ROUNDS = 150_000;

export function newAccount(name: string, color: string, now: number): AccountState {
  return { v: 1, name: name.trim().slice(0, 40) || 'Trader', color: AVATAR_COLORS.includes(color) ? color : AVATAR_COLORS[0]!, createdAt: now, pin: null, biometric: false, lockAfterMin: 1 };
}

export const initials = (name: string): string =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || 'T';

export const validPin = (pin: string): boolean => new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin);

const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s: string) => new Uint8Array((s.match(/../g) ?? []).map((h) => parseInt(h, 16)));

async function derive(pin: string, salt: Uint8Array, rounds: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: rounds }, key, 256);
  return hex(bits);
}

export async function hashPin(pin: string, rounds = ROUNDS): Promise<NonNullable<AccountState['pin']>> {
  if (!validPin(pin)) throw new Error(`The PIN must be ${PIN_LENGTH} digits.`);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { salt: hex(salt), hash: await derive(pin, salt, rounds), rounds };
}

/** Constant-time comparison of the derived hash. */
export async function checkPin(pin: string, stored: NonNullable<AccountState['pin']>): Promise<boolean> {
  if (!validPin(pin)) return false;
  const h = await derive(pin, unhex(stored.salt), stored.rounds);
  if (h.length !== stored.hash.length) return false;
  let diff = 0;
  for (let i = 0; i < h.length; i++) diff |= h.charCodeAt(i) ^ stored.hash.charCodeAt(i);
  return diff === 0;
}

/** Should the app ask for the PIN again, after being away since `leftAt`? */
export function lockDue(a: AccountState | null | undefined, leftAt: number | null, now: number): boolean {
  if (!a?.pin || a.lockAfterMin < 0 || leftAt === null) return false;
  return now - leftAt >= a.lockAfterMin * 60_000;
}

/** After 5 wrong PINs in a row, wait 30 s per further try (stops guessing). */
export function waitAfterFails(fails: number): number {
  return fails < 5 ? 0 : 30_000 * (fails - 4);
}

/** Everything worth keeping, without keys or tokens (for "Copy backup"). */
export const BACKUP_KEYS = ['settings', 'watchlist', 'wallet', 'plans', 'alerts', 'dayTrades', 'mlJournal', 'account'] as const;

export function makeBackup(data: Record<string, unknown>, now: number, version: string): string {
  const out: Record<string, unknown> = { app: 'TradeBuddy', version, exportedAt: new Date(now).toISOString() };
  for (const k of BACKUP_KEYS) if (data[k] !== undefined) out[k] = data[k];
  // never: secrets, auth (tokens), caches
  return JSON.stringify(out);
}

export function readBackup(text: string): Record<string, unknown> {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error('This is not a TradeBuddy backup (not readable).');
  }
  if (!obj || typeof obj !== 'object' || (obj as { app?: unknown }).app !== 'TradeBuddy') throw new Error('This is not a TradeBuddy backup.');
  const out: Record<string, unknown> = {};
  for (const k of BACKUP_KEYS) if ((obj as Record<string, unknown>)[k] !== undefined) out[k] = (obj as Record<string, unknown>)[k];
  return out;
}
