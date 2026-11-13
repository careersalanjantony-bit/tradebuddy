import { useEffect, useState } from 'preact/hooks';
import type { AlertRule } from '../../alerts/rules';
import { formatDateTimeIST, formatINR, formatNumberIN, formatTimeIST } from '../../lib/format';
import { errorMessage } from '../../lib/serialize';
import { callBackground } from '../../shared/messages';
import type { AlertLogEntry } from '../../storage/db';
import type { TradePlan } from '../../storage/schema';
import type { Go } from '../App';
import { useQuotes, useStocksData } from '../data';
import { adviceForPlan } from '../../advisor/forPlan';
import type { Advice } from '../../advisor/holdAdvice';
import type { StockData } from '../../data/stockData';
import { useLocal, useSessionValue, useSettings } from '../hooks';
import { UpstoxSyncLine } from '../components/Market';
import { AddPurchaseCard, stopLimitFor } from '../components/Bought';

const KIND_LABEL: Record<AlertRule['kind'], string> = {
  above: 'Crosses above',
  below: 'Crosses below',
  stop: 'Stop hit',
  target: 'Target hit',
  safeTarget: 'Safe target reached',
  holdTarget: 'Hold-until target reached',
  nearStop: 'Within 1% of stop',
  oneR: '+1R reached',
  closeBelowSma20: 'Closes below SMA20 (end of day)',
};

