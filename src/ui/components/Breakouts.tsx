import { useState } from 'preact/hooks';
import type { BreakoutSignal, BreakoutStatus } from '../../background/breakoutJobs';
import { BO } from '../../daytrade/breakout';
import { minutesIST } from '../../daytrade/live';
import { formatINR, formatNumberIN, formatTimeIST } from '../../lib/format';
import { updateSettings } from '../../storage/local';
import { useQuotes } from '../data';
import { useLocal, useMarketState, useNow, useSessionValue, useSettings } from '../hooks';
import { openTrade } from './TradeSheet';
import { AlsoIn, IndexTag } from './ScanList';

/**
 * App v1.9 — "🚀 Breakout Today — buy-first ideas" (Day trade tab, below "Falling now"). The live
 * engine (background/breakoutJobs.ts) checks every stock on each live price; this card shows what it
 * found: breakout price, current price, time, volume jump, entry, stop-loss, two targets and the
 * quantity for the chosen risk. Stale ideas are marked "Too late" and then removed.
 */

const signed = (x: number) => `${x >= 0 ? '+' : '−'}${formatINR(Math.abs(x), 0)}`;
const ACTIVE: BreakoutStatus[] = ['confirmed', 'breakout'];

const STATUS: Record<BreakoutStatus, { label: string; cls: string }> = {
  breakout: { label: '🚀 Breakout', cls: 'go' },
  confirmed: { label: '✅ Confirmed', cls: 'ok' },
  late: { label: '⏱ Too late', cls: 'late' },
  failed: { label: '✖ Failed', cls: 'bad' },
  stopped: { label: '⛔ Stop-loss hit', cls: 'bad' },
  target: { label: '🎯 Target 2 reached', cls: 'ok' },
};

export function BreakoutCard() {
  const data = useSessionValue('breakouts');
  const feed = useSessionValue('feedStatus');
  const test = useLocal('breakoutTest');
  const settings = useSettings();
  const market = useMarketState();
  const now = useNow(1_000);
  if (!settings) return null;
  const risk = settings.dayTrade.breakoutRiskInr ?? 100;
  const today = data && data.date === new Date(now + 5.5 * 3600_000).toISOString().slice(0, 10);
  const signals = today ? data.signals : [];
  const order = (s: BreakoutSignal) => (ACTIVE.includes(s.status) ? 0 : 1);
  // app v1.11: one card per stock — the live idea (or the newest one); earlier ones are counted on it
  const sorted = [...signals].sort((a, b) => order(a) - order(b) || b.at - a.at);
  const earlier = new Map<string, number>();
  const list = sorted.filter((s, i) => {
    const first = sorted.findIndex((x) => x.key === s.key) === i;
    if (!first) earlier.set(s.key, (earlier.get(s.key) ?? 0) + 1);
    return first;
  });
  const active = list.filter((s) => ACTIVE.includes(s.status));
  const live = !!feed?.connected && now - feed.lastTickAt < 15_000;
  const t = minutesIST(now);
  const open = market.phase === 'open';
  let status: string;
  if (!open) status = `Market ${market.label}. Live breakout scanning runs on trading days, 9:15 am – 3:30 pm (alerts from 9:20 to 3:00).`;
  else if (t < BO.firstT) status = 'Building the first 5-minute candle (9:15–9:20). Breakout alerts can start at 9:20.';
  else if (t > BO.lastT) status = 'No new breakout ideas after 3:00 pm (same-day trades close by 3:10).';
  else {
    const total = data?.total ?? data?.scanned ?? 0;
    const loading = total > (data?.scanned ?? 0) ? ` (${formatNumberIN(data?.scanned ?? 0, 0)} of ${formatNumberIN(total, 0)} loaded — the rest join as their candles come in)` : '';
    status = `Checking ${formatNumberIN(total, 0)} stocks on every live price${live ? ' (Upstox live feed)' : ' (about every 2 seconds)'}${loading} — updated ${data ? formatTimeIST(data.at) : '—'}.`;
  }
  return (
    <section class="card breakout-card" data-testid="breakouts">
      <div class="row">
        <h2 style={{ margin: 0 }}>🚀 Breakout Today — buy-first ideas</h2>
        <span class="spacer" />
        <span class={`live-pill ${open && live ? 'on' : ''}`} data-testid="breakout-live">
          <i aria-hidden="true" />
          {open && live ? 'LIVE' : open ? 'POLLING' : 'CLOSED'}
        </span>
      </div>
      <p class="tiny muted" style={{ margin: '4px 0 8px' }}>
        Buy when a stock breaks above <b>today's high</b> (its resistance) with a <b>sudden jump in trading</b>. Alert the moment it crosses — no waiting for the 5-minute scan — then <b>✅ Confirmed</b>{' '}
        when a 5-minute candle closes above. False breakouts are filtered with volume spike, VWAP, EMA 9, RSI (55–80) and momentum. Buy and sell the same day (Upstox <b>Intraday</b>).
      </p>
      <div class="risk-row small">
        <span class="muted">Most I want to lose per trade:</span>
        {[50, 100, 200, 500].map((r) => (
          <button type="button" class={`filter-chip ${risk === r ? 'on' : ''}`} data-bo-risk={r} onClick={() => void updateSettings({ dayTrade: { breakoutRiskInr: r } })}>
            ₹{r}
          </button>
        ))}
      </div>
      <p class="small muted" data-testid="breakout-status" style={{ margin: '6px 0' }}>
        {status}
      </p>
      <DataSaver n={data?.total ?? data?.scanned ?? 0} on={!!settings.data.saveData} />
      {active.length === 0 && (
        <p class="small muted" data-testid="breakout-empty">
          {open && t >= BO.firstT && t <= BO.lastT ? 'No stock is breaking out right now. You get an alert with sound the moment one does.' : 'Ideas appear here during market hours.'}
        </p>
      )}
      {list.map((s) => (
        <BreakoutIdea s={s} key={s.id} now={now} earlier={earlier.get(s.key) ?? 0} />
      ))}
      <BreakoutTestLine test={test} />
    </section>
  );
}

