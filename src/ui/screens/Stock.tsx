import { useMemo, useState } from 'preact/hooks';
import { formatDateIST, formatNumberIN, formatPct, formatTimeIST } from '../../lib/format';
import { errorMessage } from '../../lib/serialize';
import { callBackground } from '../../shared/messages';
import { setLocal } from '../../storage/local';
import type { Go } from '../App';
import { Flags, SetupBadge } from '../components/Badges';
import { PriceChart, type ChartLine } from '../components/PriceChart';
import { Term } from '../components/Term';
import { useInstrumentMap, useStockData } from '../data';
import { useLocal } from '../hooks';
import { AddStock } from './Watchlist';
import { ExplainCard, StudyButton } from '../components/Explain';

export function StockScreen({ keyParam, go }: { keyParam: string | null; go: Go }) {
  const watchlist = useLocal('watchlist') ?? [];
  const key = keyParam ?? watchlist[0] ?? null;
  const byKey = useInstrumentMap();
  const plans = useLocal('plans') ?? [];
  const { data, loading } = useStockData(key);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [alertLevel, setAlertLevel] = useState('');
  const [alertKind, setAlertKind] = useState<'above' | 'below'>('above');

  const inst = key ? byKey.get(key) : undefined;
  const sym = inst?.trading_symbol ?? key ?? '';
  const s = data?.snapshot ?? null;
  const plan = plans.find((p) => p.key === key && !p.practice && (p.status === 'planned' || p.status === 'open'));
  const lines = useMemo<ChartLine[]>(
    () => (plan ? [{ price: plan.entry, title: 'Entry', color: '#1f6feb' }, { price: plan.stop, title: 'Stop', color: '#cf222e' }, { price: plan.target, title: 'Target', color: '#1a7f37' }] : []),
    [plan?.entry, plan?.stop, plan?.target],
  );

  if (!key) {
    return (
      <section class="card">
        <h2>Stock</h2>
        <p class="muted">Pick a stock:</p>
        <AddStock onAdd={(k) => go('stock', k)} />
      </section>
    );
  }

  const act = async (fn: () => Promise<string>) => {
    setBusy(true);
    setMsg(null);
    try {
      setMsg({ tone: 'ok', text: await fn() });
    } catch (err) {
      setMsg({ tone: 'err', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const q = data?.quote;
  return (
    <>
      <section class="card">
        <div class="row">
          <h2 style={{ margin: 0 }}>{sym}</h2>
          <span class="muted small">{inst?.short_name ?? inst?.name}</span>
          <span class="spacer" />
          {!watchlist.includes(key) && (
            <button class="btn small" type="button" onClick={() => void act(async () => {
              await setLocal('watchlist', [...watchlist, key]);
              return 'Added to watchlist.';
            })}>
              + Watchlist
            </button>
          )}
        </div>
        <div class="row big-price">
          <b>{s ? `₹${formatNumberIN(s.price)}` : q ? `₹${formatNumberIN(q.ltp)}` : '—'}</b>
          <span class={s?.changePct !== null && s?.changePct !== undefined && s.changePct >= 0 ? 'ok-text' : 'err-text'}>{formatPct(s?.changePct ?? null)}</span>
          {s && <SetupBadge setup={s.setup} />}
        </div>
        <p class="small muted" style={{ margin: '2px 0' }}>
          {q ? `Price at ${formatTimeIST(q.fetchedAt)} IST${data?.stale ? ' (STALE)' : ''}` : 'No live price yet'} · daily data up to {data?.lastCandleDate ? formatDateIST(Date.parse(`${data.lastCandleDate}T12:00:00+05:30`)) : '—'}
          {s?.live ? ' + today (live)' : ''}
        </p>
        {s && (
          <div class="small">
            <span class="muted">{s.trend ?? 'Trend: not enough data'}</span> <Flags flags={s.flags} />
          </div>
        )}
        <div class="row" style={{ marginTop: '8px' }}>
          <button class="btn primary small" type="button" onClick={() => go('planner', key)}>
            Plan trade
          </button>
          <button class="btn small" type="button" disabled={busy} onClick={() => void act(async () => {
            const r = await callBackground('stock:sync', { key });
            await callBackground('quotes:refresh').catch(() => undefined);
            return `Data updated (${r.fetched} days fetched, last ${r.lastDate ?? '—'}).`;
          })}>
            {busy ? 'Updating…' : 'Refresh data'}
          </button>
          <button class="btn small" type="button" disabled title="Deep company study arrives in M7">
            Analyze (M7)
          </button>
        </div>
        {msg && <p class={`small ${msg.tone === 'ok' ? 'ok-text' : 'err-text'}`}>{msg.text}</p>}
      </section>

      {s && <ExplainCard symbol={sym} snap={s} />}
      {s && (
        <section class="card">
          <h2>Company study (free)</h2>
          <StudyButton
            input={{ symbol: sym, name: inst?.name ?? sym, ...(inst?.isin ? { isin: inst.isin } : {}), snap: s, priceTime: q?.fetchedAt ?? Date.now(), plan: null }}
          />
        </section>
      )}

      {data?.suspicious.length ? (
        <div class="banner err">
          <b>Possible unadjusted bonus/split.</b> These one-day moves are bigger than ±18% with no matching corporate action, so the averages may be wrong:
          <ul>
            {data.suspicious.map((g) => (
              <li>
                {g.date}: {formatPct(g.changePct, 1)}{' '}
                <button class="btn small" type="button" onClick={() => void act(async () => {
                  await callBackground('gaps:ignore', { key, date: g.date });
                  return 'Noted — that move is treated as real.';
                })}>
                  This move was real
                </button>
              </li>
            ))}
          </ul>
          Check the stock on another chart (e.g. the Upstox app) before trusting the signals.
        </div>
      ) : null}
      {data?.events.length ? (
        <p class="small muted">
          Adjusted for:{' '}
          {data.events.map((e) => `${e.kind} ${e.ratio ?? ''} on ${e.date} (prices before ×${e.factor.toFixed(4)})`).join('; ')}.
        </p>
      ) : null}

      <section class="card">
        {loading && !data ? <p class="muted">Loading…</p> : data && data.candles.length ? <PriceChart candles={data.candles} supports={s?.supports ?? []} resistances={s?.resistances ?? []} lines={lines} /> : <p class="muted">No price history yet. Click "Refresh data".</p>}
      </section>

      {s && (
        <details class="card">
          <summary>
            <b>All the numbers</b> <span class="muted small">(indicators, levels, returns)</span>
          </summary>
          <dl class="kv small indicators">
            <dt><Term t="SMA20">SMA 20</Term></dt>
            <dd>{formatNumberIN(s.sma20)} <span class="muted">({formatPct(s.distSma20Pct, 1)})</span></dd>
            <dt><Term t="SMA50">SMA 50</Term></dt>
            <dd>{formatNumberIN(s.sma50)}</dd>
            <dt><Term t="SMA200">SMA 200</Term></dt>
            <dd>{formatNumberIN(s.sma200)} <span class="muted">({formatPct(s.distSma200Pct, 1)}, {s.sma200Rising === null ? '—' : s.sma200Rising ? 'rising' : 'falling'})</span></dd>
            <dt><Term t="EMA20">EMA 20</Term></dt>
            <dd>{formatNumberIN(s.ema20)}</dd>
            <dt><Term t="RSI">RSI 14</Term></dt>
            <dd>{formatNumberIN(s.rsi14, 1)}</dd>
            <dt><Term t="ATR">ATR 14</Term></dt>
            <dd>₹{formatNumberIN(s.atr14)} <span class="muted">({s.atr14 ? formatPct((s.atr14 / s.price) * 100, 1, false) : '—'} of price)</span></dd>
            <dt><Term t="Stretch">Stretch</Term></dt>
            <dd>{formatNumberIN(s.stretch, 2)} × ATR</dd>
            <dt>20-day high / low</dt>
            <dd>{formatNumberIN(s.high20)} / {formatNumberIN(s.low20)}</dd>
            <dt>52-week high / low</dt>
            <dd>{formatNumberIN(s.high52w)} / {formatNumberIN(s.low52w)}</dd>
            <dt><Term t="Volume ratio">Volume ratio</Term></dt>
            <dd>{formatNumberIN(s.volumeRatio, 2)}</dd>
            <dt><Term t="Traded value">Traded value</Term></dt>
            <dd>₹{formatNumberIN(s.avgTradedValueCr, 1)} cr/day</dd>
            <dt>Returns</dt>
            <dd>1M {formatPct(s.ret1m, 1)} · 3M {formatPct(s.ret3m, 1)} · 6M {formatPct(s.ret6m, 1)} · 1Y {formatPct(s.ret1y, 1)}</dd>
            <dt><Term t="Support">Support</Term></dt>
            <dd>{s.supports.length ? s.supports.map((l) => `₹${formatNumberIN(l.price)}`).join(', ') : '—'}</dd>
            <dt><Term t="Resistance">Resistance</Term></dt>
            <dd>{s.resistances.length ? s.resistances.map((l) => `₹${formatNumberIN(l.price)}`).join(', ') : '—'}</dd>
            <dt><Term t="Swing low">Last swing low</Term></dt>
            <dd>{s.lastSwingLow !== null ? `₹${formatNumberIN(s.lastSwingLow)}` : '—'}</dd>
          </dl>
          <p class="tiny muted">Based on {s.sessions} daily sessions (bonus/split adjusted){s.live ? ' plus today’s live price' : ''}. ATR, 20-day high/low and levels use completed days only.</p>
        </details>
      )}

      <section class="card">
        <h2>Add price alert</h2>
        <div class="row">
          <select aria-label="Direction" value={alertKind} onChange={(e) => setAlertKind((e.currentTarget as HTMLSelectElement).value as 'above' | 'below')}>
            <option value="above">Crosses above</option>
            <option value="below">Crosses below</option>
          </select>
          <input type="number" step="0.05" placeholder="₹ level" value={alertLevel} onInput={(e) => setAlertLevel((e.currentTarget as HTMLInputElement).value)} style={{ width: '110px' }} />
          <button class="btn small" type="button" disabled={busy} onClick={() => void act(async () => {
            const level = Number(alertLevel);
            await callBackground('alerts:add', { rule: { key, symbol: sym, kind: alertKind, level, repeat: false } });
            setAlertLevel('');
            return `Alert added: ${sym} ${alertKind === 'above' ? 'crosses above' : 'crosses below'} ₹${formatNumberIN(level)}.`;
          })}>
            Add alert
          </button>
        </div>
      </section>
    </>
  );
}
