import { useState } from 'preact/hooks';
import { formatINR, formatNumberIN, formatPct, formatTimeIST } from '../../lib/format';
import { istDate } from '../../lib/time';
import { callBackground } from '../../shared/messages';
import { newWallet, WALLET_START, walletSummary, type Fill } from '../../wallet/wallet';
import type { Go } from '../App';
import { openTrade } from '../components/TradeSheet';
import { AnimatedNumber } from '../components/Motion';
import { useQuotes } from '../data';
import { useLocal, useNow } from '../hooks';
import { AutoTraderView } from '../components/AutoTrader';
import { Icon } from '../components/Icon';

const signed = (x: number, d = 0) => `${x >= 0 ? '+' : '−'}${formatINR(Math.abs(x), d)}`;
const tone = (x: number) => (x > 0 ? 'ok-text' : x < 0 ? 'err-text' : 'muted');
const REASON: Record<Fill['reason'], string> = { order: '', stop: 'safety net', target: 'take-profit', 'day-end': '3:10 pm', t1: 'target 1' };

/** Practice tab (app v1.6): your own practice money, or the auto-trader's ₹50 lakh. */
export function PracticeScreen({ go, view }: { go: Go; view?: string | null }) {
  const [tab, setTab] = useState<'me' | 'bot'>(view === 'bot' ? 'bot' : 'me');
  const bot = useLocal('bot');
  const botCash = bot?.wallet.startCash ?? 5_000_000;
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
        <div class="wallet-split small muted">
          Free cash {formatINR(s.free, 0)} · in shares {formatINR(s.value, 0)} · {s.trades} closed trade{s.trades === 1 ? '' : 's'}
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
              <div class="holding" data-symbol={h.symbol}>
                <div class="row">
                  <b>{h.symbol}</b>
                  {h.sellByClose && <span class="chip day buy">day trade</span>}
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
                <div class="row" style={{ gap: '6px', marginTop: '4px' }}>
                  <button class="btn small sell" type="button" data-testid="holding-sell" onClick={() => openTrade({ key: h.key, symbol: h.symbol, side: 'sell', qty: h.qty })}>
                    Sell
                  </button>
                  <button class="btn small" type="button" onClick={() => openTrade({ key: h.key, symbol: h.symbol, side: 'buy' })}>
                    Buy more
                  </button>
                  {h.sellByClose ? (
                    <button class="link-btn small" type="button" onClick={() => void callBackground('wallet:update', { key: h.key, patch: { sellByClose: false } })}>
                      keep overnight
                    </button>
                  ) : (
                    <button class="link-btn small" type="button" onClick={() => void callBackground('wallet:update', { key: h.key, patch: { sellByClose: true } })}>
                      sell at 3:10 pm
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
                Buy back if it rises to ₹{formatNumberIN(p.stop)}
                {p.t1Done ? ' (target 1 done — the rest can no longer lose)' : ` · target 1 ₹${formatNumberIN(p.t1)} (half)`} · target 2 ₹{formatNumberIN(p.t2)} · by 3:10 pm — automatic
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
            <div class="row small order-row">
              <span class={o.side === 'buy' ? 'ok-text' : 'err-text'}>{o.side === 'buy' ? 'Buy' : 'Sell'}</span> {o.qty} <b>{o.symbol}</b>
              <span class="muted">{o.atOpen ? 'at the next opening price' : `at ₹${formatNumberIN(o.limitPrice ?? 0)}`}</span>
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
                    {REASON[f.reason] && <span class="chip flag"> {REASON[f.reason]}</span>}
                  </td>
                  <td class={`num ${f.pnl !== undefined ? tone(f.pnl) : ''}`}>{f.pnl !== undefined ? signed(f.pnl) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p class="tiny muted">
          Results after estimated Upstox charges: same-day buy and sell = intraday charges; kept overnight = delivery charges. A small price slippage (0.02%) is included, because real orders
          rarely fill exactly at the last price.
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
