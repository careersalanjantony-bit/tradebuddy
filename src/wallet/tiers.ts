import { BUNDLED } from '../data/indexLists';
import { memberKey } from '../data/universeParse';
import { productTerms, type Product, type ProductTerms, type Tier } from './wallet';

/**
 * How big and liquid a stock is, from the bundled NSE index lists — it decides the practice leverage
 * (Upstox's exact figure differs per stock and is shown in its order window).
 */
const N100 = new Set(BUNDLED.nifty100.map(memberKey));
const N500 = new Set(BUNDLED.nifty500.map(memberKey));

export function tierOf(key: string): Tier {
  return N100.has(key) ? 'nifty100' : N500.has(key) ? 'nifty500' : 'other';
}

export const termsFor = (product: Product, key: string): ProductTerms => productTerms(product, tierOf(key));
