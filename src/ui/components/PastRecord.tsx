import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { backtestPicks, type BacktestReport, type BacktestResult, type ExitReason } from '../../advisor/backtest';
import { formatDateIST, formatINR, formatNumberIN, formatPct } from '../../lib/format';
import { istEpoch } from '../../lib/time';
import { setSession } from '../../storage/session';
import { useInstrumentMap, useStocksData, useStudyKeys } from '../data';
import { useSessionValue, useSettings } from '../hooks';

const ORDER_LABEL = { safety: 'Safest first', earning: 'Highest earning first' } as const;
const WHY: Record<ExitReason, string> = { target: 'profit target', stop: 'sell price', gap: 'opened below sell price', time: 'after 20 days', open: 'still running' };
const day = (d: string) => formatDateIST(istEpoch(d, '12:00'));
const signed = (x: number) => `${x >= 0 ? '+' : '−'}${formatINR(Math.abs(x), 0)}`;
/** bump when the test or the pick rules change, so old results are recomputed */
const TEST_VERSION = 'v0.8.0';

/**
 * "Can I trust these picks?" (v0.8.0): replays the last year with today's rules and shows what
 * following every pick would have done. Runs by itself once the price history is downloaded, and
 * again when the history, amount, split or price range changes.
 */
export function PastRecordCard() {
  const settings = useSettings();
  const progress = useSessionValue('syncProgress');
  const cached = useSessionValue('pastRecord');
  const { keys, listLabel } = useStudyKeys();
  const { data, loading } = useStocksData(keys);
  const byKey = useInstrumentMap();
  const [running, setRunning] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runId = useRef(0);

  const syncing = !!(progress?.running && progress.total > 0);
  const input = useMemo(() => {
    if (!settings?.risk.capitalInr || loading || syncing) return null;
    const stocks = keys.flatMap((k) => {
      const d = data.get(k);
      if (!d) return [];
      return [{ key: k, symbol: d.instrument?.trading_symbol ?? byKey.get(k)?.trading_symbol ?? k, candles: d.candles.filter((c) => !c.partial), tick: d.instrument?.tick ?? 0.05 }];
    });
    const last = stocks.reduce((m, s) => (s.candles.length && s.candles[s.candles.length - 1]!.date > m ? s.candles[s.candles.length - 1]!.date : m), '');
    const r = settings.risk;
    const key = [TEST_VERSION, last, stocks.length, r.capitalInr, r.sizing, r.splitInto, r.maxOpenTrades, r.chargesEstimatePct, settings.ui.priceMin, settings.ui.priceMax, JSON.stringify(settings.planner), JSON.stringify(settings.indicators)].join('|');
    return { stocks, key, amount: r.capitalInr! };
  }, [settings, loading, syncing, data, keys.join(','), byKey]);

  useEffect(() => {
    if (!input || !settings || cached?.key === input.key || running !== null) return;
    if (input.stocks.filter((s) => s.candles.length > 300).length < 3) return;
    const id = ++runId.current;
    setRunning(0);
    setError(null);
    void backtestPicks(input.stocks, settings, input.amount, {
      priceMin: settings.ui.priceMin,
      priceMax: settings.ui.priceMax,
      onProgress: (done, total) => id === runId.current && setRunning(Math.round((done / total) * 100)),
    })
      .then(async (report) => {
        if (id !== runId.current) return;
        if (report) await setSession('pastRecord', { key: input.key, report });
        else setError('Not enough price history yet for the past-year test.');
      })
      .catch((err: unknown) => setError(String(err)))
      .finally(() => id === runId.current && setRunning(null));
  }, [input?.key, cached?.key, running === null]);

  if (!settings?.risk.capitalInr) return null;
  const report = cached?.report ?? null;
  const fresh = !!input && cached?.key === input.key;
  const chosen = settings.scanner.rankBy ?? 'safety';

  return (
    <section class="card" data-testid="past-record">
      <h2>Can I trust these picks? — the past-year test</h2>
      {running !== null && (
        <p class="small muted" data-testid="past-record-running">
          Testing the pick rules on the last year of {listLabel}… {running}%
        </p>
      )}
      {!report && running === null && !error && <p class="small muted">The test runs by itself once the price history has downloaded.</p>}
      {error && <p class="small err-text">{error}</p>}
      {report && <ReportView report={report} chosen={chosen} stale={!fresh && running === null} />}
    </section>
  );
}

