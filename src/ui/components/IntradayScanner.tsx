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

/**
 * App v1.19 — the "Intraday" tab of Early Movers: stocks gaining momentum during the session, from
 * every NSE EQ-series stock (not only the pre-open list), refreshed every 15 seconds 9:15–3:15.
 * BUY / WAIT / NO TRADE with the reason; tap a stock for the numbers, the checks and its support and
 * resistance with the live price.
 */

const CALL_CLS: Record<IntradayCall, string> = { BUY: 'call-buy', WAIT: 'call-wait', 'NO TRADE': 'call-no' };
const rs = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
type Filter = 'all' | IntradayCall;

export function IntradayList({ open, now, go }: { open: boolean; now: number; go: Go }) {
  const st = useSessionValue('intraday');
  const s = st && st.date === istDate(now) ? st : null;
  const [filter, setFilter] = useState<Filter>('all');
  const rows = (s?.rows ?? []).filter((r) => filter === 'all' || r.call === filter);
  const fresh = !!s && now - s.at < 45_000;
  return (
    <div class="intra" data-testid="intraday">
      <p class="small muted intra-head" data-testid="intraday-head">
        {s
          ? `All ${s.universe.toLocaleString('en-IN')} NSE stocks (EQ series) checked every 15 s · ${s.priced.toLocaleString('en-IN')} priced · updated ${formatTimeIST(s.at)}${fresh ? '' : ' (waiting for the next round)'}`
          : 'Every NSE stock (EQ series — never BE / T2T) is checked every 15 seconds from 9:15 to 3:15 for fresh momentum.'}
      </p>
      {s?.gate && (
        <div class="banner warn small" data-testid="intraday-gate">
          <b>Market falling</b> ({s.gate}) — no BUY now; stocks show as WAIT.
        </div>
      )}
      {s?.error && <p class="tiny muted">{s.error}</p>}
      {s && s.rows.length > 0 && (
        <div class="intra-filters" role="tablist">
          {(['all', 'BUY', 'WAIT', 'NO TRADE'] as Filter[]).map((f) => (
            <button type="button" role="tab" class={`chip ${filter === f ? 'on' : ''}`} data-intra-filter={f} onClick={() => setFilter(f)}>
              {f === 'all' ? `All ${s.rows.length}` : `${f} ${f === 'BUY' ? s.counts.buy : f === 'WAIT' ? s.counts.wait : s.counts.noTrade}`}
            </button>
          ))}
        </div>
      )}
      {rows.length === 0 ? (
        <p class="small muted" data-testid="intraday-empty">
          {open ? (s?.rows.length ? 'None in this group right now.' : `No stock is up ${INTRADAY.watchPct}% or more with the signs yet — the list fills itself every 15 seconds.`) : 'Live from 9:15 to 3:15 on market days.'}
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
  const line = r.call === 'BUY' && r.plan ? `entry ${rs(r.plan.entry)} · stop ${rs(r.plan.stop)} · target ${rs(r.plan.target)} · 1:${r.plan.rr}` : r.why;
  return (
    <div class={`mv-item intra-item ${CALL_CLS[r.call]} ${open ? 'open' : ''}`} data-symbol={r.symbol} data-call={r.call} data-testid="intraday-item">
      <button type="button" class="mv-row" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span class="mv-main">
          <span class="row" style={{ gap: '6px' }}>
            <b>{r.symbol}</b>
            <span class={`chip intra-call ${CALL_CLS[r.call]}`}>{r.call}</span>
            {r.breakoutT !== null && <small class="muted">⚡ {hhmmT(r.breakoutT)}</small>}
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

function IntradayDetail({ r, go }: { r: IntradayRow; go: Go }) {
  const { data } = useStockData(r.key);
  const p = r.plan;
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
