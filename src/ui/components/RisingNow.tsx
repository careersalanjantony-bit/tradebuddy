import { useState } from 'preact/hooks';
import type { HeldRow, RiseRow } from '../../background/risingJobs';
import type { MeterLabel } from '../../data/flow';
import { PLAN, type RiseReport, type RiseTag } from '../../rising/momentum';
import { formatINR, formatNumberIN, formatPct, formatTimeIST } from '../../lib/format';
import { errorMessage } from '../../lib/serialize';
import { callBackground } from '../../shared/messages';
import { useLocal, useMarketState, useNow, useSessionValue, useSettings } from '../hooks';
import { openTrade } from './TradeSheet';
import { IndexTag } from './ScanList';
import { toast } from './Motion';
import { suggestionRecord } from '../../early/early';

export const meterTone = (l: MeterLabel): string => (l === 'Buyers strong' || l === 'More buyers' ? 'good' : l === 'Sellers strong' || l === 'More sellers' ? 'bad' : 'neutral');

/**
 * App v1.14 — "📈 Rising now — live" (owner: "we made money only from Rising today: buy a strongly
 * rising stock, hold 10–20 minutes, sell; list them earlier, and tag whether to keep it"). Every stock
 * is read on each live price; the tag comes from the model learned on past days and says how often
 * similar moments kept rising on days it never saw. Never "100 %", never "confirmed".
 */

export const TAG_TEXT: Record<RiseTag, { label: string; cls: string }> = {
  strong: { label: '▲ Likely to keep rising', cls: 'strong' },
  unclear: { label: '◆ Unclear', cls: 'unclear' },
  fading: { label: '▼ Slowing', cls: 'fading' },
};

const hhmm = (ms: number) => formatTimeIST(ms).slice(0, 5);
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** The tag chip, with how often similar moments really kept rising. */
export function RiseChip({ tag, measured }: { tag: RiseTag; measured: number | null }) {
  const t = TAG_TEXT[tag];
  return (
    <span class={`chip rise-tag ${t.cls}`} data-testid="rise-tag" data-tag={tag} title="How similar moments did on past days the app did not learn from — not a promise">
      {t.label}
      {measured !== null && tag !== 'fading' ? ` · ${Math.round(measured * 100)}/100` : ''}
    </span>
  );
}

type View = 'all' | 'early' | 'strong';

export function RisingNowCard() {
  const rise = useSessionValue('rise');
  const model = useLocal('riseModel');
  const market = useMarketState();
  const now = useNow(2_000);
  const [view, setView] = useState<View>('all');
  const open = market.phase === 'open';
  const today = rise && rise.date === new Date(now + 5.5 * 3600_000).toISOString().slice(0, 10);
  const rows = (today ? rise.rows : []).filter((r) => (view === 'early' ? r.early && r.tag !== 'fading' : view === 'strong' ? r.tag === 'strong' : true));
  const held = today ? rise.held : [];
  const live = !!rise && now - rise.at < 15_000;
  // money per quick trade: your amount split like the day trades (no borrowing)
  const settings = useSettings();
  const slots = settings ? Math.max(1, Math.min(5, Math.round(settings.risk.sizing === 'split' ? settings.risk.splitInto : settings.risk.maxOpenTrades))) : 1;
  const perTrade = settings?.risk.capitalInr ? settings.risk.capitalInr / slots : null;
  return (
    <section class="card rise-card" data-testid="rising-now">
      <div class="row">
        <h2 style={{ margin: 0 }}>📈 Rising now — live</h2>
        <span class="spacer" />
        <span class={`live-pill ${open && live ? 'on' : ''}`}>
          <i aria-hidden="true" />
          {open && live ? 'LIVE' : open ? 'WAITING' : 'CLOSED'}
        </span>
      </div>
      <p class="tiny muted" style={{ margin: '4px 0 8px' }}>
        Every stock of the five indices is read on each live price. The tag says whether a stock is <b>likely to keep rising</b> for the next 20 minutes: how often similar moments gained{' '}
        {PLAN.target * 100}% before losing {PLAN.stop * 100}% on past days the app did not learn from. Never a promise — protect every trade.
      </p>
      <MarketGateBanner />
      <SuggestionRecordLine />
      {held.length > 0 && <HeldList held={held} />}
      <div class="filter-chips" style={{ margin: '6px 0' }}>
        {(
          [
            ['all', 'All rising'],
            ['early', 'Just starting (< 1%)'],
            ['strong', '▲ Likely only'],
          ] as Array<[View, string]>
        ).map(([v, label]) => (
          <button type="button" class={`filter-chip ${view === v ? 'on' : ''}`} data-rise-view={v} onClick={() => setView(v)}>
            {label}
          </button>
        ))}
      </div>
      {!open && !rows.length ? (
        <p class="small muted">Live from 9:15 on market days. Quick trades from 9:30 to 2:45 (closed by 3:10).</p>
      ) : rows.length === 0 ? (
        <p class="small muted" data-testid="rise-empty">
          {rise ? (view === 'all' ? 'No stock is rising clearly right now.' : 'None right now in this view.') : 'Starting — reading the live prices…'}
          {rise && rise.loaded < rise.scanned ? ` Today's candles loaded for ${formatNumberIN(rise.loaded, 0)} of ${formatNumberIN(rise.scanned, 0)} stocks.` : ''}
        </p>
      ) : (
        <div class="rise-list">
          {rows.map((r) => (
            <RiseItem r={r} now={now} perTrade={perTrade} key={r.key} />
          ))}
        </div>
      )}
      {rise && (
        <p class="tiny muted" style={{ margin: '6px 0 0' }} data-testid="rise-status">
          Read {formatTimeIST(rise.at)} · {formatNumberIN(rise.scanned, 0)} stocks{rise.loaded < rise.scanned ? ` (${formatNumberIN(rise.loaded, 0)} with today's candles)` : ''}.
        </p>
      )}
      <ModelLine report={model?.report ?? null} />
    </section>
  );
}

