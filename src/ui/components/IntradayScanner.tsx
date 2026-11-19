import { useState } from 'preact/hooks';
import { hhmmT, INTRADAY, type IntradayCall, type IntradayRow } from '../../intraday/scanner';
import { formatINR, formatPct, formatTimeIST } from '../../lib/format';
import { errorMessage } from '../../lib/serialize';
import { istDate } from '../../lib/time';
import { callBackground } from '../../shared/messages';
import type { Go } from '../App';
import { useStockData } from '../data';
import { useLocal, useSessionValue } from '../hooks';
import { LevelsCard } from './LevelsCard';
import { toast, useFlash } from './Motion';
import { openTrade } from './TradeSheet';

/**
 * App v1.19 — the "Intraday" tab of Early Movers: stocks gaining momentum during the session, from
 * every NSE EQ-series stock (not only the pre-open list), refreshed every 15 seconds 9:15–3:15.
 * BUY / WAIT / NO TRADE with the reason; tap a stock for the numbers, the checks and its support and
 * resistance with the live price.
 */

const CALL_CLS: Record<IntradayCall, string> = { BUY: 'call-buy', SELL: 'call-sell', WAIT: 'call-wait', 'NO TRADE': 'call-no' };
const rs = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
type Filter = 'all' | IntradayCall;
const FILTERS: Filter[] = ['all', 'BUY', 'SELL', 'WAIT', 'NO TRADE'];

/** app v1.20: live counts of the listed rows — every row is in exactly one group, so they add up to All. */
export function intradayCounts(rows: IntradayRow[]): Record<Filter, number> {
  const c: Record<Filter, number> = { all: rows.length, BUY: 0, SELL: 0, WAIT: 0, 'NO TRADE': 0 };
  for (const r of rows) c[r.call]++;
  return c;
}

