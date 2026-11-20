import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Suggestion } from '../../background/botJobs';
import { STRATEGY_LABEL } from '../../bot/brain';
import { searchInstruments } from '../../data/instrumentsParse';
import { formatINR, formatNumberIN, formatTimeIST } from '../../lib/format';
import { errorMessage } from '../../lib/serialize';
import { callBackground } from '../../shared/messages';
import { termsFor } from '../../wallet/tiers';
import {
  availableCash,
  estimateCharges,
  mtfDailyInterest,
  newWallet,
  orderNeeds,
  PRODUCT_LABEL,
  sellableQty,
  sharesFor,
  SQUARE_OFF_CHARGE,
  type OrderSide,
  type OrderType,
  type Product,
  type Validity,
} from '../../wallet/wallet';
import { useInstruments, useQuotes } from '../data';
import { useLocal, useMarketState, useNow } from '../hooks';
import { priceView } from '../priceView';
import { Icon } from './Icon';
import { buzz, toast } from './Motion';

/**
 * The Buy / Sell window for practice money, laid out like Upstox's (app v1.10): product (Delivery,
 * Intraday with leverage, MTF), order type (Market, Limit, SL, SL-M), quantity, prices, validity
 * (Day / IOC), optional stop-loss and target, and the money: margin needed, what is free and the
 * balance after this order. Opens from anywhere; prices are live; nothing is sent to Upstox.
 */

export interface TradePrefill {
  key?: string;
  symbol?: string;
  side?: OrderSide;
  qty?: number;
  stop?: number | null;
  target?: number | null;
  /** app v1.20: sell-first target 1 (half) */
  t1?: number | null;
  sellByClose?: boolean;
  source?: string;
  product?: Product;
}

const EVENT = 'tb-trade';
/**
 * Review fix (1.20.2): price boxes are plain decimal text boxes. A phone's number box could reset or
 * re-format a price while it was typed (the order window refreshes with every live price), which made a
 * trigger like 247.05 hard to enter. Keeps digits and one decimal point; commas (₹1,500) are dropped.
 */
export function decimalText(v: string): string {
  const s = v.replace(/[^0-9.]/g, '');
  const i = s.indexOf('.');
  return i < 0 ? s : s.slice(0, i + 1) + s.slice(i + 1).replace(/\./g, '');
}

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
const PRODUCTS: Product[] = ['delivery', 'intraday', 'mtf'];
/** app v1.20: the price request gives up after this long and offers Retry */
const PRICE_TIMEOUT_MS = 12_000;