/**
 * Live details (volume, VWAP, 1-minute candles) cost mobile data: roughly 1.3 MB an hour per stock,
 * prices only about 0.25 MB. With "Save mobile data" on, volume comes from the ~10-second check.
 */
function DataSaver({ n, on }: { n: number; on: boolean }) {
  const stocks = Math.max(1, n);
  const mb = (perStock: number) => Math.max(1, Math.round(stocks * perStock));
  return (
    <label class="switch-row bo-data" data-testid="breakout-savedata">
      <span>
        <b>Save mobile data</b>
        <span class="tiny muted">
          {on
            ? `On: live prices only (about ${mb(0.25)} MB an hour for ${stocks} stocks). Volume is checked about every 10 seconds, so an alert can come a few seconds later.`
            : `Off: full live details for every stock (about ${mb(1.3)} MB an hour for ${stocks} stocks — Wi-Fi is best). Turn on if your data pack is small.`}
        </span>
      </span>
      <input type="checkbox" role="switch" class="switch" checked={on} onChange={(e) => void updateSettings({ data: { saveData: (e.currentTarget as HTMLInputElement).checked } })} />
    </label>
  );
}

function BreakoutIdea({ s, now, earlier }: { s: BreakoutSignal; now: number; earlier: number }) {
  const quotes = useQuotes();
  const [how, setHow] = useState(false);
  const q = quotes[s.key];
  const ltp = q && now - q.fetchedAt < 60_000 ? q.ltp : s.lastPrice;
  const p = s.plan;
  const R = p.entry - p.stop;
  // the engine marks it within a second; this keeps the card honest in between
  const ranAway = ACTIVE.includes(s.status) && ltp > p.entry + 0.6 * R;
  const st = ranAway ? STATUS.late : STATUS[s.status];
  const canBuy = ACTIVE.includes(s.status) && !ranAway && ltp > p.stop;
  const fromBreak = (ltp / s.price - 1) * 100;
  const ageMin = Math.max(0, Math.floor((now - s.at) / 60_000));
  return (
    <div class={`day-signal bo-idea bo-${st.cls}`} data-symbol={s.symbol} data-status={ranAway ? 'late' : s.status} data-testid="breakout-idea">
      <div class="sig-head">
        <div class="sig-title">
          <span class={`chip bo-chip ${st.cls}`}>{st.label}</span>
          <h3>{s.symbol}</h3>
          <IndexTag index={s.index} k={s.key} />
          <span class="muted small">
            {formatTimeIST(s.at)} · {ageMin < 1 ? 'just now' : `${ageMin} min ago`}
            {earlier ? ` · ${earlier} earlier breakout${earlier === 1 ? '' : 's'} today` : ''}
          </span>
          <AlsoIn k={s.key} here="breakout" />
        </div>
        <span class={`ring ${s.score >= 75 ? 'hi' : 'mid'} score-ring`} title={`Breakout score ${s.score}`}>
          <svg viewBox="0 0 36 36" width={54} height={54} aria-hidden="true">
            <circle cx="18" cy="18" r="15.5" class="ring-bg" />
            <circle cx="18" cy="18" r="15.5" class="ring-fg" pathLength={100} style={{ '--p': s.score }} />
          </svg>
          <b>{s.score}</b>
        </span>
      </div>
      <div class="idea-grid sig-grid four bo-facts">
        <div>
          <span>Breakout price</span>
          <b>₹{formatNumberIN(s.price)}</b>
          <small class="muted">above ₹{formatNumberIN(s.level)}</small>
        </div>
        <div>
          <span>Current price</span>
          <b class={fromBreak >= 0 ? 'ok-text' : 'err-text'}>₹{formatNumberIN(ltp)}</b>
          <small class="muted">
            {fromBreak >= 0 ? '+' : ''}
            {fromBreak.toFixed(2)}% since
          </small>
        </div>
        <div>
          <span>Volume increase</span>
          <b>{s.volX.toFixed(1)}×</b>
          <small class="muted">normal</small>
        </div>
        <div>
          <span>Breakout time</span>
          <b>{formatTimeIST(s.at).slice(0, 5)}</b>
          <small class="muted">{s.status === 'confirmed' && s.confirmedAt ? `confirmed ${formatTimeIST(s.confirmedAt).slice(0, 5)}` : s.kind === 'prev-day-high' ? "yesterday's high" : "today's high"}</small>
        </div>
      </div>
      <div class="idea-grid sig-grid four">
        <div>
          <span>Buy (entry) around</span>
          <b>₹{formatNumberIN(p.entry)}</b>
        </div>
        <div>
          <span>Stop-loss</span>
          <b class="err-text">₹{formatNumberIN(p.stop)}</b>
        </div>
        <div>
          <span>Target 1 (half)</span>
          <b class="ok-text">₹{formatNumberIN(p.t1)}</b>
        </div>
        <div>
          <span>Target 2 (rest)</span>
          <b class="ok-text">₹{formatNumberIN(p.t2)}</b>
        </div>
      </div>
      <div class="small sig-flow">
        <b>{p.qty} shares</b> (for {formatINR(p.risk, 0)} risk) · after charges: <span class="ok-text">{signed(p.netAtTargets)}</span> at both targets, <span class="err-text">{signed(p.netAtStop)}</span> at the stop-loss
      </div>
      <div class="reason-chips">
        {s.reasons.slice(0, 5).map((r) => (
          <span class="reason-pill">{r}</span>
        ))}
      </div>
      {(s.note || ranAway) && <p class="small bo-note">{ranAway ? 'The price already ran up — too late to buy safely.' : `Note: ${s.note}.`}</p>}
      <div class="row" style={{ gap: '8px', marginTop: '10px' }}>
        <button
          class="btn small buy"
          type="button"
          data-testid="breakout-practice"
          disabled={!canBuy}
          onClick={() => openTrade({ key: s.key, symbol: s.symbol, side: 'buy', qty: p.qty, stop: p.stop, target: p.t2, sellByClose: true, source: 'Breakout today' })}
        >
          Practice buy
        </button>
        <button class="btn small" type="button" onClick={() => setHow(!how)}>
          How in Upstox
        </button>
      </div>
      {how && (
        <ol class="small how-steps">
          <li>
            Upstox → <b>{s.symbol}</b> → <b>Buy</b> → product <b>Intraday</b> → quantity <b>{p.qty}</b> → Limit ₹{formatNumberIN(p.entry)} (or Market if it is still near).
          </li>
          <li>
            Right after: <b>Sell</b> → Intraday → <b>Stop-loss</b> order, trigger ₹{formatNumberIN(p.stop)} — your safety net.
          </li>
          <li>
            Sell half at ₹{formatNumberIN(p.t1)} (then move the stop-loss up to your buy price), the rest at ₹{formatNumberIN(p.t2)} — or everything by <b>3:10 pm</b>.
          </li>
          <li>Skip it if the price is already far above the entry, or the candle closes back below ₹{formatNumberIN(s.level)}.</li>
        </ol>
      )}
    </div>
  );
}

function BreakoutTestLine({ test }: { test: ReturnType<typeof useLocal<'breakoutTest'>> }) {
  if (!test) return <p class="tiny muted">Past test: runs on the 5-minute history after it has downloaded.</p>;
  const n = test.newer;
  const all = test.older.trades + test.newer.trades;
  return (
    <div class={`verdict small ${test.passed ? 'pass' : 'fail'}`} data-testid="breakout-test">
      <b>{test.passed ? '✅ Past test passed' : '⏸ Past test not passed yet'}</b> — the confirmed-breakout rule on {test.days} past days: {all} trades, {Math.round(test.winRate * 100)}% made money. Newest half:{' '}
      {n.trades} trades, result <span class={n.pnl >= 0 ? 'ok-text' : 'err-text'}>{signed(n.pnl)}</span> after charges (₹{test.riskRupees} risk each).
      {!test.passed && ' Use practice only.'}
    </div>
  );
}
