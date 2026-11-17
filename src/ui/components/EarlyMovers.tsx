import { useState } from 'preact/hooks';
import type { EarlyRow } from '../../background/risingJobs';
import type { PremarketRow } from '../../background/earlyJobs';
import type { Stage } from '../../early/early';
import { formatINR, formatNumberIN, formatPct, formatTimeIST } from '../../lib/format';
import { errorMessage } from '../../lib/serialize';
import { istDate } from '../../lib/time';
import { callBackground } from '../../shared/messages';
import { updateSettings } from '../../storage/local';
import { useLocal, useMarketState, useNow, useSessionValue, useSettings } from '../hooks';
import { IndexTag } from './ScanList';
import { openTrade } from './TradeSheet';
import { toast } from './Motion';

/**
 * App v1.15 — "🌱 Early Movers — Before the Rally". Stocks getting ready to rise, found BEFORE the big
 * move: a potential setup (coiling under resistance with unusual volume), a breakout the moment a live
 * price crosses (not confirmed yet), and the confirmation when the 5-minute candle closes above. Each
 * with the numbers behind it, news and NSE deal data when there are any, a plan sized for your capital
 * and risk limit (charges included), and the honest past test. Never a guarantee; you place every order.
 */

const STAGE: Record<Stage, { label: string; cls: string }> = {
  setup: { label: '🌱 Potential setup', cls: 'setup' },
  breakout: { label: '🚀 Breakout — live, not confirmed', cls: 'breakout' },
  confirmed: { label: '✅ Confirmed breakout', cls: 'confirmed' },
};

const hhmm = (ms: number) => formatTimeIST(ms).slice(0, 5);
const x = (v: number | null) => (v === null ? '—' : `${v.toFixed(1)}×`);
const rs = (v: number) => `₹${formatNumberIN(v)}`;
const lakh = (q: number) => (q >= 100_000 ? `${(q / 100_000).toFixed(2)} lakh` : formatNumberIN(q, 0));

type View = 'all' | 'setup' | 'breakouts';

export function EarlyMoversCard() {
  const early = useSessionValue('early');
  const pre = useSessionValue('premarket');
  const settings = useSettings();
  const market = useMarketState();
  const now = useNow(2_000);
  const [view, setView] = useState<View>('all');
  const today = istDate(now);
  const rows = (early && early.date === today ? early.rows : []).filter((r) => (view === 'setup' ? r.stage === 'setup' : view === 'breakouts' ? r.stage !== 'setup' : true));
  const open = market.phase === 'open';
  const live = !!early && now - early.at < 15_000;
  const capital = settings?.dayTrade.earlyCapitalInr ?? 10_000;
  const maxRisk = settings?.dayTrade.earlyRiskInr ?? 50;
  return (
    <section class="card early-card" data-testid="early-movers">
      <div class="row">
        <h2 style={{ margin: 0 }}>🌱 Early Movers — Before the Rally</h2>
        <span class="spacer" />
        <span class={`live-pill ${open && live ? 'on' : ''}`}>
          <i aria-hidden="true" />
          {open && live ? 'LIVE' : open ? 'WAITING' : 'CLOSED'}
        </span>
      </div>
      <p class="tiny muted" style={{ margin: '4px 0 8px' }}>
        Stocks getting ready to rise <b>before</b> a big move: unusual volume, momentum above the day's average price, pressing under a resistance — then a live breakout and its 5-minute confirmation. Every
        stock of the five indices, on live Upstox prices. <b>Never a guarantee</b> — the app does not place orders.
      </p>
      <MoneyLine capital={capital} maxRisk={maxRisk} />
      <Premarket pre={pre ?? null} now={now} />
      <div class="filter-chips" style={{ margin: '8px 0 6px' }}>
        {(
          [
            ['all', 'All'],
            ['setup', '🌱 Potential setups'],
            ['breakouts', '🚀 Breakouts'],
          ] as Array<[View, string]>
        ).map(([v, label]) => (
          <button type="button" class={`filter-chip ${view === v ? 'on' : ''}`} data-early-view={v} onClick={() => setView(v)}>
            {label}
          </button>
        ))}
      </div>
      {!open && !rows.length ? (
        <p class="small muted">Live from 9:20 to 2:30 on market days. Before the open, the catalysts and gap-ups above.</p>
      ) : rows.length === 0 ? (
        <p class="small muted" data-testid="early-empty">
          No stock meets all the conditions right now — that is normal; most minutes have none. You get an alert the moment one does.
        </p>
      ) : (
        <div class="early-list">
          {rows.map((r) => (
            <EarlyItem r={r} now={now} key={r.key} />
          ))}
        </div>
      )}
      {early && early.date === today && (
        <p class="tiny muted" style={{ margin: '6px 0 0' }} data-testid="early-removed">
          Updated {formatTimeIST(early.at)}. Not shown: {early.expired} expired today (no breakout in time, false breakout, ran too far), {early.tooRisky} where ₹{early.maxRisk} risk with charges
          was not enough, {early.badNews} with bad news.
        </p>
      )}
      <EarlyTestLine />
      <DataLimits />
    </section>
  );
}

