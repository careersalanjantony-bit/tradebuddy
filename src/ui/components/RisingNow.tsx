import type { MeterLabel } from '../../data/flow';
import { formatNumberIN, formatPct, formatTimeIST } from '../../lib/format';
import { useInstrumentMap, useQuotes } from '../data';
import { useMarketState, useSessionValue } from '../hooks';
import { openTrade } from './TradeSheet';
import { BuyersBar } from './Motion';

export const meterTone = (l: MeterLabel): string => (l === 'Buyers strong' || l === 'More buyers' ? 'good' : l === 'Sellers strong' || l === 'More sellers' ? 'bad' : 'neutral');

/**
 * "Rising now" (owner: "analyse the active buyers and advise which stock to buy suddenly and sell soon"):
 * stocks rising from their open, above the day's average price, with more buyers than sellers and more
 * trading than usual. A list to WATCH — fast rises often fall back, so every practice buy gets a tight
 * safety sell price and a 3:10 pm exit.
 */
export function RisingNowCard() {
  const flow = useSessionValue('flow');
  const quotes = useQuotes();
  const byKey = useInstrumentMap();
  const market = useMarketState();
  if (market.phase !== 'open' && !flow?.rising.length) return null;
  const rows = flow?.rising ?? [];
  return (
    <section class="card" data-testid="rising-now">
      <div class="row">
        <h2 style={{ margin: 0 }}>Rising now</h2>
        <span class="spacer" />
        <span class="tiny muted">{flow ? `updated ${formatTimeIST(flow.at).slice(0, 8)}` : 'starts 9:20'}</span>
      </div>
      <p class="tiny muted" style={{ margin: '2px 0 8px' }}>
        Up from the open, above the day's average price, more buyers than sellers, busier than usual. <b>A list to watch, not a buy signal</b> — quick rises often fall back.
      </p>
      {rows.length === 0 ? (
        <p class="small muted">{flow?.error ? `Not available: ${flow.error}` : 'No stock fits all four right now.'}</p>
      ) : (
        <div class="holding-list">
          {rows.map((r) => {
            const sym = byKey.get(r.key)?.trading_symbol ?? r.key;
            const ltp = quotes[r.key]?.ltp ?? null;
            const vwap = flow?.stocks[r.key]?.vwap ?? null;
            // safety sell just under the day's average price (at most 1% below), target 1.5× that distance
            const stop = ltp ? Math.floor(Math.max(ltp * 0.99, Math.min(ltp * 0.997, (vwap ?? ltp) * 0.998)) * 20) / 20 : null;
            const target = ltp && stop ? Math.ceil((ltp + 1.5 * (ltp - stop)) * 20) / 20 : null;
            return (
              <div class="holding" data-symbol={sym}>
                <div class="row">
                  <b>{sym}</b>
                  <span class={`chip meter ${meterTone(r.meter.label)}`}>{r.meter.label}</span>
                  <span class="spacer" />
                  <span class="big-num">{ltp ? `₹${formatNumberIN(ltp)}` : ''}</span>
                </div>
                <BuyersBar share={r.meter.buyShare} />
                <div class="row small muted">
                  <span>
                    {formatPct(r.fromOpenPct, 2)} since the open · {formatPct(r.changePct, 2)} today
                    {r.pace ? ` · ${formatNumberIN(r.pace, 1)}× usual trading` : ''}
                  </span>
                  <span class="spacer" />
                  {ltp && stop && target && (
                    <button class="btn small buy" type="button" data-testid="rising-practice" onClick={() => openTrade({ key: r.key, symbol: sym, side: 'buy', stop, target, sellByClose: true, source: 'Rising now' })}>
                      Practice
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
