import { useEffect, useMemo, useState } from 'preact/hooks';
import { formatINR, formatNumberIN } from '../../lib/format';
import { errorMessage } from '../../lib/serialize';
import { istDate } from '../../lib/time';
import { computePlan, orderTicket, type StopMethod, type TargetMethod } from '../../planner/plan';
import { callBackground } from '../../shared/messages';
import type { Go } from '../App';
import { SetupBadge } from '../components/Badges';
import { Term } from '../components/Term';
import { useInstrumentMap, useStockData } from '../data';
import { useLocal, useSettings } from '../hooks';
import { AddStock } from './Watchlist';
import { StudyButton } from '../components/Explain';
import { studyFor } from '../../advisor/forPlan';
import { chanceOf, type ExitStudy } from '../../advisor/exitStudy';

/** Trade planner (spec §11). Produces an order ticket to type into the Upstox app. */
export function PlannerScreen({ keyParam, go }: { keyParam: string | null; go: Go }) {
  const watchlist = useLocal('watchlist') ?? [];
  const plans = useLocal('plans') ?? [];
  const settings = useSettings();
  const byKey = useInstrumentMap();
  const key = keyParam;
  const { data } = useStockData(key);
  const inst = key ? byKey.get(key) : undefined;
  const sym = inst?.trading_symbol ?? key ?? '';
  const snap = data?.snapshot ?? null;

  const [entryText, setEntryText] = useState('');
  const [entryTouched, setEntryTouched] = useState(false);
  const [stopMethod, setStopMethod] = useState<StopMethod>('atr');
  const [targetMethod, setTargetMethod] = useState<TargetMethod>('2R');
  const [manualStop, setManualStop] = useState('');
  const [manualTarget, setManualTarget] = useState('');
  const [riskText, setRiskText] = useState('');
  const [resultsDate, setResultsDate] = useState('');
  const [saved, setSaved] = useState<{ id: string; ticket: string } | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  // Defaults: live price for entry (until the owner edits it), settings for methods/risk.
  useEffect(() => {
    if (!entryTouched && snap) setEntryText(String(snap.price));
  }, [snap?.price, entryTouched]);
  useEffect(() => {
    if (settings) {
      setStopMethod(settings.planner.stopMethod);
      setTargetMethod(settings.planner.targetMethod);
      setRiskText(String(settings.risk.riskPerTradePct));
    }
  }, [settings?.planner.stopMethod, settings?.planner.targetMethod, settings?.risk.riskPerTradePct]);
  useEffect(() => {
    setSaved(null);
    setMsg(null);
    setEntryTouched(false);
  }, [key]);

  const study = useMemo(() => (settings ? studyFor(data, settings) : null), [data, settings]);

  const plan = useMemo(() => {
    if (!settings || !key) return null;
    const other = plans.filter((p) => p.id !== saved?.id && (p.status === 'planned' || p.status === 'open')).map((p) => p.riskRupees);
    return computePlan({
      symbol: sym,
      entry: Number(entryText),
      tick: inst?.tick ?? 0.05,
      stopMethod,
      manualStop: Number(manualStop) || null,
      targetMethod,
      manualTarget: Number(manualTarget) || null,
      atr: snap?.atr14 ?? null,
      lastSwingLow: snap?.lastSwingLow ?? null,
      resistances: snap?.resistances.map((l) => l.price) ?? [],
      history: study ? { safeAtr: study.safeAtr, holdAtr: study.holdAtr } : null,
      riskPct: Number(riskText) || settings.risk.riskPerTradePct,
      settings: { ...settings.risk, ...settings.planner },
      snapshot: snap ? { flags: snap.flags, setup: snap.setup, trend: snap.trend } : null,
      otherOpenRisks: other,
      resultsDate: resultsDate || null,
      today: istDate(Date.now()),
    });
  }, [settings, key, entryText, stopMethod, manualStop, targetMethod, manualTarget, riskText, resultsDate, snap, inst?.tick, plans, saved, study]);

  if (!key) {
    return (
      <section class="card">
        <h2>Planner</h2>
        <p class="muted">Choose a stock to plan:</p>
        <div class="row">
          {watchlist.map((k) => (
            <button class="btn small" type="button" onClick={() => go('planner', k)}>
              {byKey.get(k)?.trading_symbol ?? k}
            </button>
          ))}
        </div>
        <p class="muted small">Or search:</p>
        <AddStock onAdd={(k) => go('planner', k)} />
      </section>
    );
  }

  const ticket = plan?.ok ? orderTicket(sym, plan, saved?.id ?? 'NEW') : '';
  const save = async () => {
    if (!plan?.ok) return;
    try {
      const r = await callBackground('plans:save', {
        plan: {
          key,
          symbol: sym,
          entry: plan.entry,
          stop: plan.stop,
          target: plan.target,
          qty: plan.qty,
          riskRupees: plan.riskRupees,
          rewardRupees: plan.rewardRupees,
          rr: plan.rr,
          targetMode: plan.targetMode,
          holdTarget: plan.holdTarget,
          ...(study && snap?.atr14
            ? {
                safeChance: chanceOf(study, (plan.target - plan.entry) / snap.atr14),
                ...(plan.holdTarget !== null ? { holdChance: chanceOf(study, (plan.holdTarget - plan.entry) / snap.atr14) } : {}),
                studySamples: study.samples,
              }
            : {}),
          setup: snap?.setup ?? null,
          trend: snap?.trend ?? null,
          ticket,
        },
      });
      setSaved(r);
      setMsg({
        tone: 'ok',
        text:
          plan.targetMode === 'history'
            ? 'Plan saved. Alerts: stop hit, safe target, hold-until target, within 1% of stop, +1R, close below SMA20 — plus hold-or-sell advice every evening once you mark it bought.'
            : 'Plan saved. Alerts created: stop hit, target hit, within 1% of stop, +1R, close below SMA20.',
      });
    } catch (err) {
      setMsg({ tone: 'err', text: errorMessage(err) });
    }
  };
  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <>
      <section class="card">
        <div class="row">
          <h2 style={{ margin: 0 }}>Plan: {sym}</h2>
          {snap && <SetupBadge setup={snap.setup} />}
          <span class="spacer" />
          <button class="btn small" type="button" onClick={() => go('stock', key)}>
            Chart
          </button>
        </div>
        {!settings?.risk.capitalInr && (
          <div class="banner warn small" style={{ marginTop: '8px' }}>
            Enter your trading capital first.{' '}
            <button class="btn small" type="button" onClick={() => go('settings')}>
              Open Settings
            </button>
          </div>
        )}
        <div class="grid2">
          <label class="field">
            <span>Entry ₹ (limit price)</span>
            <input type="number" step={inst?.tick ?? 0.05} value={entryText} onInput={(e) => {
              setEntryTouched(true);
              setEntryText((e.currentTarget as HTMLInputElement).value);
            }} />
            <span class="hint">{snap ? `Live: ₹${formatNumberIN(snap.price)}` : ''} · tick ₹{inst?.tick ?? 0.05}</span>
          </label>
          <label class="field">
            <span>Risk per trade %</span>
            <input type="number" step="0.1" min="0.1" value={riskText} onInput={(e) => setRiskText((e.currentTarget as HTMLInputElement).value)} />
            <span class="hint">Cap {settings?.risk.riskPerTradeCapPct ?? 2}%. First month live: 0.5%.</span>
          </label>
          <label class="field">
            <span>Stop-loss</span>
            <select value={stopMethod} onChange={(e) => setStopMethod((e.currentTarget as HTMLSelectElement).value as StopMethod)}>
              <option value="atr">{settings?.planner.stopAtrMultiple ?? 2} × ATR below entry</option>
              <option value="swingLow">Below last swing low</option>
              <option value="manual">Manual</option>
            </select>
            {stopMethod === 'manual' && <input type="number" step="0.05" placeholder="Stop ₹" value={manualStop} onInput={(e) => setManualStop((e.currentTarget as HTMLInputElement).value)} />}
          </label>
          <label class="field">
            <span>Target</span>
            <select value={targetMethod} onChange={(e) => setTargetMethod((e.currentTarget as HTMLSelectElement).value as TargetMethod)}>
              <option value="history">From history — no fixed target</option>
              <option value="2R">2R (twice the risk)</option>
              <option value="3R">3R</option>
              <option value="resistance">Nearest resistance</option>
              <option value="manual">Manual</option>
            </select>
            {targetMethod === 'manual' && <input type="number" step="0.05" placeholder="Target ₹" value={manualTarget} onInput={(e) => setManualTarget((e.currentTarget as HTMLInputElement).value)} />}
          </label>
          <label class="field">
            <span>Next results date (optional)</span>
            <input type="date" value={resultsDate} onInput={(e) => setResultsDate((e.currentTarget as HTMLInputElement).value)} />
            <span class="hint">Check the company's announcements. Avoid entries within 7 days.</span>
          </label>
        </div>
      </section>

      {plan && !plan.ok && (
        <div class="banner err" data-testid="plan-errors">
          {plan.errors.map((e) => (
            <div>{e}</div>
          ))}
        </div>
      )}

      {plan?.ok && (
        <>
          <section class="card" data-testid="plan-result">
            <h2>Risk and profit</h2>
            <dl class="kv plan-kv">
              <dt>Entry</dt>
              <dd>₹{formatNumberIN(plan.entry)}</dd>
              <dt>Stop-loss</dt>
              <dd class="err-text">₹{formatNumberIN(plan.stop)} <span class="muted">({formatNumberIN(((plan.entry - plan.stop) / plan.entry) * 100, 1)}% below)</span></dd>
              <dt>{plan.targetMode === 'history' ? 'Safe target' : 'Target'}</dt>
              <dd class="ok-text">₹{formatNumberIN(plan.target)}</dd>
              {plan.targetMode === 'history' && (
                <>
                  <dt>Hold-until target</dt>
                  <dd class="ok-text">{plan.holdTarget !== null ? `₹${formatNumberIN(plan.holdTarget)}` : '— (same as safe)'}</dd>
                </>
              )}
              <dt><Term t="R">Risk per share (1R)</Term></dt>
              <dd>₹{formatNumberIN(plan.riskPerShare)}</dd>
              <dt>Quantity</dt>
              <dd><b>{plan.qty}</b> shares</dd>
              <dt>Investment</dt>
              <dd>{formatINR(plan.positionValue, 0)} <span class="muted">({formatNumberIN(plan.positionPct, 1)}% of capital)</span></dd>
              <dt>₹ at risk</dt>
              <dd class="err-text"><b>{formatINR(plan.riskRupees, 0)}</b> <span class="muted">({plan.riskPctUsed}% of capital)</span></dd>
              <dt>{plan.targetMode === 'history' ? '₹ at safe target' : '₹ at target'}</dt>
              <dd class="ok-text"><b>{formatINR(plan.rewardRupees, 0)}</b></dd>
              <dt>Reward : risk</dt>
              <dd><b>{plan.rr.toFixed(2)}R</b></dd>
              <dt>Charges (est.)</dt>
              <dd>{plan.charges !== null ? `${formatINR(plan.charges, 0)} · breakeven ₹${formatNumberIN(plan.breakeven)}` : 'not set (Settings)'}</dd>
            </dl>
          </section>

          {plan.targetMode === 'history' && study && snap?.atr14 && <ExitPlanCard study={study} entry={plan.entry} stop={plan.stop} safe={plan.target} hold={plan.holdTarget} atr={snap.atr14} />}

          {plan.guardrails.length > 0 && (
            <section class="banner warn" data-testid="guardrails">
              <b>Check before ordering:</b>
              <ul>
                {plan.guardrails.map((g) => (
                  <li>{g.text}</li>
                ))}
              </ul>
            </section>
          )}

          <section class="card">
            <h2>Order ticket</h2>
            <p class="small muted">Type this into the Upstox app yourself. This extension never places orders.</p>
            <pre class="ticket" data-testid="ticket">{ticket}</pre>
            <div class="row">
              <button class="btn small" type="button" onClick={() => void copy(ticket)}>
                {copied ? 'Copied' : 'Copy'}
              </button>
              {!saved && (
                <button class="btn small primary" type="button" onClick={() => void save()}>
                  Save plan + alerts
                </button>
              )}
              {saved && (
                <button class="btn small" type="button" onClick={() => go('alerts')}>
                  View in Trades &amp; alerts
                </button>
              )}
            </div>
            {msg && <p class={`small ${msg.tone === 'ok' ? 'ok-text' : 'err-text'}`}>{msg.text}</p>}
            {snap && (
              <div style={{ marginTop: '8px' }}>
                <StudyButton
                  label="Copy study question (with this plan) for Claude"
                  input={{
                    symbol: sym,
                    name: inst?.name ?? sym,
                    ...(inst?.isin ? { isin: inst.isin } : {}),
                    snap,
                    priceTime: data?.quote?.fetchedAt ?? Date.now(),
                    plan: { entry: plan.entry, stop: plan.stop, target: plan.target, holdTarget: plan.holdTarget, qty: plan.qty, riskRupees: plan.riskRupees, historyMode: plan.targetMode === 'history' },
                  }}
                />
              </div>
            )}
            <p class="small">
              {plan.targetMode === 'history' ? (
                <>
                  After your buy order fills, create the <Term t="GTT">GTT</Term> stop-loss in Upstox straight away (stop only — no target), so it works even if this computer is off.
                  The extension tells you when to hold or sell.
                </>
              ) : (
                <>
                  After your buy order fills, create the <Term t="GTT">GTT</Term> stop-loss and target in Upstox straight away, so they work even if this computer is off.
                </>
              )}
            </p>
          </section>
        </>
      )}
    </>
  );
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** What the history study says, in plain words (owner's exit logic). */
function ExitPlanCard({ study, entry, stop, safe, hold, atr }: { study: ExitStudy; entry: number; stop: number; safe: number; hold: number | null; atr: number }) {
  const R = entry - stop;
  const twoR = entry + 2 * R;
  const chance = (price: number) => chanceOf(study, (price - entry) / atr);
  const bestPrice = study.best ? entry + study.best.atr * atr : null;
  return (
    <section class="card exit-plan" data-testid="exit-plan">
      <h2>Exit plan from history</h2>
      <p class="small muted">
        Based on {study.samples} {study.similarOnly ? 'similar (same-trend) ' : ''}days in the last {Math.round(study.lookback / 250)} year: if you had bought on those days with a {study.stopAtr}×ATR stop,
        how far did the price rise in the next {study.horizon} trading days before the stop was hit? This is the past, not a promise.
      </p>
      <table class="simple">
        <thead>
          <tr>
            <th>Level</th>
            <th>Price</th>
            <th>Reached before the stop</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><b>Safe target</b></td>
            <td>₹{formatNumberIN(safe)}</td>
            <td>{pct(chance(safe))} of the time</td>
          </tr>
          {hold !== null && (
            <tr>
              <td><b>Hold-until</b></td>
              <td>₹{formatNumberIN(hold)}</td>
              <td>{pct(chance(hold))}</td>
            </tr>
          )}
          <tr>
            <td>2R (classic)</td>
            <td>₹{formatNumberIN(twoR)}</td>
            <td>{pct(chance(twoR))}</td>
          </tr>
        </tbody>
      </table>
      <p class="small">
        Stopped out within {study.horizon} days in {pct(study.stoppedPct)} of past cases.
        {study.best && bestPrice !== null && (
          <>
            {' '}Best fixed exit in the past: about ₹{formatNumberIN(bestPrice)}, averaging {study.best.expectancyR >= 0 ? '+' : ''}
            {study.best.expectancyR.toFixed(2)}R per trade{study.best.expectancyR <= 0 ? ' — history does not favour this trade' : ''}.
          </>
        )}
      </p>
      <p class="small">
        <b>How it works after you buy:</b> keep only the stop-loss in the Upstox GTT. When the safe target is reached the extension says <b>HOLD</b> (trend healthy) or <b>BOOK PROFIT</b> (momentum
        fading); at the hold-until target it says <b>BOOK PROFIT</b>; if the price closes below the trailing stop it says <b>SELL</b>. Every evening it tells you if the GTT stop should move up.
      </p>
    </section>
  );
}
