import { useState } from 'preact/hooks';
import { STRATEGIES, STRATEGY_LABEL, topLessons } from '../../bot/brain';
import type { PlaybookEvidence, PlaybookState } from '../../bot/evidence';
import { PLAYBOOK_LABEL, playbookOf, type PlaybookId } from '../../bot/playbooks';
import { AGAINST_MARKET_SIZE, BOT_START, MAX_CHARGES_R, MAX_LEARNING_OPEN, MAX_OPEN_RISK, MAX_PER_INDUSTRY, MIN_EDGE_R, minPositionFor, RISK_SHARE, SWING_MAX_DAYS } from '../../bot/policy';
import { EVIDENCE } from '../../bot/evidence';
import { DRAWDOWN, PROTECT_CHOICES, keepLevel, maxOpenFor, maxPositionFor, protectRules, type ProtectRules } from '../../bot/protect';
import { copySteps } from '../../bot/copy';
import type { BotState, BotTrade, RushSummary } from '../../background/botJobs';
import { EXIT_STYLE_SHORT, EXIT_STYLES } from '../../bot/openRush';
import { formatINR, formatNumberIN, formatTimeIST } from '../../lib/format';
import { errorMessage } from '../../lib/serialize';
import { istDate } from '../../lib/time';
import { callBackground } from '../../shared/messages';
import { estimateCharges, newWallet, walletSummary } from '../../wallet/wallet';
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
              It decides what to buy or sell first, how much, and when to close — from 9:15 am (Opening rush; the other kinds from 9:30). Pretend money only: it never touches your Upstox account.
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
        <DrawdownNote bot={bot} ctl={ctl} />
      </section>

      <KindsCard bot={bot} total={s.total} ctl={ctl} />

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
          <p class="small muted">Nothing yet — it learns from every finished trade. What it learns ranks the ideas of a kind; whether a kind may use money at all comes from its results (Kinds of trade, above).</p>
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
            return (
              <div class="strat-row" data-strategy={k}>
                <span class="grow">{STRATEGY_LABEL[k]}</span>
                <span class="muted">{x.n ? `${x.wins}/${x.n} won` : '—'}</span>
                <span class={tone(x.pnl)}>{x.n ? signed(x.pnl) : ''}</span>
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
                <span class="tiny muted">{PLAYBOOK_LABEL[playbookOf(t)]}</span>
                <span class="spacer" />
                <b class={tone(t.pnl ?? 0)}>{signed(t.pnl ?? 0)}</b>
              </div>
              <div class="tiny muted">
                {t.qty} × ₹{formatNumberIN(t.entry)} → ₹{formatNumberIN(t.exitPrice ?? t.entry)} · {t.exitWhy} · {(t.r ?? 0) >= 0 ? '+' : ''}
                {(t.r ?? 0).toFixed(1)} R after charges{t.grossR !== undefined ? ` (${t.grossR >= 0 ? '+' : ''}${t.grossR.toFixed(1)} R before)` : ''} · {istDate(t.openedAt)} {formatTimeIST(t.openedAt).slice(0, 5)}
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
            <li>
              <b>Opening rush</b> (9:15–9:35, app 1.25): it reads the pre-open list (price jump, buyers vs sellers, news) and, from 9:15, buys a stock that holds its opening jump — above its opening price and the day's average price, with heavy buying — as it makes a new high, every 15 seconds. The safety net sits close under the day's average price (0.3–1.2% away), so a wrong trade is a small loss and the position can be big for the same money at risk. It sells the way its past test did best after charges: quick profit, half and half, or let it run (see Kinds of trade). Never after the stock fell back or ran 2.5% from its open.
            </li>
            <li>From 9:30 am, every minute, it also looks at today's day-trade buy signals, Rising now, the top picks, the "Falling now" sell-first ideas, breakouts and the Intraday scanner's BUY. A stock that already lost money today gets no second try that day.</li>
            <li>
              Each kind of trade is judged on its own results: its finished trades, counted before charges, and its past test on days it never saw, counted cautiously (a safe estimate). <b>Proven</b> kinds ({EVIDENCE.provenMinN} trades, safe estimate +{EVIDENCE.provenMinSafeR.toFixed(2)} R or better) and <b>trial</b> kinds ({EVIDENCE.trialMinN} trades, safe estimate 0 R or better) use their normal sizes; kinds <b>not proven yet</b> trade at a small learning size (at most {MAX_LEARNING_OPEN} such trades at once) so they build a record. A kind whose newest 20 trades average below −0.05 R is paused — followed as shadow trades, no money — until they reach +0.10 R. You can switch any kind off.
            </li>
            <li>
              Size: {RISK_SHARE.proven * 100}% of its money at risk on a proven kind, {RISK_SHARE.trial * 100}% on a trial kind, {RISK_SHARE.learning * 100}% on a kind not proven yet — never more than half the daily loss limit. All open trades together risk at most {MAX_OPEN_RISK * 100}%, at most {MAX_PER_INDUSTRY} open trades per industry. A trade is skipped when Upstox's charges for its size would be more than {MAX_CHARGES_R * 100}% of its risk, or (trial and proven kinds) when its kind's safe estimate minus those charges is below {MIN_EDGE_R} R.
            </li>
            <li>With the market's direction: no new buys while the market is falling, no new sell-first trades while it is rising — the same rules as the alerts. Only trial and proven kinds may go against it, at {AGAINST_MARKET_SIZE * 100}% of their size.</li>
            <li>
              With <b>Protect my money</b> on (the default): at most one stock per ₹25,000 (up to 10 at once), each at most a fair share of the money; "hold a few days" picks only up to their share; no buy on stocks with bad news today, nothing against a market clearly going the other way. It keeps the day's profit and stops at the daily loss limit (see above); two losing trades of one kind stop that kind for the day. No new same-day trades after 2:30 pm (closed by 3:10), top picks until 3:15.
            </li>
            <li>Drawdown brake: {DRAWDOWN.halfAtPct}% below its best money it trades at half size; {DRAWDOWN.stopAtPct}% below, it stops opening trades until you press Resume.</li>
            <li>
              Every trade has a safety net (sell if it falls to…) and a target. Same-day trades: the safety net moves to the buy price at 0.75× the risk in profit and then follows the best price; half is sold at 1× the risk; a trade that goes nowhere is closed; everything by 3:10 pm. Top picks: the buy price at 1× the risk, then it follows; sold after {SWING_MAX_DAYS} market days. Same-day buys are booked as Upstox <b>Intraday</b> (lower charges), paid in full — no borrowing. It never adds to a losing trade.
            </li>
            <li>If the phone stopped the app during market hours, it replays the 5-minute candles it missed when you open it again, so a safety net that was hit counts as hit.</li>
            <li>Moved to your server (app 1.22): the server runs exactly these rules every market minute, also with this app closed; this phone shows the server’s state and sends your changes to it — it never trades a second copy.</li>
            <li>Not a guarantee: if no kind of trade has proven itself, it does not trade.</li>
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

const STATE_TEXT: Record<PlaybookState, string> = { proven: 'Proven', trial: 'Trial (small size)', watch: 'Not proven yet · learning size', paused: 'Paused', off: 'Off' };
const STATE_CLASS: Record<PlaybookState, string> = { proven: 'more', trial: 'less', watch: '', paused: 'paused', off: '' };
const rText = (x: number | null) => (x === null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2)} R`);

function kindLine(e: PlaybookEvidence): string {
  if (e.n) return `${e.n} finished${e.shadow ? ` (${e.shadow} shadow)` : ''} · won ${e.wins} · ${rText(e.avgNetR)} a trade after charges · safe estimate ${rText(e.safeR)} before charges`;
  if (e.prior && e.priorCounted) return `No trades of its own yet · past test: ${e.prior.trades} trades, ${rText(e.prior.avgR)} a trade (${e.prior.label})`;
  return 'No results yet';
}

/** app v1.23: each kind of trade with its state (app v1.24: kinds not proven yet trade at a learning size). */
function KindsCard({ bot, total, ctl }: { bot: BotState | null | undefined; total: number; ctl: BotControls }) {
  const [busy, setBusy] = useState<PlaybookId | null>(null);
  const list = bot?.evidence?.list ?? null;
  const shadowOpen = (bot?.shadow?.trades ?? []).filter((t) => t.status === 'open').length;
  const quickMin = minPositionFor(0.004, (v) => estimateCharges('intraday', 1, v));
  const toggle = (id: PlaybookId, off: boolean) => {
    setBusy(id);
    void ctl
      .playbook(id, off)
      .then(() => toast(`${PLAYBOOK_LABEL[id]}: ${off ? 'switched off' : 'switched on'}${ctl.cloud ? ' — on your server' : ''}`, 'ok'))
      .catch((e: unknown) => toast(errorMessage(e), 'err'))
      .finally(() => setBusy(null));
  };
  return (
    <section class="card" data-testid="bot-kinds">
      <h2>Kinds of trade</h2>
      <p class="tiny muted">
        Each kind is judged on its own results — its finished trades and its past test on days it never saw, counted cautiously. <b>Proven</b> kinds risk {RISK_SHARE.proven * 100}% of the money a trade, <b>trial</b> kinds {RISK_SHARE.trial * 100}%, kinds <b>not proven yet</b> {RISK_SHARE.learning * 100}% (learning size, at most {MAX_LEARNING_OPEN} at once). Paused kinds are followed as shadow trades (no money, no alerts) until they recover.
      </p>
      {!list ? (
        <p class="small muted">It rates its kinds of trade at its next run{ctl.cloud ? ' (if this stays empty, your server still runs an older version)' : ''}.</p>
      ) : (
        <div class="kinds-table">
          {list.map((e) => (
            <div class="kind-row" data-kind={e.id} data-state={e.state} key={e.id}>
              <div class="row" style={{ gap: '8px' }}>
                <b class="grow small">{PLAYBOOK_LABEL[e.id]}</b>
                <span class={`focus ${STATE_CLASS[e.state]}`}>{STATE_TEXT[e.state]}</span>
              </div>
              <div class="tiny muted">{kindLine(e)}</div>
              <div class="tiny">{e.why}</div>
              {e.id === 'open-drive' && bot?.rush && <RushLine r={bot.rush} />}
              <button class="btn small kind-toggle" type="button" data-testid={`kind-toggle-${e.id}`} disabled={!ctl.canControl || busy === e.id} onClick={() => toggle(e.id, e.state !== 'off')}>
                {e.state === 'off' ? 'Switch on' : 'Switch off'}
              </button>
            </div>
          ))}
        </div>
      )}
      {shadowOpen > 0 && (
        <p class="tiny muted" data-testid="bot-shadow">
          {shadowOpen} shadow trade{shadowOpen === 1 ? '' : 's'} open — followed with no money.
        </p>
      )}
      {maxPositionFor(total) < quickMin && (
        <p class="tiny bot-gap" data-testid="bot-small-money">
          With {formatINR(total, 0)} it skips the Rising now quick trades: with their 0.4% safety net, Upstox's charges would be more than {MAX_CHARGES_R * 100}% of the risk on any trade below {formatINR(quickMin, 0)}.
        </p>
      )}
    </section>
  );
}

/** app v1.25: the Opening rush test — each way of selling on the same trades, after charges. */
function RushLine({ r }: { r: RushSummary }) {
  return (
    <div class="tiny" data-testid="bot-rush">
      Ways of selling in its past test ({r.from} – {r.to}, same trades, after charges):{' '}
      {EXIT_STYLES.map((s, i) => {
        const x = r.styles[s];
        return (
          <span key={s}>
            {i ? ' · ' : ''}
            {s === r.best ? <b>{EXIT_STYLE_SHORT[s]}</b> : EXIT_STYLE_SHORT[s]} {rText(x.avgNetR)}
            {x.trades ? ` (won ${x.wins} of ${x.trades})` : ''}
          </span>
        );
      })}
      . Uses {r.why}
    </div>
  );
}

/** app v1.23: the drawdown brake stopped it — no new trades until Resume. */
function DrawdownNote({ bot, ctl }: { bot: BotState | null | undefined; ctl: BotControls }) {
  const [busy, setBusy] = useState(false);
  const d = bot?.ddStop;
  if (!d) return null;
  const resume = () => {
    setBusy(true);
    void ctl
      .resume()
      .then(() => toast('Resumed — it trades again', 'ok'))
      .catch((e: unknown) => toast(errorMessage(e), 'err'))
      .finally(() => setBusy(false));
  };
  return (
    <div class="small bot-gap" data-testid="bot-drawdown">
      ⏸ Stopped: its money fell {DRAWDOWN.stopAtPct}% below its best ({formatINR(d.peak, 0)} → {formatINR(d.total, 0)}). It opens no new trades until you press Resume; open trades keep their safety nets. Look at "Kinds of trade" first.
      <div style={{ marginTop: '8px' }}>
        <button class="btn small" type="button" data-testid="bot-resume" disabled={!ctl.canControl || busy} onClick={resume}>
          Resume
        </button>
      </div>
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
        {t.state === 'trial' && <span class="chip flag">trial size</span>}
        {t.state === 'watch' && <span class="chip flag">learning size</span>}
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
        {PLAYBOOK_LABEL[playbookOf(t)]}{t.state ? ` · ${t.state === 'proven' ? 'proven kind' : t.state === 'trial' ? 'trial kind' : 'not proven yet (learning size)'}` : ''}{t.chargesR !== undefined ? ` · charges ${t.chargesR.toFixed(2)} R` : ''} · {t.reasons.slice(0, 2).join(' · ')}
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
