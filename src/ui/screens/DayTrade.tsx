import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { DAY_RULES_VERSION, MIN_SESSIONS, runDayTest, type DayTestReport, type DayTestResult, type Variant } from '../../daytrade/backtest';
import { minutesIST, signalState } from '../../daytrade/live';
import { DEFAULT_RULES, dayTradePnl, hhmm } from '../../daytrade/rules';
import type { DaySignal, DayTrade } from '../../daytrade/types';
import { countIntradayDays, getIntradayDays } from '../../data/intraday';
import { NIFTY100_KEYS } from '../../data/universe';
import { formatDateIST, formatINR, formatNumberIN, formatPct, formatTimeIST } from '../../lib/format';
import { errorMessage } from '../../lib/serialize';
import { istDate, istEpoch } from '../../lib/time';
import { callBackground } from '../../shared/messages';
import { setLocal, updateSettings } from '../../storage/local';
import type { Go } from '../App';
import { BoughtForm } from '../components/Bought';
import { MoodLine, NewsCard, UpstoxSyncLine } from '../components/Market';
import { useInstrumentMap, useQuotes, useStudyKeys } from '../data';
import { useLocal, useMarketState, useNow, useSessionValue, useSettings } from '../hooks';
import { openTrade } from '../components/TradeSheet';
import { ChanceRing } from '../components/Motion';
import { LearningCard } from '../components/Learning';
import { RisingNowCard, meterTone } from '../components/RisingNow';
import { BreadthCard, FallingNowCard } from '../components/Shorts';
import { BreakoutCard } from '../components/Breakouts';
import { AlsoIn, IndexTag, ScanCoverage, useScanUniverse } from '../components/ScanList';

const signed = (x: number) => `${x >= 0 ? '+' : '−'}${formatINR(Math.abs(x), 0)}`;
const day = (d: string) => formatDateIST(istEpoch(d, '12:00'));
const R = DEFAULT_RULES;

function variantWords(v: Variant): string {
  const sides = v.sides === 'both' ? 'BUY and SELL (short) signals' : v.sides === 'long' ? 'BUY signals only' : 'SELL (short) signals only';
  const tgt = v.target === 'eod' ? 'no fixed target (hold until 3:10 pm)' : `target = ${v.target} × the stop distance`;
  return `${sides}; ${tgt}; only stocks with at least ${v.minRvol}× their usual volume in the first 15 minutes`;
}

/** Day-trade mode (v0.11.0): buy and sell — or sell short and buy back — on the same day. */
/** Today's plan at a glance: wait → ideas → last idea → close. The current step pulses. */
function DayPlan({ now }: { now: number }) {
  const t = minutesIST(now);
  const steps = [
    { from: 9 * 60 + 15, to: 9 * 60 + 30, time: '9:15', text: 'Opens — wait' },
    { from: 9 * 60 + 30, to: 11 * 60 + 30, time: '9:30', text: 'Buy ideas' },
    { from: 11 * 60 + 30, to: 15 * 60 + 10, time: '11:30', text: 'Hold & watch' },
    { from: 15 * 60 + 10, to: 15 * 60 + 30, time: '3:10', text: 'Close all' },
  ];
  return (
    <section class="plan" data-testid="day-plan" aria-label="Today's plan">
      {steps.map((s) => (
        <div class={`plan-step ${t >= s.from && t < s.to ? 'now' : t >= s.to ? 'done' : ''}`}>
          <b>{s.time}</b>
          {s.text}
        </div>
      ))}
    </section>
  );
}

