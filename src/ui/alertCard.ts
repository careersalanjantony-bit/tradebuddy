import type { AlertDetail } from '../alerts/history';
import { formatNumberIN } from '../lib/format';

/** App v1.20 — what an in-app alert card says (pure; the card itself is components/AlertBanner.tsx). */

export type Tone = 'buy' | 'sell' | 'ok' | 'warn' | 'info';

/** The card's top line and colour. */
export function headOf(a: { id: string; title: string }, d: AlertDetail | null): { kicker: string; tone: Tone } {
  if (d && d.event && d.event !== 'new') {
    if (d.event === 't1') return { kicker: 'TARGET 1 REACHED', tone: 'ok' };
    if (d.event === 'target') return { kicker: 'TARGET REACHED', tone: 'ok' };
    if (d.event === 'stop') return { kicker: 'STOP-LOSS HIT', tone: 'warn' };
    return { kicker: 'SIGNAL INVALIDATED', tone: 'warn' };
  }
  if (d && /^Auto-trader/.test(d.source)) return { kicker: d.side === 'sell' ? 'AUTO-TRADER · SOLD FIRST' : 'AUTO-TRADER · BOUGHT', tone: d.side === 'sell' ? 'sell' : 'buy' };
  if (d && d.entry !== null) return d.side === 'sell' ? { kicker: 'NEW SHORT-SELL OPPORTUNITY', tone: 'sell' } : { kicker: 'NEW BUY OPPORTUNITY', tone: 'buy' };
  if (/stop-loss|fell|failed|loss/i.test(a.title)) return { kicker: 'ALERT', tone: 'warn' };
  if (/^alert:(sold|closed|practice|wallet)-/.test(a.id)) return { kicker: 'PRACTICE MONEY', tone: 'info' };
  if (/^alert:update-/.test(a.id)) return { kicker: 'APP UPDATE', tone: 'info' };
  if (a.id === 'login-reminder' || a.id === 'session-expired' || a.id === 'analytics-invalid') return { kicker: 'UPSTOX', tone: 'info' };
  return { kicker: 'ALERT', tone: 'info' };
}

const rs = (v: number) => `₹${formatNumberIN(v)}`;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The alert's own words without what the card already shows (the symbol, "at ₹…", the score): e.g.
 * "CHOICEIN: breaking out (live, not confirmed) · score 60" → "breaking out (live, not confirmed)".
 */
export function headlineOf(title: string, d: AlertDetail | null): string {
  if (!d?.symbol) return title;
  return title
    .replace(new RegExp(`(^|[\\s:·])${esc(d.symbol)}(?=$|[\\s:·,])`), '$1')
    .replace(/·?\s*score\s+\d+(\s*\/\s*100)?/i, ' ')
    .replace(/·?\s*\d+%\s*chance/i, ' ')
    .replace(/\bat\s+₹[\d,.]+/i, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s:·—–-]+|[\s:·—–-]+$/g, '')
    .trim();
}

/** The trade lines (label, value), one per line. */
export function linesOf(d: AlertDetail): Array<[string, string]> {
  const sell = d.side === 'sell';
  const out: Array<[string, string]> = [];
  if (d.entry !== null) out.push([sell ? 'Sell first at' : 'Entry', rs(d.entry)]);
  if (d.stop !== null) out.push([sell ? 'Stop-loss (buy back above)' : 'Stop-loss', rs(d.stop)]);
  if (d.targets.length) out.push([d.targets.length > 1 ? 'Targets' : 'Target', d.targets.map(rs).join(' / ')]);
  if (d.qty !== null) out.push(['Quantity', `${d.qty.toLocaleString('en-IN')} shares`]);
  if (d.risk !== null) out.push(['Maximum risk', `₹${Math.round(d.risk).toLocaleString('en-IN')} incl. est. charges`]);
  return out;
}
