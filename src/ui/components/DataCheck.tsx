import { sma } from '../../indicators/core';
import { formatNumberIN, formatPct } from '../../lib/format';
import { useInstrumentMap, useStocksData } from '../data';
import { useLocal } from '../hooks';

/**
 * Spec §9 integration sanity check: SMA200 from daily candles up to 8 Nov 2026 must be within ±0.5%
 * of the owner's 9 Nov 2026 analysis (which matched Trendlyne). TRENT only matches after the bonus
 * adjustment (unadjusted ≈ 3388.1).
 */
export const SPEC_SMA200: Record<string, number> = {
  ICICIBANK: 1356.2,
  HDFCBANK: 783.9,
  SBIN: 1038.4,
  AXISBANK: 1282.9,
  BAJFINANCE: 974.6,
  BSE: 3394.9,
  EICHERMOT: 7394.0,
  SUNPHARMA: 1811.4,
  ETERNAL: 282.3,
  TRENT: 2794.7,
};
const AS_OF = '2026-11-08';

export function DataCheck() {
  const byKey = useInstrumentMap();
  const watchlist = useLocal('watchlist') ?? [];
  const keys = watchlist.filter((k) => byKey.get(k)?.trading_symbol && SPEC_SMA200[byKey.get(k)!.trading_symbol] !== undefined);
  const { data } = useStocksData(keys);
  if (!keys.length) return null;
  const rows = keys.map((k) => {
    const sym = byKey.get(k)!.trading_symbol;
    const d = data.get(k);
    const closes = (d?.candles ?? []).filter((c) => !c.partial && c.date <= AS_OF).map((c) => c.close);
    const ours = sma(closes, 200);
    const ref = SPEC_SMA200[sym]!;
    const diff = ours !== null ? (ours / ref - 1) * 100 : null;
    return { sym, ours, ref, diff, adjusted: d?.events.length ?? 0, n: closes.length };
  });
  const passed = rows.filter((r) => r.diff !== null && Math.abs(r.diff) <= 0.5).length;
  const checked = rows.filter((r) => r.diff !== null).length;
  return (
    <section class="card" data-testid="data-check">
      <h2>Data check (SMA200 on 8 Nov 2026)</h2>
      <p class="small muted">
        Compares this app's 200-day average with your 9 Nov 2026 analysis. Within ±0.5% = data and bonus/split adjustment are right. {checked ? `${passed}/${checked} pass.` : 'Waiting for price history.'}
      </p>
      <table class="simple">
        <thead>
          <tr>
            <th>Stock</th>
            <th>App</th>
            <th>Expected</th>
            <th>Diff</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr>
              <td>
                {r.sym}
                {r.adjusted ? <span class="muted"> (adj.)</span> : ''}
              </td>
              <td>{r.ours !== null ? formatNumberIN(r.ours, 1) : r.n ? `${r.n} days` : '—'}</td>
              <td>{formatNumberIN(r.ref, 1)}</td>
              <td class={r.diff === null ? 'muted' : Math.abs(r.diff) <= 0.5 ? 'ok-text' : 'err-text'}>{r.diff === null ? '—' : `${formatPct(r.diff, 2)} ${Math.abs(r.diff) <= 0.5 ? '✓' : '✗'}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