const pts = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)} pts`);

export function IntradayList({ open, now, go }: { open: boolean; now: number; go: Go }) {
  const st = useSessionValue('intraday');
  const s = st && st.date === istDate(now) ? st : null;
  const [filter, setFilter] = useState<Filter>('all');
  const all = s?.rows ?? [];
  const counts = intradayCounts(all);
  const rows = all.filter((r) => filter === 'all' || r.call === filter);
  const fresh = !!s && now - s.at < 45_000;
  return (
    <div class="intra" data-testid="intraday">
      <p class="small muted intra-head" data-testid="intraday-head">
        {s
          ? `All ${s.universe.toLocaleString('en-IN')} NSE stocks (EQ series) checked every 15 s · ${s.priced.toLocaleString('en-IN')} priced · updated ${formatTimeIST(s.at)}${fresh ? '' : ' (waiting for the next round)'}`
          : open
            ? 'All NSE stocks (EQ series) checked every 15 s · the first round is on its way…'
            : 'Every NSE stock (EQ series — never BE / T2T) is checked every 15 seconds from 9:15 to 3:15: rising ones for a BUY, falling Nifty 500 ones for a SELL (sell first).'}
      </p>
      {s?.gate && (
        <div class="banner warn small" data-testid="intraday-gate">
          <b>Market falling</b> ({s.gate}) — no BUY now; rising stocks show as WAIT.
        </div>
      )}
      {s?.shortGate && (
        <div class="banner warn small" data-testid="intraday-short-gate">
          <b>Market rising</b> ({s.shortGate}) — no SELL now; falling stocks show as WAIT.
        </div>
      )}
      {s?.error && <p class="tiny muted">{s.error}</p>}
      {s?.slow?.length ? (
        <p class="tiny muted" data-testid="intraday-slow">
          Still arriving from Upstox: {s.slow.join(', ')} — the list fills in over the next rounds.
        </p>
      ) : null}
      {/* app v1.20.1: the filters are always there, also before the first stock appears (counts 0) */}
      <div class="intra-filters" role="tablist" data-testid="intraday-filters">
        {FILTERS.map((f) => (
          <button type="button" role="tab" aria-selected={filter === f} class={`chip ${filter === f ? 'on' : ''}`} data-intra-filter={f} data-count={counts[f]} onClick={() => setFilter(f)}>
            {f === 'all' ? `All ${counts.all}` : `${f} ${counts[f]}`}
          </button>
        ))}
      </div>
      {rows.length === 0 ? (
        <p class="small muted" data-testid="intraday-empty">
          {open
            ? s?.rows.length
              ? 'None in this group right now.'
              : s
                ? `No stock is up or down ${INTRADAY.watchPct}% or more with the signs yet — the list fills itself every 15 seconds.`
                : 'Reading the market — the first stocks appear within a minute.'
            : 'Live from 9:15 to 3:15 on market days.'}
        </p>
      ) : (
        <div class="mv-list" data-testid="intraday-list">
          {rows.map((r) => (
            <IntradayItem r={r} key={r.key} go={go} />
          ))}
        </div>
      )}
    </div>
  );
}

function IntradayItem({ r, go }: { r: IntradayRow; go: Go }) {
  const [open, setOpen] = useState(false);
  const flash = useFlash(r.price);
  const line =
    r.call === 'BUY' && r.plan
      ? `entry ${rs(r.plan.entry)} · stop ${rs(r.plan.stop)} · target ${rs(r.plan.target)} · 1:${r.plan.rr}`
      : r.call === 'SELL' && r.plan
        ? `sell ${rs(r.plan.entry)} · stop ${rs(r.plan.stop)} · targets ${rs(r.plan.t1)} / ${rs(r.plan.target)} · 1:${r.plan.rr}`
        : r.why;
  const sellSide = r.side === 'sell';
  return (
    <div class={`mv-item intra-item ${CALL_CLS[r.call]} ${sellSide ? 'side-sell' : ''} ${open ? 'open' : ''}`} data-symbol={r.symbol} data-call={r.call} data-side={sellSide ? 'sell' : 'buy'} data-testid="intraday-item">
      <button type="button" class="mv-row" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span class="mv-main">
          <span class="row" style={{ gap: '6px' }}>
            <b>{r.symbol}</b>
            <span class={`chip intra-call ${CALL_CLS[r.call]}`}>{r.call}</span>
            {r.breakoutT !== null && <small class="muted">⚡ {hhmmT(r.breakoutT)}</small>}
            {sellSide && r.breakdownT !== null && r.breakdownT !== undefined && <small class="muted">▼ {hhmmT(r.breakdownT)}</small>}
          </span>
          <small class="muted">{line}</small>
        </span>
        <span class="mv-right">
          <b class={`price ${flash}`}>{rs(r.price)}</b>
          <span class={`ch-pill ${r.changePct >= 0 ? 'up' : 'down'}`}>{formatPct(r.changePct, 1)}</span>
        </span>
        <span class={`mv-score ${r.call === 'NO TRADE' ? 'off' : ''}`} title="Points out of 100 (not a chance)">
          {r.call === 'NO TRADE' ? '—' : r.score}
        </span>
      </button>
      {open && <IntradayDetail r={r} go={go} />}
    </div>
  );
}

/** The SELL side's numbers (sell first, buy back later). */
function shortCells(r: IntradayRow): Array<[string, string, string?]> {
  const p = r.plan;
  return [
    ['Breakdown time', r.breakdownT !== null && r.breakdownT !== undefined ? hhmmT(r.breakdownT) : 'not yet'],
    ['Current price', rs(r.price)],
    ['Change today', formatPct(r.changePct, 2), r.changePct >= 0 ? 'ok-text' : 'err-text'],
    ['Volume surge', r.rvol !== null ? `${r.rvol.toFixed(1)}× usual` : '—'],
    ['VWAP', rs(r.vwap)],
    ['RSI 14', r.rsi !== null && r.rsi !== undefined ? String(Math.round(r.rsi)) : '—'],
    ['vs NIFTY 50', pts(r.relNifty)],
    ['vs its sector', pts(r.relSector)],
    [r.call === 'SELL' ? 'Sell first at' : 'Sell only below', rs(p?.entry)],
    ['Buy back if it rises to', rs(p?.stop), 'err-text'],
    ['Target 1 (half)', rs(p?.t1), 'ok-text'],
    ['Target 2 (rest)', rs(p?.target), 'ok-text'],
    ['Risk : reward', p ? `1 : ${p.rr}` : '—'],
    ['Shares', r.size?.ok ? `${r.size.qty} (₹${Math.round(r.size.value).toLocaleString('en-IN')})` : '—'],
    ['Max loss with charges', r.size?.ok ? formatINR(r.size.risk, 0) : '—'],
    ['If both targets', r.size?.ok ? `+${formatINR(r.size.reward, 0)} after charges` : '—', 'ok-text'],
  ];
}

function IntradayDetail({ r, go }: { r: IntradayRow; go: Go }) {
  const { data } = useStockData(r.key);
  const wallet = useLocal('wallet');
  const p = r.plan;
  if (r.side === 'sell') {
    const short = (wallet?.shorts ?? []).find((x) => x.key === r.key);
    // shares you bought Intraday are never "sold first" by this button (that would just close them)
    const longIntraday = (wallet?.holdings ?? []).some((h) => h.key === r.key && h.product === 'intraday');
    return (
      <div class="intra-detail" data-testid="intraday-detail">
        <p class={`small intra-why ${CALL_CLS[r.call]}`}>
          <b>{r.call === 'SELL' ? 'SELL (sell first, buy back later)' : r.call}:</b> {r.why.replace(/^sell-first: /, '')}
        </p>
        <dl class="alert-detail-grid">
          {shortCells(r).map(([k, v, cls]) => (
            <div>
              <dt>{k}</dt>
              <dd class={cls ?? ''}>{v}</dd>
            </div>
          ))}
        </dl>
        <ul class="intra-checks" data-testid="intraday-checks">
          {r.checks.map((c) => (
            <li class={c.ok === true ? 'ok' : c.ok === false ? 'no' : 'unknown'}>
              <span aria-hidden="true">{c.ok === true ? '✓' : c.ok === false ? '✗' : '·'}</span> {c.text}
            </li>
          ))}
        </ul>
        <div class="row intra-actions" style={{ gap: '8px', flexWrap: 'wrap' }}>
          {r.call === 'SELL' && longIntraday && <p class="tiny muted" style={{ margin: 0 }}>You hold {r.symbol} bought Intraday — close those shares first (Practice tab).</p>}
          {r.call === 'SELL' && p && r.size?.ok && !short && !longIntraday && (
            <button
              class="btn small sell"
              type="button"
              data-testid="intraday-sell-practice"
              onClick={() => openTrade({ key: r.key, symbol: r.symbol, side: 'sell', qty: r.size!.qty, stop: p.stop, t1: p.t1 ?? null, target: p.target, sellByClose: true, product: 'intraday', source: 'Intraday scanner' })}
            >
              Sell first (practice)
            </button>
          )}
          {short && (
            <button class="btn small buy" type="button" data-testid="intraday-buy-back" onClick={() => openTrade({ key: r.key, symbol: r.symbol, side: 'buy', qty: short.qty, product: 'intraday', source: 'Intraday scanner' })}>
              Buy back {short.qty} (practice)
            </button>
          )}
          <button class="btn small" type="button" onClick={() => go('stock', `${r.key}~short`)}>
            Open {r.symbol} — sell-first view
          </button>
        </div>
        <LevelsCard stockKey={r.key} snap={data?.snapshot ?? null} candles={data?.candles ?? []} />
        <p class="tiny muted">
          Intraday only: sell first and buy back by 3:15 pm (Upstox squares off at 3:20). Shorting is for Nifty 500 stocks only — never BE / T2T — and this never sells shares you hold in Delivery. Score = points out
          of 100, not a chance. Never a guarantee — the app never places an order; you do, in Upstox.
        </p>
      </div>
    );
  }
  const cells: Array<[string, string, string?]> = [
    ['Breakout time', r.breakoutT !== null ? hhmmT(r.breakoutT) : 'not yet'],
    ['Current price', rs(r.price)],
    ['Change today', formatPct(r.changePct, 2), r.changePct >= 0 ? 'ok-text' : 'err-text'],
    ['Volume surge', r.rvol !== null ? `${r.rvol.toFixed(1)}× usual` : '—'],
    ['VWAP', rs(r.vwap)],
    ['Buyers waiting', r.buyers !== null ? `${Math.round(r.buyers * 100)}%` : '—'],
    [r.call === 'BUY' ? 'Entry' : 'Buy only above', rs(p?.entry)],
    ['Stop-loss', rs(p?.stop), 'err-text'],
    ['Target', rs(p?.target), 'ok-text'],
    ['Risk : reward', p ? `1 : ${p.rr}` : '—'],
    ['Shares', r.size?.ok ? `${r.size.qty} (₹${Math.round(r.size.value).toLocaleString('en-IN')})` : '—'],
    ['Risk with charges', r.size?.ok ? formatINR(r.size.risk, 0) : '—'],
  ];
  return (
    <div class="intra-detail" data-testid="intraday-detail">
      <p class={`small intra-why ${CALL_CLS[r.call]}`}>
        <b>{r.call}:</b> {r.why}
      </p>
      <dl class="alert-detail-grid">
        {cells.map(([k, v, cls]) => (
          <div>
            <dt>{k}</dt>
            <dd class={cls ?? ''}>{v}</dd>
          </div>
        ))}
      </dl>
      <ul class="intra-checks" data-testid="intraday-checks">
        {r.checks.map((c) => (
          <li class={c.ok === true ? 'ok' : c.ok === false ? 'no' : 'unknown'}>
            <span aria-hidden="true">{c.ok === true ? '✓' : c.ok === false ? '✗' : '·'}</span> {c.text}
          </li>
        ))}
      </ul>
      {r.call === 'BUY' && p && r.size?.ok && (
        <div class="row intra-actions" style={{ gap: '8px', flexWrap: 'wrap' }}>
          <button class="btn small buy" type="button" data-testid="intraday-buy-practice" onClick={() => openTrade({ key: r.key, symbol: r.symbol, side: 'buy', qty: r.size!.qty, stop: p.stop, target: p.target, sellByClose: true, product: 'intraday', source: 'Intraday scanner' })}>
            Buy (practice)
          </button>
        </div>
      )}
      <LevelsCard stockKey={r.key} snap={data?.snapshot ?? null} candles={data?.candles ?? []} />
      <p class="tiny muted">
        Exit by 3:15 pm (Intraday). Score = points out of 100, not a chance. Never a guarantee — the app never places an order; you do, in Upstox.{' '}
        <button class="link-btn" type="button" onClick={() => go('stock', r.key)}>
          Open {r.symbol}
        </button>
      </p>
    </div>
  );
}

/**
 * App v1.20 — on a stock's page: the Intraday scanner's live plan for it (BUY in the Buy view, SELL in
 * the Sell-first view), so the page shows the same entry, stop-loss and targets as the list.
 */
export function IntradayPlanCard({ stockKey, side, now }: { stockKey: string; side: 'buy' | 'sell'; now: number }) {
  const st = useSessionValue('intraday');
  const r = st && st.date === istDate(now) ? st.rows.find((x) => x.key === stockKey && (x.side ?? 'buy') === side) : undefined;
  if (!r) return null;
  const cells = side === 'sell' ? shortCells(r) : null;
  const p = r.plan;
  return (
    <section class={`card intra-plan-card ${CALL_CLS[r.call]}`} data-testid="intraday-plan-card" data-call={r.call}>
      <div class="row" style={{ gap: '8px' }}>
        <h2 style={{ margin: 0 }}>Intraday scanner</h2>
        <span class={`chip intra-call ${CALL_CLS[r.call]}`}>{r.call}</span>
        <span class="spacer" />
        <span class="mv-score" title="Points out of 100 (not a chance)">
          {r.call === 'NO TRADE' ? '—' : r.score}
        </span>
      </div>
      <p class="small">{r.why.replace(/^sell-first: /, '')}</p>
      <dl class="alert-detail-grid">
        {(cells ??
          ([
            ['Entry', rs(p?.entry)],
            ['Stop-loss', rs(p?.stop), 'err-text'],
            ['Target', rs(p?.target), 'ok-text'],
            ['Risk : reward', p ? `1 : ${p.rr}` : '—'],
            ['Shares', r.size?.ok ? String(r.size.qty) : '—'],
            ['Risk with charges', r.size?.ok ? formatINR(r.size.risk, 0) : '—'],
          ] as Array<[string, string, string?]>)
        ).map(([k, v, cls]) => (
          <div>
            <dt>{k}</dt>
            <dd class={cls ?? ''}>{v}</dd>
          </div>
        ))}
      </dl>
      <ul class="intra-checks">
        {r.checks.map((c) => (
          <li class={c.ok === true ? 'ok' : c.ok === false ? 'no' : 'unknown'}>
            <span aria-hidden="true">{c.ok === true ? '✓' : c.ok === false ? '✗' : '·'}</span> {c.text}
          </li>
        ))}
      </ul>
      <p class="tiny muted" style={{ margin: 0 }}>
        Updated {formatTimeIST(r.at)} · the chart shows these prices as lines.
      </p>
    </section>
  );
}

/** The scanner's plan as chart lines (entry, stop-loss, targets). */
export function intradayLines(r: IntradayRow | undefined): Array<{ price: number; title: string; color: string }> {
  const p = r?.plan;
  if (!r || !p) return [];
  if (r.side === 'sell')
    return [
      { price: p.entry, title: 'Sell', color: '#64748b' },
      { price: p.stop, title: 'Buy back if above', color: '#ef4444' },
      ...(p.t1 !== undefined ? [{ price: p.t1, title: 'T1', color: '#10b981' }] : []),
      { price: p.target, title: 'T2', color: '#10b981' },
    ];
  return [
    { price: p.entry, title: 'Entry', color: '#64748b' },
    { price: p.stop, title: 'Stop', color: '#ef4444' },
    { price: p.target, title: 'Target', color: '#10b981' },
  ];
}

/** "More": the scanner's past test on the stored 5-minute history. */
export function IntradayTestLine() {
  const r = useLocal('intradayTest');
  const [busy, setBusy] = useState(false);
  const run = () => {
    setBusy(true);
    void callBackground('intraday:test')
      .then((x) => toast(x.ok ? `Intraday past test: ${x.trades} trades on ${x.days} days` : 'Not enough 5-minute history yet', x.ok ? 'ok' : 'err'))
      .catch((e: unknown) => toast(errorMessage(e), 'err'))
      .finally(() => setBusy(false));
  };
  return (
    <p class="tiny muted" data-testid="intraday-test" style={{ margin: '6px 0 0' }}>
      <b>Intraday past test:</b>{' '}
      {r
        ? r.trades
          ? `${r.from} – ${r.to}, ${r.days} market days: ${r.trades} BUYs, ${Math.round((r.winRate ?? 0) * 100)}% ended in profit, average ${r.avgR ?? 0}R, ${formatINR(r.netPnl, 0)} after charges for your trade sizes (target ${r.byExit.target}, stop-loss ${r.byExit.stop}, 3:15 exit ${r.byExit.time}). The same rules as the live list; the waiting buy / sell quantities and the market gate are not in the history. Past results do not promise future ones.`
          : `${r.days} market days of 5-minute history: no BUY under these rules.`
        : 'runs once a day after the close on the stored 5-minute history.'}{' '}
      <button class="link-btn" type="button" disabled={busy} onClick={run}>
        {busy ? 'testing…' : 'Test now'}
      </button>
    </p>
  );
}
