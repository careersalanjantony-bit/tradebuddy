import { useEffect, useState } from 'preact/hooks';
import { formatINR } from '../../lib/format';
import { updateSettings } from '../../storage/local';
import type { Settings } from '../../storage/schema';
import { CapitalHelper } from './CapitalHelper';

type Field = { key: keyof Settings['risk']; label: string; hint: string; step: string; min: number; max?: number };

const FIELDS: Field[] = [
  { key: 'capitalInr', label: 'Trading capital (₹)', hint: 'The money set aside for swing trading. Quantities and risk are based on this.', step: '1000', min: 1000 },
  { key: 'riskPerTradePct', label: 'Risk per trade (%)', hint: 'How much of the capital one trade may lose at its stop. Spec default 1%; 0.5% in the first month of real money.', step: '0.1', min: 0.1, max: 5 },
  { key: 'riskPerTradeCapPct', label: 'Risk cap (%)', hint: 'Hard upper limit for risk per trade.', step: '0.1', min: 0.1, max: 5 },
  { key: 'maxOpenTrades', label: 'Max open trades', hint: 'Start with 3; up to 5 later.', step: '1', min: 1, max: 5 },
  { key: 'maxTotalOpenRiskPct', label: 'Max total open risk (%)', hint: 'All planned/open trades together.', step: '0.5', min: 0.5, max: 20 },
  { key: 'chargesEstimatePct', label: 'Round-trip charges estimate (%)', hint: 'Brokerage + STT + fees for a buy and a sell, as % of the position. Check Upstox\'s charges page; e.g. 0.25.', step: '0.01', min: 0, max: 2 },
  { key: 'dailyLossLimitPct', label: 'Daily loss limit (%)', hint: 'Enforced from M8 (journal). Stop trading for the day when hit.', step: '0.5', min: 0.5, max: 10 },
  { key: 'weeklyLossLimitPct', label: 'Weekly loss limit (%)', hint: 'Enforced from M8 (journal).', step: '0.5', min: 0.5, max: 20 },
];

export function RiskSettings({ risk }: { risk: Settings['risk'] }) {
  const [vals, setVals] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  useEffect(() => {
    setVals(Object.fromEntries(FIELDS.map((f) => [f.key, risk[f.key] === null ? '' : String(risk[f.key])])));
  }, [risk]);

  const save = async () => {
    const patch: Record<string, number | null> = {};
    for (const f of FIELDS) {
      const raw = (vals[f.key] ?? '').trim();
      if (raw === '') {
        if (f.key === 'capitalInr' || f.key === 'chargesEstimatePct') patch[f.key] = null;
        continue;
      }
      const n = Number(raw);
      if (!Number.isFinite(n) || n < f.min || (f.max !== undefined && n > f.max)) {
        setMsg({ tone: 'err', text: `${f.label}: enter a number between ${f.min} and ${f.max ?? '…'}.` });
        return;
      }
      patch[f.key] = f.key === 'maxOpenTrades' ? Math.round(n) : n;
    }
    if ((patch.riskPerTradePct ?? risk.riskPerTradePct) > (patch.riskPerTradeCapPct ?? risk.riskPerTradeCapPct)) {
      setMsg({ tone: 'err', text: 'Risk per trade cannot be above the risk cap.' });
      return;
    }
    await updateSettings({ risk: patch as Partial<Settings['risk']> });
    setMsg({ tone: 'ok', text: 'Saved.' });
  };

  const cap = Number(vals.capitalInr);
  const rp = Number(vals.riskPerTradePct);
  return (
    <section class="card" id="risk">
      <h2>Capital and risk</h2>
      <p class="small muted">
        Capital is the money set aside only for trading — not your savings, emergency fund or borrowed money. Everything else (quantity, ₹ at risk, loss limits) is worked out from it.
      </p>
      <CapitalHelper />
      <h3>Your settings</h3>
      <div class="grid2">
        {FIELDS.map((f) => (
          <label class="field">
            <span>{f.label}</span>
            <input
              type="number"
              step={f.step}
              min={f.min}
              max={f.max}
              data-field={f.key}
              value={vals[f.key] ?? ''}
              onInput={(e) => setVals({ ...vals, [f.key]: (e.currentTarget as HTMLInputElement).value })}
            />
            <span class="hint">{f.hint}</span>
          </label>
        ))}
      </div>
      {cap > 0 && rp > 0 && <p class="small">With these settings one trade may lose at most <b>{formatINR((cap * rp) / 100, 0)}</b> at its stop.</p>}
      <div class="row">
        <button class="btn primary small" type="button" onClick={() => void save()}>
          Save capital and risk
        </button>
        {msg && <span class={`small ${msg.tone === 'ok' ? 'ok-text' : 'err-text'}`}>{msg.text}</span>}
      </div>
    </section>
  );
}
