import { useState } from 'preact/hooks';
import { STRATEGIES, STRATEGY_LABEL, strategyFocus, topLessons } from '../../bot/brain';
import { BOT_START, DAILY_LOSS_LIMIT, MAX_NEW_PER_DAY, MAX_OPEN, SWING_MAX_DAYS } from '../../bot/policy';
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

/**
 * App v1.6 — the auto-trader on screen: ₹50 lakh of pretend money that trades by itself.
 * Everything here only shows what the background auto-trader did; the switch pauses it.
 */

const signed = (x: number) => `${x >= 0 ? '+' : '−'}${formatINR(Math.abs(x), 0)}`;
const tone = (x: number) => (x > 0 ? 'ok-text' : x < 0 ? 'err-text' : 'muted');

function useBotView() {
  const bot = useLocal('bot');
  const quotes = useQuotes();
  const now = useNow(3_000);
  const today = istDate(now);
  const wallet = bot?.wallet ?? newWallet(now, BOT_START);
  const s = walletSummary(wallet, quotes, today);
  return { bot, quotes, now, today, s };
}

function status(bot: BotState | null | undefined, marketOpen: boolean): { text: string; cls: string } {
  if (!bot) return { text: 'Starting — needs live prices', cls: 'idle' };
  if (!bot.enabled) return { text: 'Paused by you', cls: 'idle' };
  if (marketOpen && bot.note?.startsWith('Stopped for today')) return { text: 'Stopped for today (loss limit)', cls: 'warn' };
  if (marketOpen) return { text: 'Trading by itself', cls: 'live' };
  return { text: 'Market closed — waits for 9:30', cls: 'idle' };
}

/** Home: a small live card. */
export function AutoTraderMini({ go }: { go: Go }) {
  const { bot, s } = useBotView();
  const market = useMarketState();
  const st = status(bot, market.phase === 'open');
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
  const { bot, quotes, now, s } = useBotView();
  const market = useMarketState();
  const st = status(bot, market.phase === 'open');
  const [confirm, setConfirm] = useState<null | 'money' | 'all'>(null);
  const trades = bot?.trades ?? [];
  const open = trades.filter((t) => t.status === 'open');
  const closed = trades.filter((t) => t.status === 'closed').reverse();
  const brain = bot?.brain;
  const winRate = brain && brain.n ? brain.wins / brain.n : null;
  const curve = (bot?.equity ?? []).map((e) => e.total);
  if (!curve.length || curve[curve.length - 1] !== Math.round(s.total)) curve.push(s.total);
  const lessons = brain ? topLessons(brain) : [];

  const toggle = (enabled: boolean) => void callBackground('bot:enable', { enabled }).catch((e: unknown) => toast(errorMessage(e), 'err'));
  const reset = (forget: boolean) =>
    void callBackground('bot:reset', { forget })
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
          Started with {formatINR(BOT_START, 0)} · free {formatINR(s.free, 0)} · {open.length} open · {winRate === null ? 'no finished trades yet' : `won ${brain!.wins} of ${brain!.n} (${Math.round(winRate * 100)}%)`}
        </div>
      </section>

      <section class="card">
        <label class="row switch-row">
          <span class="grow">
            <b>Let it trade by itself</b>
            <span class="tiny muted" style={{ display: 'block' }}>
              It decides what to buy or sell first, how much, and when to close — every minute from 9:30 am. Pretend money only: it never touches your Upstox account.
            </span>
          </span>
          <input type="checkbox" role="switch" class="switch" data-testid="bot-switch" checked={bot?.enabled ?? true} onChange={(e) => toggle((e.currentTarget as HTMLInputElement).checked)} />
        </label>
        {bot?.note && (
          <p class="small muted bot-note" data-testid="bot-note">
            <span class="think" aria-hidden="true" /> {bot.note}
          </p>
        )}
      </section>

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
            <li>Size: it risks about 0.5% of its money per trade (less when unsure, up to 0.75% when confident), never more than 20% of its money in one stock.</li>
            <li>
              Limits: at most {MAX_OPEN} open trades and {MAX_NEW_PER_DAY} new trades a day; no new same-day trades after 2:30 pm; it stops for the day after losing {DAILY_LOSS_LIMIT * 100}% of its money.
            </li>
            <li>Every trade has a safety net (sell if it falls to…) and a target. Once a trade is 1× its risk in profit, the safety net moves to the buy price. Same-day trades close by 3:10 pm; top picks after {SWING_MAX_DAYS} market days.</li>
            <li>About 1 decision in 8 is a small test trade on an idea it is unsure about — so it keeps learning.</li>
            <li>If the phone stopped the app during market hours, it replays the 5-minute candles it missed when you open it again, so a safety net that was hit counts as hit.</li>
          </ul>
        </details>
        <div class="row" style={{ gap: '8px', flexWrap: 'wrap', marginTop: '8px' }}>
          <button class="btn small" type="button" onClick={() => setConfirm('money')}>
            Reset money (keep learning)
          </button>
          <button class="btn small danger" type="button" onClick={() => setConfirm('all')}>
            Forget everything
          </button>
        </div>
        {confirm && (
          <div class="confirm-box small">
            {confirm === 'money' ? `Start again with ${formatINR(BOT_START, 0)}? Open trades are dropped; what it learned is kept.` : 'Start again with new money and a fresh brain?'}
            <div class="row" style={{ gap: '8px', marginTop: '8px' }}>
              <button class="btn small danger" type="button" onClick={() => reset(confirm === 'all')}>
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
  const px = ltp ?? t.entry;
  const dir = t.side === 'long' ? 1 : -1;
  const pnl = (px - t.entry) * t.qty * dir;
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
          {t.qty} shares · ₹{formatNumberIN(t.entry)} · {formatINR(t.qty * t.entry, 0)} · {held}
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
        {t.stop !== t.stop0 && <span class="ok-text"> · safety net moved to the buy price — can no longer lose</span>}
      </div>
    </div>
  );
}
