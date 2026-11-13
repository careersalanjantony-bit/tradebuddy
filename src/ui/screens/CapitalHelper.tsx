import { useMemo, useState } from 'preact/hooks';
import { adviseCapital } from '../../advisor/capital';
import { formatINR, formatTimeIST } from '../../lib/format';
import { errorMessage } from '../../lib/serialize';
import { callBackground } from '../../shared/messages';
import { updateSettings } from '../../storage/local';

type YesNo = 'yes' | 'no' | '';

/** Guided capital suggestion (top of Settings → Capital and risk). */
export function CapitalHelper() {
  const [cash, setCash] = useState('');
  const [cashNote, setCashNote] = useState<string | null>(null);
  const [emergency, setEmergency] = useState<YesNo>('');
  const [borrowed, setBorrowed] = useState<YesNo>('');
  const [loss, setLoss] = useState('');
  const [isNew, setIsNew] = useState<YesNo>('yes');
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const advice = useMemo(
    () =>
      adviseCapital({
        availableCash: cash.trim() === '' ? null : Number(cash),
        emergencyFundOk: emergency === '' ? null : emergency === 'yes',
        borrowedOrNeeded: borrowed === '' ? null : borrowed === 'yes',
        maxYearlyLoss: loss.trim() === '' ? null : Number(loss),
        newToTrading: isNew !== 'no',
      }),
    [cash, emergency, borrowed, loss, isNew],
  );

  const fetchCash = async () => {
    setBusy(true);
    setCashNote(null);
    try {
      const f = await callBackground('funds:get');
      setCash(String(Math.floor(f.cash)));
      setCashNote(`From Upstox at ${formatTimeIST(f.fetchedAt)}: ${formatINR(f.cash, 0)} cash available to trade.`);
    } catch (err) {
      setCashNote(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!advice.capital) return;
    await updateSettings({ risk: { capitalInr: advice.capital, riskPerTradePct: advice.riskPct, maxOpenTrades: advice.maxOpenTrades, paperMode: advice.status === 'paper' } });
    setSaved(advice.status === 'paper' ? 'Saved for practice (paper) trading.' : 'Saved. The planner now uses these numbers.');
  };

  const Q = ({ label, value, set, name }: { label: string; value: YesNo; set: (v: YesNo) => void; name: string }) => (
    <div class="field">
      <span>{label}</span>
      <div class="row">
        <label class="row small">
          <input type="radio" name={name} checked={value === 'yes'} onChange={() => set('yes')} /> Yes
        </label>
        <label class="row small">
          <input type="radio" name={name} checked={value === 'no'} onChange={() => set('no')} /> No
        </label>
      </div>
    </div>
  );

  return (
    <div class="capital-helper" data-testid="capital-helper">
      <h3>Not sure? Let the helper suggest it</h3>
      <div class="field">
        <span>Cash available in your Upstox account (₹)</span>
        <div class="inline-input">
          <input type="number" min="0" step="1000" value={cash} data-field="helper-cash" onInput={(e) => setCash((e.currentTarget as HTMLInputElement).value)} />
          <button class="btn small" type="button" disabled={busy} onClick={() => void fetchCash()}>
            {busy ? 'Reading…' : 'Read from Upstox'}
          </button>
        </div>
        {cashNote && <span class="hint">{cashNote}</span>}
      </div>
      <Q name="emergency" label="Do you keep an emergency fund (about 6 months of expenses) outside this account?" value={emergency} set={setEmergency} />
      <Q name="borrowed" label="Is any of this money borrowed, or needed within the next year (EMI, fees, family events)?" value={borrowed} set={setBorrowed} />
      <div class="field">
        <span>The most you could lose in a bad year without real harm (₹)</span>
        <input type="number" min="0" step="1000" value={loss} data-field="helper-loss" onInput={(e) => setLoss((e.currentTarget as HTMLInputElement).value)} />
        <span class="hint">Be honest: money you would be upset to lose, but that would not change your family's plans.</span>
      </div>
      <Q name="isnew" label="Are you new to trading with real money?" value={isNew} set={setIsNew} />

      <div class={`banner ${advice.status === 'ok' ? 'ok' : advice.status === 'paper' ? 'warn' : 'info'} small`} data-testid="capital-advice">
        {advice.status === 'incomplete' ? (
          advice.reasons[0]
        ) : (
          <>
            <b>
              Suggested capital {formatINR(advice.capital, 0)} · risk {advice.riskPct}% ({formatINR(advice.riskPerTrade, 0)} per trade) · max {advice.maxOpenTrades} open trades
            </b>
            {advice.status === 'paper' && <div><b>Start with paper (practice) trades.</b></div>}
            <ul>
              {advice.reasons.map((r) => (
                <li>{r}</li>
              ))}
              <li>
                Stop trading for the day after losing {formatINR(advice.dailyLossLimit, 0)}, and for the week after {formatINR(advice.weeklyLossLimit, 0)}.
              </li>
            </ul>
            {advice.warnings.map((w) => (
              <p class="warn-text" style={{ margin: '4px 0' }}>
                {w}
              </p>
            ))}
            <div class="row">
              <button class="btn small primary" type="button" disabled={!advice.capital} onClick={() => void apply()}>
                Use these settings
              </button>
              {saved && <span class="ok-text">{saved}</span>}
            </div>
            <p class="tiny muted">A suggestion from simple, cautious rules — you decide. Increase capital or risk only after your journal shows a profit over 20+ trades.</p>
          </>
        )}
      </div>
    </div>
  );
}