function MoneyLine({ capital, maxRisk }: { capital: number; maxRisk: number }) {
  const [cap, setCap] = useState('');
  const save = () => {
    const v = Math.round(Number(cap.replace(/[^0-9.]/g, '')));
    if (!(v >= 1_000)) return toast('Enter at least ₹1,000', 'err');
    void updateSettings({ dayTrade: { earlyCapitalInr: v } }).then(() => setCap(''));
  };
  return (
    <div class="early-money small" data-testid="early-money">
      <span>
        Capital <b>{formatINR(capital, 0)}</b> · most risk per trade <b>₹{maxRisk}</b> including brokerage and all charges. Quantities are worked out from these; a trade that cannot keep the limit is not shown.
      </span>
      <div class="row" style={{ gap: '6px', flexWrap: 'wrap', marginTop: '6px' }}>
        {[50, 100, 200].map((r) => (
          <button type="button" class={`filter-chip ${maxRisk === r ? 'on' : ''}`} data-early-risk={r} onClick={() => void updateSettings({ dayTrade: { earlyRiskInr: r } })}>
            ₹{r}
          </button>
        ))}
        <input type="text" inputMode="numeric" placeholder="capital ₹" value={cap} data-field="early-capital" style={{ width: '110px' }} onInput={(e) => setCap((e.currentTarget as HTMLInputElement).value)} />
        <button class="btn small" type="button" disabled={!cap} onClick={save}>
          Set capital
        </button>
      </div>
    </div>
  );
}