function RiseItem({ r, now, perTrade }: { r: RiseRow; now: number; perTrade: number | null }) {
  const [how, setHow] = useState(false);
  const p = r.plan;
  const qty = perTrade ? Math.floor(perTrade / r.price) : 0;
  const sinceUp = r.sincePrice ? (r.price / r.sincePrice - 1) * 100 : null;
  const late = now > p.sellBy - 15 * 60_000 + 60_000 && r.since !== null && now - r.since > 10 * 60_000;
  return (
    <div class={`rise-item ${r.tag}`} data-symbol={r.symbol} data-testid="rise-item">
      <div class="row" style={{ gap: '6px', flexWrap: 'wrap' }}>
        <b class="bt-sym">{r.symbol}</b>
        <IndexTag index={r.index} k={r.key} />
        <RiseChip tag={r.tag} measured={r.measured} />
        {r.early && r.tag !== 'fading' && <span class="chip early">just starting</span>}
        <span class="spacer" />
        <b>₹{formatNumberIN(r.price)}</b>
        <span class={`ch-pill ${r.fromOpenPct >= 0 ? 'up' : 'down'}`}>{formatPct(r.fromOpenPct, 1)}</span>
      </div>
      {r.reasons.length > 0 && (
        <div class="reason-chips">
          {r.reasons.map((x) => (
            <span class="reason-pill">{x}</span>
          ))}
        </div>
      )}
      {r.tag !== 'fading' && (
        <div class="small sig-flow" data-testid="rise-plan">
          Quick trade: buy ~₹{formatNumberIN(p.entry)}{qty >= 1 ? ` (${qty} shares for ${formatINR(qty * r.price, 0)})` : ''} · take profit <span class="ok-text">₹{formatNumberIN(p.target)}</span> (+{PLAN.target * 100}%) · stop <span class="err-text">₹{formatNumberIN(p.stop)}</span> (−{PLAN.stop * 100}%) · sell by{' '}
          {hhmm(p.sellBy)}
        </div>
      )}
      <div class="tiny muted">
        {r.since !== null && r.sincePrice !== null ? `Likely since ${hhmm(r.since)} at ₹${formatNumberIN(r.sincePrice)} (${sinceUp !== null && sinceUp >= 0 ? '+' : ''}${(sinceUp ?? 0).toFixed(2)}% since)` : ''}
        {late ? ' · it has been rising for a while — a late buy is riskier' : ''}
        {r.since !== null ? ' · ' : ''}
        {formatPct(r.changePct, 1)} today
      </div>
      {r.tag !== 'fading' && (
        <div class="row" style={{ gap: '8px', marginTop: '6px' }}>
          <button class="btn small buy" type="button" data-testid="rise-practice" onClick={() => openTrade({ key: r.key, symbol: r.symbol, side: 'buy', ...(qty >= 1 ? { qty } : {}), stop: p.stop, target: p.target, sellByClose: true, product: 'intraday', source: 'Rising now' })}>
            Practice buy
          </button>
          <button class="btn small" type="button" onClick={() => setHow(!how)}>
            How in Upstox
          </button>
        </div>
      )}
      {how && (
        <ol class="small how-steps">
          <li>
            Upstox → <b>{r.symbol}</b> → <b>Buy</b> → <b>Intraday</b>{qty >= 1 ? <> → <b>{qty}</b> shares</> : null} → Limit ₹{formatNumberIN(p.entry)} (or Market if it is still near).
          </li>
          <li>
            Right after: <b>Sell</b> → Intraday → <b>Stop-loss</b>, trigger ₹{formatNumberIN(p.stop)}.
          </li>
          <li>
            Sell at ₹{formatNumberIN(p.target)} or by <b>{hhmm(p.sellBy)}</b> — keep longer only while this tag says "Likely to keep rising" (the app tells you where to protect the profit).
          </li>
        </ol>
      )}
    </div>
  );
}

