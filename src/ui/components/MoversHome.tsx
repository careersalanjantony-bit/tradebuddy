import { useState } from 'preact/hooks';
import type { DriveRow, EarlyRow } from '../../background/risingJobs';
import type { PreRow } from '../../background/preopenJobs';
import { prePhase, type PrePhase } from '../../early/preopen';
import { minutesIST } from '../../daytrade/live';
import { formatINR, formatPct, formatTimeIST } from '../../lib/format';
import { errorMessage } from '../../lib/serialize';
import { istDate } from '../../lib/time';
import { callBackground } from '../../shared/messages';
import type { Go } from '../App';
import type { SessionStore } from '../../storage/session';
import { useQuotes } from '../data';
import { useLocal, useMarketState, useNow, useSessionValue, useSettings } from '../hooks';
import { DataLimits, DriveDetail, EarlyDetail, EarlyTestLine, MoneyLine, PreDetail, rs, STAGE } from './EarlyMovers';
import { Sparkline, toast, useFlash } from './Motion';
import { MarketGateBanner, SuggestionRecordLine } from './RisingNow';
import { IntradayList, IntradayTestLine } from './IntradayScanner';

/**
 * App v1.16 — the main tool, on Home: "🌱 Early Movers". One list that follows the clock:
 *   before 9:00   good news since yesterday's close (the pre-open starts at 9:00);
 *   9:00–9:15     the pre-open rising candidates — ranked from 9:05, final top 10 at 9:13;
 *   from 9:15     "Intraday" (app v1.19; was "Live now"): the Intraday scanner — momentum during the
 *                 session among every NSE EQ stock, every 15 s — and below it, as before, the final
 *                 picks that hold their opening gap, setups, live breakouts and confirmed breakouts.
 * Each row is one line; tap it for the numbers, the plan sized for your capital and risk, and how to
 * place it yourself in Upstox. Past test, record and data limits sit behind one "More" at the bottom.
 */

type Tab = 'pre' | 'live';

