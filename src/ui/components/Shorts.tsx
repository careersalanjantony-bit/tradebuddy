import { useState } from 'preact/hooks';
import { breadthAdvice } from '../../advisor/breadth';
import { formatINR, formatNumberIN, formatPct, formatTimeIST } from '../../lib/format';
import { errorMessage } from '../../lib/serialize';
import { callBackground } from '../../shared/messages';
import { updateSettings } from '../../storage/local';
import type { ShortIdea } from '../../background/shortJobs';
import { useQuotes } from '../data';
import { useLocal, useMarketState, useSessionValue, useSettings } from '../hooks';
import { Icon } from './Icon';
import { AnimatedNumber, buzz, toast } from './Motion';

const signed = (x: number) => `${x >= 0 ? '+' : '−'}${formatINR(Math.abs(x), 0)}`;

/** "Are more stocks rising or falling?" — Nifty 500 breadth with what it means today (owner's picture). */
export function BreadthCard() {
  const b = useSessionValue('breadth');
  if (!b || b.total < 20) return null;
  const adv = breadthAdvice(b);
  const upPct = (b.advanced / Math.max(1, b.advanced + b.declined)) * 100;
  return (
    <section class="card breadth-card" data-testid="breadth">
      <h2>Are more stocks rising or falling?</h2>
      <div class="breadth-nums">
        <span class="ok-text">
          <b>
            <AnimatedNumber value={b.advanced} format={(v) => String(Math.round(v))} />
          </b>{' '}
          {b.list} up
        </span>
        <span class="err-text">
          <b>
            <AnimatedNumber value={b.declined} format={(v) => String(Math.round(v))} />
          </b>{' '}
          down
        </span>
      </div>
      <div class="breadth-bar" role="img" aria-label={`${b.advanced} up, ${b.declined} down`}>
        <span class="up" style={{ width: `${upPct}%` }} />
        <span class="down" style={{ width: `${100 - upPct}%` }} />
      </div>
      <p class="small muted" style={{ margin: '6px 0 4px' }}>
        {adv?.headline} {b.unchanged ? `${b.unchanged} unchanged.` : ''} Updated {formatTimeIST(b.at).slice(0, 5)}.
      </p>
      {adv && (
        <ul class="breadth-points small">
          {adv.points.map((p) => (
            <li>
              <b>{p.label}:</b> {p.text}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** "Falling now" — ranked sell-first ideas with entry, buy-back price, two targets and quantity. */
export function FallingNowCard() {
  const data = useSessionValue('shortIdeas');
  const test = useLocal('shortTest');
  const settings = useSettings();
  const market = useMarketState();
  const breadth = useSessionValue('breadth');
  const [busy, setBusy] = useState(false);
  if (!settings) return null;
  const risk = settings.dayTrade.shortRiskInr ?? 50;
  const ideas = data?.ideas ?? [];
  const rising = breadth && breadth.advanced > breadth.declined * 2;
  const refresh = () => {
    setBusy(true);
    void callBackground('shorts:scan')
      .catch((e: unknown) => toast(errorMessage(e), 'err'))
      .finally(() => setBusy(false));
  };
  return (
    <section class="card falling-card" data-testid="falling-now">
      <div class="row">
        <h2 style={{ margin: 0 }}>
          <Icon name="down" size={20} /> Falling now — sell-first ideas
        </h2>
        <span class="spacer" />
        <button class={`icon-btn ${busy ? 'spin' : ''}`} type="button" aria-label="Scan now" data-testid="shorts-refresh" onClick={refresh}>
          <Icon name="refresh" size={18} />
        </button>
      </div>
      <p class="tiny muted" style={{ margin: '4px 0 8px' }}>
        Sell first, buy back the same day (Upstox <b>Intraday</b>). Scored on the day's average price, EMA 9, RSI, selling volume, lower highs and red candles. Every 5 minutes, 9:35–2:30.
      </p>
      <div class="risk-row small">
        <span class="muted">Most I want to lose per trade:</span>
        {[50, 100, 200].map((r) => (
          <button type="button" class={`filter-chip ${risk === r ? 'on' : ''}`} data-risk={r} onClick={() => void updateSettings({ dayTrade: { shortRiskInr: r } })}>
            ₹{r}
          </button>
        ))}
      </div>
      {rising && <div class="banner warn small">Most stocks are rising today — sell-first ideas go against the market. Be extra careful.</div>}
      {ideas.length === 0 ? (
        <p class="small muted">{market.phase === 'open' ? 'No stock is falling clearly enough right now (score 60 or more). Checked every 5 minutes.' : 'Ideas appear during market hours, 9:35 – 2:30.'}</p>
      ) : (
        ideas.map((x) => <ShortIdeaCard x={x} key={x.key} />)
      )}
      <ShortTestLine test={test} />
    </section>
  );
}

function ShortIdeaCard({ x }: { x: ShortIdea }) {
  const quotes = useQuotes();
  const [how, setHow] = useState(false);
  const ltp = quotes[x.key]?.ltp ?? x.plan.entry;
  const p = x.plan;
  const moved = ltp >= p.stop || ltp <= p.t1;
  const practice = async () => {
    try {
      const r = await callBackground('wallet:short', { key: x.key, symbol: x.symbol, qty: p.qty, stop: p.stop, t1: p.t1, t2: p.t2, source: 'Falling now' });
      void buzz('success');
      toast(`Sold ${p.qty} ${x.symbol} first at ₹${formatNumberIN(r.price)} (practice)`);
    } catch (e) {
      toast(errorMessage(e), 'err');
    }
  };
  return (
    <div class={`day-signal short-idea ${moved ? 'stale' : ''}`} data-symbol={x.symbol} data-side="short">
      <div class="sig-head">
        <div class="sig-title">
          <span class="chip day sell">▼ SELL first</span>
          <h3>{x.symbol}</h3>
          <span class="muted small">
            {formatPct(x.changePct, 1)} today · {formatTimeIST(x.at).slice(0, 5)}
          </span>
          {moved && <span class="chip flag">price moved — skip</span>}
        </div>
        <span class={`ring ${x.score >= 75 ? 'lo' : 'mid'} score-ring`} title={`Bearish score ${x.score}`}>
          <svg viewBox="0 0 36 36" width={54} height={54} aria-hidden="true">
            <circle cx="18" cy="18" r="15.5" class="ring-bg" />
            <circle cx="18" cy="18" r="15.5" class="ring-fg" pathLength={100} style={{ '--p': x.score }} />
          </svg>
          <b>{x.score}</b>
        </span>
      </div>
      <div class="idea-grid sig-grid four">
        <div>
          <span>Sell first at</span>
          <b>₹{formatNumberIN(p.entry)}</b>
        </div>
        <div>
          <span>Buy back if it rises to</span>
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
        <b>{p.qty} shares</b> · most you lose ≈ {formatINR(p.risk, 0)} · after charges: <span class="ok-text">{signed(p.netAtTargets)}</span> at both targets, <span class="err-text">{signed(p.netAtStop)}</span> at the stop
      </div>
      <div class="reason-chips">
        {x.reasons.slice(0, 4).map((r) => (
          <span class="reason-pill">{r.text}</span>
        ))}
      </div>
      <div class="row" style={{ gap: '8px', marginTop: '10px' }}>
        <button class="btn small sell" type="button" data-testid="short-practice" disabled={moved} onClick={() => void practice()}>
          Practice sell-first
        </button>
        <button class="btn small" type="button" onClick={() => setHow(!how)}>
          How in Upstox
        </button>
      </div>
      {how && (
        <ol class="small how-steps">
          <li>
            Upstox → <b>{x.symbol}</b> → <b>Sell</b> → product <b>Intraday</b> → quantity <b>{p.qty}</b> → Market.
          </li>
          <li>
            Right after: <b>Buy</b> → Intraday → <b>Stop-loss</b> order, trigger ₹{formatNumberIN(p.stop)} (your safety net).
          </li>
          <li>
            Buy back half at ₹{formatNumberIN(p.t1)} and the rest at ₹{formatNumberIN(p.t2)}, or everything by <b>3:10 pm</b> — Upstox closes Intraday trades by itself around 3:20 pm.
          </li>
        </ol>
      )}
    </div>
  );
}

function ShortTestLine({ test }: { test: ReturnType<typeof useLocal<'shortTest'>> }) {
  if (!test) return <p class="tiny muted">Past test: runs after the 5-minute history has downloaded (Day trade switched on).</p>;
  const n = test.newer;
  return (
    <div class={`verdict small ${test.passed ? 'pass' : 'fail'}`} data-testid="short-test">
      <b>{test.passed ? '✅ Past test passed' : '⏸ Past test not passed yet'}</b> — on the newest {Math.round(test.days / 3)} days ({test.days} tested): {n.trades} trades, {n.trades ? Math.round((n.wins / n.trades) * 100) : 0}% won,
      reached target 1 in {n.t1Hits}, result <span class={n.pnl >= 0 ? 'ok-text' : 'err-text'}>{signed(n.pnl)}</span> after charges (₹{test.riskRupees} risk each).
      {!test.passed && ' Use practice only.'}
    </div>
  );
}
