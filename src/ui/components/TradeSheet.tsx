import { useEffect, useMemo, useState } from 'preact/hooks';
import { searchInstruments } from '../../data/instrumentsParse';
import { formatINR, formatNumberIN } from '../../lib/format';
import { errorMessage } from '../../lib/serialize';
import { callBackground } from '../../shared/messages';
import { availableCash, sellableQty, sharesFor, newWallet, type OrderSide, type OrderType } from '../../wallet/wallet';
import { useInstruments, useQuotes } from '../data';
import { useLocal, useMarketState } from '../hooks';
import { buzz, toast } from './Motion';

/**
 * The Buy / Sell panel for practice money. Opens from anywhere: the Practice tab, a day-trade
 * signal, a top pick or a stock row. Prices are live; nothing is sent to Upstox.
 */

export interface TradePrefill {
  key?: string;
  symbol?: string;
  side?: OrderSide;
  qty?: number;
  stop?: number | null;
  target?: number | null;
  sellByClose?: boolean;
  source?: string;
}

const EVENT = 'tb-trade';
export function openTrade(prefill: TradePrefill = {}): void {
  window.dispatchEvent(new CustomEvent<TradePrefill>(EVENT, { detail: prefill }));
}

export function TradeSheetHost() {
  const [prefill, setPrefill] = useState<TradePrefill | null>(null);
  useEffect(() => {
    const on = (e: Event) => setPrefill((e as CustomEvent<TradePrefill>).detail ?? {});
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  if (!prefill) return null;
  return <TradeSheet prefill={prefill} onClose={() => setPrefill(null)} />;
}

function TradeSheet({ prefill, onClose }: { prefill: TradePrefill; onClose: () => void }) {
  const instruments = useInstruments();
  const quotes = useQuotes();
  const market = useMarketState();
  const wallet = useLocal('wallet') ?? newWallet(Date.now());
  const [side, setSide] = useState<OrderSide>(prefill.side ?? 'buy');
  const [stock, setStock] = useState<{ key: string; symbol: string } | null>(prefill.key && prefill.symbol ? { key: prefill.key, symbol: prefill.symbol } : null);
  const [query, setQuery] = useState('');
  const [type, setType] = useState<OrderType>('market');
  const [qty, setQty] = useState(prefill.qty ? String(prefill.qty) : '');
  const [limit, setLimit] = useState('');
  const [stop, setStop] = useState(prefill.stop ? String(prefill.stop) : '');
  const [target, setTarget] = useState(prefill.target ? String(prefill.target) : '');
  const [sellByClose, setSellByClose] = useState(prefill.sellByClose ?? false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const results = useMemo(() => (instruments && query.trim() ? searchInstruments(instruments.filter((i) => i.instrument_type === 'EQ'), query, 8) : []), [instruments, query]);
  const ltp = stock ? (quotes[stock.key]?.ltp ?? null) : null;
  const free = availableCash(wallet, quotes);
  const canSell = stock ? sellableQty(wallet, stock.key) : 0;
  const q = Math.floor(Number(qty) || 0);
  const px = type === 'limit' ? Number(limit) || null : ltp;
  const cost = px && q ? px * q : null;
  const open = market.phase === 'open';

  useEffect(() => {
    // a stock that is not followed yet gets prices as soon as it is chosen
    if (stock && ltp === null) void callBackground('quotes:refresh').catch(() => undefined);
  }, [stock?.key]);

  const submit = async () => {
    if (!stock) return setMsg({ ok: false, text: 'Choose a stock first.' });
    setBusy(true);
    setMsg(null);
    try {
      const r = await callBackground('wallet:order', {
        key: stock.key,
        symbol: stock.symbol,
        side,
        qty: q,
        type,
        ...(type === 'limit' ? { limitPrice: Number(limit) } : {}),
        ...(side === 'buy' ? { stop: stop ? Number(stop) : null, target: target ? Number(target) : null, sellByClose } : {}),
        ...(prefill.source ? { source: prefill.source } : {}),
      });
      const verb = side === 'buy' ? 'Bought' : 'Sold';
      setMsg({
        ok: true,
        text:
          r.filledAt !== undefined
            ? `${verb} ${q} ${stock.symbol} at ₹${formatNumberIN(r.filledAt)} (practice money).`
            : r.order.atOpen
              ? `Order placed: it ${side === 'buy' ? 'buys' : 'sells'} at the next opening price (market closed now).`
              : `Order placed: it ${side === 'buy' ? 'buys' : 'sells'} when the price reaches ₹${formatNumberIN(Number(limit))}.`,
      });
      // sales are announced with their result by the app (one message per sale)
      if (side === 'buy' || r.filledAt === undefined) toast(r.filledAt !== undefined ? `${verb} ${q} ${stock.symbol}` : 'Order placed');
      void buzz('success');
      setTimeout(onClose, 1600);
    } catch (err) {
      setMsg({ ok: false, text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <section class="sheet" role="dialog" aria-label="Practice trade" data-testid="trade-sheet">
        <div class="row">
          <h2 style={{ margin: 0 }}>Practice trade</h2>
          <span class="spacer" />
          <button class="link-btn" type="button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <p class="tiny muted" style={{ margin: '2px 0 8px' }}>
          Pretend money · live prices · nothing is sent to Upstox
        </p>
        <div class="seg" role="tablist">
          <button type="button" class={side === 'buy' ? 'on buy' : ''} data-testid="side-buy" onClick={() => setSide('buy')}>
            Buy
          </button>
          <button type="button" class={side === 'sell' ? 'on sell' : ''} data-testid="side-sell" onClick={() => setSide('sell')}>
            Sell
          </button>
        </div>

        {stock ? (
          <div class="row stock-pick" data-testid="trade-stock">
            <b>{stock.symbol}</b> <span class="exch">NSE</span>
            <span class="spacer" />
            <span class="big-num">{ltp ? `₹${formatNumberIN(ltp)}` : 'price loading…'}</span>
            {!prefill.key && (
              <button class="link-btn small" type="button" onClick={() => setStock(null)}>
                change
              </button>
            )}
          </div>
        ) : (
          <label class="field">
            <span>Stock</span>
            <input value={query} placeholder="Type a name, e.g. TATA or RELIANCE" data-field="trade-search" onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)} autoFocus />
            {results.length > 0 && (
              <div class="results">
                {results.map((i) => (
                  <button type="button" class="result" onClick={() => (setStock({ key: i.instrument_key, symbol: i.trading_symbol }), setQuery(''))}>
                    <b>{i.trading_symbol}</b> <span class="muted small">{i.name}</span>
                  </button>
                ))}
              </div>
            )}
          </label>
        )}

        <div class="grid2">
          <label class="field">
            <span>Number of shares</span>
            <input type="number" min="1" step="1" inputMode="numeric" value={qty} data-field="trade-qty" onInput={(e) => setQty((e.currentTarget as HTMLInputElement).value)} />
          </label>
          <label class="field">
            <span>Price</span>
            <select value={type} data-field="trade-type" onChange={(e) => setType((e.currentTarget as HTMLSelectElement).value as OrderType)}>
              <option value="market">Market (live price)</option>
              <option value="limit">Limit (my price)</option>
            </select>
          </label>
        </div>
        {side === 'buy' && ltp && (
          <div class="quick-amounts">
            {[10_000, 25_000, 50_000, 100_000].map((a) => (
              <button type="button" class="chip-btn" onClick={() => setQty(String(sharesFor(a, ltp)))}>
                ₹{a >= 100_000 ? `${a / 100_000}L` : `${a / 1000}k`}
              </button>
            ))}
          </div>
        )}
        {side === 'sell' && stock && canSell > 0 && (
          <div class="quick-amounts">
            <button type="button" class="chip-btn" onClick={() => setQty(String(canSell))}>
              All {canSell} shares
            </button>
          </div>
        )}
        {type === 'limit' && (
          <label class="field">
            <span>{side === 'buy' ? 'Buy when the price falls to (₹)' : 'Sell when the price rises to (₹)'}</span>
            <input type="number" step="0.05" min="0" value={limit} data-field="trade-limit" onInput={(e) => setLimit((e.currentTarget as HTMLInputElement).value)} />
          </label>
        )}
        {side === 'buy' && (
          <details class="small" open={!!(prefill.stop || prefill.target)}>
            <summary>Safety net and take-profit (recommended)</summary>
            <div class="grid2">
              <label class="field">
                <span>Sell if it falls to ₹</span>
                <input type="number" step="0.05" min="0" value={stop} data-field="trade-stop" onInput={(e) => setStop((e.currentTarget as HTMLInputElement).value)} />
              </label>
              <label class="field">
                <span>Take profit at ₹</span>
                <input type="number" step="0.05" min="0" value={target} data-field="trade-target" onInput={(e) => setTarget((e.currentTarget as HTMLInputElement).value)} />
              </label>
            </div>
            <label class="row small" style={{ gap: '6px' }}>
              <input type="checkbox" checked={sellByClose} data-field="trade-sellbyclose" onChange={(e) => setSellByClose((e.currentTarget as HTMLInputElement).checked)} />
              Day trade: sell by itself at 3:10 pm (untick to keep it overnight)
            </label>
          </details>
        )}

        <div class="trade-summary small">
          {side === 'buy' ? (
            <>
              {cost ? <>Costs about <b>{formatINR(cost, 0)}</b> · </> : null}free practice money <b>{formatINR(free, 0)}</b>
            </>
          ) : (
            <>You own {canSell} shares{cost ? <> · worth about <b>{formatINR(cost, 0)}</b></> : null}</>
          )}
          {!open && <div class="muted">Market closed: a market order waits for the next opening price.</div>}
        </div>
        <button class={`btn primary block ${side}`} type="button" disabled={busy || !stock || q < 1} data-testid="trade-submit" onClick={() => void submit()}>
          {busy ? 'Placing…' : `${side === 'buy' ? 'Buy' : 'Sell'}${q ? ` ${q}` : ''}${stock ? ` ${stock.symbol}` : ''} (practice)`}
        </button>
        {msg && (
          <p class={`small ${msg.ok ? 'ok-text' : 'err-text'}`} data-testid="trade-msg">
            {msg.text}
          </p>
        )}
      </section>
    </div>
  );
}
