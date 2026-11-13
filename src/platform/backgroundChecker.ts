import { BackgroundRunner } from '@capacitor/background-runner';
import { isNative } from './http';

/**
 * Bridge to the background checker (public/runners/background.js), which Android runs about every
 * 15 minutes, also when the app is closed. The app hands it what it needs and collects practice
 * sales it found. Nothing here runs in a desktop browser.
 */

export const RUNNER_LABEL = 'in.tradebuddy.background';

export interface BackgroundConfig {
  enabled: boolean;
  rising: boolean;
  token: string | null;
  holidays: string[];
  universe: string[];
  holdings: Array<{ key: string; symbol: string; qty: number; avgPrice: number; stop: number | null; target: number | null; sellByClose: boolean }>;
  appActiveAt: number;
  lastOpenDate: string;
}

export async function syncBackground(cfg: BackgroundConfig): Promise<boolean> {
  if (!isNative()) return false;
  try {
    await BackgroundRunner.dispatchEvent({ label: RUNNER_LABEL, event: 'sync', details: cfg as unknown as Record<string, unknown> });
    return true;
  } catch (err) {
    console.warn('TradeBuddy: background checker not reachable', err);
    return false;
  }
}

export async function drainBackground(): Promise<Array<{ key: string; price: number; at: number; reason: string }>> {
  if (!isNative()) return [];
  try {
    const r = await BackgroundRunner.dispatchEvent<{ hits?: Array<{ key: string; price: number; at: number; reason: string }> }>({ label: RUNNER_LABEL, event: 'drain', details: {} });
    return Array.isArray(r?.hits) ? r.hits : [];
  } catch {
    return [];
  }
}
