import { useEffect, useMemo, useState } from 'preact/hooks';
import type { Suggestion } from '../../background/botJobs';
import { STRATEGY_LABEL } from '../../bot/brain';
import { searchInstruments } from '../../data/instrumentsParse';
import { formatINR, formatNumberIN } from '../../lib/format';
import { errorMessage } from '../../lib/serialize';
import { callBackground } from '../../shared/messages';
import { availableCash, sellableQty, sharesFor, newWallet, type OrderSide, type OrderType } from '../../wallet/wallet';
import { useInstruments, useQuotes } from '../data';
import { useLocal, useMarketState } from '../hooks';
import { Icon } from './Icon';
import { buzz, toast } from './Motion';

/**
 * The Buy / Sell panel for practice money. Opens from anywhere: the Practice tab, a day-trade
 * signal, a top pick or a stock row. Prices are live; nothing is sent to Upstox.
 *
 * App v1.8: Sell is always available — it sells shares you hold, or (for a stock you do not hold)
 * sells first and buys back the same day. Both sides show suggestions ranked by the app's analysis.
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

const r2 = (x: number) => Math.round(x * 20) / 20;

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
  const [t1, setT1] = useState('');
  const [sellByClose, setSellByClose] = useState(prefill.sellByClose ?? false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [sugs, setSugs] = useState<{ side: OrderSide; items: Suggestion[]; open: boolean } | null>(null);
  const [sugsBusy, setSugsBusy] = useState(false);
  const [picked, setPicked] = useState<Suggestion | null>(null);

  const results = useMemo(() => (instruments && query.trim() ? searchInstruments(instruments.filter((i) => i.instrument_type === 'EQ'), query, 8) : []), [instruments, query]);
  const ltp = stock ? (quotes[stock.key]?.ltp ?? null) : null;
  const free = availableCash(wallet, quotes);
  const canSell = stock ? sellableQty(wallet, stock.key) : 0;
  // selling a stock you do not hold = selling first (same-day short)
  const sellFirst = side === 'sell' && !!stock && canSell === 0;
  const q = Math.floor(Number(qty) || 0);
  const px = type === 'limit' && !sellFirst ? Number(limit) || null : ltp;
  const cost = px && q ? px * q : null;
  const open = market.phase === 'open';
  const held = wallet.holdings.filter((h) => sellableQty(wallet, h.key) > 0);

  useEffect(() => {
    // a stock that is not followed yet gets prices as soon as it is chosen
    if (stock && ltp === null) void callBackground('quotes:refresh').catch(() => undefined);
  }, [stock?.key]);

  // suggestions for the chosen side (the app's own analysis)
  useEffect(() => {
    if (prefill.key) return;
    let alive = true;
    setSugsBusy(true);
    void callBackground('ideas:suggest', { side: side === 'buy' ? 'buy' : 'sell' })
      .then((r) => alive && setSugs({ side, items: r.items, open: r.marketOpen }))
      .catch(() => alive && setSugs({ side, items: [], open }))
      .finally(() => alive && setSugsBusy(false));
    return () => {
      alive = false;
    };
  }, [side]);

  /** Fills the form from a suggestion: prices from the plan, size so the loss at the safety net is about 1 % of the practice money. */
  const use = (s: Suggestion) => {
    setPicked(s);
    setStock({ key: s.key, symbol: s.symbol });
    setType('market');
    const per = Math.abs(s.price - s.stop);
    const byRisk = per > 0 ? Math.floor((wallet.startCash * 0.01) / per) : 0;
    const byCash = Math.floor((free * 0.98) / (s.price * 1.002));
    setQty(String(Math.max(1, Math.min(byRisk || byCash, byCash))));
    setStop(String(s.stop));
    if (s.side === 'buy') {
      setTarget(String(s.target));
      setSellByClose(s.sameDay);
    } else {
      setT1(String(s.t1 ?? r2(s.price - (s.stop - s.price))));
      setTarget(String(s.target));
    }
  };

  const submit = async () => {
    if (!stock) return setMsg({ ok: false, text: 'Choose a stock first.' });
    setBusy(true);
    setMsg(null);
    try {
      if (sellFirst) {
        if (!open) throw new Error('Selling first works only while the market is open (9:15 am – 3:10 pm).');
        const price = ltp ?? 0;
        const sp = Number(stop);
        if (!(sp > price)) throw new Error('Set "buy back if it rises to" above the current price — it is your safety net.');
        const R = sp - price;
        const tgt1 = Number(t1) || r2(price - R);
        const tgt2 = Number(target) || r2(price - 2 * R);
        const r = await callBackground('wallet:short', { key: stock.key, symbol: stock.symbol, qty: q, stop: sp, t1: tgt1, t2: tgt2, source: prefill.source ?? (picked ? 'Suggestion' : 'Practice') });
        setMsg({ ok: true, text: `Sold ${q} ${stock.symbol} first at ₹${formatNumberIN(r.price)} (practice money). It is bought back by itself at the targets, the safety net or 3:10 pm.` });
        toast(`Sold ${q} ${stock.symbol} first`);
        void buzz('success');
        setTimeout(onClose, 1800);
        return;
      }
      const r = await callBackground('wallet:order', {
        key: stock.key,
        symbol: stock.symbol,
        side,
        qty: q,
        type,
        ...(type === 'limit' ? { limitPrice: Number(limit) } : {}),
        ...(side === 'buy' ? { stop: stop ? Number(stop) : null, target: target ? Number(target) : null, sellByClose } : {}),
        ...(prefill.source ? { source: prefill.source } : picked ? { source: 'Suggestion' } : {}),
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

  const shownSugs = sugs && sugs.side === side ? sugs.items : [];

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
          <button type="button" class={side === 'buy' ? 'on buy' : ''} data-testid="side-buy" onClick={() => (setSide('buy'), setPicked(null))}>
            <Icon name="up" size={16} /> Buy
          </button>
          <button type="button" class={side === 'sell' ? 'on sell' : ''} data-testid="side-sell" onClick={() => (setSide('sell'), setPicked(null))}>
            <Icon name="down" size={16} /> Sell
          </button>
        </div>

        {side === 'sell' && !stock && held.length > 0 && (
          <div class="held-picks">
            <div class="tiny muted">Sell your shares</div>
            <div class="quick-amounts">
              {held.map((h) => (
                <button type="button" class="chip-btn" data-testid="held-pick" onClick={() => setStock({ key: h.key, symbol: h.symbol })}>
                  {h.symbol} · {h.qty}
                </button>
              ))}
            </div>
          </div>
        )}

        {!prefill.key && !stock && (
          <div class="sugs" data-testid="trade-suggestions">
            <div class="row tiny">
              <b>{side === 'buy' ? 'Suggested buys' : 'Suggested sell-first (buy back lower, same day)'}</b>
              <span class="spacer" />
              <span class="muted">{sugsBusy ? 'studying…' : sugs && !sugs.open ? 'market closed — for the next session' : 'live'}</span>
            </div>
            {!sugsBusy && shownSugs.length === 0 && (
              <p class="tiny muted" style={{ margin: '4px 0' }}>
                {side === 'buy' ? 'No buy idea strong enough right now. Ideas appear during market hours (day-trade signals from 9:35, rising stocks, top picks).' : 'No sell-first idea right now. They appear during market hours when a stock falls below its opening price with a weak trend.'}
              </p>
            )}
            {shownSugs.map((s) => (
              <button type="button" class={`sug ${s.side}`} data-testid="suggestion" data-symbol={s.symbol} onClick={() => use(s)}>
                <span class="sug-top">
                  <b>{s.symbol}</b>
                  <span class="tiny muted">{STRATEGY_LABEL[s.kind]}</span>
                  <span class="spacer" />
                  <span class={`sug-chance ${s.side}`}>{Math.round(s.chance * 100)}%</span>
                </span>
                <span class="tiny sug-plan">
                  {s.side === 'buy' ? 'Buy' : 'Sell first'} ₹{formatNumberIN(s.price)} · {s.side === 'buy' ? 'sell if it falls to' : 'buy back if it rises to'} ₹{formatNumberIN(s.stop)} · target ₹{formatNumberIN(s.side === 'sell' && s.t1 ? s.t1 : s.target)}
                  {s.when === 'next-session' ? ' · next session' : ''}
                </span>
                <span class="tiny muted sug-why">
                  {s.reasons.slice(0, 2).join(' · ')}
                  {s.news ? ` · ${s.news === 'good' ? '👍 good news' : '👎 bad news'}` : ''}
                </span>
              </button>
            ))}
          </div>
        )}

        {stock ? (
          <div class="row stock-pick" data-testid="trade-stock">
            <b>{stock.symbol}</b> <span class="exch">NSE</span>
            {picked && <span class={`sug-chance ${picked.side}`}>{Math.round(picked.chance * 100)}%</span>}
            <span class="spacer" />
            <span class="big-num">{ltp ? `₹${formatNumberIN(ltp)}` : 'price loading…'}</span>
            {!prefill.key && (
              <button class="link-btn small" type="button" onClick={() => (setStock(null), setPicked(null))}>
                change
              </button>
            )}
          </div>
        ) : (
          <label class="field">
            <span>{side === 'buy' ? 'Or find a stock' : 'Or find any stock to sell first'}</span>
            <input value={query} placeholder="Type a name, e.g. TATA or RELIANCE" data-field="trade-search" onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)} />
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

        {sellFirst && (
          <div class="banner info small" data-testid="sell-first-note">
            <b>Sell first:</b> you do not hold {stock!.symbol}, so this sells first and buys back the same day (like Upstox <b>Intraday</b>). It is bought back by itself at your targets, at the safety net, or at 3:10 pm. Practice money is set aside for it.
            {!open && <div class="err-text">The market is closed — selling first works from 9:15 am to 3:10 pm.</div>}
          </div>
        )}

        <div class="grid2">
          <label class="field">
            <span>Number of shares</span>
            <input type="number" min="1" step="1" inputMode="numeric" value={qty} data-field="trade-qty" onInput={(e) => setQty((e.currentTarget as HTMLInputElement).value)} />
          </label>
          {!sellFirst ? (
            <label class="field">
              <span>Price</span>
              <select value={type} data-field="trade-type" onChange={(e) => setType((e.currentTarget as HTMLSelectElement).value as OrderType)}>
                <option value="market">Market (live price)</option>
                <option value="limit">Limit (my price)</option>
              </select>
            </label>
          ) : (
            <label class="field">
              <span>Price</span>
              <input value="Market (live price)" disabled />
            </label>
          )}
        </div>
        {(side === 'buy' || sellFirst) && ltp && (
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
        {type === 'limit' && !sellFirst && (
          <label class="field">
            <span>{side === 'buy' ? 'Buy when the price falls to (₹)' : 'Sell when the price rises to (₹)'}</span>
            <input type="number" step="0.05" min="0" value={limit} data-field="trade-limit" onInput={(e) => setLimit((e.currentTarget as HTMLInputElement).value)} />
          </label>
        )}
        {side === 'buy' && (
          <details class="small" open={!!(prefill.stop || prefill.target || picked)}>
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
        {sellFirst && (
          <div class="grid3">
            <label class="field">
              <span>Buy back if it rises to ₹</span>
              <input type="number" step="0.05" min="0" value={stop} data-field="short-stop" onInput={(e) => setStop((e.currentTarget as HTMLInputElement).value)} />
            </label>
            <label class="field">
              <span>Target 1 (half) ₹</span>
              <input type="number" step="0.05" min="0" value={t1} placeholder="auto" data-field="short-t1" onInput={(e) => setT1((e.currentTarget as HTMLInputElement).value)} />
            </label>
            <label class="field">
              <span>Target 2 (rest) ₹</span>
              <input type="number" step="0.05" min="0" value={target} placeholder="auto" data-field="short-t2" onInput={(e) => setTarget((e.currentTarget as HTMLInputElement).value)} />
            </label>
          </div>
        )}

        <div class="trade-summary small">
          {side === 'buy' || sellFirst ? (
            <>
              {cost ? (
                <>
                  {sellFirst ? 'Sets aside' : 'Costs'} about <b>{formatINR(cost, 0)}</b> ·{' '}
                </>
              ) : null}
              free practice money <b>{formatINR(free, 0)}</b>
              {stop && ltp && q ? (
                <>
                  {' '}
                  · most you lose ≈ <b>{formatINR(Math.abs(ltp - Number(stop)) * q, 0)}</b>
                </>
              ) : null}
            </>
          ) : (
            <>You own {canSell} shares{cost ? <> · worth about <b>{formatINR(cost, 0)}</b></> : null}</>
          )}
          {!open && !sellFirst && <div class="muted">Market closed: a market order waits for the next opening price.</div>}
        </div>
        <button class={`btn primary block ${side}`} type="button" disabled={busy || !stock || q < 1 || (sellFirst && !open)} data-testid="trade-submit" onClick={() => void submit()}>
          {busy ? 'Placing…' : `${side === 'buy' ? 'Buy' : sellFirst ? 'Sell first' : 'Sell'}${q ? ` ${q}` : ''}${stock ? ` ${stock.symbol}` : ''} (practice)`}
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
