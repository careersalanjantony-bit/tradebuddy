import { useState } from 'preact/hooks';
import { closedPnl, summarisePractice } from '../../practice/practice';
import { formatDateIST, formatINR, formatNumberIN } from '../../lib/format';
import { errorMessage } from '../../lib/serialize';
import { istEpoch } from '../../lib/time';
import { callBackground } from '../../shared/messages';
import type { TradePlan } from '../../storage/schema';
import { useQuotes } from '../data';
import { useLocal, useSettings } from '../hooks';

const signed = (x: number) => `${x >= 0 ? '+' : '−'}${formatINR(Math.abs(x), 0)}`;
const day = (d: string | undefined) => (d ? formatDateIST(istEpoch(d, '12:00')) : '—');
const why = (p: TradePlan) =>
  p.exitReason === 'target' ? 'profit target' : p.exitReason === 'stop' ? (p.notes?.startsWith('Opened below') ? 'opened below sell price' : 'sell price') : p.exitReason === 'time' ? 'time limit' : 'you sold';

/**
 * Practice trades (v0.9.0): pretend money inside the extension. The results use the same rules and
 * charges as the past-year test, so the two can be compared.
 */
export function PracticeCard() {
  const plans = useLocal('plans') ?? [];
  const quotes = useQuotes();
  const settings = useSettings();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const practice = plans.filter((p) => p.practice);
  if (!settings) return null;
  const horizon = settings.planner.exitHorizonSessions;

  if (!practice.length) {
    return (
      <section class="card" data-testid="practice-card">
        <h2>Practice trades (pretend money)</h2>
        <p class="small">
          Click <b>Practice buy</b> on any pick. The extension "buys" it at the live price — or at the next opening price when the market is closed — and sells it by itself at the sell price,
          the profit target or after {horizon} trading days, the same rules as the past-year test. Nothing is sent to Upstox and no real money is used.
        </p>
      </section>
    );
  }

  const s = summarisePractice(plans, (k) => quotes[k]?.ltp ?? null, settings.risk.chargesEstimatePct);
  const open = practice.filter((p) => p.status === 'open' || p.status === 'planned');
  const closed = practice.filter((p) => p.status === 'closed').sort((a, b) => b.updatedAt - a.updatedAt);
  const skipped = practice.filter((p) => p.status === 'cancelled');
  const total = s.realised + s.openPnl;

  const act = async (fn: () => Promise<string>) => {
    setMsg(null);
    try {
      setMsg({ ok: true, text: await fn() });
    } catch (err) {
      setMsg({ ok: false, text: errorMessage(err) });
    }
  };

  return (
    <section class="card practice" data-testid="practice-card">
      <div class="row">
        <h2 style={{ margin: 0 }}>Practice trades (pretend money)</h2>
        <span class="spacer" />
        <span class={`big-number ${total >= 0 ? 'ok-text' : 'err-text'}`} data-testid="practice-total" title="Finished trades after charges + open trades at the latest price">
          {signed(total)}
        </span>
      </div>
      <p class="small">
        Finished: <b>{s.closed}</b> trade{s.closed === 1 ? '' : 's'} · made money <b class="ok-text">{s.wins}</b> · lost <b class="err-text">{s.losses}</b> · result{' '}
        <b class={s.realised >= 0 ? 'ok-text' : 'err-text'}>{signed(s.realised)}</b> after charges
        {s.days.length > 0 && (
          <>
            {' '}
            · days with profit <b>{s.greenDays}</b>, with loss <b>{s.redDays}</b>
          </>
        )}
        {s.open > 0 && (
          <>
            {' '}
            · open now <b class={s.openPnl >= 0 ? 'ok-text' : 'err-text'}>{signed(s.openPnl)}</b>
          </>
        )}
      </p>

      {open.length > 0 && (
        <table class="simple" data-testid="practice-open">
          <thead>
            <tr>
              <th>Stock</th>
              <th>Bought</th>
              <th>Now</th>
              <th>Result</th>
              <th>Sells at</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {open.map((p) => {
              const ltp = quotes[p.key]?.ltp ?? null;
              const r = p.status === 'open' && ltp !== null ? (ltp - p.fillPrice!) * p.qty : null;
              return (
                <tr data-symbol={p.symbol}>
                  <td>
                    <b>{p.symbol}</b>
                  </td>
                  <td>{p.status === 'open' ? `${p.qty} @ ₹${formatNumberIN(p.fillPrice)}` : <span class="muted">waits for the opening price ({p.qty} shares)</span>}</td>
                  <td>{ltp !== null ? `₹${formatNumberIN(ltp)}` : '—'}</td>
                  <td class={r === null ? '' : r >= 0 ? 'ok-text' : 'err-text'}>{r === null ? '—' : signed(r)}</td>
                  <td class="tiny">
                    ↓ ₹{formatNumberIN(p.stop)} · ↑ ₹{formatNumberIN(p.target)}
                  </td>
                  <td>
                    <button
                      class="btn small"
                      type="button"
                      data-testid="practice-sell"
                      onClick={() =>
                        void act(async () => {
                          const res = await callBackground('practice:sell', { id: p.id });
                          return p.status === 'planned' ? `${p.symbol}: practice order cancelled.` : `${p.symbol} sold at ₹${formatNumberIN(res.price)}: ${signed(res.pnl)} after charges (pretend money).`;
                        })
                      }
                    >
                      {p.status === 'planned' ? 'Cancel' : 'Sell now'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {msg && <p class={`small ${msg.ok ? 'ok-text' : 'err-text'}`}>{msg.text}</p>}

      {s.days.length > 0 && (
        <details class="small" style={{ marginTop: '8px' }}>
          <summary>Results per day ({s.days.length})</summary>
          <table class="simple" data-testid="practice-days">
            <tbody>
              {s.days.map((d) => (
                <tr>
                  <td>{day(d.date)}</td>
                  <td>
                    {d.trades} trade{d.trades === 1 ? '' : 's'}
                  </td>
                  <td class={d.pnl >= 0 ? 'ok-text' : 'err-text'}>{signed(d.pnl)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      {closed.length > 0 && (
        <details class="small" style={{ marginTop: '8px' }}>
          <summary>Finished practice trades ({closed.length})</summary>
          <table class="simple" data-testid="practice-closed">
            <thead>
              <tr>
                <th>Sold</th>
                <th>Stock</th>
                <th>Buy → sell</th>
                <th>Result</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {closed.map((p) => {
                const pnl = closedPnl(p);
                return (
                  <tr>
                    <td>{day(p.exitDate)}</td>
                    <td>{p.symbol}</td>
                    <td>
                      ₹{formatNumberIN(p.fillPrice)} → ₹{formatNumberIN(p.exitPrice)}
                    </td>
                    <td class={pnl >= 0 ? 'ok-text' : 'err-text'}>{signed(pnl)}</td>
                    <td>{why(p)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </details>
      )}
      {skipped.length > 0 && (
        <p class="tiny muted">
          Not bought: {skipped.map((p) => `${p.symbol} (${p.notes?.replace(/^Practice order /, '').replace(/\.$/, '') ?? 'cancelled'})`).join('; ')}.
        </p>
      )}
      <div class="row" style={{ marginTop: '8px' }}>
        {!confirmReset ? (
          <button class="link-btn" type="button" onClick={() => setConfirmReset(true)}>
            Start practice again (clear all practice trades)
          </button>
        ) : (
          <>
            <span class="small">Clear all practice trades?</span>
            <button
              class="btn small"
              type="button"
              data-testid="practice-reset"
              onClick={() =>
                void act(async () => {
                  const r = await callBackground('practice:reset');
                  setConfirmReset(false);
                  return `Cleared ${r.removed} practice trade(s).`;
                })
              }
            >
              Yes, clear
            </button>
            <button class="btn small" type="button" onClick={() => setConfirmReset(false)}>
              No
            </button>
          </>
        )}
      </div>
      <p class="tiny muted">
        Pretend money only — nothing is sent to Upstox. Sold by the extension itself at the sell price (at the opening price if a stock opens below it), at the profit target, or after {horizon}{' '}
        trading days. Charges estimated at {settings.risk.chargesEstimatePct ?? 0.25}% per trade. Keep Chrome open during market hours so prices are checked; days missed are caught up from the
        daily history.
      </p>
    </section>
  );
}
