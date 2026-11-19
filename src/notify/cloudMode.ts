import { getLocal } from '../storage/local';
import { categoryOf, MARKET_CATEGORIES, type AlertCategory } from './categories';

/**
 * Milestone 4 — "cloud alerts": this phone is paired with the user's TradeBuddy server, which pushes
 * alerts through Firebase even when the app is closed or the phone was off.
 *
 * Duplicates: the phone and the server find the same market signals with the same code and the same
 * alert id. While cloud alerts are working, the phone does not show its own system notification for a
 * market signal the server pushes (it still keeps it in the Alerts tab and shows the in-app banner when
 * the app is open); a pushed alert that the phone already has (same id) is not shown again either.
 * Alerts about this phone's own data — practice money, price alerts, plans, the auto-trader — always
 * come from the phone itself.
 *
 * Review fix: "working" now means the server CONFIRMED within the last few minutes that it is making
 * signals, can push, and has this phone's token (the heartbeat in platform/push.ts). If the server is
 * down, unreachable or its Upstox token stopped, the phone shows its own notifications again by itself.
 */

/** A server "yes" counts for this long (the heartbeat asks every 3 minutes). */
export const CLOUD_FRESH_MS = 7 * 60_000;

export interface CloudState {
  /** https://… — the user's own server */
  serverUrl: string;
  deviceId: string;
  name: string;
  pairedAt: number;
  /** the alert kinds the server pushes to this phone */
  categories: AlertCategory[];
  /** when this phone's FCM token last reached the server (null = not yet) */
  tokenSentAt: number | null;
  lastError: string | null;
  /** review fix: when the server last confirmed it covers this phone (null = not confirmed) */
  serverOkAt?: number | null;
}

/** Paired and the server has this phone's push token (it may still not be confirmed working). */
export const cloudActive = (c: CloudState | null | undefined): c is CloudState => !!c && c.tokenSentAt !== null;

/** Cloud alerts confirmed working right now. */
export const cloudConfirmed = (c: CloudState | null | undefined, now = Date.now()): c is CloudState =>
  cloudActive(c) && typeof c.serverOkAt === 'number' && now - c.serverOkAt >= 0 && now - c.serverOkAt < CLOUD_FRESH_MS;

/** Pure: does the server push this alert to this phone right now (so the phone shows no copy of its own)? */
export function coveredByCloud(c: CloudState | null | undefined, alertId: string, now = Date.now()): boolean {
  if (!cloudConfirmed(c, now)) return false;
  const cat = categoryOf(alertId);
  return MARKET_CATEGORIES.includes(cat) && c.categories.includes(cat);
}

export async function cloudCovers(alertId: string, now = Date.now()): Promise<boolean> {
  return coveredByCloud(await getLocal('cloud'), alertId, now);
}
