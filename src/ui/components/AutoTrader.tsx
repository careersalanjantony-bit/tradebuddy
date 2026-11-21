import { useState } from 'preact/hooks';
import { STRATEGIES, STRATEGY_LABEL, strategyFocus, topLessons } from '../../bot/brain';
import { BOT_START, MAX_RISK, MIN_RISK, SWING_MAX_DAYS } from '../../bot/policy';
import { PROTECT_CHOICES, keepLevel, maxOpenFor, protectRules, type ProtectRules } from '../../bot/protect';
import { copySteps } from '../../bot/copy';
import type { BotState, BotTrade } from '../../background/botJobs';
import { formatINR, formatNumberIN, formatTimeIST } from '../../lib/format';
import { errorMessage } from '../../lib/serialize';
import { istDate } from '../../lib/time';
import { callBackground } from '../../shared/messages';
import { newWallet, walletSummary } from '../../wallet/wallet';
import type { Go } from '../App';
import { useQuotes } from '../data';
import { useLocal, useMarketState, useNow } from '../hooks';
import { Icon } from './Icon';
import { AnimatedNumber, Sparkline, toast, useFlash } from './Motion';
import { botControls, cloudQuotes, cloudStatus, CloudBotPanel, useCloudRefresh, type BotControls } from './CloudBotPanel';

/**
 * App v1.6 — the auto-trader on screen: ₹50 lakh of pretend money that trades by itself.
 * Everything here only shows what the background auto-trader did; the switch pauses it.
 */

const signed = (x: number) => `${x >= 0 ? '+' : '−'}${formatINR(Math.abs(x), 0)}`;
const tone = (x: number) => (x > 0 ? 'ok-text' : x < 0 ? 'err-text' : 'muted');

/**
 * app v1.22: the auto-trader shown here — this phone's own, or (after it was moved to the user's server)
 * the server's: its state, its prices and its money totals exactly as the server works them out.
 */
function useBotView() {
  const link = useLocal('botCloud');
  const own = useLocal('bot');
  const phoneQuotes = useQuotes();
  const now = useNow(3_000);
  const today = istDate(now);
  const onServer = !!link;
  const snap = link?.mode === 'cloud' ? link.snapshot : null;
  const bot = onServer ? (snap?.bot ?? null) : own;
  const quotes = onServer ? cloudQuotes(snap) : phoneQuotes;
  const wallet = bot?.wallet ?? newWallet(now, BOT_START);
  const s0 = walletSummary(wallet, quotes, today);
  const s = snap?.money ? { ...s0, total: snap.money.total, free: snap.money.free, todayPnl: snap.money.todayPnl, totalPnl: snap.money.totalPnl } : s0;
  return { bot, quotes, now, today, s, link: link ?? null, ctl: botControls(link) };
}

function status(bot: BotState | null | undefined, marketOpen: boolean, link: ReturnType<typeof useBotView>['link'] = null, now = Date.now()): { text: string; cls: string } {
  if (link) return cloudStatus(link, now);
  if (!bot) return { text: 'Starting — needs live prices', cls: 'idle' };
  if (!bot.enabled) return { text: 'Paused by you', cls: 'idle' };
  if (marketOpen) return { text: 'Trading by itself', cls: 'live' };
  return { text: 'Market closed — waits for 9:30', cls: 'idle' };
}