/** Stocks you hold: keep, protect the profit, or take it. */
function HeldList({ held }: { held: HeldRow[] }) {
  return (
    <div class="rise-held" data-testid="rise-held">
      <b class="small">Your stocks now</b>
      {held.map((h) => {
        const pnl = (h.price - h.buyPrice) * h.qty;
        return (
          <div class={`rise-held-row ${h.action}`} data-symbol={h.symbol}>
            <div class="row" style={{ gap: '6px', flexWrap: 'wrap' }}>
              <b>{h.symbol}</b>
              <span class="tiny muted">
                {h.source === 'practice' ? 'practice' : h.source === 'auto' ? 'auto-trader' : 'yours'} · {h.qty} @ ₹{formatNumberIN(h.buyPrice)}
              </span>
              <RiseChip tag={h.tag} measured={h.measured} />
              <span class="spacer" />
              <b class={pnl >= 0 ? 'ok-text' : 'err-text'}>
                {pnl >= 0 ? '+' : '−'}
                {formatINR(Math.abs(pnl), 0)}
              </b>
            </div>
            <div class={`small ${h.action === 'sell' ? 'err-text' : h.action === 'keep' ? 'ok-text' : ''}`} data-testid="rise-advice">
              {h.text}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** How the learned check did on days it never saw — shown honestly, even when it is not better. */
function ModelLine({ report }: { report: RiseReport | null }) {
  const [busy, setBusy] = useState(false);
  const learn = () => {
    setBusy(true);
    void callBackground('rise:train')
      .then((r) => toast(r.ok ? `Learned again from ${r.days} days` : 'Not enough 5-minute history yet', r.ok ? 'ok' : 'err'))
      .catch((e: unknown) => toast(errorMessage(e), 'err'))
      .finally(() => setBusy(false));
  };
  return (
    <div class="small" data-testid="rise-model" style={{ marginTop: '8px' }}>
      {!report ? (
        <p class="tiny muted" style={{ margin: 0 }}>
          The check learns from the stored 5-minute prices (they download once Day trade is on; about 10 market days are needed). Until then every rising stock is "Unclear".
        </p>
      ) : (
        <div class={`verdict ${report.strong && report.strong.win > report.base.win ? 'pass' : 'fail'}`}>
          <b>Learned from {report.trainDays} days, tested on the newest {report.testDays} it never saw</b> ({report.testFrom} – {report.testTo}):
          <br />
          {report.strong ? (
            <>
              "Likely to keep rising" gained {PLAN.target * 100}% first in <b>{pct(report.strong.win)}</b> of {formatNumberIN(report.strong.n, 0)} cases (all rising moments: {pct(report.base.win)}; the old Rising-today list: {pct(report.old.win)}). Average per quick trade after charges:{' '}
              <b class={report.strong.avgNetPct >= 0 ? 'ok-text' : 'err-text'}>{report.strong.avgNetPct >= 0 ? '+' : ''}{report.strong.avgNetPct.toFixed(2)}%</b> (old list {report.old.avgNetPct >= 0 ? '+' : ''}
              {report.old.avgNetPct.toFixed(2)}%).
              {report.early && report.early.n >= 20 ? ` While still early (< 1% since the open): ${pct(report.early.win)} of ${report.early.n}.` : ''}
            </>
          ) : (
            <>No chance band was clearly better than average on the unseen days, so nothing is tagged "likely" yet — the list is sorted by chance only. It learns again every day.</>
          )}
          <br />
          <span class="tiny muted">Watches most: {report.importance.slice(0, 3).map((i) => i.name).join(', ')}. Ranking quality {report.auc !== null ? `${Math.round(report.auc * 100)}/100 (50 = a coin)` : '—'}.</span>
        </div>
      )}
      <button class="btn small" type="button" style={{ marginTop: '6px' }} disabled={busy} data-testid="rise-learn" onClick={learn}>
        {busy ? 'Learning…' : 'Learn again now'}
      </button>
    </div>
  );
}

/** App v1.16.2 — shown while the market is falling: no buy suggestions then. */
export function MarketGateBanner() {
  const rise = useSessionValue('rise');
  const now = useNow(5_000);
  if (!rise?.weak?.weak || now - rise.at > 60_000) return null;
  return (
    <p class="small mv-gate" data-testid="market-gate">
      🔴 <b>Market falling ({rise.weak.text}) — no buy suggestions now.</b> On days like this most "rising" stocks turn down within minutes. Buy ideas and alerts come back when the market steadies.
    </p>
  );
}

/** App v1.16.2 — the app's own record: its "likely to keep rising" suggestions 15 minutes later. */
export function SuggestionRecordLine() {
  const rec = useLocal('riseRecord');
  const r = suggestionRecord(rec);
  return (
    <p class={`small ${r.checked && r.lower >= r.higher ? 'err-text' : ''}`} data-testid="rise-record" style={{ margin: '6px 0' }}>
      📒 <b>The app's record:</b>{' '}
      {r.checked
        ? `${r.checked} suggestions over ${r.days} day${r.days === 1 ? '' : 's'} — ${r.higher} were higher 15 minutes later, ${r.lower} lower (average ${r.avg15! >= 0 ? '+' : '−'}${Math.abs(r.avg15!).toFixed(2)}%).${r.lower >= r.higher ? ' So far they lost more often than they won — use Practice money only, not real money.' : ''}`
        : 'from today, every suggestion and its price 15 minutes later is written down here — trust it with real money only if this record shows it works.'}
    </p>
  );
}
