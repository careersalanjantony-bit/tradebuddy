import { useEffect, useMemo, useState } from 'preact/hooks';
import { stockChance } from '../../advisor/shortModel';
import { dailyShortPlan } from '../../advisor/shortPlan';
import { indicatorsOf, shortSetupAt } from '../../advisor/shortSell';
import type { LiveShortAnalysis } from '../../background/shortJobs';
import type { StockData } from '../../data/stockData';
import { formatINR, formatNumberIN, formatPct, formatTimeIST } from '../../lib/format';
import { errorMessage } from '../../lib/serialize';
import { callBackground } from '../../shared/messages';
import type { ChartLine } from './PriceChart';
import { useLocal, useMarketState, useSessionValue, useSettings } from '../hooks';
import { buzz, toast } from './Motion';
import { StockNews } from './StockNews';

/**
 * App v1.7 — the full sell-first analysis of one stock (owner: "clicking a short-selling stock opens
 * its complete detailed analysis: entry, stop-loss, targets, RSI, VWAP, volume, trend analysis and
 * risk-reward"). During market hours the plan comes from today's 5-minute candles (the "Falling now"
 * study); otherwise from daily data, for the next session.
 */

const signed = (x: number) => `${x >= 0 ? '+' : '−'}${formatINR(Math.abs(x), 0)}`;
const rs = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : `₹${formatNumberIN(x)}`);