/** Home: a small live card. */
export function AutoTraderMini({ go }: { go: Go }) {
  const { bot, s, link, now } = useBotView();
  const market = useMarketState();
  const st = status(bot, market.phase === 'open', link, now);
  const open = (bot?.trades ?? []).filter((t) => t.status === 'open').length;
  return (
    <section class="card bot-mini" data-testid="bot-mini" onClick={() => go('practice', 'bot')}>
      <div class="row">
        <span class={`bot-avatar ${st.cls}`} aria-hidden="true">
          <Icon name="robot" size={22} />
        </span>
        <div class="grow">
          <div class="row" style={{ gap: '6px' }}>
            <b>Auto-trader</b>
            <span class={`bot-status ${st.cls}`}>
              <span class="dot" /> {st.text}
            </span>
          </div>
          <div class="bot-mini-value">
            <AnimatedNumber value={s.total} format={(v) => formatINR(v, 0)} />
          </div>
          <div class="tiny">
            <span class={tone(s.todayPnl)}>Today {signed(s.todayPnl)}</span> · <span class={tone(s.totalPnl)}>Overall {signed(s.totalPnl)}</span> · {open} open · learned from {bot?.brain.n ?? 0} trades
          </div>
        </div>
        <Icon name="chevron" size={18} />
      </div>
    </section>
  );
}

