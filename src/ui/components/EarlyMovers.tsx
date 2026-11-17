import { useState } from 'preact/hooks';
import type { DriveRow, EarlyRow } from '../../background/risingJobs';
import type { PreRow } from '../../background/preopenJobs';
import { recordSummary } from '../../early/preopen';
import type { EarlyPlan, Size, Stage } from '../../early/early';
import { formatINR, formatNumberIN, formatPct, formatTimeIST } from '../../lib/format';
import { errorMessage } from '../../lib/serialize';
import { istDate } from '../../lib/time';
import { callBackground } from '../../shared/messages';
import { updateSettings } from '../../storage/local';
import { useLocal, useNow, useSessionValue } from '../hooks';
import { openTrade } from './TradeSheet';
import { toast } from './Motion';

/**
 * App v1.15 / v1.16 — the pieces of "🌱 Early Movers" (the card itself is on Home since v1.16, see
 * MoversHome.tsx): the details of a pre-open candidate, an opening-drive stock and a setup / breakout,
 * the capital and risk line, the past test and the data panel. Never a guarantee; you place every order.
 */

export const STAGE: Record<Stage | 'drive' | 'waiting', { label: string; short: string; cls: string }> = {
  setup: { label: '🌱 Potential setup', short: '🌱 Setup', cls: 'setup' },
  breakout: { label: '🚀 Breakout — live, not confirmed', short: '🚀 Breakout', cls: 'breakout' },
  confirmed: { label: '✅ Confirmed breakout', short: '✅ Confirmed', cls: 'confirmed' },
  drive: { label: '⚡ Holding its opening gap', short: '⚡ Holding gap', cls: 'drive' },
  waiting: { label: '⏳ Pre-open pick — not holding yet', short: '⏳ Waiting', cls: 'waiting' },
};

export const hhmm = (ms: number) => formatTimeIST(ms).slice(0, 5);
const x = (v: number | null) => (v === null ? '—' : `${v.toFixed(1)}×`);
export const rs = (v: number) => `₹${formatNumberIN(v)}`;
const lakh = (q: number) => (q >= 100_000 ? `${(q / 100_000).toFixed(2)} lakh` : formatNumberIN(q, 0));