export function ShortAnalysis({ stockKey, sym, data, onLines }: { stockKey: string; sym: string; data: StockData | undefined; onLines: (l: ChartLine[]) => void }) {
  const market = useMarketState();
  const settings = useSettings();
  const model = useLocal('shortModel');
  const flow = useSessionValue('flow');
  const [live, setLive] = useState<LiveShortAnalysis | null>(null);
  const [liveErr, setLiveErr] = useState<string | null>(null);
  const open = market.phase === 'open';

  useEffect(() => {
    if (!open) {
      setLive(null);
      return;
    }
    let alive = true;
    const load = () =>
      void callBackground('shorts:analyze', { key: stockKey })
        .then((r) => alive && (setLive(r), setLiveErr(null)))
        .catch((e: unknown) => alive && setLiveErr(errorMessage(e)));
    load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [stockKey, open]);

  const candles = data?.candles ?? [];
  const s = data?.snapshot ?? null;
  const ltp = data?.quote?.ltp ?? s?.price ?? null;
  const risk = settings?.dayTrade.shortRiskInr ?? 50;
  const setup = useMemo(() => {
    if (candles.length < 60) return null;
    const ind = indicatorsOf(candles);
    return candles[candles.length - 1]!.partial ? shortSetupAt(candles, candles.length - 1, ind, true) : shortSetupAt(candles, candles.length, ind, false);
  }, [candles]);
  const chance = useMemo(() => (model ? stockChance(model, stockKey, candles) : null), [model, stockKey, candles]);
  const daily = useMemo(() => (ltp ? dailyShortPlan(candles, ltp, risk, data?.instrument?.tick ?? 0.05) : null), [candles, ltp, risk]);
  const intraday = live?.plan ?? null;
  const plan = intraday
    ? { entry: intraday.entry, stop: intraday.stop, t1: intraday.t1, t2: intraday.t2, qty: intraday.qty, risk: intraday.risk, netAtTargets: intraday.netAtTargets, netAtStop: intraday.netAtStop, charges: intraday.charges, stopPct: ((intraday.stop - intraday.entry) / intraday.entry) * 100, rr1: (intraday.entry - intraday.t1) / (intraday.stop - intraday.entry), rr2: (intraday.entry - intraday.t2) / (intraday.stop - intraday.entry) }
    : daily;

  useEffect(() => {
    onLines(plan ? [{ price: plan.entry, title: 'Sell first', color: '#9aa0a6' }, { price: plan.stop, title: 'Buy back if', color: '#c23a48' }, { price: plan.t1, title: 'Target 1', color: '#2fa36b' }, { price: plan.t2, title: 'Target 2', color: '#2fa36b' }] : []);
  }, [plan?.entry, plan?.stop, plan?.t1, plan?.t2]);

  const f = flow?.stocks[stockKey];
  const vwap = live?.vwap ?? f?.vwap ?? null;
  const supportBelow = (s?.supports ?? []).filter((l) => ltp !== null && l.price < ltp).sort((a, b) => b.price - a.price)[0];
  const resistAbove = (s?.resistances ?? []).filter((l) => ltp !== null && l.price > ltp).sort((a, b) => a.price - b.price)[0];

  const practice = async () => {
    if (!plan) return;
    try {
      const r = await callBackground('wallet:short', { key: stockKey, symbol: sym, qty: plan.qty, stop: plan.stop, t1: plan.t1, t2: plan.t2, source: 'Sell-first analysis' });
      void buzz('success');
      toast(`Sold ${plan.qty} ${sym} first at ₹${formatNumberIN(r.price)} (practice)`);
    } catch (e) {
      toast(errorMessage(e), 'err');
    }
  };

  return (
    <section class="card short-analysis" data-testid="short-analysis">
      <div class="row">
        <h2 style={{ margin: 0 }}>Sell-first analysis</h2>
        <span class="spacer" />
        {chance && (
          <span class="fall-chance big" data-testid="sa-chance">
            <b>{Math.round(chance.chance * 100)}%</b>
            <span class="tiny">fall</span>
          </span>
        )}
      </div>
      <p class="tiny muted" style={{ margin: '2px 0 10px' }}>
        {chance
          ? `Its own chance of ending ≥0.3% below ${chance.live ? "today's" : "the next session's"} opening price, from its own numbers. Its past year: fell that much on ${chance.ownFell} of ${chance.ownDays} days.`
          : 'The chance appears once the past year has been studied (Stocks → For short selling).'}
        {model?.test ? ` The model's check on days it never saw: top-rated stocks fell ${Math.round(model.test.topRate * 100)}% of the time, an average day ${Math.round(model.test.baseRate * 100)}%.` : ''}
      </p>

      <div class="sa-mode tiny">
        {intraday ? (
          <>
            <span class="live-dot" /> Live plan from today's 5-minute candles ({formatTimeIST(live!.at).slice(0, 5)}, candle {String(Math.floor(live!.candleT / 60)).padStart(2, '0')}:{String(live!.candleT % 60).padStart(2, '0')}) · score {live!.score}/100
          </>
        ) : open ? (
          liveErr ? `Live 5-minute study not available (${liveErr}) — plan from daily data.` : 'Loading today\'s 5-minute candles… plan from daily data meanwhile.'
        ) : (
          'Market closed — plan for the next session from daily data. Check it again after 9:30 am: sell first only if the price is below the opening price.'
        )}
      </div>

      {plan ? (
        <>
          <div class="idea-grid sig-grid four">
            <div>
              <span>Sell first at</span>
              <b data-testid="sa-entry">{rs(plan.entry)}</b>
            </div>
            <div>
              <span>Stop-loss (buy back if it rises to)</span>
              <b class="err-text" data-testid="sa-stop">
                {rs(plan.stop)}
              </b>
            </div>
            <div>
              <span>Target 1 (buy back half)</span>
              <b class="ok-text">{rs(plan.t1)}</b>
            </div>
            <div>
              <span>Target 2 (the rest)</span>
              <b class="ok-text">{rs(plan.t2)}</b>
            </div>
          </div>
          <div class="sa-facts small">
            <div>
              <span class="muted">Quantity</span>
              <b>{plan.qty} shares</b>
            </div>
            <div>
              <span class="muted">Most you lose</span>
              <b>{formatINR(plan.risk, 0)}</b>
            </div>
            <div>
              <span class="muted">Risk : reward</span>
              <b data-testid="sa-rr">
                1 : {plan.rr1.toFixed(1)} · 1 : {plan.rr2.toFixed(1)}
              </b>
            </div>
            <div>
              <span class="muted">Stop distance</span>
              <b>{plan.stopPct.toFixed(2)}%</b>
            </div>
            <div>
              <span class="muted">At both targets</span>
              <b class="ok-text">{signed(plan.netAtTargets)}</b>
            </div>
            <div>
              <span class="muted">At the stop-loss</span>
              <b class="err-text">{signed(plan.netAtStop)}</b>
            </div>
          </div>
          <p class="tiny muted" style={{ margin: '4px 0 0' }}>
            For ₹{risk} risk (change it on the Day trade tab). Results after Upstox intraday charges (≈ {formatINR(plan.charges, 0)}). Close everything by 3:10 pm.
          </p>
        </>
      ) : (
        <p class="small muted">No plan: not enough price history yet.</p>
      )}

      <h3 class="sa-h">The numbers</h3>
      <dl class="kv small sa-kv" data-testid="sa-numbers">
        <dt>Price now</dt>
        <dd>
          {rs(ltp)} {s?.changePct !== null && s?.changePct !== undefined ? <span class={s.changePct < 0 ? 'err-text' : 'ok-text'}>{formatPct(s.changePct, 2)}</span> : null}
        </dd>
        <dt>RSI 14 (daily)</dt>
        <dd>
          {s?.rsi14 !== null && s?.rsi14 !== undefined ? s.rsi14.toFixed(1) : '—'} <span class="muted">{s?.rsi14 == null ? '' : s.rsi14 < 30 ? '— already very low: bounce risk' : s.rsi14 <= 55 ? '— room to fall' : s.rsi14 >= 70 ? '— stretched high' : '— neutral'}</span>
        </dd>
        {live && (
          <>
            <dt>RSI 14 (5-minute)</dt>
            <dd>{live.rsi5 !== null ? live.rsi5.toFixed(1) : '—'}</dd>
          </>
        )}
        <dt>VWAP (day's average price)</dt>
        <dd>
          {vwap ? (
            <>
              {rs(vwap)} <span class={ltp !== null && ltp < vwap ? 'err-text' : 'ok-text'}>{ltp !== null ? (ltp < vwap ? '— price below: sellers in control' : '— price above: buyers in control') : ''}</span>
            </>
          ) : (
            <span class="muted">during market hours</span>
          )}
        </dd>
        {live && (
          <>
            <dt>EMA 9 (5-minute)</dt>
            <dd>
              {rs(live.ema9)} <span class="muted">{ltp !== null ? (ltp < live.ema9 ? '— below' : '— above') : ''}</span>
            </dd>
            <dt>Today's high / low</dt>
            <dd>
              {rs(live.dayHigh)} / {rs(live.dayLow)}
            </dd>
          </>
        )}
        <dt>Volume</dt>
        <dd>
          {s?.volumeRatio != null ? `${s.volumeRatio.toFixed(2)}× its 20-day average (last session)` : '—'}
          {f?.pace ? ` · today ${f.pace.toFixed(1)}× the usual pace` : ''}
          {live?.volRatio ? ` · last 5-min candle ${live.volRatio.toFixed(1)}× today's average` : ''}
        </dd>
        <dt>Trend</dt>
        <dd>
          {s?.trend ?? '—'}
          {s?.ema20 && s.sma50 ? ` · 20-day average ${rs(s.ema20)} vs 50-day ${rs(s.sma50)}` : ''}
          {s?.ret1m !== null && s?.ret1m !== undefined ? ` · 1 month ${formatPct(s.ret1m, 1)}` : ''}
        </dd>
        <dt>Normal daily range (ATR)</dt>
        <dd>{s?.atr14 ? `₹${formatNumberIN(s.atr14)} (${((s.atr14 / s.price) * 100).toFixed(1)}%)` : '—'}</dd>
        <dt>Support below</dt>
        <dd>{supportBelow ? `${rs(supportBelow.price)} — the fall may pause there` : s?.low20 ? `20-day low ${rs(s.low20)}` : '—'}</dd>
        <dt>Resistance above</dt>
        <dd>{resistAbove ? `${rs(resistAbove.price)} — a stop above it is safer` : s?.high20 ? `20-day high ${rs(s.high20)}` : '—'}</dd>
      </dl>

      {(setup || live) && (
        <>
          <h3 class="sa-h">Why it may fall</h3>
          <div class="reason-chips">
            {(live?.reasons ?? []).map((r) => (
              <span class="reason-pill">{r.text}</span>
            ))}
            {(setup?.reasons ?? []).map((r) => (
              <span class="reason-pill">{r}</span>
            ))}
            {(setup?.against ?? []).map((r) => (
              <span class="reason-pill against">⚠ {r}</span>
            ))}
          </div>
        </>
      )}

      <h3 class="sa-h">News</h3>
      <StockNews stockKey={stockKey} side="short" bare />

      <div class="row" style={{ gap: '8px', marginTop: '10px', flexWrap: 'wrap' }}>
        <button class="btn small sell" type="button" data-testid="sa-practice" disabled={!open || !plan} onClick={() => void practice()}>
          Practice sell-first
        </button>
        <details class="small grow">
          <summary>How in Upstox</summary>
          <ol class="how-steps">
            <li>
              Upstox → <b>{sym}</b> → <b>Sell</b> → product <b>Intraday</b> → quantity <b>{plan?.qty ?? '—'}</b> → Market.
            </li>
            <li>
              Right after: <b>Buy</b> → Intraday → <b>Stop-loss</b> order, trigger {rs(plan?.stop)} (your safety net).
            </li>
            <li>
              Buy back half at {rs(plan?.t1)} and the rest at {rs(plan?.t2)}, or everything by <b>3:10 pm</b>.
            </li>
          </ol>
        </details>
      </div>
    </section>
  );
}