/** Trades (saved plans) and alerts (spec §12, §14-lite). */
export function AlertsScreen({ go }: { go: Go }) {
  const plans = useLocal('plans') ?? [];
  const rules = useLocal('alerts') ?? [];
  const unread = useSessionValue('alertsUnread') ?? 0;
  const quotes = useQuotes();
  const [log, setLog] = useState<AlertLogEntry[]>([]);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [showClosed, setShowClosed] = useState(false);

  useEffect(() => {
    void callBackground('alerts:seen').catch(() => undefined);
  }, [unread]);
  useEffect(() => {
    void callBackground('alerts:log', { limit: 50 }).then((r) => setLog(r.entries)).catch(() => undefined);
  }, [unread, rules.length]);

  const act = async (fn: () => Promise<string | void>) => {
    setMsg(null);
    try {
      const t = await fn();
      if (t) setMsg({ tone: 'ok', text: t });
    } catch (err) {
      setMsg({ tone: 'err', text: errorMessage(err) });
    }
  };

  const active = plans.filter((p) => !p.practice && (p.status === 'planned' || p.status === 'open'));
  const settings = useSettings();
  const { data: stockData } = useStocksData([...new Set(active.filter((p) => p.status === 'open').map((p) => p.key))]);
  const finished = plans.filter((p) => !p.practice && (p.status === 'closed' || p.status === 'cancelled'));
  const priceRules = rules.filter((r) => !r.planId);

  return (
    <>
      {msg && <div class={`banner ${msg.tone === 'ok' ? 'ok' : 'err'} small`}>{msg.text}</div>}
      <UpstoxSyncLine />
      <AddPurchaseCard />
      <section class="card">
        <h2>Real trades</h2>
        {active.length === 0 && <p class="muted small">No planned or open real trades. Save a pick on Today ("Save & set alerts") to start one.</p>}
        {active.map((p) => (
          <PlanCard
            plan={p}
            ltp={quotes[p.key]?.ltp}
            rules={rules.filter((r) => r.planId === p.id)}
            advice={settings ? adviceForPlan(p, stockData.get(p.key) as StockData | undefined, settings) : null}
            go={go}
            act={act}
          />
        ))}
        {finished.length > 0 && (
          <button class="btn small" type="button" onClick={() => setShowClosed(!showClosed)}>
            {showClosed ? 'Hide' : 'Show'} {finished.length} closed/cancelled
          </button>
        )}
        {showClosed &&
          finished.map((p) => (
            <div class="small plan-done">
              <b>{p.symbol}</b> {p.status}
              {p.fillPrice ? ` · bought ₹${formatNumberIN(p.fillPrice)}` : ''}
              {p.exitPrice ? ` · sold ₹${formatNumberIN(p.exitPrice)} (${p.exitReason})` : ''}
              {p.fillPrice && p.exitPrice ? ` · P&L ${formatINR((p.exitPrice - p.fillPrice) * p.qty, 0)} (${((p.exitPrice - p.fillPrice) / (p.entry - p.stop)).toFixed(2)}R, before charges)` : ''}
              {' '}
              <button class="link-btn" type="button" onClick={() => void act(async () => {
                if (!confirm(`Delete the ${p.symbol} plan permanently?`)) return;
                await callBackground('plans:delete', { id: p.id });
              })}>
                delete
              </button>
            </div>
          ))}
      </section>

      <section class="card">
        <h2>Price alerts</h2>
        {priceRules.length === 0 && <p class="muted small">None. Add one from a stock's page.</p>}
        {priceRules.map((r) => (
          <RuleRow rule={r} act={act} />
        ))}
        <p class="tiny muted">Alerts are checked on every price refresh (every 2 s while this panel is open, 30 s otherwise) in market hours, only on fresh prices. A price alert fires when the price crosses the level (0.1% band to avoid flapping).</p>
      </section>

      <section class="card">
        <h2>Alert log</h2>
        {log.length === 0 && <p class="muted small">No alerts have fired yet.</p>}
        {log.map((e) => (
          <div class={`small log-line ${e.critical ? 'critical' : ''}`}>
            <span class="muted">{formatDateTimeIST(e.ts)}</span> — {e.message}
          </div>
        ))}
      </section>
    </>
  );
}

function RuleRow({ rule, act }: { rule: AlertRule; act: (fn: () => Promise<string | void>) => Promise<void> }) {
  return (
    <div class={`rule-row small ${rule.active ? '' : 'muted'}`}>
      <span>
        <b>{rule.symbol}</b> {KIND_LABEL[rule.kind]}
        {rule.kind !== 'closeBelowSma20' ? ` ₹${formatNumberIN(rule.level)}` : ''}
        {!rule.active && (rule.firedCount ? ` · fired ${rule.lastFiredAt ? formatTimeIST(rule.lastFiredAt) : ''}` : ' · paused')}
      </span>
      <span class="spacer" />
      <button class="link-btn" type="button" onClick={() => void act(async () => void (await callBackground('alerts:update', { id: rule.id, patch: { active: !rule.active } })))}>
        {rule.active ? 'pause' : 'turn on'}
      </button>
      {!rule.planId && (
        <button class="link-btn" type="button" onClick={() => void act(async () => void (await callBackground('alerts:delete', { id: rule.id })))}>
          delete
        </button>
      )}
    </div>
  );
}

function PlanCard({ plan: p, ltp, rules, advice, go, act }: { plan: TradePlan; ltp: number | undefined; rules: AlertRule[]; advice: Advice | null; go: Go; act: (fn: () => Promise<string | void>) => Promise<void> }) {
  const [showTicket, setShowTicket] = useState(false);
  const basis = p.fillPrice ?? p.entry;
  const pnl = ltp && p.status === 'open' ? (ltp - basis) * p.qty : null;

  const markBought = () =>
    act(async () => {
      const v = prompt(`${p.symbol}: at what price did your buy fill?`, String(p.entry));
      if (v === null) return;
      const price = Number(v);
      if (!(price > 0)) throw new Error('Enter a valid price.');
      // the owner may buy a different number of shares than suggested (owner, 11 Nov 2026)
      const qv = prompt(`${p.symbol}: how many shares did you buy?`, String(p.qty));
      if (qv === null) return;
      const qty = Math.floor(Number(qv));
      if (!(qty >= 1)) throw new Error('Enter the number of shares (1 or more).');
      const riskRupees = Number((qty * Math.max(0, price - p.stop)).toFixed(2));
      const rewardRupees = Number((qty * (p.target - price)).toFixed(2));
      await callBackground('plans:update', { id: p.id, patch: { status: 'open', fillPrice: price, qty, riskRupees, rewardRupees } });
      return `${p.symbol}: ${qty} shares marked as bought at ₹${formatNumberIN(price)}. Set the GTT sell for ${qty} shares at ₹${formatNumberIN(p.stop)} in Upstox if you have not yet.`;
    });
  const markClosed = () =>
    act(async () => {
      const v = prompt(`${p.symbol}: at what price did you sell?`, String(ltp ?? p.target));
      if (v === null) return;
      const price = Number(v);
      if (!(price > 0)) throw new Error('Enter a valid price.');
      const reason = price <= p.stop * 1.002 ? 'stop' : price >= p.target * 0.998 ? 'target' : 'manual';
      await callBackground('plans:update', { id: p.id, patch: { status: 'closed', exitPrice: price, exitReason: reason } });
      return `${p.symbol} closed at ₹${formatNumberIN(price)}.`;
    });
  const cancel = () =>
    act(async () => {
      if (!confirm(`Cancel the ${p.symbol} plan? Its alerts stop.`)) return;
      await callBackground('plans:update', { id: p.id, patch: { status: 'cancelled' } });
    });

  return (
    <div class="plan-card" data-plan={p.symbol}>
      <div class="row">
        <b>{p.symbol}</b>
        <span class={`chip ${p.status === 'open' ? 'setup good' : 'flag'}`}>{p.status === 'open' ? 'OPEN' : 'planned'}</span>
        {p.auto && (
          <span class="chip setup neutral" title="Found automatically in your Upstox account" data-testid="from-upstox">
            from Upstox
          </span>
        )}
        <span class="small muted">{p.setup ?? ''}</span>
        <span class="spacer" />
        <span class="small">{ltp ? `now ₹${formatNumberIN(ltp)}` : ''}</span>
      </div>
      {p.status === 'open' && (
        <div class="owned" data-testid="owned">
          You own <b>{p.qty}</b> shares · bought <b>₹{formatNumberIN(p.fillPrice)}</b>
          {ltp ? (
            <>
              {' '}
              · now <b>₹{formatNumberIN(ltp)}</b> ·{' '}
              <b class={pnl !== null && pnl >= 0 ? 'ok-text' : 'err-text'}>
                {pnl !== null && pnl >= 0 ? 'profit' : 'loss'} {formatINR(Math.abs(pnl ?? 0), 0)}
              </b>
            </>
          ) : null}
          <div class="small">
            <span class="err-text">
              Safety sell (GTT in Upstox): trigger ₹{formatNumberIN(p.stop)}, limit ₹{formatNumberIN(stopLimitFor(p.stop))}
            </span>{' '}
            · <span class="ok-text">profit target ₹{formatNumberIN(p.target)}</span>
          </div>
        </div>
      )}
      <div class="small" hidden={p.status === 'open'}>
        Buy ₹{formatNumberIN(p.entry)} · <span class="err-text">Sell if falls to ₹{formatNumberIN(p.stop)}</span> ·{' '}
        {p.targetMode === 'history' ? (
          <span class="ok-text">
            Profit target ₹{formatNumberIN(p.target)}
            {p.holdTarget ? ` · can go up to ₹${formatNumberIN(p.holdTarget)}` : ''}
          </span>
        ) : (
          <span class="ok-text">Target ₹{formatNumberIN(p.target)}</span>
        )}{' '}
        · {p.qty} shares · most you can lose {formatINR(p.riskRupees, 0)}
      </div>
      {advice && <AdviceBox advice={advice} />}

      <div class="small muted">Alerts: {rules.filter((x) => x.active).length} active{rules.some((x) => !x.active && x.firedCount) ? ` · fired: ${rules.filter((x) => x.firedCount).map((x) => KIND_LABEL[x.kind]).join(', ')}` : ''}</div>
      <div class="row" style={{ marginTop: '4px' }}>
        {p.status === 'planned' && (
          <button class="btn small primary" type="button" onClick={() => void markBought()}>
            I bought it
          </button>
        )}
        {p.status === 'open' && (
          <button class="btn small primary" type="button" onClick={() => void markClosed()}>
            I sold it
          </button>
        )}
        <button class="btn small" type="button" onClick={() => go('stock', p.key)}>
          Chart
        </button>
        <button class="btn small" type="button" onClick={() => setShowTicket(!showTicket)}>
          Ticket
        </button>
        {p.status === 'planned' && (
          <button class="btn small danger" type="button" onClick={() => void cancel()}>
            Cancel
          </button>
        )}
      </div>
      {showTicket && <pre class="ticket">{p.ticket}</pre>}
    </div>
  );
}

const ADVICE_TONE: Record<Advice['action'], string> = { HOLD: 'ok', BOOK_PROFIT: 'info', SELL: 'err', EXIT: 'err', REVIEW: 'warn' };

/** Live hold-or-sell advice for an open trade (owner's history-based exit logic). */
function AdviceBox({ advice: a }: { advice: Advice }) {
  return (
    <div class={`banner ${ADVICE_TONE[a.action]} small advice`} data-testid="advice">
      <b>{a.action.replace('_', ' ')}:</b> {a.headline}
      <ul>
        {/* plain words: lines written in "R" units are left out */}
        {a.reasons
          .filter((r) => !/[+−-]?\d+(\.\d+)?R\b/.test(r))
          .map((r) => (
            <li>{r.replace(/\bstop\b/g, 'safety sell price')}</li>
          ))}
      </ul>
      <span class="muted">
        Safety sell price ₹{formatNumberIN(a.trailingStop)} · held {a.sessionsHeld} trading day(s)
      </span>
    </div>
  );
}