/** Capital and risk per trade (the quantities are worked out from these). */
export function MoneyLine({ capital, maxRisk }: { capital: number; maxRisk: number }) {
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

/** Entry / stop / targets in one row. */
function PlanGrid({ p, label = 'Breakout above' }: { p: EarlyPlan; label?: string }) {
  return (
    <div class="idea-grid sig-grid four early-plan" data-testid="early-plan">
      <div>
        <span>{label}</span>
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
  );
}

function SizeLine({ s }: { s: Size }) {
  return (
    <div class="small sig-flow" data-testid="early-size">
      <b>{s.qty} shares</b> ({formatINR(s.value, 0)}) · most you lose ≈ <span class="err-text">₹{s.risk.toFixed(0)}</span> incl. ₹{s.charges.toFixed(0)} charges · at both targets after charges{' '}
      <span class="ok-text">+₹{s.reward.toFixed(0)}</span>
    </div>
  );
}

function Pills({ reasons, warnings, missing = [] }: { reasons: string[]; warnings: string[]; missing?: string[] }) {
  if (!reasons.length && !warnings.length && !missing.length) return null;
  return (
    <div class="reason-chips">
      {reasons.map((w) => (
        <span class="reason-pill">{w}</span>
      ))}
      {missing.map((w) => (
        <span class="reason-pill against">✗ {w}</span>
      ))}
      {warnings.map((w) => (
        <span class="reason-pill warn">⚠ {w}</span>
      ))}
    </div>
  );
}

function CatalystLine({ c, now }: { c: EarlyRow['catalyst']; now: number }) {
  return (
    <div class="tiny early-cat" data-testid="early-catalyst">
      {c ? (
        <>
          📰 <span class={c.tone === 'good' ? 'ok-text' : c.tone === 'bad' ? 'err-text' : ''}>{c.kind}</span>: {c.heading} <span class="muted">({istDate(c.at) === istDate(now) ? hhmm(c.at) : istDate(c.at).slice(5)}, Upstox news)</span>
        </>
      ) : (
        <span class="muted">📰 No headline since yesterday's close in Upstox news.</span>
      )}
    </div>
  );
}

/** "Practice buy" and the steps to place it yourself in Upstox. */
function TradeButtons({ symbol, k, qty, p, armed, source }: { symbol: string; k: string; qty: number; p: EarlyPlan; armed: boolean; source: string }) {
  const [how, setHow] = useState(false);
  return (
    <>
      <div class="row" style={{ gap: '8px', marginTop: '8px' }}>
        {armed && (
          <button class="btn small buy" type="button" data-testid="early-practice" onClick={() => openTrade({ key: k, symbol, side: 'buy', qty, stop: p.stop, target: p.t2, sellByClose: true, product: 'intraday', source })}>
            Practice buy
          </button>
        )}
        <button class="btn small" type="button" onClick={() => setHow(!how)}>
          How in Upstox
        </button>
      </div>
      {how && (
        <ol class="small how-steps">
          {p.breakout > p.entry - 0.001 || !armed ? (
            <li>
              Upstox → <b>{symbol}</b> → <b>Buy</b> → <b>Intraday</b> → <b>{qty}</b> shares → order type <b>SL</b>, trigger ₹{formatNumberIN(p.breakout)}, limit ₹{formatNumberIN(Math.ceil(p.breakout * 1.002 * 20) / 20)} — it buys
              only if the price goes above ₹{formatNumberIN(p.breakout)}.
            </li>
          ) : (
            <li>
              Upstox → <b>{symbol}</b> → <b>Buy</b> → <b>Intraday</b> → <b>{qty}</b> shares → Limit ₹{formatNumberIN(p.entry)} (skip it if the price has already run far above).
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
    </>
  );
}

/** A setup / live breakout / confirmed breakout (app v1.15), opened from its row. */
export function EarlyDetail({ r, now }: { r: EarlyRow; now: number }) {
  const age = Math.max(0, Math.round((now - r.since) / 60_000));
  return (
    <div class="mv-detail" data-testid="early-detail">
      <div class="tiny muted">
        {r.name} · NSE: {r.symbol}
        {r.industry ? ` · ${r.industry}` : ''}
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
      <PlanGrid p={r.plan} />
      <SizeLine s={r.size} />
      <Pills reasons={r.reasons} warnings={r.warnings} />
      <CatalystLine c={r.catalyst} now={now} />
      <div class="tiny muted" data-testid="early-inst">
        🏦{' '}
        {r.deals.length ? r.deals.map((d) => `${d.kind} deal ${d.side} ${lakh(d.qty)} shares — ${d.client} (${d.date})`).join('; ') : 'No NSE bulk/block deal in the latest file'}
        {r.delivery ? ` · delivery ${r.delivery.pct.toFixed(0)}% (${r.delivery.date})` : ' · delivery: not available'} · FII/DII: not available
      </div>
      <div class="tiny muted">
        {r.stage === 'setup' ? `Setup since ${hhmm(r.since)} (${age} min)` : ''}
        {r.breakAt ? `Broke out ${hhmm(r.breakAt)}` : ''}
        {r.confirmedAt ? ` · confirmed ${hhmm(r.confirmedAt)}` : ''} · score {r.score}/100 (points, not a chance)
      </div>
      <TradeButtons symbol={r.symbol} k={r.key} qty={r.size.qty} p={r.plan} armed={r.stage !== 'setup'} source="Early Movers" />
    </div>
  );
}

/** A stock holding its opening gap (or a final pre-open pick still waiting), opened from its row. */
export function DriveDetail({ r, now }: { r: DriveRow; now: number }) {
  return (
    <div class="mv-detail" data-testid="drive-detail">
      <div class="tiny muted">
        {r.name} · NSE: {r.symbol}
        {r.industry ? ` · ${r.industry}` : ''}
        {r.preRank ? ` · #${r.preRank} on the final pre-open list (score ${r.preScore})` : ''}
      </div>
      <div class="idea-grid sig-grid four early-facts">
        <div>
          <span>Opened</span>
          <b>{formatPct(r.gapPct, 1)}</b>
          <small class="muted">at {rs(r.open)}</small>
        </div>
        <div>
          <span>Since the open</span>
          <b>{formatPct(r.fromOpenPct, 2)}</b>
        </div>
        <div>
          <span>Volume pace</span>
          <b>{x(r.pace)}</b>
          <small class="muted">vs usual by now</small>
        </div>
        <div>
          <span>VWAP</span>
          <b>{r.vwap ? rs(r.vwap) : '—'}</b>
          <small class="muted">{r.buyShare !== null ? `buyers ${Math.round(r.buyShare * 100)}%` : 'buyers —'}</small>
        </div>
      </div>
      {r.state === 'holding' ? (
        <>
          <PlanGrid p={r.plan} label="Buy above" />
          <SizeLine s={r.size} />
        </>
      ) : (
        <p class="tiny muted" style={{ margin: '6px 0' }}>
          Not a buy yet — it is listed because it was on the final pre-open list. It turns into a plan the moment it holds above its open with heavy volume.
        </p>
      )}
      <Pills reasons={r.reasons} warnings={r.warnings} missing={r.missing} />
      <CatalystLine c={r.catalyst} now={now} />
      <div class="tiny muted">
        {r.since ? `Holding since ${hhmm(r.since)}` : 'Waiting'} · score {r.score}/100 (points, not a chance)
      </div>
      {r.state === 'holding' && <TradeButtons symbol={r.symbol} k={r.key} qty={r.size.qty} p={r.plan} armed source="Opening drive" />}
    </div>
  );
}

/** A pre-open candidate, opened from its row: every point and the number behind it. */
export function PreDetail({ r }: { r: PreRow }) {
  return (
    <div class="mv-detail" data-testid="pre-detail">
      <div class="tiny muted">
        {r.name} · NSE: {r.symbol}
        {r.industry ? ` · ${r.industry}` : ''} · yesterday {rs(r.prevClose)}
      </div>
      <div class="pre-parts" data-testid="pre-parts">
        {r.parts.map((p) => (
          <div class="pre-part" data-part={p.id}>
            <div class="row">
              <span class="small">{p.label}</span>
              <span class="spacer" />
              <b class="small">
                {Math.round(p.pts)}/{p.max}
              </b>
            </div>
            <div class="pre-bar" aria-hidden="true">
              <i style={{ width: `${Math.round((p.pts / p.max) * 100)}%` }} />
            </div>
            <div class="tiny muted">{p.text}</div>
          </div>
        ))}
      </div>
      <Pills reasons={[]} warnings={r.warnings} />
      <div class="tiny muted" data-testid="pre-auction">
        Upstox pre-open: matched {r.ieq === null ? '—' : lakh(r.ieq)} shares at {rs(r.iep)}
        {r.imb !== null ? ` · unmatched ${lakh(Math.abs(r.imb))} (Upstox does not say which side, so the score uses waiting buy vs sell)` : ' · unmatched: not given'}
        {r.rp ? ` · reference price ${rs(r.rp)}` : ''} · {r.readings} readings ({r.src === 'feed' ? 'live feed' : 'quotes API'})
      </div>
      <div class="small sig-flow" data-testid="pre-estimate">
        {r.estimate.ok ? (
          <>
            First estimate: about <b>{r.estimate.qty} shares</b> near {rs(r.estimate.entry)} with a stop near {rs(r.estimate.stop)} keeps ₹{Math.round(r.estimate.risk)} risk incl. charges. The real plan is made after 9:15 —
            buy only if it holds above its opening price.
          </>
        ) : (
          <>Your risk limit cannot be kept here: {r.estimate.why}.</>
        )}
      </div>
      {r.catalyst && (
        <div class="tiny early-cat">
          📰 <span class={r.catalyst.tone === 'good' ? 'ok-text' : ''}>{r.catalyst.kind}</span>: {r.catalyst.heading}
        </div>
      )}
    </div>
  );
}

/** The past tests and the pre-open record, as they came out (rules fixed before testing; nothing tuned). */
export function EarlyTestLine() {
  const t = useLocal('earlyTest');
  const rec = useLocal('preopenRecord');
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
  const s = recordSummary(rec);
  return (
    <div class="small" data-testid="early-test" style={{ marginTop: '8px' }}>
      <p class="tiny" style={{ margin: '0 0 6px' }} data-testid="pre-record">
        <b>Pre-open record:</b>{' '}
        {s.stocks
          ? `${s.days} day${s.days === 1 ? '' : 's'} since ${s.since}: ${s.upFirst} of ${s.stocks} final picks rose 1% above their open before falling 1% below it; on average ${s.avg945! >= 0 ? '+' : '−'}${Math.abs(s.avg945!).toFixed(2)}% at 9:45 vs the open.`
          : 'starts with the first morning the app is open during the pre-open — each day’s final 10 and their first 30 minutes are written down here. Upstox keeps no past pre-open data, so this record is the only honest test of the ranking.'}
      </p>
      {!t ? (
        <p class="tiny muted" style={{ margin: 0 }}>
          Past test: runs after the market closes, on the stored 5-minute prices (needs at least 5 market days).
        </p>
      ) : (
        <div class={`verdict ${t.live.pnl > t.late.pnl && t.live.pnl > 0 ? 'pass' : 'fail'}`}>
          <b>Past test on {t.days} market days</b> ({formatNumberIN(t.stockDays, 0)} stock-days, {formatINR(t.capital, 0)} capital, ₹{t.maxRisk} risk with charges):
          <ul class="tiny" style={{ margin: '4px 0', paddingLeft: '18px' }}>
            {t.open && g(`Opening drive — gap-up held its first candle (${t.open.gapDays} gap-up days)`, t.open.drive)}
            {t.open && g('Any gap-up bought at 9:20 (baseline)', t.open.anyGap)}
            {g('Early — bought at the live breakout', t.live)}
            {g('Early — bought after the confirmation', t.confirmed)}
            {g('Late chasers (already up 4%+)', t.late)}
            {g('Any rising stock (baseline)', t.baseline)}
          </ul>
          <span class="tiny">
            Breakouts: older half {t.older.pnl >= 0 ? '+' : '−'}₹{Math.abs(Math.round(t.older.pnl))} ({t.older.trades}) · newer half {t.newer.pnl >= 0 ? '+' : '−'}₹{Math.abs(Math.round(t.newer.pnl))} ({t.newer.trades})
            {t.open ? ` · opening drive: older ${t.open.older.pnl >= 0 ? '+' : '−'}₹${Math.abs(Math.round(t.open.older.pnl))} (${t.open.older.trades}), newer ${t.open.newer.pnl >= 0 ? '+' : '−'}₹${Math.abs(Math.round(t.open.newer.pnl))} (${t.open.newer.trades})` : ''}. Only the
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
export function DataLimits() {
  const feed = useSessionValue('feedStatus');
  const fill = useSessionValue('priceFill');
  const pre = useSessionValue('preopen');
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
  const today = istDate(now);
  return (
    <div data-testid="early-limits">
      <ul class="tiny" style={{ paddingLeft: '18px' }}>
        <li>
          <b>Pre-open (9:00–9:15):</b> Upstox's indicative opening price (IEP), the quantity matching there, the unmatched quantity and the waiting buy / sell quantities — read every ~15 s from Full Market
          Quotes V3 and in between from the live feed.
          {pre && pre.date === today
            ? ` Today: ${pre.counts.withIep} of ${pre.counts.scanned} stocks had a pre-open price${pre.quoteAt ? `, last read ${formatTimeIST(pre.quoteAt)}` : ''}${pre.quoteError ? ` — problem: ${pre.quoteError}` : ''}${pre.status ? `; Upstox status ${pre.status.status}` : ''}.`
            : ''}{' '}
          They are indicative: orders can be changed or cancelled until 9:07–9:08, and the real gap is known at 9:15.
        </li>
        <li>
          <b>Prices:</b>{' '}
          {feedLive
            ? `Upstox live feed (${feed?.full ?? 0} stocks with full details${feed?.ltpc ? `, ${feed.ltpc} prices only` : ''}${feed?.overflow ? `, ${feed.overflow} over Upstox's limit checked by price request every 3 s` : ''})`
            : 'live feed not connected — prices are asked for every few seconds'}
          {fill?.count ? `; ${fill.count} stocks without a tick for 15 s were re-checked` : ''}. From 9:15 the opening drive is read on each live price; setups and breakouts from 9:20 (they need a finished
          5-minute candle); a confirmation waits for the 5-minute candle to close.
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
          <b>Learned check (Rising now):</b> {model ? `learned ${istDate(model.report.at)}` : 'not learned yet (needs about 10 market days of 5-minute prices)'}.
        </li>
        <li>
          <b>Score:</b> how many independent signs agree, out of 100 — not a chance of rising. The pre-open record and the past test are the only measured results.
        </li>
      </ul>
      <button class="btn small" type="button" disabled={busy} data-testid="early-refresh" onClick={refresh}>
        {busy ? 'Reading…' : 'Read news and NSE files now'}
      </button>
    </div>
  );
}
