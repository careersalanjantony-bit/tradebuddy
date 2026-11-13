/**
 * Index instruments used for the "market mood" (keys verified in the Upstox instruments file and
 * docs, 12 Nov 2026). They are priced like stocks but are not part of any list or ranking.
 */
export const NIFTY_KEY = 'NSE_INDEX|Nifty 50';
export const VIX_KEY = 'NSE_INDEX|India VIX';
export const INDEX_KEYS: string[] = [NIFTY_KEY, VIX_KEY];
export const isIndexKey = (key: string): boolean => key.startsWith('NSE_INDEX|');