/** Practice tab → Auto-trader. */
export function AutoTraderView() {
  const { bot, quotes, now, s, link, ctl } = useBotView();
  const market = useMarketState();
  const st = status(bot, market.phase === 'open', link, now);
  useCloudRefresh(link);
  const [confirm, setConfirm] = useState<null | 'money' | 'all'>(null);
  const [amount, setAmount] = useState(String(bot?.wallet.startCash ?? BOT_START));
  const startCash = Math.round(Number(amount.replace(/[^0-9.]/g, '')) || 0);
  const trades = bot?.trades ?? [];
  const open = trades.filter((t) => t.status === 'open');
  const closed = trades.filter((t) => t.status === 'closed').reverse();
  const brain = bot?.brain;
  const winRate = brain && brain.n ? brain.wins / brain.n : null;
  const curve = (bot?.equity ?? []).map((e) => e.total);
  if (!curve.length || curve[curve.length - 1] !== Math.round(s.total)) curve.push(s.total);
  const lessons = brain ? topLessons(brain) : [];

  const toggle = (enabled: boolean) =>
    void ctl
      .enable(enabled)
      .then(() => ctl.cloud && toast(enabled ? 'Switched on — on your server' : 'Paused — on your server', 'ok'))
      .catch((e: unknown) => toast(errorMessage(e), 'err'));
  const reset = (forget: boolean) =>
    void ctl
      .reset(forget, startCash)
      .then(() => toast(forget ? 'Auto-trader reset completely' : 'Money reset — it kept what it learned'))
      .catch((e: unknown) => toast(errorMessage(e), 'err'))
      .finally(() => setConfirm(null));

  return (
    <div class="bot-view" data-testid="bot-view">
      <section class="bot-hero" data-testid="bot-hero">
        <div class="bot-hero-bg" aria-hidden="true" />
        <div class="row">
          <span class={`bot-avatar big ${st.cls}`} aria-hidden="true">
            <Icon name="robot" size={30} />
            <i />
            <i />
          </span>
          <div class="grow">
            <div class="tiny hero-label">Auto-trader · pretend money · trades by itself</div>
            <span class={`bot-status ${st.cls}`} data-testid="bot-status">
              <span class="dot" /> {st.text}
            </span>
          </div>
        </div>
        <div class="bot-total" data-testid="bot-total">
          <AnimatedNumber value={s.total} format={(v) => formatINR(v, 0)} />
        </div>
        <div class="row bot-pnl">
          <span class="pnl-chip">Today {signed(s.todayPnl)}</span>
          <span class="small">Overall {signed(s.totalPnl)}</span>
          <span class="spacer" />
          <Sparkline values={curve.length > 1 ? curve : [s.total, s.total]} width={96} height={34} />
        </div>
        <div class="tiny bot-hero-foot">
          Put in {formatINR(bot?.wallet.startCash ?? BOT_START, 0)} · free {formatINR(s.free, 0)} · {open.length} open · {winRate === null ? 'no finished trades yet' : `won ${brain!.wins} of ${brain!.n} (${Math.round(winRate * 100)}%)`}
        </div>
      </section>

      <CloudBotPanel link={link} bot={bot} />

      <section class="card">
        <label class="row switch-row">
          <span class="grow">
            <b>Let it trade by itself</b>
            <span class="tiny muted" style={{ display: 'block' }}>
              It decides what to buy or sell first, how much, and when to close — every minute from 9:30 am. Pretend money only: it never touches your Upstox account.
            </span>
          </span>
          <input type="checkbox" role="switch" class="switch" data-testid="bot-switch" checked={bot?.enabled ?? true} disabled={!ctl.canControl} onChange={(e) => toggle((e.currentTarget as HTMLInputElement).checked)} />
        </label>
        {ctl.why && <p class="tiny muted" data-testid="bot-readonly">{ctl.why}</p>}
        {bot?.note && (
          <p class="small muted bot-note" data-testid="bot-note">
            <span class="think" aria-hidden="true" /> {bot.note}
          </p>
        )}
        {!link && <GapNote bot={bot} now={now} marketOpen={market.phase === 'open'} />}
      </section>

      <AmountCard bot={bot} total={s.total} free={s.free} ctl={ctl} />
      <ProtectCard bot={bot} todayPnl={s.todayPnl} total={s.total} ctl={ctl} protectTest={link ? ((link.snapshot?.protectTest ?? null) as ReturnType<typeof useLocal<'botProtectTest'>>) : undefined} />

      <section class="card" data-testid="bot-open">
        <h2>
          Open trades <span class="count-pill">{open.length}</span>
        </h2>
        {open.length === 0 ? <p class="small muted">None right now. When it finds a good idea, the trade appears here and moves live.</p> : open.map((t) => <OpenTrade t={t} ltp={quotes[t.key]?.ltp ?? null} now={now} key={t.id} />)}
      </section>

      <section class="card" data-testid="bot-learned">
        <h2>
          <Icon name="brain" size={18} /> What it has learned
        </h2>
        {!brain || brain.n === 0 ? (
          <p class="small muted">Nothing yet — it learns from every finished trade. It starts out trusting the app's studies (the day-trade model, the top picks' past record, the sell-first test) and changes its mind as its own results come in.</p>
        ) : (
          <>
            <p class="small" style={{ margin: '0 0 8px' }}>
              From <b>{brain.n}</b> finished trades: won <b>{brain.wins}</b> ({Math.round((brain.wins / brain.n) * 100)}%).
            </p>
            {brain.curve.length > 2 && (
              <div class="row small muted" style={{ gap: '8px', alignItems: 'center' }}>
                Win rate over time <Sparkline values={brain.curve} width={140} height={30} />
              </div>
            )}
            {lessons.length > 0 && (
              <ul class="lessons small">
                {lessons.map((l) => (
                  <li class={l.up ? 'up' : 'down'}>{l.text}</li>
                ))}
              </ul>
            )}
          </>
        )}
        <div class="strat-table small">
          {STRATEGIES.map((k) => {
            const x = brain?.by[k] ?? { n: 0, wins: 0, pnl: 0, r: 0 };
            const f = strategyFocus(x);
            return (
              <div class="strat-row" data-strategy={k}>
                <span class="grow">{STRATEGY_LABEL[k]}</span>
                <span class="muted">{x.n ? `${x.wins}/${x.n} won` : '—'}</span>
                <span class={tone(x.pnl)}>{x.n ? signed(x.pnl) : ''}</span>
                <span class={`focus ${f}`}>{f === 'more' ? 'focus more' : f === 'less' ? 'smaller trades' : f === 'paused' ? 'paused' : 'learning'}</span>
              </div>
            );
          })}
        </div>
      </section>

      <section class="card" data-testid="bot-log">
        <h2>What it did</h2>
        {(bot?.log ?? []).length === 0 ? (
          <p class="small muted">Nothing yet.</p>
        ) : (
          <ol class="timeline">
            {[...(bot?.log ?? [])]
              .reverse()
              .slice(0, 14)
              .map((e) => (
                <li class={e.kind}>
                  <span class="tl-time">{formatTimeIST(e.at).slice(0, 5)}</span>
                  <span class="tl-dot" />
                  <span class="tl-text small">{e.text}</span>
                </li>
              ))}
          </ol>
        )}
      </section>

      <section class="card" data-testid="bot-closed">
        <h2>Finished trades</h2>
        {closed.length === 0 ? (
          <p class="small muted">None yet.</p>
        ) : (
          closed.slice(0, 20).map((t) => (
            <div class="bot-closed-row">
              <div class="row">
                <b>{t.symbol}</b>
                <span class={`chip ${t.side === 'long' ? 'day buy' : 'day sell'}`}>{t.side === 'long' ? 'BUY' : 'SELL first'}</span>
                <span class="tiny muted">{STRATEGY_LABEL[t.strategy]}</span>
                <span class="spacer" />
                <b class={tone(t.pnl ?? 0)}>{signed(t.pnl ?? 0)}</b>
              </div>
              <div class="tiny muted">
                {t.qty} × ₹{formatNumberIN(t.entry)} → ₹{formatNumberIN(t.exitPrice ?? t.entry)} · {t.exitWhy} · {(t.r ?? 0) >= 0 ? '+' : ''}
                {(t.r ?? 0).toFixed(1)} R · {istDate(t.openedAt)} {formatTimeIST(t.openedAt).slice(0, 5)}
              </div>
              {t.lesson && <div class="tiny lesson-line">🧠 {t.lesson}</div>}
            </div>
          ))
        )}
      </section>

      <section class="card">
        <details class="small">
          <summary>How it decides</summary>
          <ul>
            <li>Every minute from 9:30 am it looks at today's day-trade buy signals, "Rising today", the top picks and the "Falling now" sell-first ideas.</li>
            <li>For each idea it works out a chance of making money (the app's studies, adjusted by what it learned from its own trades) and the expected result after charges. It only takes ideas worth more than their risk.</li>
            <li>
              Size — no fixed limit: it can put any amount into a trade, up to all its free cash (no borrowing). How much it risks comes from its own confidence (a quarter of the "Kelly" amount): {MIN_RISK * 100}% of its money when unsure, up to {MAX_RISK * 100}% when very sure. When several good ideas appear at once, its free cash is shared among them by how good each one is.
            </li>
            <li>
              With <b>Protect my money</b> on (the default): at most one stock per ₹25,000 (up to 10 at once), each at most a fair share of the money; "hold a few days" picks only up to their share; no buy on stocks with bad news today, nothing against a market clearly going the other way. It keeps the day's profit and stops at the daily loss limit (see above). No new same-day trades after 2:30 pm (closed by 3:10), top picks until 3:15.
            </li>
            <li>
              Every trade has a safety net (sell if it falls to…) and a target. Same-day trades: the safety net moves to the buy price at 0.75× the risk in profit and then follows the best price; half is sold at 1× the risk; a trade that goes nowhere is closed; everything by 3:10 pm. Top picks: the buy price at 1× the risk, then it follows; sold after {SWING_MAX_DAYS} market days. Same-day buys are booked as Upstox <b>Intraday</b> (lower charges), paid in full — no borrowing.
            </li>
            <li>About 1 decision in 8 is a small test trade on an idea it is unsure about — so it keeps learning.</li>
            <li>If the phone stopped the app during market hours, it replays the 5-minute candles it missed when you open it again, so a safety net that was hit counts as hit.</li>
            <li>Moved to your server (app 1.22): the server runs exactly these rules every market minute, also with this app closed; this phone shows the server’s state and sends your changes to it — it never trades a second copy.</li>
          </ul>
        </details>
        <div class="row" style={{ gap: '8px', flexWrap: 'wrap', marginTop: '8px' }}>
          <button class="btn small" type="button" data-testid="bot-reset" disabled={!ctl.canControl} onClick={() => setConfirm('money')}>
            Start again (keep learning)
          </button>
          <button class="btn small danger" type="button" disabled={!ctl.canControl} onClick={() => setConfirm('all')}>
            Forget everything
          </button>
        </div>
        {confirm && (
          <div class="confirm-box small">
            <label class="field" style={{ margin: '0 0 8px' }}>
              <span>Start with (any amount, ₹)</span>
              <input type="text" inputMode="numeric" value={amount} data-field="bot-amount" onInput={(e) => setAmount((e.currentTarget as HTMLInputElement).value)} />
            </label>
            {startCash < 10_000 ? 'Enter at least ₹10,000.' : confirm === 'money' ? `Start again with ${formatINR(startCash, 0)}? Open trades are dropped; what it learned is kept.` : `Start again with ${formatINR(startCash, 0)} and a fresh brain?`}
            <div class="row" style={{ gap: '8px', marginTop: '8px' }}>
              <button class="btn small danger" type="button" disabled={startCash < 10_000} data-testid="bot-reset-yes" onClick={() => reset(confirm === 'all')}>
                Yes
              </button>
              <button class="btn small" type="button" onClick={() => setConfirm(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

/** One open trade with a live progress bar: safety net ← buy price → target. */
function OpenTrade({ t, ltp, now }: { t: BotTrade; ltp: number | null; now: number }) {
  const flash = useFlash(ltp);
  const [copy, setCopy] = useState(false);
  const px = ltp ?? t.entry;
  const dir = t.side === 'long' ? 1 : -1;
  const qty = t.left ?? t.qty;
  const pnl = (px - t.entry) * qty * dir;
  const locked = (t.stop - t.entry) * dir;
  const lo = t.side === 'long' ? t.stop0 : t.target;
  const hi = t.side === 'long' ? t.target : t.stop0;
  const pos = (v: number) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
  const mins = Math.max(0, Math.round((now - t.openedAt) / 60_000));
  const held = mins < 60 ? `${mins} min` : mins < 1440 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${Math.floor(mins / 1440)} days`;
  return (
    <div class={`bot-trade ${t.side}`} data-symbol={t.symbol} data-testid="bot-trade">
      <div class="row">
        <span class={`chip ${t.side === 'long' ? 'day buy' : 'day sell'}`}>{t.side === 'long' ? '▲ BUY' : '▼ SELL first'}</span>
        <b class="bt-sym">{t.symbol}</b>
        {t.explore && <span class="chip flag">test trade</span>}
        <span class="spacer" />
        <span class={`price ${flash}`}>₹{formatNumberIN(px)}</span>
      </div>
      <div class="row small">
        <span class="muted">
          {qty} shares{t.halfDone ? ` (half of ${t.qty} sold)` : ''} · ₹{formatNumberIN(t.entry)} · {formatINR(qty * t.entry, 0)} · {held}{t.product === 'intraday' ? ' · Intraday' : t.strategy === 'swing' ? ' · Delivery' : ''}
        </span>
        <span class="spacer" />
        <b class={tone(pnl)}>
          <AnimatedNumber value={pnl} format={signed} ms={400} />
        </b>
      </div>
      <div class={`trade-track ${t.side}`} role="img" aria-label={`Safety net ₹${t.stop}, bought ₹${t.entry}, target ₹${t.target}, now ₹${px}`}>
        <span class="fill" style={{ left: `${Math.min(pos(t.entry), pos(px))}%`, width: `${Math.abs(pos(px) - pos(t.entry))}%` }} data-good={pnl >= 0 ? '1' : '0'} />
        <span class="mark entry" style={{ left: `${pos(t.entry)}%` }} />
        {t.stop !== t.stop0 && <span class="mark trail" style={{ left: `${pos(t.stop)}%` }} title="safety net moved" />}
        <span class="mark now" style={{ left: `${pos(px)}%` }} />
      </div>
      <div class="row tiny muted track-labels">
        <span>{t.side === 'long' ? `safety ₹${formatNumberIN(t.stop0)}` : `target ₹${formatNumberIN(t.target)}`}</span>
        <span class="spacer" />
        <span>{t.side === 'long' ? `target ₹${formatNumberIN(t.target)}` : `safety ₹${formatNumberIN(t.stop0)}`}</span>
      </div>
      <div class="tiny bt-why">
        {Math.round(t.chance * 100)}% chance · {STRATEGY_LABEL[t.strategy]} · {t.reasons.slice(0, 2).join(' · ')}
        {t.stop !== t.stop0 && <span class="ok-text"> · {locked > 0 ? `safety net raised to ₹${formatNumberIN(t.stop)} — at least ${formatINR(locked * qty, 0)} profit kept` : 'safety net moved to the buy price — can no longer lose'}</span>}
      </div>
      <button class="btn small" type="button" data-testid="bot-copy" style={{ marginTop: '6px' }} onClick={() => setCopy(!copy)}>
        Copy in Upstox
      </button>
      {copy && (
        <ol class="small how-steps" data-testid="bot-copy-steps">
          {copySteps({ symbol: t.symbol, side: t.side, qty: t.left ?? t.qty, entry: t.entry, stop: t.stop, target: t.target, swing: t.strategy === 'swing', ...(t.t1 !== undefined ? { t1: t.t1 } : {}) }).map((x) => (
            <li>{x}</li>
          ))}
          <li class="muted">You place it yourself — the app never sends orders. Your price can differ a little from the auto-trader's.</li>
        </ol>
      )}
    </div>
  );
}

/** When the auto-trader could not run during market hours (app closed / phone asleep). */
function GapNote({ bot, now, marketOpen }: { bot: BotState | null | undefined; now: number; marketOpen: boolean }) {
  const g = bot?.lastGap;
  if (!g || istDate(g.to) !== istDate(now)) return null;
  const mins = Math.round((g.to - g.from) / 60_000);
  return (
    <p class="small bot-gap" data-testid="bot-gap">
      ⏸ Not running {formatTimeIST(g.from).slice(0, 5)}–{formatTimeIST(g.to).slice(0, 5)} ({mins} min) — the app was closed or the phone was asleep. It checked its safety nets and targets against the 5-minute prices it missed, but could not open trades in that time.
      {marketOpen && ' To keep it running: keep the app open or in the background, and set Settings → Apps → TradeBuddy → Battery → Unrestricted.'}
    </p>
  );
}

/** App v1.13: the money it trades with — type it, or take what is in your Upstox account. */
function AmountCard({ bot, total, free, ctl }: { bot: BotState | null | undefined; total: number; free: number; ctl: BotControls }) {
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState<null | 'funds' | 'set'>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const typed = Math.round(Number(amount.replace(/[^0-9.]/g, '')) || 0);
  const lowest = Math.max(10_000, Math.ceil(total - free));
  const fromUpstox = async () => {
    setBusy('funds');
    setMsg(null);
    try {
      const f = await callBackground('funds:get');
      setAmount(String(Math.floor(f.cash)));
      setMsg({ ok: true, text: `Your Upstox account has ${formatINR(f.cash, 0)} available to trade (read only). Tap "Set amount" to use it.` });
    } catch (e) {
      setMsg({ ok: false, text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };
  const set = async () => {
    setBusy('set');
    setMsg(null);
    try {
      const r = await ctl.amount(typed);
      setMsg({ ok: true, text: `Done — it now trades with ${formatINR(r.total, 0)} (${formatINR(r.free, 0)} free). Open trades and what it learned are kept.` });
      setAmount('');
    } catch (e) {
      setMsg({ ok: false, text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };
  return (
    <section class="card" data-testid="bot-amount-card">
      <h2>Amount to auto-trade</h2>
      <p class="tiny muted" style={{ margin: '0 0 8px' }}>
        Set it to what you have in Upstox and every auto-trade is sized for your real money — you can copy it share for share. Now: <b>{formatINR(total, 0)}</b> · holds at most <b>{maxOpenFor(total)}</b> stock{maxOpenFor(total) === 1 ? '' : 's'} at once
        {bot ? '' : ' (₹50 lakh until you set it)'}.
      </p>
      <div class="row" style={{ gap: '8px', flexWrap: 'wrap' }}>
        <input type="text" inputMode="numeric" placeholder="e.g. 100000" value={amount} data-field="bot-set-amount" style={{ flex: '1 1 140px' }} onInput={(e) => setAmount((e.currentTarget as HTMLInputElement).value)} />
        <button class="btn small primary" type="button" data-testid="bot-set-amount" disabled={busy !== null || typed < 10_000 || !ctl.canControl} onClick={() => void set()}>
          {busy === 'set' ? 'Setting…' : 'Set amount'}
        </button>
        <button class="btn small" type="button" data-testid="bot-upstox-funds" disabled={busy !== null || !ctl.canControl} onClick={() => void fromUpstox()}>
          {busy === 'funds' ? 'Asking Upstox…' : 'Use my Upstox balance'}
        </button>
      </div>
      {typed > 0 && typed < lowest && <p class="tiny err-text">{typed < 10_000 ? 'At least ₹10,000.' : `${formatINR(total - free, 0)} is in open trades — the lowest it can go now is ${formatINR(lowest, 0)}.`}</p>}
      {typed >= 10_000 && <p class="tiny muted">With {formatINR(typed, 0)}: at most {maxOpenFor(typed)} stock{maxOpenFor(typed) === 1 ? '' : 's'} at once.</p>}
      {msg && <p class={`small ${msg.ok ? 'ok-text' : 'err-text'}`} data-testid="bot-amount-msg">{msg.text}</p>}
    </section>
  );
}

const pctLabel = (x: number) => `${x}%`;

/** App v1.13: keep the day's profit, the daily loss limit, the few-days share and the quick exit — with the past test. */
function ProtectCard({ bot, todayPnl, total, ctl, protectTest }: { bot: BotState | null | undefined; todayPnl: number; total: number; ctl: BotControls; protectTest?: ReturnType<typeof useLocal<'botProtectTest'>> }) {
  const rules = protectRules(bot?.rules);
  const ownTest = useLocal('botProtectTest');
  // app v1.22: on the server, its own past test (its own history)
  const test = protectTest !== undefined ? protectTest : ownTest;
  const [busy, setBusy] = useState(false);
  const now = Date.now();
  const today = istDate(now);
  const guard = bot?.guard?.date === today ? bot.guard : undefined;
  const money = total - todayPnl;
  const keep = keepLevel(guard, money, rules);
  const set = (patch: Partial<ProtectRules>) => void ctl.rules(patch).catch((e: unknown) => toast(errorMessage(e), 'err'));
  const rerun = () => {
    setBusy(true);
    void ctl
      .protectTest()
      .then((r) => toast(r.ok ? `Past test done: ${r.days} days` : 'Not enough 5-minute history yet', r.ok ? 'ok' : 'err'))
      .catch((e: unknown) => toast(errorMessage(e), 'err'))
      .finally(() => setBusy(false));
  };
  const chips = <K extends keyof typeof PROTECT_CHOICES>(k: K, label: (v: number) => string) => (
    <span class="row" style={{ gap: '6px', flexWrap: 'wrap' }}>
      {PROTECT_CHOICES[k].map((v) => (
        <button type="button" class={`filter-chip ${rules[k] === v ? 'on' : ''}`} data-protect={`${k}-${v}`} disabled={!rules.on || !ctl.canControl} onClick={() => set({ [k]: v } as Partial<ProtectRules>)}>
          {label(v)}
        </button>
      ))}
    </span>
  );
  return (
    <section class="card" data-testid="bot-protect">
      <label class="row switch-row">
        <span class="grow">
          <b>Protect my money</b>
          <span class="tiny muted" style={{ display: 'block' }}>
            Keeps the day's profit, cuts losing trades early and stops on a bad day. Off = as before (no day limits).
          </span>
        </span>
        <input type="checkbox" role="switch" class="switch" data-testid="bot-protect-switch" checked={rules.on} disabled={!ctl.canControl} onChange={(e) => set({ on: (e.currentTarget as HTMLInputElement).checked })} />
      </label>
      {rules.on && (
        <>
          <p class="small" data-testid="bot-protect-today" style={{ margin: '6px 0' }}>
            {guard?.halted === 'lock'
              ? `✅ Stopped for today at ${formatTimeIST(guard.haltedAt ?? now).slice(0, 5)}: kept the profit (${signed(guard.pnlAtHalt ?? 0)}; best ${signed(guard.best)}).`
              : guard?.halted === 'loss'
                ? `⛔ Stopped for today at ${formatTimeIST(guard.haltedAt ?? now).slice(0, 5)}: daily loss limit (${signed(guard.pnlAtHalt ?? 0)}).`
                : keep !== null
                  ? `Today's best ${signed(guard!.best)} — it sells what it bought today if the day falls to ${signed(keep)}.`
                  : `Keeps the profit once the day is up ${formatINR((rules.lockStartPct / 100) * money, 0)}; stops at a loss of ${formatINR((rules.dayLossPct / 100) * money, 0)}.`}
          </p>
          <div class="protect-grid small">
            <span class="muted">Keep the profit from</span>
            {chips('lockStartPct', (v) => `+${v}%`)}
            <span class="muted">Daily loss limit</span>
            {chips('dayLossPct', (v) => `−${v}%`)}
            <span class="muted">Few-days picks at most</span>
            {chips('swingSharePct', pctLabel)}
            <span class="muted">Close a trade going nowhere after</span>
            {chips('quickExitMin', (v) => (v ? `${v} min` : 'never'))}
          </div>
        </>
      )}
      <ProtectTestLine test={test} busy={busy || !ctl.canControl} rerun={rerun} />
    </section>
  );
}

function ProtectTestLine({ test, busy, rerun }: { test: ReturnType<typeof useLocal<'botProtectTest'>>; busy: boolean; rerun: () => void }) {
  return (
    <div class="small" data-testid="bot-protect-test" style={{ marginTop: '8px' }}>
      {!test ? (
        <p class="tiny muted" style={{ margin: 0 }}>
          Past test: runs once the 5-minute history (Nifty 100 + your stocks) has downloaded.
        </p>
      ) : (
        <div class={`verdict ${test.protected.pnl >= test.old.pnl ? 'pass' : 'fail'}`}>
          <b>Past test on {test.days} market days</b> ({formatINR(test.money, 0)}, the same {test.trades} same-day trades both ways, after charges):
          <br />
          Old way <span class={tone(test.old.pnl)}>{signed(test.old.pnl)}</span> · protected <span class={tone(test.protected.pnl)}>{signed(test.protected.pnl)}</span>
          <br />
          Worst day {signed(test.old.worstDay)} → {signed(test.protected.worstDay)} · days that gave back a good start: {test.old.gaveBackDays} → {test.protected.gaveBackDays} · profit kept early on {test.keptDays} day{test.keptDays === 1 ? '' : 's'}, loss limit on {test.limitDays}.
          {test.protected.pnl < test.old.pnl && ' On these days the protection earned less than the old way — it trades safety for profit. Use practice only, or change the levels.'}
        </div>
      )}
      <button class="btn small" type="button" style={{ marginTop: '6px' }} disabled={busy} data-testid="bot-protect-rerun" onClick={rerun}>
        {busy ? 'Testing…' : 'Run the past test again'}
      </button>
    </div>
  );
}