/** Waits for a promise at most `ms`. */
const within = <T,>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Upstox did not answer within ${Math.round(ms / 1000)} seconds.`)), ms))]);
const TYPES: Array<[OrderType, string]> = [
  ['market', 'Market'],
  ['limit', 'Limit'],
  ['sl', 'SL'],
  ['slm', 'SL-M'],
];

/** One plain line under each product. */
function productHelp(p: Product, side: OrderSide, leverage: number, sellFirst: boolean): string {
  if (sellFirst) return `Sell first, buy back the same day. You set aside only ${Math.round(100 / leverage)}% as margin (${leverage}×). Upstox squares off at 3:20 pm.`;
  if (p === 'delivery') return side === 'buy' ? 'Pay the full price. The shares are yours — keep them as long as you like.' : 'Sell shares you hold in Delivery.';
  if (p === 'intraday') return side === 'buy' ? `Pay only ${Math.round(100 / leverage)}% now (${leverage}× leverage) — buy and sell today. Upstox closes it at 3:20 pm if you do not.` : 'Close your Intraday shares (sell them today).';
  return side === 'buy' ? `Pay ${Math.round(100 / leverage)}% (${leverage}×); Upstox lends the rest at ₹20 a day per ₹40,000. Keep it for days — interest runs every day.` : 'Sell your MTF shares: the loan is repaid from the sale.';
}

function typeHelp(t: OrderType, side: OrderSide): string {
  const buy = side === 'buy';
  if (t === 'market') return buy ? 'Buys now at the live price.' : 'Sells now at the live price.';
  if (t === 'limit') return buy ? 'Buys only at your price or lower — waits until then.' : 'Sells only at your price or higher — waits until then.';
  if (t === 'sl') return buy ? 'Stop-loss: waits until the price RISES to the trigger, then buys at your limit price or lower.' : 'Stop-loss: waits until the price FALLS to the trigger, then sells at your limit price or higher.';
  return buy ? 'Stop-loss market: when the price RISES to the trigger, buys at the market price.' : 'Stop-loss market: when the price FALLS to the trigger, sells at the market price.';
}

function TradeSheet({ prefill, onClose }: { prefill: TradePrefill; onClose: () => void }) {
  const instruments = useInstruments();
  const quotes = useQuotes();
  const market = useMarketState();
  const wallet = useLocal('wallet') ?? newWallet(Date.now());
  const [side, setSide] = useState<OrderSide>(prefill.side ?? 'buy');
  const [stock, setStock] = useState<{ key: string; symbol: string } | null>(prefill.key && prefill.symbol ? { key: prefill.key, symbol: prefill.symbol } : null);
  const [query, setQuery] = useState('');
  // day-trade ideas are bought Intraday (like the Upstox steps say); everything else in Delivery
  const [product, setProduct] = useState<Product>(prefill.product ?? (prefill.side !== 'sell' && prefill.sellByClose ? 'intraday' : 'delivery'));
  const [type, setType] = useState<OrderType>('market');
  const [validity, setValidity] = useState<Validity>('day');
  const [qty, setQty] = useState(prefill.qty ? String(prefill.qty) : '');
  const [limit, setLimit] = useState('');
  const [trigger, setTrigger] = useState('');
  const [stop, setStop] = useState(prefill.stop ? String(prefill.stop) : '');
  const [target, setTarget] = useState(prefill.target ? String(prefill.target) : '');
  const [t1, setT1] = useState(prefill.t1 ? String(prefill.t1) : '');
  const [sellByClose, setSellByClose] = useState(prefill.sellByClose ?? (prefill.product === 'intraday' ? true : false));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [sugs, setSugs] = useState<{ side: OrderSide; items: Suggestion[]; open: boolean } | null>(null);
  const [sugsBusy, setSugsBusy] = useState(false);
  const [picked, setPicked] = useState<Suggestion | null>(null);

  const results = useMemo(() => (instruments && query.trim() ? searchInstruments(instruments.filter((i) => i.instrument_type === 'EQ'), query, 8) : []), [instruments, query]);
  const quote = stock ? quotes[stock.key] : undefined;
  const quotesRef = useRef(quotes);
  quotesRef.current = quotes;
  const open = market.phase === 'open';
  // app v1.20: the chosen stock's live price — fetched for any stock (followed or not), kept live while
  // the window is open, never shown when stale; an error offers Retry
  const now = useNow(1_000);
  const marketLive = open || market.phase === 'pre_open';
  const [priceBusy, setPriceBusy] = useState(false);
  const [priceErr, setPriceErr] = useState<string | null>(null);
  const loadSeq = useRef(0);
  const loadPrice = (key: string) => {
    const seq = ++loadSeq.current;
    setPriceBusy(true);
    setPriceErr(null);
    void within(callBackground('quotes:watch', { key }), PRICE_TIMEOUT_MS)
      .then((r) => {
        if (seq === loadSeq.current && !r.ok) setPriceErr(r.error ?? 'No price from Upstox.');
      })
      .catch((e: unknown) => seq === loadSeq.current && setPriceErr(errorMessage(e)))
      .finally(() => seq === loadSeq.current && setPriceBusy(false));
  };
  const pv = priceView(quote, marketLive, now, priceBusy, priceErr);
  const ltp = pv.ltp;
  const prev = quote?.prevClose ?? null;
  const free = availableCash(wallet, quotes);
  const q = Math.floor(Number(qty) || 0);

  // what this stock is held as (Upstox keeps Delivery, Intraday and MTF apart)
  const heldIn = (p: Product) => (stock ? sellableQty(wallet, stock.key, p) : 0);
  const short = stock ? (wallet.shorts ?? []).find((s) => s.key === stock.key) : undefined;
  const intradayLong = stock ? wallet.holdings.some((h) => h.key === stock.key && h.product === 'intraday') : false;
  // selling a stock not held Intraday = selling first (an Intraday short)
  const sellFirst = side === 'sell' && product === 'intraday' && !!stock && !intradayLong;
  // buying back a sell-first trade
  const covering = side === 'buy' && product === 'intraday' && !!short;
  const terms = stock ? termsFor(product, stock.key) : termsFor(product, '');
  const held = wallet.holdings.filter((h) => sellableQty(wallet, h.key, h.product ?? 'delivery') > 0);

  // the Sell side offers only what you hold, plus Intraday "sell first"
  const sellProducts: Product[] = stock ? PRODUCTS.filter((p) => p === 'intraday' || heldIn(p) > 0) : PRODUCTS;
  useEffect(() => {
    if (side !== 'sell' || !stock) return;
    if (!sellProducts.includes(product)) setProduct(sellProducts[0]!);
    else if (heldIn(product) === 0 && product !== 'intraday') setProduct(heldIn('delivery') > 0 ? 'delivery' : heldIn('mtf') > 0 ? 'mtf' : 'intraday');
  }, [side, stock?.key]);
  // a held stock opened for selling: its product with its shares
  useEffect(() => {
    if (side !== 'sell' || !stock || prefill.product) return;
    const best = (['intraday', 'mtf', 'delivery'] as Product[]).find((p) => heldIn(p) > 0);
    if (best) setProduct(best);
  }, [stock?.key]);
  useEffect(() => {
    // app v1.20: every chosen stock gets its price at once and stays live while the window is open (the
    // old refresh polled only followed stocks, so a stock from the Intraday list stayed "price loading…")
    if (!stock) {
      loadSeq.current++;
      setPriceBusy(false);
      setPriceErr(null);
      return undefined;
    }
    loadPrice(stock.key);
    // still no fresh price (e.g. the feed missed it): ask again every 15 seconds
    const t = setInterval(() => {
      const q = quotesRef.current[stock.key];
      if (!q || Date.now() - q.fetchedAt > 20_000) loadPrice(stock.key);
    }, 15_000);
    return () => clearInterval(t);
  }, [stock?.key]);
  useEffect(() => {
    // Intraday: close by itself at 3:10 pm unless you untick it; other products keep their own choice
    if (product === 'intraday') setSellByClose(true);
    else if (!prefill.sellByClose) setSellByClose(false);
  }, [product]);

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
    const p: Product = s.side === 'sell' || s.sameDay ? 'intraday' : 'delivery';
    setProduct(p);
    const m = termsFor(p, s.key).marginPct;
    const per = Math.abs(s.price - s.stop);
    const byRisk = per > 0 ? Math.floor((wallet.startCash * 0.01) / per) : 0;
    const byCash = Math.floor((free * 0.98) / (s.price * 1.002 * m));
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

  // the price the money is worked out at
  const px = type === 'market' ? ltp : type === 'slm' ? Number(trigger) || ltp : Number(limit) || null;
  const value = px && q ? px * q : 0;
  const marginPct = terms.marginPct;
  const needs = (side === 'buy' && !covering) || sellFirst ? orderNeeds(px ?? 0, q, marginPct) : 0;
  // an order that waits (market closed, or a limit / stop-loss) keeps money aside like the Practice tab
  // shows it: a market or SL-M order + 1 % in case it fills a little higher
  const waits = !open || type !== 'market';
  const keptAside = waits && (type === 'market' || type === 'slm') ? needs * 1.01 : needs;
  const after = free - keptAside;
  const charges = px && q ? estimateCharges(product, q, px) : 0;
  const funded = product === 'mtf' && side === 'buy' ? value - needs : 0;
  const position = stock && side === 'sell' && !sellFirst ? wallet.holdings.find((h) => h.key === stock.key && (h.product ?? 'delivery') === product) : undefined;
  const canSell = stock && side === 'sell' && !sellFirst ? heldIn(product) : 0;
  const leverage = terms.leverage;

  const submit = async () => {
    if (!stock) return setMsg({ ok: false, text: 'Choose a stock first.' });
    setBusy(true);
    setMsg(null);
    try {
      if (sellFirst && type === 'market' && stop && (t1 || target) && open) {
        // the classic sell-first plan: buy back half at target 1, the rest at target 2, by 3:10 pm
        const price = ltp ?? 0;
        const sp = Number(stop);
        if (!(sp > price)) throw new Error('Set "buy back if it rises to" above the current price — it is your safety net.');
        const R = sp - price;
        const tgt1 = Number(t1) || r2(price - R);
        const tgt2 = Number(target) || r2(price - 2 * R);
        const r = await callBackground('wallet:short', { key: stock.key, symbol: stock.symbol, qty: q, stop: sp, t1: tgt1, t2: tgt2, source: prefill.source ?? (picked ? 'Suggestion' : 'Practice') });
        setMsg({ ok: true, text: `Sold ${q} ${stock.symbol} first at ₹${formatNumberIN(r.price)} (Intraday, practice money). It is bought back by itself at the targets, at the safety net, or at 3:10 pm.` });
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
        product,
        ...(type === 'limit' || type === 'sl' ? { limitPrice: Number(limit) } : {}),
        ...(type === 'sl' || type === 'slm' ? { trigger: Number(trigger) } : {}),
        ...(validity === 'ioc' ? { validity } : {}),
        ...(side === 'buy' && !covering ? { stop: stop ? Number(stop) : null, target: target ? Number(target) : null, sellByClose } : {}),
        ...(sellFirst ? { stop: stop ? Number(stop) : null, target: target ? Number(target) : null, t1: t1 ? Number(t1) : null, sellByClose } : {}),
        ...(prefill.source ? { source: prefill.source } : picked ? { source: 'Suggestion' } : {}),
      });
      const verb = side === 'buy' ? (covering ? 'Bought back' : 'Bought') : sellFirst ? 'Sold first' : 'Sold';
      const balance = r.cashAfter !== undefined ? ` Balance now ${formatINR(r.free, 0)} free.` : '';
      const st = r.order.status;
      setMsg({
        ok: st !== 'cancelled' && st !== 'rejected',
        text:
          r.filledAt !== undefined
            ? `${verb} ${q} ${stock.symbol} at ₹${formatNumberIN(r.filledAt)} (${PRODUCT_LABEL[product]}, practice money).${balance}`
            : st === 'cancelled'
              ? (r.order.note ?? 'The order was cancelled.')
              : r.order.atOpen || r.order.amo
                ? `After-market order placed: it works when the market opens (${type === 'market' ? 'at the opening price' : type === 'limit' ? `at ₹${formatNumberIN(Number(limit))} or better` : `when the price reaches ₹${formatNumberIN(Number(trigger))}`}).`
                : type === 'limit'
                  ? `Order placed: it ${side === 'buy' ? 'buys' : 'sells'} when the price reaches ₹${formatNumberIN(Number(limit))}.`
                  : `Stop-loss order placed: it wakes up when the price ${side === 'buy' ? 'rises' : 'falls'} to ₹${formatNumberIN(Number(trigger))}.`,
      });
      // sales are announced with their result by the app (one message per sale)
      if (side === 'buy' || r.filledAt === undefined) toast(r.filledAt !== undefined ? `${verb} ${q} ${stock.symbol}` : st === 'cancelled' ? 'Order cancelled' : 'Order placed');
      void buzz('success');
      if (st !== 'cancelled') setTimeout(onClose, 1800);
    } catch (err) {
      setMsg({ ok: false, text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const shownSugs = sugs && sugs.side === side ? sugs.items : [];
  const productChoices = side === 'sell' ? sellProducts : PRODUCTS;
  const change = ltp && prev ? (ltp / prev - 1) * 100 : null;
  const label = `${side === 'buy' ? (covering ? 'Buy back' : 'Buy') : sellFirst ? 'Sell first' : 'Sell'}${q ? ` ${q}` : ''}${stock ? ` ${stock.symbol}` : ''} · ${PRODUCT_LABEL[product]}`;

  return (
    <div class="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <section class="sheet order-sheet" role="dialog" aria-label="Practice trade" data-testid="trade-sheet">
        <div class="row">
          <h2 style={{ margin: 0 }}>Practice trade</h2>
          <span class="spacer" />
          <button class="link-btn" type="button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <p class="tiny muted" style={{ margin: '2px 0 8px' }}>
          Pretend money · live prices · works like the Upstox order window · nothing is sent to Upstox
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
                <button
                  type="button"
                  class="chip-btn"
                  data-testid="held-pick"
                  onClick={() => {
                    setStock({ key: h.key, symbol: h.symbol });
                    setProduct(h.product ?? 'delivery');
                  }}
                >
                  {h.symbol} · {h.qty} · {PRODUCT_LABEL[h.product ?? 'delivery']}
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
          <>
            <div class="row stock-pick" data-testid="trade-stock">
              <b>{stock.symbol}</b> <span class="exch">{stock.key.startsWith('BSE_') ? 'BSE' : 'NSE'}</span>
              {picked && <span class={`sug-chance ${picked.side}`}>{Math.round(picked.chance * 100)}%</span>}
              <span class="spacer" />
              <span class={`big-num price-${pv.state}`} data-testid="trade-price" data-state={pv.state}>
                {pv.state === 'loading' && <i class="spin" aria-hidden="true" />}
                {pv.text}
              </span>
              {change !== null && <span class={`small ${change >= 0 ? 'ok-text' : 'err-text'}`}>{`${change >= 0 ? '+' : ''}${change.toFixed(2)}%`}</span>}
              {!prefill.key && (
                <button class="link-btn small" type="button" onClick={() => (setStock(null), setPicked(null))}>
                  change
                </button>
              )}
            </div>
            {pv.state === 'closed' && quote && <p class="tiny muted price-note">Market closed — the last traded price (read {formatTimeIST(quote.fetchedAt)}).</p>}
            {pv.state === 'error' && (
              <p class="small err-text price-note" data-testid="trade-price-error">
                {priceErr ?? 'No fresh price from Upstox.'}{' '}
                <button class="link-btn small" type="button" data-testid="trade-price-retry" onClick={() => loadPrice(stock.key)}>
                  Retry
                </button>
              </p>
            )}
          </>
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

        <div class="order-label tiny muted">Product</div>
        <div class="product-tabs" role="tablist" data-testid="product-tabs">
          {productChoices.map((p) => {
            const t = stock ? termsFor(p, stock.key) : termsFor(p, '');
            const n = side === 'sell' && stock ? heldIn(p) : 0;
            return (
              <button type="button" role="tab" aria-selected={product === p} class={`product-tab ${product === p ? 'on' : ''}`} data-product={p} disabled={side === 'buy' && !t.available} onClick={() => setProduct(p)}>
                <b>{PRODUCT_LABEL[p]}</b>
                <span class="tiny">{side === 'sell' && stock ? (n > 0 ? `${n} held` : p === 'intraday' ? 'sell first' : '—') : t.available ? (t.leverage > 1 ? `${t.leverage}×` : 'full price') : 'not offered'}</span>
              </button>
            );
          })}
        </div>
        <p class="tiny muted product-help" data-testid="product-help">
          {productHelp(product, side, leverage, sellFirst)}
          {covering && ` You sold ${short!.qty} ${stock!.symbol} first: this buys them back.`}
        </p>

        {sellFirst && (
          <div class="banner info small" data-testid="sell-first-note">
            <b>Sell first:</b> you do not hold {stock!.symbol} in Intraday, so this sells first and buys back the same day (Upstox <b>Intraday</b>). With a buy-back price and targets it is bought back by itself; it is always closed by 3:20 pm.
            {!open && <div class="err-text">The market is closed — selling first works from 9:15 am to 3:15 pm.</div>}
          </div>
        )}

        <div class="order-label tiny muted">Order type</div>
        <div class="type-chips" data-testid="order-types">
          {TYPES.map(([t, name]) => (
            <button type="button" class={`filter-chip ${type === t ? 'on' : ''}`} data-type={t} onClick={() => setType(t)}>
              {name}
            </button>
          ))}
        </div>
        <p class="tiny muted" style={{ margin: '2px 0 6px' }}>
          {typeHelp(type, side)}
        </p>

        <div class="grid2">
          <label class="field">
            <span>Quantity</span>
            <input type="number" min="1" step="1" inputMode="numeric" value={qty} data-field="trade-qty" onInput={(e) => setQty((e.currentTarget as HTMLInputElement).value)} />
          </label>
          {(type === 'limit' || type === 'sl') && (
            <label class="field">
              <span>{type === 'sl' ? 'Limit price ₹' : side === 'buy' ? 'Buy at ₹ (or lower)' : 'Sell at ₹ (or higher)'}</span>
              <input type="text" inputMode="decimal" autoComplete="off" value={limit} placeholder={ltp ? String(ltp) : ''} data-field="trade-limit" onInput={(e) => setLimit(decimalText((e.currentTarget as HTMLInputElement).value))} />
            </label>
          )}
          {(type === 'sl' || type === 'slm') && (
            <label class="field">
              <span>Trigger price ₹</span>
              <input type="text" inputMode="decimal" autoComplete="off" value={trigger} data-field="trade-trigger" onInput={(e) => setTrigger(decimalText((e.currentTarget as HTMLInputElement).value))} />
            </label>
          )}
        </div>
        {((side === 'buy' && !covering) || sellFirst) && ltp && (
          <div class="quick-amounts">
            {[10_000, 25_000, 50_000, 100_000].map((a) => (
              <button type="button" class="chip-btn" onClick={() => setQty(String(sharesFor(a, ltp, marginPct)))}>
                ₹{a >= 100_000 ? `${a / 100_000}L` : `${a / 1000}k`}
                {marginPct < 1 ? ' margin' : ''}
              </button>
            ))}
          </div>
        )}
        {covering && (
          <div class="quick-amounts">
            <button type="button" class="chip-btn" onClick={() => setQty(String(short!.qty))}>
              All {short!.qty} shares
            </button>
          </div>
        )}
        {side === 'sell' && !sellFirst && canSell > 0 && (
          <div class="quick-amounts">
            <button type="button" class="chip-btn" onClick={() => setQty(String(canSell))}>
              All {canSell} shares
            </button>
          </div>
        )}
        <div class="row tiny validity" data-testid="validity">
          <span class="muted">Validity</span>
          {(['day', 'ioc'] as Validity[]).map((v) => (
            <button type="button" class={`filter-chip ${validity === v ? 'on' : ''}`} data-validity={v} onClick={() => setValidity(v)}>
              {v === 'day' ? 'Day' : 'IOC'}
            </button>
          ))}
          <span class="muted">{validity === 'day' ? 'waits until the market closes' : 'fills at once or is cancelled'}</span>
        </div>

        {product === 'intraday' && !covering && (side === 'buy' || sellFirst) && (
          <label class="small check-row square-off-note">
            <input type="checkbox" checked={sellByClose} data-field="trade-sellbyclose" onChange={(e) => setSellByClose((e.currentTarget as HTMLInputElement).checked)} />
            <span>
              Close by itself at <b>3:10 pm</b>. <span class="muted">Otherwise Upstox squares it off at 3:20 pm and charges ₹{SQUARE_OFF_CHARGE} (₹50 + GST) — close yourself before 3:18 pm.</span>
            </span>
          </label>
        )}

        {side === 'buy' && !covering && (
          <details class="small" open={!!(prefill.stop || prefill.target || picked)}>
            <summary>Add stop-loss &amp; target (sells by itself)</summary>
            <div class="grid2">
              <label class="field">
                <span>Stop-loss: sell if it falls to ₹</span>
                <input type="text" inputMode="decimal" autoComplete="off" value={stop} data-field="trade-stop" onInput={(e) => setStop(decimalText((e.currentTarget as HTMLInputElement).value))} />
              </label>
              <label class="field">
                <span>Target: take profit at ₹</span>
                <input type="text" inputMode="decimal" autoComplete="off" value={target} data-field="trade-target" onInput={(e) => setTarget(decimalText((e.currentTarget as HTMLInputElement).value))} />
              </label>
            </div>
            {product !== 'intraday' && (
              <label class="small check-row">
                <input type="checkbox" checked={sellByClose} data-field="trade-sellbyclose" onChange={(e) => setSellByClose((e.currentTarget as HTMLInputElement).checked)} />
                <span>Day trade: sell by itself at 3:10 pm (untick to keep it overnight)</span>
              </label>
            )}
          </details>
        )}
        {sellFirst && (
          <div class="grid3">
            <label class="field">
              <span>Buy back if it rises to ₹</span>
              <input type="text" inputMode="decimal" autoComplete="off" value={stop} data-field="short-stop" onInput={(e) => setStop(decimalText((e.currentTarget as HTMLInputElement).value))} />
            </label>
            <label class="field">
              <span>Target 1 (half) ₹</span>
              <input type="text" inputMode="decimal" autoComplete="off" value={t1} placeholder="optional" data-field="short-t1" onInput={(e) => setT1(decimalText((e.currentTarget as HTMLInputElement).value))} />
            </label>
            <label class="field">
              <span>Target 2 (rest) ₹</span>
              <input type="text" inputMode="decimal" autoComplete="off" value={target} placeholder="optional" data-field="short-t2" onInput={(e) => setTarget(decimalText((e.currentTarget as HTMLInputElement).value))} />
            </label>
          </div>
        )}

        <div class="funds-box" data-testid="funds-box">
          {side === 'buy' && !covering ? (
            <>
              <div class="funds-row">
                <span>Order value</span>
                <b>{value ? formatINR(value, 0) : '—'}</b>
              </div>
              {marginPct < 1 && (
                <div class="funds-row">
                  <span>
                    Margin you pay ({Math.round(marginPct * 100)}%, {leverage}×)
                  </span>
                  <b>{needs ? formatINR(needs, 0) : '—'}</b>
                </div>
              )}
              {product === 'mtf' && funded > 0 && (
                <div class="funds-row muted">
                  <span>Upstox lends · interest</span>
                  <span>
                    {formatINR(funded, 0)} · ₹{mtfDailyInterest(funded)}/day
                  </span>
                </div>
              )}
              <div class="funds-row">
                <span>Available now</span>
                <b>{formatINR(free, 0)}</b>
              </div>
              <div class={`funds-row big ${after < 0 ? 'err-text' : ''}`} data-testid="balance-after">
                <span>{waits ? 'Balance after (kept aside until it buys)' : 'Balance after this buy'}</span>
                <b>{needs ? formatINR(after, 0) : formatINR(free, 0)}</b>
              </div>
              {waits && needs > 0 && (type === 'market' || type === 'slm') && <div class="tiny muted">Keeps {formatINR(keptAside, 0)} aside: the margin + 1% in case the price opens higher.</div>}
            </>
          ) : sellFirst ? (
            <>
              <div class="funds-row">
                <span>Sale value</span>
                <b>{value ? formatINR(value, 0) : '—'}</b>
              </div>
              <div class="funds-row">
                <span>
                  Margin set aside ({Math.round(marginPct * 100)}%, {leverage}×)
                </span>
                <b>{needs ? formatINR(needs, 0) : '—'}</b>
              </div>
              <div class={`funds-row big ${after < 0 ? 'err-text' : ''}`} data-testid="balance-after">
                <span>Balance after</span>
                <b>{needs ? formatINR(after, 0) : formatINR(free, 0)}</b>
              </div>
            </>
          ) : covering ? (
            <div class="funds-row">
              <span>
                Sold first at ₹{formatNumberIN(short!.entry)} · now {ltp ? `₹${formatNumberIN(ltp)}` : '—'}
              </span>
              <b class={ltp && ltp < short!.entry ? 'ok-text' : 'err-text'}>{ltp && q ? `${ltp < short!.entry ? '+' : '−'}${formatINR(Math.abs(short!.entry - ltp) * q, 0)}` : '—'}</b>
            </div>
          ) : (
            <>
              <div class="funds-row">
                <span>
                  You hold {canSell} in {PRODUCT_LABEL[product]}
                  {position ? ` · bought ₹${formatNumberIN(position.avgPrice)}` : ''}
                </span>
                <b>{value ? formatINR(value, 0) : '—'}</b>
              </div>
              {position && px && q ? (
                <div class="funds-row">
                  <span>Profit / loss before charges</span>
                  <b class={px >= position.avgPrice ? 'ok-text' : 'err-text'}>{`${px >= position.avgPrice ? '+' : '−'}${formatINR(Math.abs(px - position.avgPrice) * q, 0)}`}</b>
                </div>
              ) : null}
              {position && product === 'mtf' && (position.interest ?? 0) > 0 && (
                <div class="funds-row muted">
                  <span>MTF interest paid so far</span>
                  <span>{formatINR(position.interest ?? 0, 0)}</span>
                </div>
              )}
            </>
          )}
          {charges > 0 && (
            <div class="funds-row muted tiny">
              <span>Charges for buying and selling ({PRODUCT_LABEL[product]})</span>
              <span>≈ {formatINR(charges, 0)}</span>
            </div>
          )}
          {!open && <div class="tiny muted">Market closed: this is an after-market order (AMO) — it works when the market opens.</div>}
        </div>
        <button class={`btn primary block ${side}`} type="button" disabled={busy || !stock || q < 1 || (sellFirst && !open) || ((type === 'market' || sellFirst) && open && !ltp)} data-testid="trade-submit" onClick={() => void submit()}>
          {busy ? 'Placing…' : `${label} (practice)`}
        </button>
        {stock && open && !ltp && (type === 'market' || sellFirst) && <p class="tiny muted" style={{ margin: '4px 0 0' }}>A market order needs a live price — waiting for it.</p>}
        {msg && (
          <p class={`small ${msg.ok ? 'ok-text' : 'err-text'}`} data-testid="trade-msg">
            {msg.text}
          </p>
        )}
      </section>
    </div>
  );
}