export function MoversCard({ go }: { go: Go }) {
  const now = useNow(2_000);
  const market = useMarketState();
  const settings = useSettings();
  const pre = useSessionValue('preopen');
  const early = useSessionValue('early');
  const today = istDate(now);
  const t = minutesIST(now);
  const phase: PrePhase = market.phase === 'open' ? 'open' : market.phase === 'pre_open' ? prePhase(t) : 'before';
  const [tab, setTab] = useState<Tab | null>(null);
  const [money, setMoney] = useState(false);
  const shown: Tab = tab ?? (market.phase === 'open' ? 'live' : 'pre');
  const preToday = pre && pre.date === today ? pre : null;
  const earlyToday = early && early.date === today ? early : null;
  const preRows = preToday ? (preToday.final?.rows ?? preToday.rows) : [];
  const intraday = useSessionValue('intraday');
  const intraToday = intraday && intraday.date === today ? intraday : null;
  const liveCount = (intraToday ? intraToday.counts.buy + (intraToday.counts.sell ?? 0) + intraToday.counts.wait : 0) + (earlyToday?.drive?.length ?? 0) + (earlyToday?.rows.length ?? 0);
  const capital = settings?.dayTrade.earlyCapitalInr ?? 10_000;
  const maxRisk = settings?.dayTrade.earlyRiskInr ?? 50;
  const isLive =
    (market.phase === 'open' && ((!!early && now - early.at < 15_000) || (!!intraToday && now - intraToday.at < 30_000))) || (market.phase === 'pre_open' && !!pre && now - pre.at < 30_000);
  const pill = market.phase === 'pre_open' ? (isLive ? 'PRE-OPEN' : 'WAITING') : market.phase === 'open' ? (isLive ? 'LIVE' : 'WAITING') : 'CLOSED';
  return (
    <section class="card movers-card" data-testid="early-movers">
      <div class="row">
        <h2 style={{ margin: 0 }}>🌱 Early Movers</h2>
        <span class="spacer" />
        <span class={`live-pill ${isLive ? 'on' : ''}`} data-testid="movers-pill">
          <i aria-hidden="true" />
          {pill}
        </span>
      </div>
      {/* app v1.20.1: the 9:00 → 9:20 timeline and its status line are gone (owner: the earlier, simpler look) */}
      <button type="button" class="mv-money" data-testid="movers-money" onClick={() => setMoney(!money)}>
        {formatINR(capital, 0)} capital · ₹{maxRisk} risk per trade incl. charges <span class="muted">· change</span>
      </button>
      {money && <MoneyLine capital={capital} maxRisk={maxRisk} />}
      <MarketGateBanner />
      <div class="mv-tabs" role="tablist">
        <button type="button" role="tab" class={shown === 'pre' ? 'on' : ''} data-movers-tab="pre" onClick={() => setTab('pre')}>
          Pre-open {preRows.length ? `(${preRows.length})` : ''}
        </button>
        <button type="button" role="tab" class={shown === 'live' ? 'on' : ''} data-movers-tab="live" onClick={() => setTab('live')}>
          Intraday {liveCount ? `(${liveCount})` : ''}
        </button>
      </div>
      {shown === 'pre' ? (
        <PreList pre={preToday} phase={phase} marketPhase={market.phase} now={now} />
      ) : (
        <>
          <IntradayList open={market.phase === 'open'} now={now} go={go} />
          <h3 class="mv-sub">Opening picks &amp; setups</h3>
          <LiveList early={earlyToday} open={market.phase === 'open'} now={now} />
        </>
      )}
      <details class="mv-more" data-testid="movers-more">
        <summary class="small">More: past test, record and data limits</summary>
        <SuggestionRecordLine />
        <Removed early={earlyToday} pre={preToday} />
        <EarlyTestLine />
        <IntradayTestLine />
        <DataLimits />
        <button class="link-btn small" type="button" onClick={() => go('daytrade')}>
          Rising now, buy ideas and day trades → Day trade
        </button>
      </details>
      <p class="tiny muted" style={{ margin: '8px 0 0' }}>
        Points, not a chance of rising. Never a guarantee — the app does not place orders; you do, in Upstox.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------- pre-open

function PreList({ pre, phase, marketPhase, now }: { pre: import('../../background/preopenJobs').PreopenState | null; phase: PrePhase; marketPhase: string; now: number }) {
  const premarket = useSessionValue('premarket');
  const auth = useLocal('auth');
  const secrets = useLocal('secrets');
  const quotes = useQuotes();
  const [busy, setBusy] = useState(false);
  const refresh = () => {
    setBusy(true);
    void callBackground('preopen:refresh')
      .then((r) => toast(`${r.listed} stocks 1%+ above yesterday in the pre-open`))
      .catch((e: unknown) => toast(errorMessage(e), 'err'))
      .finally(() => setBusy(false));
  };
  const rows = pre ? (pre.final?.rows ?? pre.rows) : [];
  if (!rows.length) {
    const noLogin = auth?.status !== 'logged_in' && !secrets?.upstoxAnalyticsToken;
    const goodNews = (premarket && istDate(premarket.at) === istDate(now) ? premarket.rows : []).filter((r) => r.catalyst?.tone === 'good').slice(0, 5);
    return (
      <div data-testid="pre-empty">
        <p class="small muted">
          {noLogin
            ? 'Connect Upstox (Settings) — the pre-open prices come from your Upstox login.'
            : marketPhase === 'pre_open'
              ? pre?.quoteError
                ? `Upstox did not give pre-open prices yet (${pre.quoteError}). Trying again every 15 seconds.`
                : pre
                  ? `No stock is 1%+ above yesterday in the pre-open right now (${pre.counts.withIep} of ${pre.counts.scanned} have a pre-open price).`
                  : 'Reading the pre-open… the first prices come within 15 seconds.'
              : marketPhase === 'open'
                ? 'No pre-open list today — the app was not running between 9:00 and 9:13. The Live now list works all day.'
                : 'From 9:00 the stocks of the five indices are read every few seconds and ranked: the final top 10 is ready at 9:13, two minutes before the open.'}
        </p>
        {marketPhase === 'pre_open' && !noLogin && (
          <button class="btn small" type="button" disabled={busy} data-testid="pre-refresh" onClick={refresh}>
            {busy ? 'Reading…' : 'Read the pre-open now'}
          </button>
        )}
        {goodNews.length > 0 && (
          <div class="mv-news">
            <div class="tiny muted">Good news since yesterday's close:</div>
            {goodNews.map((r) => (
              <div class="tiny" data-symbol={r.symbol}>
                📰 <b>{r.symbol}</b> — <span class="ok-text">{r.catalyst!.kind}</span>: {r.catalyst!.heading}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }
  const opened = phase === 'open';
  return (
    <div>
      <p class="small mv-watch" data-testid="pre-watch">
        👀 <b>A watch list, not buy signals.</b> Pre-open prices are only orders — they can be cancelled until 9:08, and many gap-ups fall back in the first minutes.{' '}
        <b>Do not buy at 9:15.</b> Buy only a stock that turns <b>⚡ Holding gap</b> in "Live now" (above its opening price with heavy buying), with its stop-loss.
      </p>
      {pre!.marketGap !== null && pre!.marketGap < -0.2 && (
        <p class="small err-text" style={{ margin: '0 0 6px' }} data-testid="pre-weak">
          ⚠ The market is opening weak (the whole list {formatPct(pre!.marketGap, 2)} on average) — gap-ups fade more often on days like this.
        </p>
      )}
      <p class="tiny muted" style={{ margin: '0 0 6px' }} data-testid="pre-status">
        {pre!.final ? `Final list, fixed at ${formatTimeIST(pre!.final.at).slice(0, 5)}.` : `Updated ${formatTimeIST(pre!.at)} — ${phase === 'collecting' ? 'early read, the ranking starts at 9:05' : 'changes until 9:13'}.`} {pre!.counts.listed} of{' '}
        {pre!.counts.withIep} stocks are 1%+ above yesterday with buyers clearly ahead
        {pre!.marketGap !== null ? `; the whole list ${pre!.marketGap >= 0 ? '+' : '−'}${Math.abs(pre!.marketGap).toFixed(2)}% on average` : ''}. Left out:{' '}
        {pre!.counts.sellers ?? 0} with more sellers than buyers waiting, {pre!.counts.falling ?? 0} whose pre-open price was falling, {pre!.counts.badNews} with bad news.
      </p>
      <div class="mv-list" data-testid="pre-list">
        {rows.map((r) => (
          <PreItem r={r} key={r.key} live={opened ? quotes[r.key] : undefined} />
        ))}
      </div>
    </div>
  );
}

function PreItem({ r, live }: { r: PreRow; live: import('../../data/quotesParse').Quote | undefined }) {
  const [open, setOpen] = useState(false);
  const after = live && live.open && live.open > 0 ? live : null;
  const status = after ? (after.ltp >= after.open! ? { t: 'holding above its open', c: 'ok-text' } : { t: 'below its open', c: 'err-text' }) : null;
  return (
    <div class={`mv-item ${open ? 'open' : ''}`} data-symbol={r.symbol} data-testid="pre-item">
      <button type="button" class="mv-row" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span class="mv-rank">{r.rank}</span>
        <span class="mv-main">
          <b>{r.symbol}</b>
          <small class="muted">
            {after ? (
              <>
                opened {formatPct((after.open! / r.prevClose - 1) * 100, 1)} · <span class={status!.c}>{status!.t}</span>
              </>
            ) : (
              <>
                pre-open {rs(r.iep)}
                {r.buyShare !== null ? ` · buyers ${Math.round(r.buyShare * 100)}%` : ''}
                {r.catalyst?.tone === 'good' ? ` · 📰 ${r.catalyst.kind}` : ''}
              </>
            )}
          </small>
        </span>
        {r.path.length > 2 && <Sparkline values={r.path} width={44} height={20} class="mv-spark" />}
        <span class="mv-right">
          <span class={`ch-pill ${r.gapPct >= 0 ? 'up' : 'down'}`}>{formatPct(after ? (after.ltp / r.prevClose - 1) * 100 : r.gapPct, 1)}</span>
        </span>
        <span class="mv-score" title="Points out of 100 (not a chance)">
          {r.score}
        </span>
      </button>
      {open && <PreDetail r={r} />}
    </div>
  );
}

// ---------------------------------------------------------------- live (from 9:15)

type LiveRow = { kind: 'drive'; r: DriveRow } | { kind: 'early'; r: EarlyRow };

function LiveList({ early, open, now }: { early: SessionStore['early'] | null; open: boolean; now: number }) {
  const rank = (x: LiveRow) => (x.kind === 'early' ? { confirmed: 5, breakout: 4, setup: 2 }[x.r.stage] : x.r.state === 'holding' ? 3 : 1);
  const rows: LiveRow[] = [...(early?.drive ?? []).map((r) => ({ kind: 'drive' as const, r })), ...(early?.rows ?? []).map((r) => ({ kind: 'early' as const, r }))];
  // one row per stock: its most advanced stage
  const best = new Map<string, LiveRow>();
  for (const x of rows) {
    const cur = best.get(x.r.key);
    if (!cur || rank(x) > rank(cur) || (rank(x) === rank(cur) && x.r.score > cur.r.score)) best.set(x.r.key, x);
  }
  const list = [...best.values()].sort((a, b) => rank(b) - rank(a) || b.r.score - a.r.score);
  if (!list.length)
    return (
      <p class="small muted" data-testid="early-empty">
        {open
          ? 'No stock meets all the conditions right now — that is normal; most minutes have none. You get an alert the moment one does.'
          : 'Live from 9:15: first the pre-open picks that hold their opening gap, then setups and breakouts until 2:30.'}
      </p>
    );
  return (
    <div class="mv-list" data-testid="live-list">
      {list.map((x) => (x.kind === 'drive' ? <DriveItem r={x.r} now={now} key={x.r.key} /> : <EarlyItem r={x.r} now={now} key={x.r.key} />))}
    </div>
  );
}

function LiveRowHead({ symbol, stage, price, changePct, score, line, open, onToggle }: { symbol: string; stage: keyof typeof STAGE; price: number; changePct: number; score: number; line: string; open: boolean; onToggle: () => void }) {
  const flash = useFlash(price);
  const st = STAGE[stage];
  return (
    <button type="button" class="mv-row" onClick={onToggle} aria-expanded={open}>
      <span class="mv-main">
        <span class="row" style={{ gap: '6px' }}>
          <b>{symbol}</b>
          <span class={`chip early-stage ${st.cls}`}>{st.short}</span>
        </span>
        <small class="muted">{line}</small>
      </span>
      <span class="mv-right">
        <b class={`price ${flash}`}>{rs(price)}</b>
        <span class={`ch-pill ${changePct >= 0 ? 'up' : 'down'}`}>{formatPct(changePct, 1)}</span>
      </span>
      <span class="mv-score" title="Points out of 100 (not a chance)">
        {score}
      </span>
    </button>
  );
}

function DriveItem({ r, now }: { r: DriveRow; now: number }) {
  const [open, setOpen] = useState(false);
  const line = r.state === 'holding' ? `buy above ${rs(r.plan.breakout)} · stop ${rs(r.plan.stop)} · ${r.size.qty} sh, risk ₹${Math.round(r.size.risk)}` : `#${r.preRank} pre-open pick · ${r.missing[0] ?? 'waiting'}`;
  return (
    <div class={`mv-item early-item ${r.state === 'holding' ? 'drive' : 'waiting'} ${open ? 'open' : ''}`} data-symbol={r.symbol} data-stage={r.state === 'holding' ? 'drive' : 'waiting'} data-testid="early-item">
      <LiveRowHead symbol={r.symbol} stage={r.state === 'holding' ? 'drive' : 'waiting'} price={r.price} changePct={r.changePct} score={r.score} line={line} open={open} onToggle={() => setOpen(!open)} />
      {open && <DriveDetail r={r} now={now} />}
    </div>
  );
}

function EarlyItem({ r, now }: { r: EarlyRow; now: number }) {
  const [open, setOpen] = useState(false);
  const line = r.stage === 'setup' ? `buy only above ${rs(r.plan.breakout)} · ${r.size.qty} sh, risk ₹${Math.round(r.size.risk)}` : `entry ${rs(r.plan.entry)} · stop ${rs(r.plan.stop)} · ${r.size.qty} sh, risk ₹${Math.round(r.size.risk)}`;
  return (
    <div class={`mv-item early-item ${r.stage} ${open ? 'open' : ''}`} data-symbol={r.symbol} data-stage={r.stage} data-testid="early-item">
      <LiveRowHead symbol={r.symbol} stage={r.stage} price={r.price} changePct={r.changePct} score={r.score} line={line} open={open} onToggle={() => setOpen(!open)} />
      {open && <EarlyDetail r={r} now={now} />}
    </div>
  );
}

function Removed({ early, pre }: { early: { expired: number; tooRisky: number; badNews: number; driveOut?: number; maxRisk: number; at: number } | null; pre: { counts: { badNews: number } } | null }) {
  if (!early && !pre) return null;
  return (
    <p class="tiny muted" style={{ margin: '6px 0 0' }} data-testid="early-removed">
      {early ? `Updated ${formatTimeIST(early.at)}. ` : ''}Not shown today: {early?.driveOut ?? 0} that lost their opening gap or ran too far, {early?.expired ?? 0} setups that expired (no breakout in time, false
      breakout, ran too far), {early?.tooRisky ?? 0} where ₹{early?.maxRisk ?? 50} risk with charges was not enough, {(early?.badNews ?? 0) + (pre?.counts.badNews ?? 0)} with bad news.
    </p>
  );
}
