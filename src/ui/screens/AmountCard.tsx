import { useEffect, useState } from 'preact/hooks';
import { formatINR } from '../../lib/format';
import { updateSettings } from '../../storage/local';
import type { Settings } from '../../storage/schema';
import { useStudyKeys } from '../data';

/**
 * Simple mode (v0.6.0): the only number a beginner enters. Everything else uses careful defaults:
 * at most 3 trades at once, each limited so a failed trade loses about 0.5% of the amount.
 */
export function AmountCard({ risk, newPickAlerts, rankBy }: { risk: Settings['risk']; newPickAlerts: boolean; rankBy: Settings['scanner']['rankBy'] }) {
  // app v1.12: always all five indices (no single-index choice)
  const studied = useStudyKeys().universeKeys.length;
  const [amount, setAmount] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => setAmount(risk.capitalInr ? String(risk.capitalInr) : ''), [risk.capitalInr]);

  const save = async () => {
    const n = Math.floor(Number(amount));
    if (!Number.isFinite(n) || n < 5000) {
      setMsg({ ok: false, text: 'Enter an amount of at least ₹5,000.' });
      return;
    }
    await updateSettings({
      risk: {
        capitalInr: n,
        riskPerTradePct: 0.5,
        riskPerTradeCapPct: 2,
        maxTotalOpenRiskPct: 5,
        dailyLossLimitPct: 2,
        weeklyLossLimitPct: 5,
        chargesEstimatePct: risk.chargesEstimatePct ?? 0.25,
      },
    });
    setMsg({ ok: true, text: 'Saved. Today’s top picks now use this amount.' });
  };

  const n = Number(amount);
  return (
    <section class="card" data-testid="amount-card">
      <h2>Amount to invest</h2>
      <div class="inline-input">
        <span>₹</span>
        <input type="number" min="5000" step="1000" value={amount} data-field="amount" onInput={(e) => setAmount((e.currentTarget as HTMLInputElement).value)} />
        <button class="btn primary small" type="button" onClick={() => void save()}>
          Save
        </button>
      </div>
      {msg && <p class={`small ${msg.ok ? 'ok-text' : 'err-text'}`}>{msg.text}</p>}
      <div class="grid2" style={{ marginTop: '8px' }}>
        <label class="field">
          <span>Split my amount into</span>
          <select
            value={String(risk.sizing === 'split' ? risk.splitInto : 0)}
            data-field="split"
            onChange={(e) => {
              const v = Number((e.currentTarget as HTMLSelectElement).value);
              void updateSettings({ risk: v === 0 ? { sizing: 'risk' } : { sizing: 'split', splitInto: v, maxOpenTrades: v } });
            }}
          >
            <option value="1">1 stock (all in one)</option>
            <option value="2">2 stocks</option>
            <option value="3">3 stocks (recommended)</option>
            <option value="4">4 stocks</option>
            <option value="5">5 stocks</option>
            <option value="0">Careful: small positions (lose at most 0.5% per trade)</option>
          </select>
        </label>
        <div class="field" data-field="universe">
          <span>Companies to study</span>
          <p class="small" style={{ margin: '4px 0 0' }} data-testid="study-all">
            <b>All five indices</b> — Nifty 50, Nifty 100, Midcap 100, Smallcap 100 and Nifty 500 together ({studied} companies, each once), plus your own stocks. Nothing to choose.
          </p>
        </div>
      </div>
      <label class="field" style={{ marginTop: '8px' }}>
        <span>Which picks come first</span>
        <select value={rankBy ?? 'safety'} data-field="rank-by" onChange={(e) => void updateSettings({ scanner: { rankBy: (e.currentTarget as HTMLSelectElement).value as 'safety' | 'earning' } })}>
          <option value="safety">Safest first — most often made money before (recommended)</option>
          <option value="earning">Highest earning first — biggest past average, bigger swings</option>
        </select>
      </label>
      {n >= 5000 && risk.sizing === 'split' && (
        <p class="small">
          About <b>{formatINR(n / Math.max(1, risk.splitInto), 0)}</b> goes into each of the top {risk.splitInto} pick{risk.splitInto > 1 ? 's' : ''}. Each has a sell-if-falls price (GTT) that limits its loss —
          the exact amount is shown with every pick.
        </p>
      )}
      {n >= 5000 && risk.sizing !== 'split' && (
        <p class="small">
          Careful mode: up to {risk.maxOpenTrades} stocks, each sized so a failed trade loses at most about <b>{formatINR(n * 0.005, 0)}</b>.
        </p>
      )}
      <label class="row small">
        <input type="checkbox" checked={newPickAlerts} onChange={(e) => void updateSettings({ scanner: { newPickAlerts: (e.currentTarget as HTMLInputElement).checked } })} />
        Alert me when a stock becomes a new top pick during market hours
      </label>
      <p class="tiny muted">Only use money you can leave invested for a few weeks and could partly lose — not savings you need or borrowed money.</p>
    </section>
  );
}
