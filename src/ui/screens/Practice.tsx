import { useState } from 'preact/hooks';
import { formatINR, formatNumberIN, formatPct, formatTimeIST } from '../../lib/format';
import { istDate } from '../../lib/time';
import { callBackground } from '../../shared/messages';
import { AUTO_SQUARE_OFF_T, newWallet, orderReserve, PRODUCT_LABEL, WALLET_START, walletSummary, type Fill, type PaperOrder, type Product } from '../../wallet/wallet';
import { errorMessage } from '../../lib/serialize';
import { toast } from '../components/Motion';
import type { Go } from '../App';
import { openTrade } from '../components/TradeSheet';
import { AnimatedNumber } from '../components/Motion';
import { useQuotes } from '../data';
import { useLocal, useNow } from '../hooks';
import { AutoTraderView } from '../components/AutoTrader';
import { Icon } from '../components/Icon';

const signed = (x: number, d = 0) => `${x >= 0 ? '+' : '−'}${formatINR(Math.abs(x), d)}`;
const tone = (x: number) => (x > 0 ? 'ok-text' : x < 0 ? 'err-text' : 'muted');
const REASON: Record<Fill['reason'], string> = { order: '', stop: 'safety net', target: 'take-profit', 'day-end': '3:10 pm', t1: 'target 1', 'square-off': 'auto square-off 3:20', margin: 'margin shortfall' };

/** "Delivery", "Intraday 5×", "MTF 4×" */
const productChip = (p: Product | undefined, leverage?: number) => {
  const prod = p ?? 'delivery';
  return (
    <span class={`chip product-chip ${prod}`} data-product={prod}>
      {PRODUCT_LABEL[prod]}
      {prod !== 'delivery' && leverage && leverage > 1 ? ` ${leverage}×` : ''}
    </span>
  );
};

/** A waiting order in plain words: "Limit ₹1,500", "SL trigger ₹1,480 → limit ₹1,478", "at the next opening price". */
function orderWords(o: PaperOrder): string {
  const rs = (x: number | undefined) => `₹${formatNumberIN(x ?? 0)}`;
  const when = o.atOpen ? 'at the next opening price' : o.type === 'limit' ? `at ${rs(o.limitPrice)}` : o.type === 'sl' ? `stop-loss: trigger ${rs(o.trigger)} → limit ${rs(o.limitPrice)}` : o.type === 'slm' ? `stop-loss market: trigger ${rs(o.trigger)}` : 'at market';
  return `${when}${o.amo ? ' · after-market order' : ''}${o.triggered ? ' · triggered' : ''}${o.validity === 'ioc' ? ' · IOC' : ''}`;
}

const convert = (key: string, from: Product, to: Product) =>
  void callBackground('wallet:convert', { key, from, to })
    .then(() => toast(to === 'delivery' ? 'Converted to Delivery — kept overnight' : 'Converted to Intraday'))
    .catch((e: unknown) => toast(errorMessage(e), 'err'));

/** Practice tab (app v1.6): your own practice money, or the auto-trader's ₹50 lakh. */
export function PracticeScreen({ go, view }: { go: Go; view?: string | null }) {
  const [tab, setTab] = useState<'me' | 'bot'>(view === 'bot' ? 'bot' : 'me');
  const own = useLocal('bot');
  // app v1.22: the auto-trader may run on the server (then its money is the server's)
  const link = useLocal('botCloud');
  const botCash = (link ? link.snapshot?.money?.startCash : own?.wallet.startCash) ?? 5_000_000;
  const short = (x: number) => (x >= 1e7 ? `₹${+(x / 1e7).toFixed(2)} Cr` : `₹${+(x / 1e5).toFixed(1)} L`);
  return (
    <>
      <div class="segmented practice-tabs" role="tablist" data-testid="practice-tabs">
        <button type="button" role="tab" aria-selected={tab === 'me'} data-tab="me" onClick={() => setTab('me')}>
          My practice · ₹10 L
        </button>
        <button type="button" role="tab" aria-selected={tab === 'bot'} data-tab="bot" onClick={() => setTab('bot')}>
          <Icon name="robot" size={16} /> Auto-trader · {short(botCash)}
        </button>
      </div>
      {tab === 'bot' ? <AutoTraderView /> : <MyPractice go={go} />}
    </>
  );
}

