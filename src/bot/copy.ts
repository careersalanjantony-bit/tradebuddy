/**
 * App v1.13 — "Copy in Upstox": the exact steps to place the same trade yourself in the Upstox app
 * (the app never places orders). Pure; used by the alerts and the Auto-trader screen.
 */

export interface CopyTrade {
  symbol: string;
  side: 'long' | 'short';
  qty: number;
  entry: number;
  stop: number;
  target: number;
  t1?: number;
  /** "hold a few days" pick (Delivery) — else same day (Intraday) */
  swing: boolean;
}

const rs = (x: number) => `₹${x.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Steps to open the trade in Upstox, one per line. */
export function copySteps(t: CopyTrade): string[] {
  const product = t.swing ? 'Delivery' : 'Intraday';
  if (t.side === 'long') {
    return [
      `Upstox → ${t.symbol} → Buy → ${product} → ${t.qty} shares → Limit ${rs(t.entry)}.`,
      `Then Sell → ${product} → Stop-loss: trigger ${rs(t.stop)} (your safety net).`,
      t.swing ? `Target ${rs(t.target)} — hold a few days, at most 10 market days.` : `Target ${rs(t.target)}${t.qty >= 2 ? ` (the auto-trader sells half at 1× the risk)` : ''} — sell everything by 3:10 pm.`,
    ];
  }
  return [
    `Upstox → ${t.symbol} → Sell → Intraday → ${t.qty} shares → Limit ${rs(t.entry)} (sell first).`,
    `Then Buy → Intraday → Stop-loss: trigger ${rs(t.stop)} (buy back if it rises there).`,
    `Buy back half at ${rs(t.t1 ?? t.target)}, the rest at ${rs(t.target)} — everything by 3:10 pm.`,
  ];
}

/** One line for a notification. */
export const copyLine = (t: CopyTrade): string => copySteps(t).join(' ');
