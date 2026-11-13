import { useEffect, useMemo, useState } from 'preact/hooks';
import { explainSnapshot } from '../../advisor/explain';
import { adviceForPlan } from '../../advisor/forPlan';
import { formatDateTimeIST, formatNumberIN, formatPct, formatTimeIST } from '../../lib/format';
import { callBackground } from '../../shared/messages';
import type { AlertLogEntry } from '../../storage/db';
import { hasLiveSession } from '../../upstox/token';
import type { Go } from '../App';
import { VerdictChip } from '../components/Explain';
import { useInstrumentMap, useStocksData } from '../data';
import { useLocal, useMarketState, useNow, useSessionValue, useSettings } from '../hooks';
import { loginWithUpstox } from '../login';
import { TodaySuggestions } from '../components/Suggestions';
import { PastRecordCard } from '../components/PastRecord';
import { PracticeCard } from '../components/Practice';
import { MoodLine, NewsCard } from '../components/Market';

/**
 * Today (v0.5.0 home screen): the daily routine in one place, in plain words —
 * setup checklist → market → open trades with advice → planned orders → candidates → alerts.
 */
export function TodayScreen({ go }: { go: Go }) {
  const settings = useSettings();
  const secrets = useLocal('secrets');
  const auth = useLocal('auth');
  const watchlist = useLocal('watchlist') ?? [];
  const plans = useLocal('plans') ?? [];
  const market = useMarketState();
  const now = useNow(15_000);
  const lastPoll = useSessionValue('lastPoll');
  const unread = useSessionValue('alertsUnread') ?? 0;
  const byKey = useInstrumentMap();
  const open = plans.filter((p) => p.status === 'open' && !p.practice);
  const planned = plans.filter((p) => p.status === 'planned' && !p.practice);
  const keys = useMemo(() => [...new Set([...watchlist, ...open.map((p) => p.key)])], [watchlist.join(','), open.map((p) => p.key).join(',')]);
  const { data, loading } = useStocksData(keys);
  const [log, setLog] = useState<AlertLogEntry[]>([]);
  const [loginMsg, setLoginMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void callBackground('alerts:log', { limit: 3 }).then((r) => setLog(r.entries)).catch(() => undefined);
  }, [unread]);

  if (!settings) return <p class="muted">Loading…</p>;
  const keysSaved = !!secrets?.upstoxApiKey && !!secrets?.upstoxApiSecret;
  const live = hasLiveSession(auth, now);
  const capitalSet = !!settings.risk.capitalInr;
  const analytics = auth?.analytics?.status === 'valid';

  const candidates = watchlist
    .map((k) => ({ key: k, sym: byKey.get(k)?.trading_symbol ?? k, d: data.get(k) }))
    .filter((x) => x.d?.snapshot)
    .map((x) => ({ ...x, e: explainSnapshot(x.sym, x.d!.snapshot!) }))
    .filter((x) => x.e.verdict === 'Good setup' || x.e.verdict === 'Wait')
    .sort((a, b) => (a.e.verdict === b.e.verdict ? 0 : a.e.verdict === 'Good setup' ? -1 : 1));
  const goodCount = candidates.filter((c) => c.e.verdict === 'Good setup').length;

  const login = async () => {
    setBusy(true);
    const r = await loginWithUpstox();
    setBusy(false);
    setLoginMsg(r.ok ? null : r.message);
  };

  const routine = (() => {
    switch (market.phase) {
      case 'before_open':
        return 'Morning: log in, read your candidates and plans. Orders open at 09:15 — waiting until about 09:20 lets prices settle.';
      case 'pre_open':
        return 'Pre-open: prices are settling. Wait until about 09:20 before placing planned orders.';
      case 'open':
        return 'Market open: place only planned orders — LIMIT, product CNC — and add the GTT stop-loss right after the fill. Alerts are watching your trades.';
      case 'after_close':
        return 'Market closed for today: check the advice on open trades, read the candidates and plan tomorrow. Not trading is also a decision.';
      default:
        return `Market closed today${market.session.reason && market.session.reason !== 'Weekend' ? ` (${market.session.reason})` : ''}. A good time to review and plan.`;
    }
  })();

  return (
    <>
      {(!keysSaved || !live || !capitalSet) && (
        <section class="card checklist" data-testid="checklist">
          <h2>Get ready</h2>
          <Step done={keysSaved} label="Upstox API key and secret saved">
            <button class="btn small" type="button" onClick={() => go('settings')}>Open Settings</button>
          </Step>
          <Step done={live} label="Logged in to Upstox today (lasts until 03:30)">
            {keysSaved && (
              <button class="btn small primary" type="button" disabled={busy} onClick={() => void login()}>
                {busy ? 'Waiting…' : 'Log in'}
              </button>
            )}
          </Step>
          <Step done={capitalSet} label="Amount to invest entered">
            <button class="btn small" type="button" onClick={() => go('settings')}>Enter amount</button>
          </Step>
          <Step done={analytics} optional label="Analytics Token (optional): prices work even before you log in">
            <button class="btn small" type="button" onClick={() => go('settings')}>Add</button>
          </Step>
          {loginMsg && <p class="small err-text">{loginMsg}</p>}
        </section>
      )}

      <section class="card">
        <div class="row">
          <h2 style={{ margin: 0 }}>Today</h2>
          <span class="spacer" />
          <span class="small muted">{formatDateTimeIST(now)}</span>
        </div>
        <p style={{ margin: '6px 0' }}>{routine}</p>
        <p class="small muted" style={{ margin: 0 }}>
          Market: <b>{market.label}</b>
          {market.nextOpenAt && market.phase !== 'open' ? ` · next open ${formatDateTimeIST(market.nextOpenAt)}` : ''} · prices {lastPoll ? `updated ${formatTimeIST(lastPoll.at)}` : 'not loaded yet'}
        </p>
      </section>

      <MoodLine />
      <TodaySuggestions go={go} />
      <NewsCard />
      <PracticeCard />
      <PastRecordCard />

      {open.length > 0 && (
        <section class="card" data-testid="today-open">
          <h2>Your open trades</h2>
          {open.map((p) => {
            const a = adviceForPlan(p, data.get(p.key), settings);
            const tone = !a ? 'info' : a.action === 'HOLD' ? 'ok' : a.action === 'REVIEW' ? 'warn' : a.action === 'BOOK_PROFIT' ? 'info' : 'err';
            return (
              <div class={`banner ${tone} small today-trade`}>
                <div class="row">
                  <b>{p.symbol}</b>
                  {a && <b>{a.action.replace('_', ' ')}</b>}
                  <span class="spacer" />
                  {a && <span>{a.r >= 0 ? '+' : ''}{a.r.toFixed(2)}R</span>}
                </div>
                <div>{a ? a.headline : 'Waiting for price data…'}</div>
                {a?.moveStopTo && a.action === 'HOLD' && <div>→ Move your GTT stop up to ₹{formatNumberIN(a.moveStopTo)} in Upstox.</div>}
                <button class="link-btn" type="button" onClick={() => go('alerts')}>details</button>
              </div>
            );
          })}
        </section>
      )}

      {planned.length > 0 && (
        <section class="card">
          <h2>Planned, not bought yet</h2>
          {planned.map((p) => (
            <div class="small row">
              <b>{p.symbol}</b> buy {p.qty} at ₹{formatNumberIN(p.entry)} · stop ₹{formatNumberIN(p.stop)}
              <span class="spacer" />
              <button class="link-btn" type="button" onClick={() => go('alerts')}>ticket / I bought it</button>
            </div>
          ))}
          <p class="tiny muted">Place these in the Upstox app only if the setup still looks right after 09:20. If the price ran away from the entry, don't chase — plan again.</p>
        </section>
      )}

      <section class="card" data-testid="today-candidates" hidden={settings.ui.mode === 'simple'}>
        <div class="row">
          <h2 style={{ margin: 0 }}>Candidates</h2>
          <span class="spacer" />
          <button class="link-btn" type="button" onClick={() => go('watchlist')}>all {watchlist.length} stocks</button>
        </div>
        {loading && !candidates.length ? (
          <p class="muted small">Reading your watchlist…</p>
        ) : candidates.length === 0 ? (
          <p class="small">No watchlist stock has a good setup right now. Waiting is a valid choice — the best traders skip most days.</p>
        ) : (
          <>
            <p class="small muted">
              {goodCount ? `${goodCount} good setup(s)` : 'No good setup right now'}
              {candidates.length - goodCount ? `, ${candidates.length - goodCount} to wait for` : ''}. Always check the results date before buying.
            </p>
            {candidates.slice(0, 6).map((c) => (
              <div class="candidate" data-symbol={c.sym}>
                <div class="row">
                  <b>{c.sym}</b>
                  <span>₹{formatNumberIN(c.d!.snapshot!.price)}</span>
                  <span class={(c.d!.snapshot!.changePct ?? 0) >= 0 ? 'ok-text small' : 'err-text small'}>{formatPct(c.d!.snapshot!.changePct)}</span>
                  <span class="spacer" />
                  <VerdictChip verdict={c.e.verdict} />
                </div>
                <div class="small">{c.e.summary}</div>
                {c.e.entryHint && <div class="small muted">{c.e.entryHint}</div>}
                <div class="row" style={{ marginTop: '4px' }}>
                  <button class="btn small" type="button" onClick={() => go('stock', c.key)}>Open</button>
                  {c.e.verdict === 'Good setup' && (
                    <button class="btn small primary" type="button" onClick={() => go('planner', c.key)}>Plan trade</button>
                  )}
                </div>
              </div>
            ))}
          </>
        )}
      </section>

      <section class="card">
        <div class="row">
          <h2 style={{ margin: 0 }}>Recent alerts</h2>
          <span class="spacer" />
          {unread > 0 && <span class="chip flag bad">{unread} new</span>}
          <button class="link-btn" type="button" onClick={() => go('alerts')}>all</button>
        </div>
        {log.length === 0 ? <p class="small muted">None yet.</p> : log.map((e) => <div class="small log-line">{formatTimeIST(e.ts)} — {e.message}</div>)}
      </section>
    </>
  );
}

function Step({ done, label, optional, children }: { done: boolean; label: string; optional?: boolean; children?: preact.ComponentChildren }) {
  return (
    <div class={`step-row ${done ? 'done' : ''}`}>
      <span class={done ? 'ok-text' : optional ? 'muted' : 'warn-text'}>{done ? '✓' : optional ? '○' : '!'}</span>
      <span class="label">{label}</span>
      {!done && children}
    </div>
  );
}