/** Practice money: ₹10 lakh of pretend money, live prices, real charges, no orders to Upstox. */
function MyPractice({ go }: { go: Go }) {
  const stored = useLocal('wallet');
  const quotes = useQuotes();
  const now = useNow(5_000);
  const [confirmReset, setConfirmReset] = useState(false);
  const today = istDate(now);
  const w = stored ?? newWallet(now);
  const s = walletSummary(w, quotes, today);
  const openOrders = w.orders.filter((o) => o.status === 'open');
  const history = [...w.fills].reverse().slice(0, 40);

  return (
    <div class="screen practice-screen" data-testid="practice">
      <section class="card wallet-card" data-testid="wallet">
        <div class="tiny muted">Practice money · pretend ₹, live prices</div>
        <div class="wallet-total" data-testid="wallet-total">
          <AnimatedNumber value={s.total} format={(v) => formatINR(v, 0)} />
        </div>
        <div class="wallet-pnl">
          <span class={tone(s.todayPnl)} data-testid="wallet-today">
            Today {signed(s.todayPnl)}
          </span>
          <span class={tone(s.totalPnl)} data-testid="wallet-all">
            Overall {signed(s.totalPnl)} ({formatPct(s.totalPct, 2)})
          </span>
        </div>
        <div class="funds-strip" data-testid="wallet-funds">
          <div>
            <span>Available</span>
            <b data-testid="wallet-free">{formatINR(s.free, 0)}</b>
          </div>
          <div>
            <span>Used margin</span>
            <b data-testid="wallet-used">{formatINR(s.used, 0)}</b>
            {s.blocked > 0.5 && <small>{s.used - s.blocked > 0.5 ? `incl. ${formatINR(s.blocked, 0)} for orders` : `for ${openOrders.length === 1 ? 'your waiting order' : 'waiting orders'}`}</small>}
          </div>
          <div>
            <span>Positions</span>
            <b>{formatINR(s.value, 0)}</b>
            {s.holdings.length + s.shorts.length === 0 && openOrders.length > 0 && <small>none bought yet</small>}
          </div>
        </div>
        {s.blocked > 0.5 && s.holdings.length + s.shorts.length === 0 && (
          <p class="tiny muted funds-note" data-testid="funds-note">
            {formatINR(s.blocked, 0)} is set aside for your waiting order{openOrders.length === 1 ? '' : 's'} (margin + 1% in case the price opens higher). The shares appear under Positions once
            {openOrders.length === 1 ? ' it buys' : ' they buy'}
            {openOrders.some((o) => o.atOpen || o.amo) ? ' — at the next opening price when the market opens' : ''}.
          </p>
        )}
        <div class="wallet-split small muted">
          {s.exposure > s.value + 1 ? <>Shares worth {formatINR(s.exposure, 0)} with leverage · </> : null}
          {s.trades} closed trade{s.trades === 1 ? '' : 's'}
          {s.trades > 0 && <>, {s.wins} with a profit ({Math.round((s.wins / s.trades) * 100)}%)</>}
        </div>
        <div class="row" style={{ marginTop: '10px', gap: '8px' }}>
          <button class="btn primary buy grow" type="button" data-testid="practice-buy" onClick={() => openTrade({ side: 'buy' })}>
            <Icon name="up" size={18} /> Buy
          </button>
          <button class="btn primary sell grow" type="button" data-testid="practice-sell" onClick={() => openTrade({ side: 'sell' })}>
            <Icon name="down" size={18} /> Sell
          </button>
        </div>
      </section>

      <section class="card" data-testid="holdings">
        <h2>Your practice shares</h2>
        {s.holdings.length === 0 ? (
          <p class="small muted">
            Nothing bought yet. Tap <b>Buy</b>, or use the <b>Practice</b> button on a{' '}
            <button class="link-btn" type="button" onClick={() => go('daytrade')}>
              day-trade signal
            </button>{' '}
            or a{' '}
            <button class="link-btn" type="button" onClick={() => go('today')}>
              top pick
            </button>
            .
          </p>
        ) : (
          <div class="holding-list">
            {s.holdings.map((h) => (
              <div class="holding" data-symbol={h.symbol} data-product={h.product ?? 'delivery'}>
                <div class="row">
                  <b>{h.symbol}</b>
                  {productChip(h.product, h.leverage)}
                  {h.sellByClose && h.product !== 'intraday' && <span class="chip day buy">day trade</span>}
                  <span class="spacer" />
                  <span class="big-num">{h.ltp ? `₹${formatNumberIN(h.ltp)}` : '—'}</span>
                </div>
                <div class="row small">
                  <span class="muted">
                    {h.qty} shares · bought ₹{formatNumberIN(h.avgPrice)}
                  </span>
                  <span class="spacer" />
                  <span class={tone(h.pnl)}>
                    {signed(h.pnl)} ({formatPct(h.pnlPct, 2)})
                  </span>
                </div>
                {(h.stop !== null || h.target !== null) && (
                  <div class="tiny muted">
                    {h.target !== null && <>Take profit at ₹{formatNumberIN(h.target)} </>}
                    {h.stop !== null && <>{h.target !== null ? '· ' : ''}sell if it falls to ₹{formatNumberIN(h.stop)} </>}— sells by itself
                  </div>
                )}
                {h.product === 'intraday' && (
                  <div class="tiny muted" data-testid="intraday-line">
                    Margin {formatINR(h.margin, 0)} for {formatINR(h.value, 0)} of shares ({h.leverage}×) · {h.sellByClose ? 'closes by itself at 3:10 pm' : `Upstox squares it off at ${Math.floor(AUTO_SQUARE_OFF_T / 60) - 12}:${String(AUTO_SQUARE_OFF_T % 60).padStart(2, '0')} pm (₹59 charge) — close it yourself before 3:18 pm`}
                  </div>
                )}
                {h.product === 'mtf' && (
                  <div class="tiny muted" data-testid="mtf-line">
                    You paid {formatINR(h.margin, 0)} · Upstox lends {formatINR(h.funded, 0)} · interest ₹{h.dailyInterest} a day (paid so far {formatINR(h.interest ?? 0, 0)})
                  </div>
                )}
                {h.shortfall > 0 && (
                  <div class="tiny err-text">
                    Margin shortfall {formatINR(h.shortfall, 0)}: the price fell, so the loan is large compared with the value. If it keeps falling, it is sold for you.
                  </div>
                )}
                <div class="row" style={{ gap: '6px', marginTop: '4px' }}>
                  <button class="btn small sell" type="button" data-testid="holding-sell" onClick={() => openTrade({ key: h.key, symbol: h.symbol, side: 'sell', qty: h.qty, product: h.product ?? 'delivery' })}>
                    {h.product === 'intraday' ? 'Exit' : 'Sell'}
                  </button>
                  <button class="btn small" type="button" onClick={() => openTrade({ key: h.key, symbol: h.symbol, side: 'buy', product: h.product ?? 'delivery' })}>
                    Buy more
                  </button>
                  {h.product === 'intraday' ? (
                    <button class="link-btn small" type="button" data-testid="convert-delivery" onClick={() => convert(h.key, 'intraday', 'delivery')}>
                      keep overnight (convert to Delivery)
                    </button>
                  ) : h.product === 'mtf' ? null : h.sellByClose ? (
                    <button class="link-btn small" type="button" onClick={() => void callBackground('wallet:update', { key: h.key, patch: { sellByClose: false }, product: 'delivery' })}>
                      keep overnight
                    </button>
                  ) : (
                    <button class="link-btn small" type="button" onClick={() => void callBackground('wallet:update', { key: h.key, patch: { sellByClose: true }, product: 'delivery' })}>
                      sell at 3:10 pm
                    </button>
                  )}
                  {(h.product ?? 'delivery') === 'delivery' && h.lots.some((l) => l.date === today) && (
                    <button class="link-btn small" type="button" data-testid="convert-intraday" onClick={() => convert(h.key, 'delivery', 'intraday')}>
                      convert to Intraday
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {s.shorts.length > 0 && (
        <section class="card" data-testid="shorts-held">
          <h2>Sold first — buy back today</h2>
          {s.shorts.map((p) => (
            <div class="holding" data-symbol={p.symbol}>
              <div class="row">
                <b>{p.symbol}</b>
                <span class="chip day sell">▼ sold first</span>
                {productChip('intraday', p.marginPct ? Math.round(10 / p.marginPct) / 10 : undefined)}
                <span class="spacer" />
                <span class="big-num">{p.ltp ? `₹${formatNumberIN(p.ltp)}` : '—'}</span>
              </div>
              <div class="row small">
                <span class="muted">
                  {p.qty} shares sold at ₹{formatNumberIN(p.entry)}
                </span>
                <span class="spacer" />
                <span class={tone(p.pnl)}>
                  {signed(p.pnl)} ({formatPct(p.pnlPct, 2)})
                </span>
              </div>
              <div class="tiny muted">
                {p.stop !== null ? `Buy back if it rises to ₹${formatNumberIN(p.stop)}` : 'No buy-back price set'}
                {p.t1Done ? ' (target 1 done — the rest can no longer lose)' : p.t1 !== null ? ` · target 1 ₹${formatNumberIN(p.t1)} (half)` : ''}
                {p.t2 !== null ? ` · target 2 ₹${formatNumberIN(p.t2)}` : ''} · {p.exitT === AUTO_SQUARE_OFF_T ? 'Upstox squares it off at 3:20 pm (₹59)' : 'by 3:10 pm — automatic'} · margin {formatINR(p.margin, 0)}
              </div>
              <button class="btn small buy" type="button" data-testid="short-cover" style={{ marginTop: '4px' }} onClick={() => void callBackground('wallet:cover', { key: p.key }).catch(() => undefined)}>
                Buy back now
              </button>
            </div>
          ))}
        </section>
      )}
      {openOrders.length > 0 && (
        <section class="card" data-testid="open-orders">
          <h2>Waiting orders</h2>
          {openOrders.map((o) => (
            <div class="row small order-row" data-testid="open-order">
              <span class={o.side === 'buy' ? 'ok-text' : 'err-text'}>{o.side === 'buy' ? (o.covers ? 'Buy back' : 'Buy') : o.opensShort ? 'Sell first' : 'Sell'}</span> {o.qty} <b>{o.symbol}</b>
              {productChip(o.product, o.marginPct ? Math.round(10 / o.marginPct) / 10 : undefined)}
              <span class="muted">
                {orderWords(o)}
                {orderReserve(o, quotes) > 0.5 && <> · keeps {formatINR(orderReserve(o, quotes), 0)} aside</>}
              </span>
              <span class="spacer" />
              <button class="link-btn small" type="button" onClick={() => void callBackground('wallet:cancel', { id: o.id })}>
                cancel
              </button>
            </div>
          ))}
        </section>
      )}

      <section class="card" data-testid="wallet-history">
        <h2>History</h2>
        {history.length === 0 ? (
          <p class="small muted">Your practice buys and sells appear here, with the result of each sale after charges.</p>
        ) : (
          <table class="simple small">
            <tbody>
              {history.map((f) => (
                <tr>
                  <td class="muted">{f.date === today ? formatTimeIST(f.at).slice(0, 5) : f.date.slice(5)}</td>
                  <td>
                    <span class={f.side === 'buy' ? 'ok-text' : 'err-text'}>{f.side === 'buy' ? 'Buy' : 'Sell'}</span> {f.qty} <b>{f.symbol}</b> @ ₹{formatNumberIN(f.price)}
                    {f.product && f.product !== 'delivery' && <span class="chip product-chip tiny-chip"> {PRODUCT_LABEL[f.product]}</span>}
                    {REASON[f.reason] && <span class="chip flag"> {REASON[f.reason]}</span>}
                    {f.cashAfter !== undefined && (
                      <div class="tiny muted balance-after" data-testid="history-balance">
                        Balance after: {formatINR(f.cashAfter, 0)}
                        {f.charges ? ` · charges ${formatINR(f.charges, 0)}` : ''}
                        {f.interest ? ` · MTF interest ${formatINR(f.interest, 0)}` : ''}
                      </div>
                    )}
                  </td>
                  <td class={`num ${f.pnl !== undefined ? tone(f.pnl) : ''}`}>{f.pnl !== undefined ? signed(f.pnl) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p class="tiny muted">
          Results after estimated Upstox charges: same-day buy and sell = intraday charges; kept overnight = delivery charges (MTF: + pledge ₹23.60 and unpledge ₹23.60, and ₹20 a day interest per
          ₹40,000 lent); ₹59 when Upstox squares off an Intraday trade at 3:20 pm. A small price slippage (0.02%) is included, because real orders rarely fill exactly at the last price.
        </p>
      </section>

      <section class="card">
        {!confirmReset ? (
          <button class="link-btn small" type="button" onClick={() => setConfirmReset(true)}>
            Start again with {formatINR(WALLET_START, 0)}
          </button>
        ) : (
          <div class="row small" style={{ gap: '8px' }}>
            <span>Delete all practice shares and history?</span>
            <button
              class="btn small danger"
              type="button"
              data-testid="wallet-reset"
              onClick={() => {
                setConfirmReset(false);
                void callBackground('wallet:reset', {});
              }}
            >
              Yes, start again
            </button>
            <button class="btn small" type="button" onClick={() => setConfirmReset(false)}>
              Cancel
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
