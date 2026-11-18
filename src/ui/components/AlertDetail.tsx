import { useEffect, useState } from 'preact/hooks';
import { alertDetail, getAlertHistory, type AlertRecord } from '../../alerts/history';
import { formatDateTimeIST, formatNumberIN } from '../../lib/format';
import type { Go, ScreenId } from '../App';
import { iconFor, routeForAlert } from './AlertBanner';

/**
 * App v1.18 — the detail view of one alert: stock, BUY / SELL first, entry, stop-loss, targets,
 * quantity, risk, score and why the alert came. Opened by tapping an alert banner, a phone
 * notification or a line in the Alerts tab.
 */

const OPEN_EVENT = 'tb-alert-detail';

const SCREEN_NAME: Partial<Record<string, string>> = { daytrade: 'Day trade', practice: 'Practice', today: 'Home', watchlist: 'Stocks', account: 'Me', settings: 'Settings' };

/** Opens the detail view; with only an id (or no saved details) the stored history is looked up. */
export function openAlertDetail(rec: Pick<AlertRecord, 'id'> & Partial<AlertRecord>): void {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: rec }));
}

export function AlertDetailHost({ go }: { go: Go }) {
  const [rec, setRec] = useState<AlertRecord | null>(null);
  useEffect(() => {
    const on = (e: Event) => {
      const given = (e as CustomEvent<Pick<AlertRecord, 'id'> & Partial<AlertRecord>>).detail;
      if (given.title !== undefined) setRec({ id: given.id, title: given.title, message: given.message ?? '', at: given.at ?? Date.now(), ...(given.detail ? { detail: given.detail } : {}) });
      // the stored copy carries the trade details
      void getAlertHistory()
        .then((h) => {
          const stored = h.items.find((x) => x.id === given.id);
          if (stored) setRec(stored);
        })
        .catch(() => undefined);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setRec(null);
    window.addEventListener(OPEN_EVENT, on);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener(OPEN_EVENT, on);
      window.removeEventListener('keydown', onKey);
    };
  }, []);
  if (!rec) return null;
  return <AlertDetailSheet rec={rec} go={go} onClose={() => setRec(null)} />;
}

const rs = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `₹${formatNumberIN(v)}`);

function AlertDetailSheet({ rec, go, onClose }: { rec: AlertRecord; go: Go; onClose: () => void }) {
  const d = alertDetail(rec);
  const route = routeForAlert(rec.id);
  const icon = iconFor(rec);
  const title = rec.title.startsWith(icon) ? rec.title.slice(icon.length).trim() : rec.title;
  const reasons = d?.reasons.length ? d.reasons : [];
  const sell = d?.side === 'sell';
  const open = (to: ScreenId, param?: string) => {
    onClose();
    go(to, param);
  };

  return (
    <div class="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <section class="sheet alert-detail" role="dialog" aria-label="Alert details" data-testid="alert-detail">
        <header class="alert-detail-head">
          <span class="alert-detail-icon" aria-hidden="true">
            {icon}
          </span>
          <div class="alert-detail-name">
            <h2 data-testid="alert-detail-symbol">{d?.symbol || title}</h2>
            <span class="muted small">
              {d?.source ? `${d.source} · ` : ''}
              {formatDateTimeIST(rec.at)}
            </span>
          </div>
          {d && (
            <span class={`signal-chip ${sell ? 'sell' : 'buy'}`} data-testid="alert-detail-side">
              {sell ? '▼ SELL first' : '▲ BUY'}
            </span>
          )}
        </header>

        {d ? (
          <dl class="alert-detail-grid">
            <div>
              <dt>{sell ? 'Sell first at' : 'Entry price'}</dt>
              <dd data-field="entry">{rs(d.entry)}</dd>
            </div>
            <div>
              <dt>{sell ? 'Stop-loss (buy back if it rises to)' : 'Stop-loss'}</dt>
              <dd class="err-text" data-field="stop">
                {rs(d.stop)}
              </dd>
            </div>
            {(d.targets.length ? d.targets : [null]).map((t, i) => (
              <div>
                <dt>{d.targets.length > 1 ? `Target ${i + 1}` : 'Target'}</dt>
                <dd class="ok-text" data-field={`target${i + 1}`}>
                  {t === null ? (d.closeBy ? `the ${d.closeBy} close` : '—') : rs(t)}
                </dd>
              </div>
            ))}
            <div>
              <dt>Quantity</dt>
              <dd data-field="qty">{d.qty !== null ? `${d.qty.toLocaleString('en-IN')} shares` : '—'}</dd>
            </div>
            <div>
              <dt>Risk</dt>
              <dd data-field="risk">{d.risk !== null ? rs(d.risk) : '—'}</dd>
            </div>
            <div>
              <dt>{d.scoreKind === 'chance' ? 'Chance' : 'Score'}</dt>
              <dd data-field="score">{d.score === null ? '—' : d.scoreKind === 'chance' ? `${d.score}%` : `${d.score} / 100`}</dd>
            </div>
          </dl>
        ) : null}

        <div class="alert-detail-why">
          <h3>Why this alert</h3>
          {reasons.length ? (
            <ul data-testid="alert-detail-reasons">
              {reasons.map((r) => (
                <li>{r}</li>
              ))}
            </ul>
          ) : (
            <p class="small">{rec.message || title}</p>
          )}
        </div>

        <div class="alert-detail-text small">
          <b>{title}</b>
          {rec.message && <p>{rec.message}</p>}
        </div>
        {d?.closeBy && <p class="small muted">Close the trade by {d.closeBy}.</p>}
        {d && <p class="tiny muted">Not investment advice. TradeBuddy never places an order — you decide and place every real order yourself in Upstox.</p>}

        <div class="alert-detail-actions">
          {d?.key && (
            <button class="btn primary" type="button" data-testid="alert-detail-stock" onClick={() => open('stock', sell ? `${d.key}~short` : d.key)}>
              Open {d.symbol}
            </button>
          )}
          {SCREEN_NAME[route] && (
            <button class="btn" type="button" onClick={() => open(route as ScreenId)}>
              Open {SCREEN_NAME[route]}
            </button>
          )}
          <button class="btn" type="button" data-testid="alert-detail-close" onClick={onClose}>
            Close
          </button>
        </div>
      </section>
    </div>
  );
}
