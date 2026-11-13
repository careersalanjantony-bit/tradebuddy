import type { StockData } from '../../data/stockData';
import { formatNumberIN, formatPct } from '../../lib/format';
import { SetupBadge, Flags } from './Badges';
import { VerdictChip } from './Explain';
import { PLAIN_VERDICT, explainSnapshot, plainLine } from '../../advisor/explain';
import { useSettings } from '../hooks';

/** One compact stock line for the narrow side panel. */
export function StockRow({
  symbol,
  data,
  onOpen,
  actions,
  badge,
  signal,
}: {
  symbol: string;
  data: StockData | undefined;
  onOpen: () => void;
  actions?: preact.ComponentChildren;
  badge?: string;
  /** today's day-trade signal for this stock */
  signal?: { side: 'long' | 'short'; time: string };
}) {
  const s = data?.snapshot;
  const q = data?.quote;
  const price = s?.price ?? q?.ltp ?? null;
  const ch = s?.changePct ?? (q && q.prevClose ? (q.ltp / q.prevClose - 1) * 100 : null);
  const simple = (useSettings()?.ui.mode ?? 'simple') === 'simple';
  const verdict = s ? explainSnapshot(symbol, s).verdict : null;
  return (
    <div class="stock-row" data-symbol={symbol} data-trend={s?.trend ?? ''} data-verdict={verdict ?? ''} data-flags={s?.flags.join(',') ?? ''}>
      <button class="stock-main" type="button" onClick={onOpen}>
        <div class="line1">
          <b>{symbol}</b>
          <span class="exch" title="National Stock Exchange — all prices here are NSE prices">NSE</span>
          {signal && (
            <span class={`chip day ${signal.side === 'long' ? 'buy' : 'sell'}`} title="Day-trade signal (buy and sell the same day) — see the Day trade tab">
              {signal.side === 'long' ? '▲ BUY today' : '▼ SELL today'} {signal.time}
            </span>
          )}
          {badge && <span class="chip pick">{badge}</span>}
          <span class="px">
            <span class="price">{price !== null ? `₹${formatNumberIN(price)}` : '—'}</span>
            <span class={ch === null ? 'muted' : ch >= 0 ? 'ok-text' : 'err-text'}>{formatPct(ch)}</span>
          </span>
        </div>
        {s ? (
          simple ? (
            <div class="line2 plain">
              <span class={`chip verdict ${verdict === 'Good setup' ? 'good' : verdict === 'Wait' ? 'wait' : verdict === 'Avoid' || verdict === 'Check data' ? 'bad' : 'neutral'}`} data-verdict={verdict}>
                {PLAIN_VERDICT[verdict!]}
              </span>{' '}
              <span class="plain-text">{plainLine(s, verdict!)}</span>
            </div>
          ) : (
            <>
              <div class="line2">
                <VerdictChip verdict={verdict!} /> <span class="muted">{s.trend ?? 'trend —'}</span> <SetupBadge setup={s.setup} /> <Flags flags={s.flags} />
              </div>
              <div class="line3 muted">
                RSI {formatNumberIN(s.rsi14, 0)} · Stretch {formatNumberIN(s.stretch, 1)} · vs SMA20 {formatPct(s.distSma20Pct, 1)} · vs SMA200 {formatPct(s.distSma200Pct, 1)}
              </div>
            </>
          )
        ) : (
          <div class="line2 muted">{data && !data.raw.length ? 'Price history is still downloading — it appears here by itself.' : 'Loading…'}</div>
        )}
      </button>
      {actions && <div class="row-actions">{actions}</div>}
    </div>
  );
}
