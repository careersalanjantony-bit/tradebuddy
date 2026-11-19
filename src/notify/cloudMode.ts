import { getLocal } from '../storage/local';
import { categoryOf, MARKET_CATEGORIES, type AlertCategory } from './categories';

/**
 * Milestone 4 — "cloud alerts": this phone is paired with the user's TradeBuddy server, which pushes
 * alerts through Firebase even when the app is closed or the phone was off.
 *
 * Duplicates: the phone and the server find the same market signals with the same code and the same
 * alert id. While cloud alerts are active, the phone does not show its own system notification for a
 * market signal the server pushes (it still keeps it in the Alerts tab and shows the in-app banner when
 * the app is open); a pushed alert that the phone already has (same id) is not shown again either.
 * Alerts about this phone's own data — practice money, price alerts, plans, the auto-trader — always
 * come from the phone itself.
 */

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
}

/** Cloud alerts are working: paired and the server has this phone's push token. */
export const cloudActive = (c: CloudState | null | undefined): c is CloudState => !!c && c.tokenSentAt !== null;

/** Pure: does the server push this alert to this phone (so the phone shows no copy of its own)? */
export function coveredByCloud(c: CloudState | null | undefined, alertId: string): boolean {
  if (!cloudActive(c)) return false;
  const cat = categoryOf(alertId);
  return MARKET_CATEGORIES.includes(cat) && c.categories.includes(cat);
}

export async function cloudCovers(alertId: string): Promise<boolean> {
  return coveredByCloud(await getLocal('cloud'), alertId);
}
