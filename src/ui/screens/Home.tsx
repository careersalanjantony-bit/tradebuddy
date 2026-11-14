import { useState } from 'preact/hooks';
import { formatINR, formatNumberIN, formatPct, formatTimeIST } from '../../lib/format';
import { istDate } from '../../lib/time';
import { newWallet, walletSummary } from '../../wallet/wallet';
import type { DaySignal } from '../../daytrade/types';
import type { Go } from '../App';
import { useInstrumentMap, useQuotes } from '../data';
import { useLocal, useMarketState, useNow, useSessionValue } from '../hooks';
import { Icon } from '../components/Icon';
import { AnimatedNumber, Sparkline, useFlash } from '../components/Motion';
import { NewsCard } from '../components/Market';
import { openTrade } from '../components/TradeSheet';
import { meterTone } from '../components/RisingNow';
import { signalState } from '../../daytrade/live';
import { BreadthCard } from '../components/Shorts';

/**
 * Home (app v1.1): one glance — your practice money, the single best idea right now, what is rising,
 * the news. Everything else (tests, tables, learning) stays one tap away.
 */

const signed = (x: number) => `${x >= 0 ? '+' : '−'}${formatINR(Math.abs(x), 0)}`;

function greeting(now: number): string {
  const h = Number(formatTimeIST(now).slice(0, 2));
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

export function MarketPill() {
  const m = useMarketState();
  const open = m.phase === 'open';
  const label = open ? 'Market open' : m.phase === 'pre_open' ? 'Opening soon' : 'Market closed';
  return (
    <span class={`market-pill ${open ? 'open' : ''}`} data-testid="market-pill">
      <span class="pulse" /> {label}
    </span>
  );
}

function WalletHero({ go }: { go: Go }) {
  const w = useLocal('wallet');
  const quotes = useQuotes();
  const now = useNow(5_000);
  const s = walletSummary(w ?? newWallet(now), quotes, istDate(now));
  const history = [...(w?.equity ?? []).map((e) => e.total)];
  if (!history.length || history[history.length - 1] !== Math.round(s.total)) history.push(s.total);
  return (
    <section class="hero-card" data-tilt data-testid="wallet-mini" onClick={() => go('practice')}>
      <span class="glare" aria-hidden="true" />
      <div class="row">
        <div>
          <div class="hero-label">Practice money</div>
          <div class="hero-value">
            <AnimatedNumber value={s.total} format={(v) => formatINR(v, 0)} />
          </div>
        </div>
        <span class="spacer" />
        <Sparkline values={history.length > 1 ? history : [s.total, s.total]} width={110} height={44} />
      </div>
      <div class="row hero-foot">
        <span class={`pnl-chip ${s.todayPnl >= 0 ? 'up' : 'down'}`}>Today {signed(s.todayPnl)}</span>
        <span class="muted small">Overall {signed(s.totalPnl)}</span>
        <span class="spacer" />
        <span class="small hero-link">
          Open <Icon name="chevron" size={16} />
        </span>
      </div>
    </section>
  );
}

/** The single strongest idea: a fresh buy signal (highest chance), else the top rising stock to watch. */
function BestIdea({ go }: { go: Go }) {
  const signals = useSessionValue('daySignals');
  const flow = useSessionValue('flow');
  const quotes = useQuotes();
  const byKey = useInstrumentMap();
  const now = useNow(10_000);
  const market = useMarketState();
  const [how, setHow] = useState(false);
  const today = istDate(now);
  const fresh = (signals?.date === today ? signals.signals : [])
    .filter((s: DaySignal) => s.side === 'long' && signalState(s, quotes[s.key]?.ltp ?? null, now) === 'fresh')
    .sort((a, b) => (b.chance ?? 0.5) - (a.chance ?? 0.5));
  const sig = fresh[0];
  const rise = flow?.rising?.[0];

  if (sig) {
    const ltp = quotes[sig.key]?.ltp ?? sig.entry;
    return (
      <section class="idea-card glow" data-testid="best-idea">
        <div class="idea-head">
          <span class="badge-buy">
            <Icon name="up" size={16} /> Buy idea
          </span>
          {sig.chance !== undefined && <span class={`chance ${sig.chance >= 0.55 ? 'hi' : sig.chance >= 0.45 ? 'mid' : 'lo'}`}>{Math.round(sig.chance * 100)}% chance</span>}
          <span class="spacer" />
          <span class="tiny muted">{formatTimeIST(sig.at).slice(0, 5)}</span>
        </div>
        <div class="idea-symbol">{sig.symbol}</div>
        <div class="idea-grid">
          <div>
            <span>Buy around</span>
            <b>₹{formatNumberIN(ltp)}</b>
          </div>
          <div>
            <span>Take profit at</span>
            <b class="ok-text">{sig.target !== null ? `₹${formatNumberIN(sig.target)}` : '3:10 pm'}</b>
          </div>
          <div>
            <span>Sell if it falls to</span>
            <b class="err-text">₹{formatNumberIN(sig.stop)}</b>
          </div>
        </div>
        <div class="row" style={{ gap: '8px', marginTop: '12px' }}>
          <button class="btn primary buy grow" type="button" data-testid="idea-practice" onClick={() => openTrade({ key: sig.key, symbol: sig.symbol, side: 'buy', stop: sig.stop, target: sig.target, sellByClose: true, source: 'Best idea' })}>
            Practice buy
          </button>
          <button class="btn grow" type="button" onClick={() => setHow(!how)}>
            Buy in Upstox
          </button>
        </div>
        {how && (
          <ol class="small how-steps">
            <li>
              Upstox → search <b>{sig.symbol}</b> → <b>Buy</b> → <b>Delivery</b>, your own money.
            </li>
            <li>Buy around ₹{formatNumberIN(ltp)}. Skip it if the price has already run up.</li>
            <li>
              Right after: <b>Sell → GTT</b> at ₹{formatNumberIN(sig.stop)} (your safety net).
            </li>
            <li>Sell at the take-profit price or by 3:10 pm. TradeBuddy finds the trade by itself if you are logged in.</li>
          </ol>
        )}
        <button class="link-btn small" type="button" onClick={() => go('daytrade')}>
          Why this idea? All ideas today
        </button>
      </section>
    );
  }
  if (rise && market.phase === 'open') {
    const sym = byKey.get(rise.key)?.trading_symbol ?? rise.key;
    return (
      <section class="idea-card" data-testid="best-idea">
        <div class="idea-head">
          <span class="badge-watch">
            <Icon name="chart" size={16} /> Rising now — watch
          </span>
        </div>
        <div class="idea-symbol">{sym}</div>
        <p class="small muted" style={{ margin: '4px 0 10px' }}>
          {formatPct(rise.fromOpenPct, 1)} since the open, {rise.meter.label.toLowerCase()}
          {rise.pace ? `, ${formatNumberIN(rise.pace, 1)}× the usual trading` : ''}. Not a tested buy idea — quick rises often fall back.
        </p>
        <button class="btn grow" type="button" onClick={() => go('daytrade')}>
          See it on Day trade
        </button>
      </section>
    );
  }
  return (
    <section class="idea-card calm" data-testid="best-idea">
      <div class="radar" aria-hidden="true">
        <span />
      </div>
      <div>
        <b>{market.phase === 'open' ? 'Watching the market…' : 'No buy idea right now'}</b>
        <p class="small muted" style={{ margin: '4px 0 0' }}>
          {market.phase === 'open'
            ? 'Buy ideas appear between 9:30 and 11:30 when a stock breaks out with heavy buying. You get an alert.'
            : 'Ideas come during market hours (9:30–11:30). Practise meanwhile, or read the news.'}
        </p>
      </div>
    </section>
  );
}

function RisingCarousel() {
  const flow = useSessionValue('flow');
  const quotes = useQuotes();
  const byKey = useInstrumentMap();
  const rows = flow?.rising ?? [];
  if (!rows.length) return null;
  return (
    <section data-testid="rising-carousel">
      <div class="section-title">
        <Icon name="chart" size={18} /> Rising now
      </div>
      <div class="carousel">
        {rows.map((r) => {
          const sym = byKey.get(r.key)?.trading_symbol ?? r.key;
          return <RiseTile key={r.key} sym={sym} k={r.key} ltp={quotes[r.key]?.ltp ?? null} pct={r.fromOpenPct} label={r.meter.label} />;
        })}
      </div>
    </section>
  );
}

function RiseTile({ sym, k, ltp, pct, label }: { sym: string; k: string; ltp: number | null; pct: number; label: Parameters<typeof meterTone>[0] }) {
  const flash = useFlash(ltp);
  return (
    <button type="button" class="rise-tile" onClick={() => openTrade({ key: k, symbol: sym, side: 'buy', sellByClose: true, source: 'Rising now' })}>
      <b>{sym}</b>
      <span class={`price ${flash}`}>{ltp ? `₹${formatNumberIN(ltp)}` : ''}</span>
      <span class="ok-text small">▲ {formatPct(pct, 1, false)}</span>
      <span class={`dot-meter ${meterTone(label)}`}>{label}</span>
    </button>
  );
}

function SetupNudge({ go }: { go: Go }) {
  const secrets = useLocal('secrets');
  const auth = useLocal('auth');
  if (secrets === undefined || secrets.upstoxAnalyticsToken || auth?.status === 'logged_in') return null;
  return (
    <button type="button" class="nudge" data-testid="setup-nudge" onClick={() => go('settings')}>
      <Icon name="shield" />
      <span>
        <b>Connect Upstox for live prices</b>
        <span class="small muted">Paste your Analytics Token once — it only reads prices.</span>
      </span>
      <Icon name="chevron" />
    </button>
  );
}

export function HomeScreen({ go }: { go: Go }) {
  const now = useNow(60_000);
  return (
    <div class="screen home" data-testid="home">
      <header class="home-head">
        <div>
          <div class="muted small">{new Date(now).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata' })}</div>
          <h1>{greeting(now)} 👋</h1>
        </div>
        <MarketPill />
      </header>
      <SetupNudge go={go} />
      <WalletHero go={go} />
      <BestIdea go={go} />
      <RisingCarousel />
      <BreadthCard />
      <div class="quick-grid">
        <button type="button" class="quick" onClick={() => go('daytrade')}>
          <Icon name="bolt" />
          <b>Day trade</b>
          <span>Today's ideas</span>
        </button>
        <button type="button" class="quick" onClick={() => go('swing')}>
          <Icon name="calendar" />
          <b>Hold a few days</b>
          <span>Top picks</span>
        </button>
        <button type="button" class="quick" onClick={() => go('learning')}>
          <Icon name="brain" />
          <b>Self-learning</b>
          <span>How sure it is</span>
        </button>
        <button type="button" class="quick" onClick={() => go('guide')}>
          <Icon name="help" />
          <b>Guide</b>
          <span>The basics</span>
        </button>
      </div>
      <NewsCard limit={4} />
    </div>
  );
}
