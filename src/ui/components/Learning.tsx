import { useState } from 'preact/hooks';
import type { DayTestResult } from '../../daytrade/backtest';
import { formatINR } from '../../lib/format';
import { errorMessage } from '../../lib/serialize';
import { explainImportance, ML_VERSION } from '../../ml/learn';
import { callBackground } from '../../shared/messages';
import type { Go } from '../App';
import { useLocal, useSessionValue } from '../hooks';

/** '2026-11-13' → '13 Nov 2026' */
const day = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const winPct = (r: DayTestResult) => (r.trades ? `${Math.round((r.wins / r.trades) * 100)}%` : '—');
const signed = (x: number) => `${x >= 0 ? '+' : '−'}${formatINR(Math.abs(x), 0)}`;

/** What the self-learning learned, and whether it passed its check on unseen days. */
export function LearningCard({ go, full = false }: { go: Go; full?: boolean }) {
  const m = useLocal('mlModel');
  const progress = useSessionValue('mlProgress');
  const [err, setErr] = useState<string | null>(null);
  const report = m && m.version === ML_VERSION ? m : null;
  const learning = !!progress?.running;
  const learnNow = () => {
    setErr(null);
    void callBackground('ml:learn')
      .then((r) => !r.samples && setErr('Not enough 5-minute history yet. Turn on day trading in the Day trade tab: it downloads the history (needs at least 45 trading days).'))
      .catch((e: unknown) => setErr(errorMessage(e)));
  };

  if (!full) {
    return (
      <div class={`banner ${report?.passed ? 'ok' : 'info'} small`} data-testid="learning-line">
        <b>🧠 Self-learning: </b>
        {learning ? (
          <>learning from past signals… {progress.total ? `${Math.round((progress.done / progress.total) * 100)}%` : ''}</>
        ) : report ? (
          report.passed ? (
            <>
              in use — on days it had never seen it won {winPct(report.ml)} of {report.ml.trades} trades ({signed(report.ml.pnl)}). Signals below {Math.round(report.threshold * 100)}% chance are skipped.
            </>
          ) : (
            <>not used yet — {report.reason.replace(/ Not used.*$/, '')}</>
          )
        ) : (
          <>has not learned yet (needs the 5-minute history).</>
        )}{' '}
        <button class="link-btn" type="button" onClick={() => go('learning')}>
          details
        </button>
      </div>
    );
  }

  const why = report ? explainImportance(report.importance) : null;
  return (
    <section class="card" data-testid="learning-card">
      <h2>🧠 Self-learning</h2>
      <p class="small">
        The app studies every past day-trade signal in the 5-minute history: what it looked like at that moment, and whether it made money after charges. It learns which signals
        tend to work, then <b>tests itself on the newest days it has never seen</b>. It learns again every evening.
      </p>
      {learning && (
        <div class="banner info small" data-testid="learning-progress">
          Learning from past signals… {progress.total ? `${progress.done} of ${progress.total} stocks read` : ''}
        </div>
      )}
      {!report && !learning && <p class="small muted">Nothing learned yet. It needs at least 45 trading days of 5-minute history — the Day trade tab downloads it when day trading is on.</p>}
      {report && (
        <>
          <div class={`verdict ${report.passed ? 'pass' : 'fail'}`} data-testid="learning-verdict">
            <b>{report.passed ? '✅ In use for live signals' : '⏸ Not used yet — the plain rules decide'}</b>
            <div class="small">{report.reason}</div>
          </div>
          <table class="simple small" data-testid="learning-compare">
            <thead>
              <tr>
                <th>
                  Unseen days
                  <br />
                  <span class="muted tiny">
                    {day(report.checkFrom)} – {day(report.checkTo)}
                  </span>
                </th>
                <th class="num">Trades</th>
                <th class="num">Won</th>
                <th class="num">Result</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <b>Learned chance</b> (≥ {Math.round(report.threshold * 100)}%)
                </td>
                <td class="num">{report.ml.trades}</td>
                <td class="num">{winPct(report.ml)}</td>
                <td class={`num ${report.ml.pnl >= 0 ? 'ok-text' : 'err-text'}`}>{signed(report.ml.pnl)}</td>
              </tr>
              <tr>
                <td>Plain rules</td>
                <td class="num">{report.base.trades}</td>
                <td class="num">{winPct(report.base)}</td>
                <td class={`num ${report.base.pnl >= 0 ? 'ok-text' : 'err-text'}`}>{signed(report.base.pnl)}</td>
              </tr>
              <tr>
                <td>Every signal</td>
                <td class="num">{report.all.trades}</td>
                <td class="num">{winPct(report.all)}</td>
                <td class={`num ${report.all.pnl >= 0 ? 'ok-text' : 'err-text'}`}>{signed(report.all.pnl)}</td>
              </tr>
            </tbody>
          </table>
          <p class="tiny muted">
            Same amount, same number of trades a day, after Upstox intraday charges and slippage. Learned only from {day(report.trainFrom)} – {day(report.trainTo)}.
          </p>
          {why && (why.more.length > 0 || why.less.length > 0) && (
            <div class="small" data-testid="learning-why">
              <b>What it noticed:</b>
              <ul>
                {why.more.length > 0 && <li>Signals won more often with {why.more.join(' and ')}.</li>}
                {why.less.length > 0 && <li>Signals won less often with {why.less.join(' and ')}.</li>}
              </ul>
            </div>
          )}
          <p class="small muted">
            Learned from {report.samples.toLocaleString('en-IN')} past signals over {report.sessions} trading days ({day(report.from)} – {day(report.to)}); on average{' '}
            {Math.round(report.baseRate * 100)}% of them made money. Ranking skill on unseen days: {report.auc !== null ? report.auc.toFixed(2) : '—'} (0.50 = a coin toss, 1.00 = perfect).
            Last learned {new Date(report.trainedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })}.
          </p>
        </>
      )}
      <button class="btn small" type="button" disabled={learning} data-testid="learn-now" onClick={learnNow}>
        {learning ? 'Learning…' : 'Learn now'}
      </button>
      {err && <p class="small err-text">{err}</p>}
      <p class="tiny muted">
        Honest limits: the past does not repeat exactly. Good short-term trading wins about 55–60% of the time with small losses; anyone promising much more is guessing. The buyers
        meter and news are recorded from now on and join the learning once enough days are collected.
      </p>
    </section>
  );
}