export function DayTradeScreen({ go }: { go: Go }) {
  const settings = useSettings();
  const market = useMarketState();
  const now = useNow(5_000);
  const { testKeys, testLabel } = useStudyKeys();
  const scan = useScanUniverse();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (!settings) return <p class="muted">Loading…</p>;
  const on = settings.dayTrade.enabled;
  const minute = minutesIST(now);
  const amount = settings.risk.capitalInr;
  const slots = Math.max(1, Math.min(5, Math.round(settings.risk.sizing === 'split' ? settings.risk.splitInto : settings.risk.maxOpenTrades)));

  let status: string;
  if (market.phase !== 'open') status = `Market ${market.label}. Signals come on trading days between 9:35 and 11:30 am.`;
  else if (minute < 9 * 60 + 31) status = 'The first 15 minutes (9:15–9:30) are being measured. Signals can start at 9:35.';
  else if (minute < R.lastSignalT + R.barMinutes) status = `Watching ${formatNumberIN(scan.keys.length, 0)} stocks (all five indices) for buy ideas until 11:30 — checked at every 5-minute mark. Falling now and Breakout today keep watching all day.`;
  else if (minute < R.exitT) status = 'No new signals after 11:30. Open day trades are watched until 3:10 pm.';
  else status = 'After 3:10 pm: all day trades should be closed now.';

  return (
    <>
      <section class="card" data-testid="day-intro">
        <div class="row">
          <h2 style={{ margin: 0 }}>Day trading — buy and sell the same day</h2>
          <span class="spacer" />
          <label class="row small">
            <input
              type="checkbox"
              role="switch"
              class="switch"
              checked={on}
              data-testid="day-enable"
              onChange={(e) => {
                const v = (e.currentTarget as HTMLInputElement).checked;
                void callBackground('daytrade:enable', { enabled: v }).catch((err: unknown) => setMsg({ ok: false, text: errorMessage(err) }));
              }}
            />
            {on ? 'On' : 'Off'}
          </label>
        </div>
        {!on ? (
          <>
            <p class="small">
              The picks on the <b>Today</b> tab are for holding a few days to weeks. This tab is different: it looks for stocks that <b>break out of their first 15 minutes' price range with
              unusually high volume</b>, tells you to <b>BUY</b> (or <b>SELL short</b>) with a stop and a target, and everything is closed by <b>3:10 pm</b>.
            </p>
            <p class="small">
              The scanners watch <b>{formatNumberIN(scan.keys.length, 0)} stocks</b> (Nifty 50, 100, Midcap 100, Smallcap 100 and Nifty 500, each once). Turning it on downloads about 6 months of 5-minute prices for the {testKeys.length} stocks of {testLabel} and about 5 weeks for the rest (usually 10–20 minutes the first time, up to an hour), then{' '}
              <b>tests the rules on {testLabel}</b> before showing any signal.
            </p>
            <button class="btn primary" type="button" data-testid="day-turn-on" onClick={() => void callBackground('daytrade:enable', { enabled: true }).catch((err: unknown) => setMsg({ ok: false, text: errorMessage(err) }))}>
              Turn on day trading
            </button>
          </>
        ) : (
          <>
            <p class="small" data-testid="day-status">
              {status}
            </p>
            <ScanCoverage />
          </>
        )}
        {msg && <p class={`small ${msg.ok ? 'ok-text' : 'err-text'}`}>{msg.text}</p>}
        {!amount && on && (
          <div class="banner info small">
            Enter the amount you want to use in Settings first.{' '}
            <button class="btn small" type="button" onClick={() => go('settings')}>
              Open Settings
            </button>
          </div>
        )}
      </section>
      {on && amount ? (
        <>
          <DayPlan now={now} />
          <MoodLine />
          <BreadthCard />
          <SignalsCard amount={amount} slots={slots} />
          <FallingNowCard />
          <BreakoutCard />
          <RisingNowCard />
          <LearningCard go={go} />
          <DayTradesCard />
          <UpstoxSyncLine />
          <details class="card details-card" data-testid="day-details">
            <summary>
              <b>How well did these rules do in the past?</b> <span class="small muted">— the past test and how it works</span>
            </summary>
            <DayTestCard keys={testKeys} listLabel={testLabel} amount={amount} slots={slots} />
            <HowItWorks slots={slots} maxLosses={settings.dayTrade.maxLossesPerDay} />
          </details>
        </>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- signals

function SignalsCard({ amount, slots }: { amount: number; slots: number }) {
  const settings = useSettings();
  const stored = useSessionValue('daySignals');
  const test = useLocal('dayTest');
  const trades = useLocal('dayTrades') ?? [];
  const quotes = useQuotes();
  const now = useNow(5_000);
  const today = istDate(now);
  // signals of the current session (never an earlier day's)
  // newest first, each stock and direction once
  const signals = (stored && stored.date >= today ? stored.signals : [])
    .slice()
    .sort((a, b) => b.at - a.at)
    .filter((s, i, all) => all.findIndex((x) => x.key === s.key && x.side === s.side) === i);
  const passed = !!test?.report && test.report.rulesVersion === DAY_RULES_VERSION && test.report.passed;
  const lost = (practice: boolean) => trades.filter((t) => t.date === today && t.practice === practice && t.status === 'closed' && t.exitPrice !== undefined && dayTradePnl(t.side, t.qty, t.entry, t.exitPrice).pnl < 0).length;
  const maxLosses = settings?.dayTrade.maxLossesPerDay ?? 2;
  const stopped = Math.max(lost(true), lost(false)) >= maxLosses;
  const takenToday = (practice: boolean) => trades.filter((t) => t.date === today && t.practice === practice).length;

  return (
    <section class="card" data-testid="day-signals">
      <h2>Today's buy ideas</h2>
      {!passed && (
        <div class="banner warn small" data-testid="day-untested">
          <b>Practice only for now.</b> {test?.report ? 'These rules did not pass the past test (see below).' : 'The rules have not been tested on your data yet (see below).'} Use the{' '}
          <b>Practice</b> button — do not use real money on these signals.
        </div>
      )}
      {stopped && (
        <div class="banner err small" data-testid="day-stopped">
          <b>Stop for today.</b> {maxLosses} day trades have lost today. No more new trades today — this rule protects your money on bad days.
        </div>
      )}
      {signals.length === 0 ? (
        <p class="small muted">No signal yet today. That is normal: on some days no stock passes all the checks, and the best decision is not to trade.</p>
      ) : (
        signals.map((s) => (
          <SignalCard
            s={s}
            ltp={quotes[s.key]?.ltp ?? null}
            now={now}
            alloc={amount / slots}
            canTake={!stopped}
            limitReached={{ real: takenToday(false) >= slots, practice: takenToday(true) >= slots }}
            slots={slots}
            taken={trades.filter((t) => t.signalId === s.id)}
          />
        ))
      )}
      <p class="tiny muted">
        At most {slots} day trades a day, {formatINR(amount / slots, 0)} each (your own money, no borrowing). Signals older than 10 minutes, or where the price has already moved away, are marked
        "too late" — skip those.
      </p>
    </section>
  );
}

function SignalCard({ s, ltp, now, alloc, canTake, limitReached, slots, taken }: { s: DaySignal; ltp: number | null; now: number; alloc: number; canTake: boolean; limitReached: { real: boolean; practice: boolean }; slots: number; taken: DayTrade[] }) {
  const [form, setForm] = useState(false);
  const [steps, setSteps] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const state = signalState(s, ltp, now);
  const price = ltp ?? s.entry;
  const qty = Math.max(0, Math.floor(alloc / price));
  const long = s.side === 'long';
  const risk = Math.abs(s.entry - s.stop) * qty;
  const gain = s.target !== null ? Math.abs(s.target - s.entry) * qty : null;
  const tookReal = taken.some((t) => !t.practice);
  const tookPractice = taken.some((t) => t.practice);
  const take = async (practice: boolean, p?: number, q?: number) => {
    setMsg(null);
    try {
      const r = await callBackground('daytrade:take', { key: s.key, symbol: s.symbol, side: s.side, qty: q ?? qty, stop: s.stop, target: s.target, practice, ...(p ? { price: p } : {}), signalId: s.id });
      setForm(false);
      setMsg({
        ok: true,
        text: practice
          ? `Practice day trade started at ₹${formatNumberIN(r.entry)} (pretend money). It closes by itself at the stop, the target or 3:10 pm.`
          : `Saved. You get an alert at the stop (₹${formatNumberIN(s.stop)})${s.target !== null ? `, at the target (₹${formatNumberIN(s.target)})` : ''} and at 3:05 pm to close it.`,
      });
    } catch (err) {
      setMsg({ ok: false, text: errorMessage(err) });
    }
  };

  return (
    <div class={`suggestion day-signal ${state !== 'fresh' ? 'stale' : ''}`} data-symbol={s.symbol} data-side={s.side}>
      <div class="sig-head">
        <div class="sig-title">
          <span class={`chip day ${long ? 'buy' : 'sell'}`}>{long ? '▲ BUY' : '▼ SELL first'}</span>
          <h3>{s.symbol}</h3>
          <IndexTag index={s.index} k={s.key} />
          <span class="muted small">at {formatTimeIST(s.at).slice(0, 5)} · NSE</span>
          <AlsoIn k={s.key} here="buy" />
          {state === 'fresh' ? <span class="chip setup good">act now</span> : <span class="chip flag">{s.late ? 'happened earlier — skip' : state === 'moved' ? 'price moved — skip' : 'too late — skip'}</span>}
        </div>
        {s.chance !== undefined && <ChanceRing value={s.chance} />}
      </div>
      <div class="idea-grid sig-grid">
        <div>
          <span>{long ? 'Buy around' : 'Sell first at'}</span>
          <b>₹{formatNumberIN(price)}</b>
        </div>
        <div>
          <span>Take profit at</span>
          <b class="ok-text">{s.target !== null ? `₹${formatNumberIN(s.target)}` : '3:10 pm'}</b>
        </div>
        <div>
          <span>{long ? 'Sell if it falls to' : 'Buy back if it rises to'}</span>
          <b class="err-text">₹{formatNumberIN(s.stop)}</b>
        </div>
      </div>
      {s.buyers && (
        <div class="sig-flow small">
          <span class={`dot-meter ${meterTone(s.buyers)}`}>{s.buyers}</span>
          {s.pace ? <span class="muted"> · {formatNumberIN(s.pace, 1)}× the usual trading</span> : null}
          {s.newsMood && s.newsMood !== 'neutral' && <span class="muted"> · news {s.newsMood === 'good' ? '👍' : '👎'}</span>}
        </div>
      )}
      <details class="sig-more">
        <summary class="small">Details: how many shares, the amounts, why</summary>
      <dl class="kv simple-plan">
        <dt>{long ? 'Buy' : 'Sell first'}</dt>
        <dd>
          <b>{qty} shares</b> at about <b>₹{formatNumberIN(price)}</b> = {formatINR(qty * price, 0)} <span class="muted">(signal price ₹{formatNumberIN(s.entry)})</span>
        </dd>
        <dt>{long ? 'Sell if it falls to' : 'Buy back if it rises to'}</dt>
        <dd class="err-text">
          <b>₹{formatNumberIN(s.stop)}</b> — your safety net; you would lose about <b>{formatINR(risk, 0)}</b>
        </dd>
        <dt>Take profit at</dt>
        <dd class="ok-text">
          {s.target !== null ? (
            <>
              <b>₹{formatNumberIN(s.target)}</b> — you would make about <b>{formatINR(gain, 0)}</b>
            </>
          ) : (
            <>No fixed target: hold while it goes your way</>
          )}
        </dd>
        <dt>Close by</dt>
        <dd>
          Close it by <b>3:10 pm</b> whatever happens
        </dd>
        {(s.buyers || s.newsMood) && (
          <>
            <dt>Right now</dt>
            <dd class="small" data-testid="day-flow">
              {s.buyers && (
                <span class={`chip meter ${meterTone(s.buyers)}`}>{s.buyers}</span>
              )}{' '}
              {s.pace ? <>{formatNumberIN(s.pace, 1)}× the usual trading by this time · </> : null}
              {s.newsMood && <>news {s.newsMood === 'good' ? '👍 good' : s.newsMood === 'bad' ? '👎 bad' : 'neutral'}</>}
            </dd>
          </>
        )}
        {s.chance !== undefined && (
          <>
            <dt>Chance</dt>
            <dd data-testid="day-chance">
              <span class={`chance ${s.chance >= 0.55 ? 'hi' : s.chance >= 0.45 ? 'mid' : 'lo'}`}>{Math.round(s.chance * 100)}%</span>{' '}
              <span class="small muted">{s.ml ? 'learned from past signals — passed its check on unseen days' : 'learned, but not trusted yet (still the plain rules)'}</span>
            </dd>
          </>
        )}
        <dt>Why this idea</dt>
        <dd class="small">
          {long ? 'Broke above' : 'Broke below'} its first-15-minutes range (₹{formatNumberIN(s.orLow)} – ₹{formatNumberIN(s.orHigh)}) with {formatNumberIN(s.rvol, 1)}× its usual opening volume, and the
          market is moving the same way.
        </dd>
        {(s.inNews || s.caution) && (
          <>
            <dt>Be careful</dt>
            <dd class="small warn-text" data-testid="day-caution">
              {s.inNews && <>📰 This company is in the news today — its price can jump either way. </>}
              {s.caution}
            </dd>
          </>
        )}
      </dl>
      </details>
      {state === 'fresh' && canTake && !form && (
        <div class="row">
          {!tookPractice && !limitReached.practice && (
            <button
              class="btn small practice-btn"
              type="button"
              data-testid="day-practice"
              onClick={() =>
                long
                  ? openTrade({ key: s.key, symbol: s.symbol, side: 'buy', qty, stop: s.stop, target: s.target, sellByClose: true, source: 'Day trade signal' })
                  : void take(true)
              }
            >
              Practice (pretend money)
            </button>
          )}
          {!tookReal && !limitReached.real && (
            <button class="btn small primary" type="button" data-testid="day-took" onClick={() => setForm(true)}>
              I took this trade in Upstox
            </button>
          )}
          <button class="btn small" type="button" onClick={() => setSteps(!steps)}>
            {steps ? 'Hide' : 'How to place it in Upstox'}
          </button>
        </div>
      )}
      {state === 'fresh' && (limitReached.real || limitReached.practice) && !tookReal && !tookPractice && <p class="tiny muted">You already took {slots} day trades today — that is the limit for one day.</p>}
      {form && (
        <BoughtForm
          defaultPrice={Number(price.toFixed(2))}
          defaultQty={qty}
          priceLabel={long ? 'Price you bought at (per share)' : 'Price you sold at (per share)'}
          onCancel={() => setForm(false)}
          onSubmit={(p, q) => take(false, p, q)}
        />
      )}
      {msg && <p class={`small ${msg.ok ? 'ok-text' : 'err-text'}`}>{msg.text}</p>}
      {steps && (
        <ol class="small upstox-steps" data-testid="day-steps">
          <li>
            Upstox app → search <b>{s.symbol}</b> → <b>{long ? 'Buy' : 'Sell'}</b>.
          </li>
          <li>
            Choose <b>Intraday</b> (not Delivery) and <b>Limit</b>. Quantity <b>{qty}</b>, price <b>₹{formatNumberIN(price)}</b>. Keep the quantity as shown so you use only your own money.
          </li>
          <li>
            When it is executed, place the protecting order: <b>{long ? 'Sell' : 'Buy'}</b> → Intraday → <b>Stop-loss (SL)</b>, quantity <b>{qty}</b>, trigger price <b>₹{formatNumberIN(s.stop)}</b>.
          </li>
          <li>
            Come back and click <b>I took this trade in Upstox</b>. You get alerts at the stop, the target and at 3:05 pm.
          </li>
          {!long && (
            <li>
              <b>Short selling:</b> you sell shares you do not own and must buy them back the same day. If the price rises instead of falling you lose money — never leave a short trade without its
              stop-loss order.
            </li>
          )}
        </ol>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- open trades + results

function DayTradesCard() {
  const trades = useLocal('dayTrades') ?? [];
  const quotes = useQuotes();
  const now = useNow(5_000);
  const today = istDate(now);
  const [closing, setClosing] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  if (!trades.length) return null;
  const open = trades.filter((t) => t.status === 'open');
  const closed = trades.filter((t) => t.status === 'closed' && t.exitPrice !== undefined);
  const pnlOf = (t: DayTrade) => dayTradePnl(t.side, t.qty, t.entry, t.exitPrice!).pnl;
  const sum = (practice: boolean, date?: string) => closed.filter((t) => t.practice === practice && (!date || t.date === date)).reduce((a, t) => a + pnlOf(t), 0);
  const count = (practice: boolean) => closed.filter((t) => t.practice === practice).length;
  const days = [...new Set(closed.map((t) => t.date))].sort().reverse().slice(0, 30);

  const act = async (fn: () => Promise<string>) => {
    setMsg(null);
    try {
      setMsg({ ok: true, text: await fn() });
    } catch (err) {
      setMsg({ ok: false, text: errorMessage(err) });
    }
  };

  return (
    <section class="card" data-testid="day-trades">
      <h2>Your day trades</h2>
      {open.length > 0 && (
        <table class="simple" data-testid="day-open">
          <thead>
            <tr>
              <th>Stock</th>
              <th>Trade</th>
              <th>Now</th>
              <th>Result</th>
              <th>Exits</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {open.map((t) => {
              const ltp = quotes[t.key]?.ltp ?? null;
              const live = ltp !== null ? dayTradePnl(t.side, t.qty, t.entry, ltp).pnl : null;
              return (
                <tr data-symbol={t.symbol}>
                  <td>
                    <b>{t.symbol}</b>
                    {t.practice && <span class="chip flag"> practice</span>}
                    {t.auto && <span class="chip setup neutral" title="Found automatically in your Upstox account"> from Upstox</span>}
                    {t.date < today && <div class="tiny err-text">from {day(t.date)} — did you close it?</div>}
                  </td>
                  <td>
                    {t.side === 'long' ? 'Bought' : 'Sold short'} {t.qty} @ ₹{formatNumberIN(t.entry)}
                  </td>
                  <td>{ltp !== null ? `₹${formatNumberIN(ltp)}` : '—'}</td>
                  <td class={live === null ? '' : live >= 0 ? 'ok-text' : 'err-text'}>{live === null ? '—' : signed(live)}</td>
                  <td class="tiny">
                    stop ₹{formatNumberIN(t.stop)}
                    {t.target !== null ? ` · target ₹${formatNumberIN(t.target)}` : ''} · 3:10 pm
                  </td>
                  <td>
                    {t.practice ? (
                      <button class="btn small" type="button" data-testid="day-close" onClick={() => void act(async () => `${t.symbol} closed at ₹${formatNumberIN((await callBackground('daytrade:close', { id: t.id })).price)} (pretend money).`)}>
                        Close now
                      </button>
                    ) : (
                      <button class="btn small primary" type="button" data-testid="day-closed-it" onClick={() => setClosing(closing === t.id ? null : t.id)}>
                        I closed it
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {closing &&
        (() => {
          const t = open.find((x) => x.id === closing);
          if (!t) return null;
          return (
            <BoughtForm
              defaultPrice={Number((quotes[t.key]?.ltp ?? t.entry).toFixed(2))}
              defaultQty={t.qty}
              priceLabel={t.side === 'long' ? `Price you sold ${t.symbol} at` : `Price you bought ${t.symbol} back at`}
              fixedQty
              submitLabel="Save"
              onCancel={() => setClosing(null)}
              onSubmit={async (price) => {
                const r = await callBackground('daytrade:close', { id: t.id, price });
                setClosing(null);
                setMsg({ ok: true, text: `${t.symbol} closed: ${signed(r.pnl)} after charges.` });
              }}
            />
          );
        })()}
      {msg && <p class={`small ${msg.ok ? 'ok-text' : 'err-text'}`}>{msg.text}</p>}
      <p class="small" data-testid="day-results">
        {count(false) > 0 && (
          <>
            <b>Real:</b> today <b class={sum(false, today) >= 0 ? 'ok-text' : 'err-text'}>{signed(sum(false, today))}</b> · all {count(false)} trades{' '}
            <b class={sum(false) >= 0 ? 'ok-text' : 'err-text'}>{signed(sum(false))}</b>
            {count(true) > 0 ? ' · ' : ''}
          </>
        )}
        {count(true) > 0 && (
          <>
            <b>Practice:</b> today <b class={sum(true, today) >= 0 ? 'ok-text' : 'err-text'}>{signed(sum(true, today))}</b> · all {count(true)} trades{' '}
            <b class={sum(true) >= 0 ? 'ok-text' : 'err-text'}>{signed(sum(true))}</b>
          </>
        )}
        {closed.length > 0 && <span class="muted"> (after Upstox intraday charges)</span>}
      </p>
      {days.length > 0 && (
        <details class="small">
          <summary>Finished day trades ({closed.length})</summary>
          <table class="simple" data-testid="day-closed">
            <thead>
              <tr>
                <th>Day</th>
                <th>Stock</th>
                <th>Trade</th>
                <th>Result</th>
                <th>Closed at</th>
              </tr>
            </thead>
            <tbody>
              {closed
                .slice()
                .sort((a, b) => (b.exitAt ?? 0) - (a.exitAt ?? 0))
                .slice(0, 100)
                .map((t) => (
                  <tr>
                    <td>{day(t.date)}</td>
                    <td>
                      {t.symbol}
                      {t.practice ? ' (practice)' : ''}
                    </td>
                    <td>
                      {t.side === 'long' ? 'Buy' : 'Short'} ₹{formatNumberIN(t.entry)} → ₹{formatNumberIN(t.exitPrice)}
                    </td>
                    <td class={pnlOf(t) >= 0 ? 'ok-text' : 'err-text'}>{signed(pnlOf(t))}</td>
                    <td>{t.exitReason === 'stop' ? 'stop' : t.exitReason === 'target' ? 'target' : t.exitReason === 'time' ? '3:10 pm' : 'by you'}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </details>
      )}
      {trades.some((t) => t.practice) && (
        <div class="row" style={{ marginTop: '6px' }}>
          {!confirmReset ? (
            <button class="link-btn" type="button" onClick={() => setConfirmReset(true)}>
              Clear practice day trades
            </button>
          ) : (
            <>
              <span class="small">Clear all practice day trades?</span>
              <button class="btn small" type="button" onClick={() => void act(async () => (setConfirmReset(false), `Cleared ${(await callBackground('daytrade:reset')).removed} practice day trade(s).`))}>
                Yes, clear
              </button>
              <button class="btn small" type="button" onClick={() => setConfirmReset(false)}>
                No
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- past test

function DayTestCard({ keys, listLabel, amount, slots }: { keys: string[]; listLabel: string; amount: number; slots: number }) {
  const settings = useSettings();
  const progress = useSessionValue('intradayProgress');
  const saved = useLocal('dayTest');
  const byKey = useInstrumentMap();
  const [coverage, setCoverage] = useState<{ ready: number; total: number } | null>(null);
  const [running, setRunning] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runId = useRef(0);
  const downloading = !!progress?.running;

  // how many stocks have enough 5-minute history
  useEffect(() => {
    if (downloading) return;
    let alive = true;
    void (async () => {
      let ready = 0;
      for (const k of keys) if ((await countIntradayDays(k)) >= MIN_SESSIONS) ready++;
      if (alive) setCoverage({ ready, total: keys.length });
    })();
    return () => {
      alive = false;
    };
  }, [keys.join(','), downloading, progress?.at]);

  const testKey = useMemo(() => {
    if (!settings || !coverage) return null;
    const d = settings.dayTrade;
    return [DAY_RULES_VERSION, settings.scanner.universe, coverage.ready, progress?.at ? istDate(progress.at) : '', amount, slots, d.maxLossesPerDay, d.slippagePct, settings.ui.priceMin, settings.ui.priceMax].join('|');
  }, [settings, coverage, progress?.at, amount, slots]);

  const enough = !!coverage && coverage.ready >= Math.max(3, Math.ceil(coverage.total * 0.5));
  const run = () => {
    if (!settings || !testKey) return;
    const id = ++runId.current;
    setRunning(0);
    setError(null);
    const refs = keys.map((k) => ({ key: k, symbol: byKey.get(k)?.trading_symbol ?? k, shortAllowed: NIFTY100_KEYS.has(k), tick: byKey.get(k)?.tick ?? 0.05 }));
    void runDayTest(refs, getIntradayDays, {
      amount,
      slots,
      maxLosses: settings.dayTrade.maxLossesPerDay,
      slippagePct: settings.dayTrade.slippagePct,
      priceMin: settings.ui.priceMin,
      priceMax: settings.ui.priceMax,
      onProgress: (done, total) => id === runId.current && setRunning(Math.round((done / total) * 100)),
    })
      .then(async (report) => {
        if (id !== runId.current) return;
        if (report) {
          await setLocal('dayTest', { key: testKey, report });
          // the self-learning uses the same history: learn again right after the test
          void callBackground('ml:learn').catch(() => undefined);
        }
        else setError(`Not enough 5-minute history yet (at least ${MIN_SESSIONS} trading days are needed).`);
      })
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => id === runId.current && setRunning(null));
  };
  // runs by itself once the history is there, and again when the inputs change
  useEffect(() => {
    if (!enough || downloading || running !== null || !testKey || saved?.key === testKey || !byKey.size) return;
    run();
  }, [enough, downloading, testKey, saved?.key, byKey.size]);

  const report = saved?.report && saved.report.rulesVersion === DAY_RULES_VERSION ? saved.report : null;
  return (
    <section class="card" data-testid="day-test">
      <h2>Do these day-trade rules work? — the past test</h2>
      {downloading && (
        <p class="small" data-testid="day-downloading">
          Downloading 5-minute prices: {progress!.done} of {progress!.total} stocks…
        </p>
      )}
      {progress?.error && !downloading && <p class="small err-text">Download stopped: {progress.error}</p>}
      {coverage && !downloading && (
        <p class="small muted" data-testid="day-coverage">
          5-minute history ready for {coverage.ready} of {coverage.total} stocks.{' '}
          <button class="link-btn" type="button" data-testid="day-download" onClick={() => void callBackground('daytrade:sync').catch((err: unknown) => setError(errorMessage(err)))}>
            {coverage.ready < coverage.total ? 'Download now' : 'Check for new days'}
          </button>
          {enough && running === null && (
            <>
              {' · '}
              <button class="link-btn" type="button" onClick={run}>
                Run the test again
              </button>
            </>
          )}
        </p>
      )}
      {running !== null && (
        <p class="small muted" data-testid="day-test-running">
          Testing the rules on {listLabel}… {running}%
        </p>
      )}
      {error && <p class="small err-text">{error}</p>}
      {!report && running === null && !downloading && !error && <p class="small muted">The test runs by itself once the 5-minute history has downloaded (you must be logged in to Upstox, or have the Analytics Token).</p>}
      {report && <TestReport r={report} />}
    </section>
  );
}

function TestReport({ r }: { r: DayTestReport }) {
  const rate = (x: DayTestResult) => (x.trades ? Math.round((x.wins / x.trades) * 100) : 0);
  const cols: Array<[string, DayTestResult]> = [
    ['Older days (settings chosen here)', r.train],
    ['Newest days (never seen — the real check)', r.check],
  ];
  const row = (label: string, f: (x: DayTestResult) => preact.ComponentChildren) => (
    <tr>
      <td>{label}</td>
      {cols.map(([, x]) => (
        <td>{f(x)}</td>
      ))}
    </tr>
  );
  const money = (v: number) => <span class={v >= 0 ? 'ok-text' : 'err-text'}>{signed(v)}</span>;
  return (
    <>
      <div class={`banner ${r.passed ? 'ok' : 'err'} small`} data-testid="day-verdict">
        <b>{r.passed ? 'PASSED.' : 'NOT PASSED.'}</b> {r.reason}{' '}
        {r.passed ? 'Signals are switched on — still start with Practice, and with small amounts.' : 'Signals are shown for practice only. Do not use real money on them.'}
      </div>
      <p class="small">
        Tested on <b>{r.stocks}</b> stocks, <b>{r.sessions}</b> trading days ({day(r.from)} – {day(r.to)}), {formatINR(r.amount, 0)} split into {r.slots} trades a day, stop after {r.maxLosses} losing
        trades. Each trade was entered one 5-minute bar after the signal, with {r.slippagePct}% slippage each way and Upstox's intraday charges.
      </p>
      <p class="small">
        <b>Setting that did best on the older days:</b> {variantWords(r.chosen)}.
      </p>
      <table class="simple past-record" data-testid="day-test-table">
        <thead>
          <tr>
            <th />
            {cols.map(([label]) => (
              <th>{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {row('Period', (x) => (x === r.train ? `${day(r.trainFrom)} – ${day(r.trainTo)}` : `${day(r.checkFrom)} – ${day(r.checkTo)}`))}
          {row('Trading days', (x) => x.days)}
          {row('Trades', (x) => x.trades)}
          {row('Made money', (x) => `${x.wins} (${rate(x)}%)`)}
          {row('Result (after charges)', (x) => (
            <b>
              {money(x.pnl)} ({formatPct(x.pnlPct, 1)})
            </b>
          ))}
          {row('Average per trading day', (x) => money(x.avgPerDay))}
          {row('Days with profit / loss', (x) => `${x.greenDays} / ${x.redDays}`)}
          {row('Best day / worst day', (x) => (
            <>
              {money(x.bestDay)} / {money(x.worstDay)}
            </>
          ))}
          {row('Deepest fall on the way', (x) => money(x.maxDrawdown))}
          {row('BUY trades', (x) => (
            <>
              {x.long.trades}: {money(x.long.pnl)}
            </>
          ))}
          {row('SELL (short) trades', (x) => (
            <>
              {x.short.trades}: {money(x.short.pnl)}
            </>
          ))}
        </tbody>
      </table>
      <details class="small" style={{ marginTop: '6px' }}>
        <summary>Month by month</summary>
        <table class="simple" data-testid="day-months">
          <tbody>
            {r.months.map((m) => (
              <tr>
                <td>
                  {m.month}
                  {m.unseen ? ' (newest days)' : ''}
                </td>
                <td>{m.trades} trades</td>
                <td>{money(m.pnl)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
      <details class="small">
        <summary>All {r.variants.length} settings that were tried</summary>
        <table class="simple" data-testid="day-variants">
          <thead>
            <tr>
              <th>Signals</th>
              <th>Target</th>
              <th>Volume</th>
              <th>Older days</th>
              <th>Newest days</th>
            </tr>
          </thead>
          <tbody>
            {r.variants.map((x) => (
              <tr>
                <td>{x.v.sides}</td>
                <td>{x.v.target === 'eod' ? '3:10 pm' : `${x.v.target}×`}</td>
                <td>≥{x.v.minRvol}×</td>
                <td>
                  {money(x.trainPnl)} ({x.trainTrades})
                </td>
                <td>
                  {money(x.checkPnl)} ({x.checkTrades})
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
      <details class="small">
        <summary>Trades in the newest days ({r.checkTrades.length})</summary>
        <table class="simple" data-testid="day-check-trades">
          <tbody>
            {r.checkTrades
              .slice()
              .reverse()
              .map((t) => (
                <tr>
                  <td>{day(t.date)}</td>
                  <td>
                    {t.side === 'long' ? 'BUY' : 'SHORT'} {t.symbol}
                  </td>
                  <td>
                    {hhmm(t.entryT)} ₹{formatNumberIN(t.entry)} → {hhmm(t.exitT)} ₹{formatNumberIN(t.exit)}
                  </td>
                  <td>{money(t.pnl)}</td>
                  <td>{t.reason === 'time' ? '3:10 pm' : t.reason}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </details>
      <p class="tiny muted">
        What this test cannot tell you: the past does not promise the future, and a few months is a short time. It uses today's list of companies. Real orders can fill at worse prices than assumed,
        especially in fast moves. Most people who day-trade lose money over a year (SEBI study, 2024) — practise first. Took {(r.computedMs / 1000).toFixed(1)} s; {r.candidates} breakouts found.
      </p>
    </>
  );
}

function HowItWorks({ slots, maxLosses }: { slots: number; maxLosses: number }) {
  return (
    <section class="card" data-testid="day-how">
      <details class="small">
        <summary>
          <b>How the day-trade signals work (in plain words)</b>
        </summary>
        <ol>
          <li>
            <b>9:15–9:30:</b> for every stock the extension notes the highest and lowest price of the first 15 minutes, and how much was traded compared with that stock's usual first 15 minutes.
          </li>
          <li>
            <b>9:35–11:30:</b> at every 5-minute mark it checks: has a busy stock closed <b>above</b> that range while the market is up? → <b>BUY</b>. Closed <b>below</b> it while the market is down? →{' '}
            <b>SELL (short)</b> — only for the big Nifty 100 companies. Only a stock's first breakout of the day counts.
          </li>
          <li>
            <b>Stop:</b> the other side of the first-15-minutes range, at most 1% away. <b>Target:</b> as chosen by the past test.
          </li>
          <li>
            <b>3:10 pm:</b> every day trade is closed, win or lose. Nothing is held overnight.
          </li>
          <li>
            <b>Limits:</b> at most {slots} day trades a day with your own money, and no new trade after {maxLosses} losing trades in a day.
          </li>
        </ol>
        <p>
          No rule wins every day. The aim is that the winning days add up to more than the losing days after charges — the past test above shows whether that was true for these rules on your stocks.
        </p>
      </details>
    </section>
  );
}

/** Turn the mode on from other screens. */
export async function enableDayTrading(): Promise<void> {
  await updateSettings({ dayTrade: { enabled: true } });
  await callBackground('daytrade:enable', { enabled: true });
}