/** Before the open (and all day): good catalysts since yesterday's close and the opening gaps. */
function Premarket({ pre, now }: { pre: { at: number; opened: boolean; rows: PremarketRow[]; newsAt: number | null; newsAsked: number; newsError: string | null } | null; now: number }) {
  const [open, setOpen] = useState(false);
  if (!pre || istDate(pre.at) !== istDate(now)) return null;
  const rows = pre.rows;
  return (
    <details class="early-pre" data-testid="early-premarket" open={!pre.opened || open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary class="small">
        <b>{pre.opened ? 'Catalysts & gap-ups today' : 'Before the open: catalysts & pre-open moves'}</b> <span class="muted">({rows.length})</span>
      </summary>
      {rows.length === 0 ? (
        <p class="tiny muted">No good news since yesterday's close and no gap-up yet.</p>
      ) : (
        <div class="early-pre-list">
          {rows.slice(0, 15).map((r) => (
            <div class="early-pre-row" data-symbol={r.symbol}>
              <div class="row" style={{ gap: '6px', flexWrap: 'wrap' }}>
                <b>{r.symbol}</b>
                <IndexTag index={r.index} k={r.key} />
                {r.gapPct !== null && (
                  <span class={`chip ${r.gapPct >= 0 ? 'early-gap' : 'flag'}`}>
                    {r.gapKind === 'pre-open' ? 'pre-open ' : 'gap '}
                    {formatPct(r.gapPct, 1)}
                  </span>
                )}
                <span class="spacer" />
                {r.price !== null && <span class="small">{rs(r.price)}</span>}
              </div>
              {r.catalyst && (
                <div class="tiny">
                  📰 <span class={r.catalyst.tone === 'good' ? 'ok-text' : r.catalyst.tone === 'bad' ? 'err-text' : ''}>{r.catalyst.kind}</span>: {r.catalyst.heading}{' '}
                  <span class="muted">({istDate(r.catalyst.at) === istDate(now) ? hhmm(r.catalyst.at) : istDate(r.catalyst.at).slice(5)})</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <p class="tiny muted" style={{ margin: '4px 0 0' }}>
        News: Upstox headlines for every stock, last read {pre.newsAt ? `${hhmm(pre.newsAt)} (${pre.newsAsked} stocks)` : 'not yet'}
        {pre.newsError ? ` — ${pre.newsError}` : ''}. Pre-open prices (9:00–9:15) are indicative; the real gap is known at 9:15.
      </p>
    </details>
  );
}

function EarlyItem({ r, now }: { r: EarlyRow; now: number }) {
  const [how, setHow] = useState(false);
  const st = STAGE[r.stage];
  const p = r.plan;
  const age = Math.max(0, Math.round((now - r.since) / 60_000));
  return (
    <div class={`early-item ${st.cls}`} data-symbol={r.symbol} data-stage={r.stage} data-testid="early-item">
      <div class="row" style={{ gap: '6px', flexWrap: 'wrap' }}>
        <span class={`chip early-stage ${st.cls}`}>{st.label}</span>
        <span class="spacer" />
        <span class="chip early-score" title="How many independent signs agree (fixed points, not a chance of rising)">
          score {r.score}/100
        </span>
      </div>
      <div class="row" style={{ gap: '6px', flexWrap: 'wrap', marginTop: '4px' }}>
        <b class="bt-sym">{r.name}</b>
        <span class="tiny muted">NSE: {r.symbol}</span>
        <IndexTag index={r.index} k={r.key} />
        <span class="spacer" />
        <b>{rs(r.price)}</b>
        <span class={`ch-pill ${r.changePct >= 0 ? 'up' : 'down'}`}>{formatPct(r.changePct, 1)}</span>
      </div>
      <div class="idea-grid sig-grid four early-facts">
        <div>
          <span>Rel. volume</span>
          <b>{x(r.rvolDay)}</b>
          <small class="muted">last 5 min {x(r.rvolBar)}</small>
        </div>
        <div>
          <span>VWAP</span>
          <b>{rs(r.vwap)}</b>
          <small class="muted">{r.price >= r.vwap ? 'price above' : 'price below'}</small>
        </div>
        <div>
          <span>RSI (5-min)</span>
          <b>{r.rsi === null ? '—' : r.rsi.toFixed(0)}</b>
        </div>
        <div>
          <span>EMA 9 (5-min)</span>
          <b>{rs(r.ema9)}</b>
        </div>
      </div>
      <div class="tiny early-cat" data-testid="early-catalyst">
        {r.catalyst ? (
          <>
            📰 <span class={r.catalyst.tone === 'good' ? 'ok-text' : ''}>{r.catalyst.kind}</span>: {r.catalyst.heading} <span class="muted">({hhmm(r.catalyst.at)}, Upstox news)</span>
          </>
        ) : (
          <span class="muted">📰 No headline since yesterday's close in Upstox news.</span>
        )}
      </div>
      <div class="tiny muted" data-testid="early-inst">
        🏦{' '}
        {r.deals.length
          ? r.deals.map((d) => `${d.kind} deal ${d.side} ${lakh(d.qty)} shares — ${d.client} (${d.date})`).join('; ')
          : 'No NSE bulk/block deal in the latest file'}
        {r.delivery ? ` · delivery ${r.delivery.pct.toFixed(0)}% (${r.delivery.date})` : ' · delivery: not available'} · FII/DII: not available
      </div>
      <div class="idea-grid sig-grid four early-plan" data-testid="early-plan">
        <div>
          <span>Breakout above</span>
          <b>{rs(p.breakout)}</b>
        </div>
        <div>
          <span>Entry</span>
          <b>{rs(p.entry)}</b>
        </div>
        <div>
          <span>Stop-loss</span>
          <b class="err-text">{rs(p.stop)}</b>
        </div>
        <div>
          <span>Targets</span>
          <b class="ok-text">{rs(p.t1)}</b>
          <small class="ok-text">{rs(p.t2)}</small>
        </div>
      </div>
      <div class="small sig-flow" data-testid="early-size">
        <b>{r.size.qty} shares</b> ({formatINR(r.size.value, 0)}) · most you lose ≈ <span class="err-text">₹{r.size.risk.toFixed(0)}</span> incl. ₹{r.size.charges.toFixed(0)} charges · at both targets after
        charges <span class="ok-text">+₹{r.size.reward.toFixed(0)}</span>
      </div>
      <div class="reason-chips">
        {r.reasons.map((w) => (
          <span class="reason-pill">{w}</span>
        ))}
        {r.warnings.map((w) => (
          <span class="reason-pill warn">⚠ {w}</span>
        ))}
      </div>
      <div class="tiny muted">
        {r.stage === 'setup' ? `Setup since ${hhmm(r.since)} (${age} min)` : ''}
        {r.breakAt ? `Broke out ${hhmm(r.breakAt)}` : ''}
        {r.confirmedAt ? ` · confirmed ${hhmm(r.confirmedAt)}` : ''}
        {r.industry ? ` · ${r.industry}` : ''}
      </div>
      <div class="row" style={{ gap: '8px', marginTop: '6px' }}>
        {r.stage !== 'setup' && (
          <button class="btn small buy" type="button" data-testid="early-practice" onClick={() => openTrade({ key: r.key, symbol: r.symbol, side: 'buy', qty: r.size.qty, stop: p.stop, target: p.t2, sellByClose: true, product: 'intraday', source: 'Early Movers' })}>
            Practice buy
          </button>
        )}
        <button class="btn small" type="button" onClick={() => setHow(!how)}>
          How in Upstox
        </button>
      </div>
      {how && (
        <ol class="small how-steps">
          {r.stage === 'setup' ? (
            <li>
              Not broken out yet: Upstox → <b>{r.symbol}</b> → <b>Buy</b> → <b>Intraday</b> → <b>{r.size.qty}</b> shares → order type <b>SL</b>, trigger ₹{formatNumberIN(p.breakout)}, limit ₹
              {formatNumberIN(Math.ceil(p.breakout * 1.002 * 20) / 20)} — it buys only if the price breaks out.
            </li>
          ) : (
            <li>
              Upstox → <b>{r.symbol}</b> → <b>Buy</b> → <b>Intraday</b> → <b>{r.size.qty}</b> shares → Limit ₹{formatNumberIN(p.entry)} (skip it if the price has already run far above).
            </li>
          )}
          <li>
            Right after the buy: <b>Sell</b> → Intraday → <b>Stop-loss</b>, trigger ₹{formatNumberIN(p.stop)}.
          </li>
          <li>
            Sell half at ₹{formatNumberIN(p.t1)} (then move the stop-loss up to your buy price), the rest at ₹{formatNumberIN(p.t2)} — or everything by 3:10 pm.
          </li>
        </ol>
      )}
    </div>
  );
}

/** The past test, as it came out (the rules were fixed before testing; nothing tuned to past winners). */
function EarlyTestLine() {
  const t = useLocal('earlyTest');
  const [busy, setBusy] = useState(false);
  const run = () => {
    setBusy(true);
    void callBackground('early:test')
      .then((r) => toast(r.ok ? `Tested on ${r.days} days` : 'Not enough 5-minute history yet', r.ok ? 'ok' : 'err'))
      .catch((e: unknown) => toast(errorMessage(e), 'err'))
      .finally(() => setBusy(false));
  };
  const g = (n: string, v: { trades: number; wins: number; t1: number; pnl: number; avg: number }) => (
    <li>
      <b>{n}</b>: {v.trades} trades, {v.trades ? Math.round((v.t1 / v.trades) * 100) : 0}% reached target 1, {v.trades ? Math.round((v.wins / v.trades) * 100) : 0}% made money · total{' '}
      <span class={v.pnl >= 0 ? 'ok-text' : 'err-text'}>{v.pnl >= 0 ? '+' : '−'}₹{Math.abs(Math.round(v.pnl)).toLocaleString('en-IN')}</span> ({v.avg >= 0 ? '+' : '−'}₹{Math.abs(v.avg).toFixed(0)} per trade)
    </li>
  );
  return (
    <div class="small" data-testid="early-test" style={{ marginTop: '8px' }}>
      {!t ? (
        <p class="tiny muted" style={{ margin: 0 }}>
          Past test: runs after the market closes, on the stored 5-minute prices (needs at least 5 market days).
        </p>
      ) : (
        <div class={`verdict ${t.live.pnl > t.late.pnl && t.live.pnl > 0 ? 'pass' : 'fail'}`}>
          <b>Past test on {t.days} market days</b> ({formatNumberIN(t.stockDays, 0)} stock-days, {formatINR(t.capital, 0)} capital, ₹{t.maxRisk} risk with charges):
          <ul class="tiny" style={{ margin: '4px 0', paddingLeft: '18px' }}>
            {g('Early — bought at the live breakout', t.live)}
            {g('Early — bought after the confirmation', t.confirmed)}
            {g('Late chasers (already up 4%+)', t.late)}
            {g('Any rising stock (baseline)', t.baseline)}
          </ul>
          <span class="tiny">
            Older half {t.older.pnl >= 0 ? '+' : '−'}₹{Math.abs(Math.round(t.older.pnl))} ({t.older.trades}) · newer half {t.newer.pnl >= 0 ? '+' : '−'}₹{Math.abs(Math.round(t.newer.pnl))} ({t.newer.trades}). Only the
            price and volume rules can be tested — news, deals and the order book have no stored history. {t.live.pnl <= 0 ? 'On these days the early setups did not make money — use practice only.' : ''}
          </span>
        </div>
      )}
      <button class="btn small" type="button" style={{ marginTop: '6px' }} disabled={busy} data-testid="early-test-run" onClick={run}>
        {busy ? 'Testing…' : 'Run the past test now'}
      </button>
    </div>
  );
}

/** What the data is, how fresh, and what is not available. */
function DataLimits() {
  const feed = useSessionValue('feedStatus');
  const fill = useSessionValue('priceFill');
  const nse = useLocal('nseFiles');
  const cat = useLocal('catalysts');
  const model = useLocal('riseModel');
  const now = useNow(10_000);
  const [busy, setBusy] = useState(false);
  const refresh = () => {
    setBusy(true);
    void callBackground('early:refresh')
      .then((r) => toast(`News read for every stock (${r.catalysts} with news); NSE files ${r.nse ? 'loaded' : 'not available'}`))
      .catch((e: unknown) => toast(errorMessage(e), 'err'))
      .finally(() => setBusy(false));
  };
  const feedLive = !!feed?.connected && now - feed.lastTickAt < 15_000;
  return (
    <details class="small" data-testid="early-limits" style={{ marginTop: '8px' }}>
      <summary>Data, delays and what is not available</summary>
      <ul class="tiny">
        <li>
          <b>Prices:</b>{' '}
          {feedLive
            ? `Upstox live feed (${feed?.full ?? 0} stocks with full details${feed?.ltpc ? `, ${feed.ltpc} prices only` : ''}${feed?.overflow ? `, ${feed.overflow} over Upstox's limit checked by price request every 3 s` : ''})`
            : 'live feed not connected — prices are asked for every few seconds'}
          {fill?.count ? `; ${fill.count} stocks without a tick for 15 s were re-checked` : ''}. Breakouts are checked on each live price (about every 1.5 s); a confirmation waits for the 5-minute candle to close.
        </li>
        <li>
          <b>News / results / orders / upgrades:</b> only Upstox headlines (no live stream, no results database — growth figures only when a headline says so). Read for every stock{' '}
          {cat ? `at ${formatTimeIST(cat.at).slice(0, 5)} on ${istDate(cat.at)} (${cat.asked} stocks)` : '— not yet'}
          {cat?.error ? `; last error: ${cat.error}` : ''}; the stocks that matter most are re-read every 2 minutes.
        </li>
        <li>
          <b>Bulk / block deals, delivery %:</b> NSE end-of-day files —{' '}
          {nse ? `bulk ${nse.bulk.date ?? 'not available'}, block ${nse.block.date ?? 'not available'}, delivery ${nse.delivery.date ?? 'not available'}` : 'not loaded yet'}. Not intraday.
          {nse?.errors.length ? ` Problems: ${nse.errors.join('; ')}.` : ''}
        </li>
        <li>
          <b>FII / DII activity:</b> not available — NSE publishes it only on its website, which apps cannot read.
        </li>
        <li>
          <b>Pre-open (9:00–9:15):</b> indicative only; the real opening gap is known at 9:15.
        </li>
        <li>
          <b>Learned check (Rising now):</b> {model ? `learned ${istDate(model.report.at)}` : 'not learned yet (needs about 10 market days of 5-minute prices)'}.
        </li>
        <li>
          <b>Score:</b> how many independent signs agree, out of 100 — not a chance of rising. The past test above is the only measured record.
        </li>
      </ul>
      <button class="btn small" type="button" disabled={busy} data-testid="early-refresh" onClick={refresh}>
        {busy ? 'Reading…' : 'Read news and NSE files now'}
      </button>
    </details>
  );
}