function ReportView({ report, chosen, stale }: { report: BacktestReport; chosen: 'safety' | 'earning'; stale: boolean }) {
  const [showTrades, setShowTrades] = useState(false);
  const mine = report.results.find((r) => r.rankBy === chosen) ?? report.results[0]!;
  const cols = [...report.results].sort((a) => (a.rankBy === chosen ? -1 : 1));
  const rate = (r: BacktestResult) => (r.closed ? Math.round((r.wins / r.closed) * 100) : 0);
  const hold = report.holdAllPct;

  let verdict: { tone: string; text: string };
  if (mine.closed < 10) verdict = { tone: 'info', text: `Only ${mine.closed} finished trades in the test — too few to judge. Treat the picks with extra care.` };
  else if (mine.totalPct <= 0) verdict = { tone: 'err', text: `Following the "${ORDER_LABEL[chosen]}" picks LOST money in this past year. Be extra careful: use a smaller amount, or wait.` };
  else if (hold !== null && mine.totalPct < hold) verdict = { tone: 'info', text: `Following the picks made money in this past year, but less than simply buying every company and holding.` };
  else verdict = { tone: 'ok', text: `Following the "${ORDER_LABEL[chosen]}" picks made money in this past year${hold !== null ? ', and more than simply buying every company and holding' : ''}.` };

  return (
    <>
      <p class="small">
        The extension replayed every trading day from <b>{day(report.from)}</b> to <b>{day(report.to)}</b> with <b>today's rules</b>, using only the prices known on each day. It put{' '}
        <b>{formatINR(report.amount, 0)}</b> into the top {report.slots} pick{report.slots > 1 ? 's' : ''} and sold exactly as the plan says: at the profit target, at the sell price, or after 20
        days.
      </p>
      <div class={`banner ${verdict.tone} small`} data-testid="past-record-verdict">
        {verdict.text}
      </div>
      <table class="simple past-record" data-testid="past-record-table">
        <thead>
          <tr>
            <th />
            {cols.map((r) => (
              <th class={r.rankBy === chosen ? 'chosen' : ''}>
                {ORDER_LABEL[r.rankBy]}
                {r.rankBy === chosen ? ' (your order)' : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Finished trades</td>
            {cols.map((r) => (
              <td>{r.closed}</td>
            ))}
          </tr>
          <tr>
            <td>Made money</td>
            {cols.map((r) => (
              <td class="ok-text">
                {r.wins} ({rate(r)}%)
              </td>
            ))}
          </tr>
          <tr>
            <td>Lost money</td>
            {cols.map((r) => (
              <td class="err-text">{r.losses}</td>
            ))}
          </tr>
          <tr>
            <td>
              <b>Result for the year</b> (after charges)
            </td>
            {cols.map((r) => (
              <td class={r.totalPnl >= 0 ? 'ok-text' : 'err-text'} data-testid={`past-total-${r.rankBy}`}>
                <b>{signed(r.totalPnl)}</b> ({formatPct(r.totalPct, 1)})
              </td>
            ))}
          </tr>
          <tr>
            <td>Average trade</td>
            {cols.map((r) => (
              <td>{formatPct(r.avgPct, 2)}</td>
            ))}
          </tr>
          <tr>
            <td>Worst single trade</td>
            {cols.map((r) => (
              <td class={r.worstPct < 0 ? 'err-text' : 'ok-text'}>{formatPct(r.worstPct, 1)}</td>
            ))}
          </tr>
          <tr>
            <td>Deepest fall on the way</td>
            {cols.map((r) => (
              <td class={r.maxDrawdown < 0 ? 'err-text' : ''}>{signed(r.maxDrawdown)}</td>
            ))}
          </tr>
          <tr>
            <td>Days with money in trades</td>
            {cols.map((r) => (
              <td>{Math.round(r.investedDays * 100)}%</td>
            ))}
          </tr>
          <tr>
            <td>Still running at the end</td>
            {cols.map((r) => (
              <td>{r.stillOpen}</td>
            ))}
          </tr>
        </tbody>
      </table>
      {hold !== null && (
        <p class="small">
          For comparison: buying all {report.stocks} companies on {day(report.from)} and simply holding: <b class={hold >= 0 ? 'ok-text' : 'err-text'}>{formatPct(hold, 1)}</b>.
        </p>
      )}
      <button class="btn small" type="button" onClick={() => setShowTrades(!showTrades)}>
        {showTrades ? 'Hide the trades' : `Show all ${mine.trades.length} trades (${ORDER_LABEL[chosen]})`}
      </button>
      {showTrades && (
        <table class="simple" data-testid="past-trades">
          <thead>
            <tr>
              <th>Bought</th>
              <th>Stock</th>
              <th>Buy</th>
              <th>Sell</th>
              <th>Result</th>
              <th>Sold at</th>
            </tr>
          </thead>
          <tbody>
            {[...mine.trades].reverse().map((t) => (
              <tr>
                <td>{day(t.buyDate)}</td>
                <td>{t.symbol}</td>
                <td>₹{formatNumberIN(t.buyPrice)}</td>
                <td>₹{formatNumberIN(t.sellPrice)}</td>
                <td class={t.pnl >= 0 ? 'ok-text' : 'err-text'}>
                  {signed(t.pnl)} ({formatPct(t.pnlPct, 1)})
                </td>
                <td>{WHY[t.reason]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {stale && <p class="tiny muted">Shown from the last test; it re-runs when the new data has loaded.</p>}
      <p class="tiny muted">
        What this test can't tell you: the past does not promise the future. It uses today's {report.stocks}-company list, so companies that dropped out of the index are missing (that makes
        results look a little better). It assumes you bought at the day's closing price and followed every sell exactly. Charges are estimated at {report.chargesPct}% per trade. Took{' '}
        {(report.computedMs / 1000).toFixed(1)} s.
      </p>
    </>
  );
}
