import { useState } from 'preact/hooks';
import { isShortlisted } from '../../indicators/snapshot';
import { formatINR, formatNumberIN, formatPct } from '../../lib/format';
import { errorMessage } from '../../lib/serialize';
import { callBackground } from '../../shared/messages';
import type { Go } from '../App';
import { SetupBadge, Flags } from '../components/Badges';
import { useInstrumentMap, useStocksData } from '../data';
import { useLocal, useSettings } from '../hooks';

/** Scanner output (spec §10): watchlist stocks above the 200-day with a valid setup. */
export function ShortlistScreen({ go }: { go: Go }) {
  const watchlist = useLocal('watchlist') ?? [];
  const settings = useSettings();
  const byKey = useInstrumentMap();
  const { data, loading } = useStocksData(watchlist);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const rows = watchlist
    .map((k) => data.get(k))
    .filter((d): d is NonNullable<typeof d> => !!d?.snapshot && isShortlisted(d.snapshot))
    .sort((a, b) => ['Breakout', 'Pullback in uptrend', 'Clean uptrend'].indexOf(a.snapshot!.setup) - ['Breakout', 'Pullback in uptrend', 'Clean uptrend'].indexOf(b.snapshot!.setup));

  const capital = settings?.risk.capitalInr ?? null;
  const riskPct = settings?.risk.riskPerTradePct ?? 1;
  const atrMult = settings?.planner.stopAtrMultiple ?? 2;

  const runScan = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await callBackground('eod:run');
      setMsg(`Scan done: history updated for ${r.synced} stocks; ${r.shortlist.length} on the shortlist.`);
    } catch (err) {
      setMsg(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section class="card">
        <div class="row">
          <h2 style={{ margin: 0 }}>Shortlist</h2>
          <span class="spacer" />
          <button class="btn small" type="button" disabled={busy} onClick={() => void runScan()}>
            {busy ? 'Scanning…' : 'Run scan now'}
          </button>
        </div>
        <p class="small muted">
          Watchlist stocks above their 200-day average with a Breakout, Pullback or Clean-uptrend setup. Updates live; the evening scan (16:00) also sends a notification.
          Suggested stop = {atrMult}×ATR; quantity uses your {riskPct}% risk setting{capital ? ` on ${formatINR(capital, 0)}` : ' (set your capital in Settings)'}.
        </p>
        {msg && <p class="small">{msg}</p>}
      </section>
      {!loading && rows.length === 0 && <div class="card empty">No watchlist stock has a valid setup right now.</div>}
      {rows.map((d) => {
        const s = d.snapshot!;
        const sym = byKey.get(d.key)?.trading_symbol ?? d.key;
        const stop = s.atr14 ? s.price - atrMult * s.atr14 : null;
        const qty = capital && stop && s.price > stop ? Math.floor((capital * riskPct) / 100 / (s.price - stop)) : null;
        return (
          <section class="card shortlist-item" data-symbol={sym}>
            <div class="row">
              <b>{sym}</b> <span>₹{formatNumberIN(s.price)}</span> <span class={s.changePct !== null && s.changePct >= 0 ? 'ok-text' : 'err-text'}>{formatPct(s.changePct)}</span>
              <span class="spacer" />
              <SetupBadge setup={s.setup} />
            </div>
            <div class="small">
              <Flags flags={s.flags} />
            </div>
            <p class="small" style={{ margin: '4px 0' }}>
              {s.trend} · RSI {formatNumberIN(s.rsi14, 0)} · stretch {formatNumberIN(s.stretch, 1)} · volume ×{formatNumberIN(s.volumeRatio, 2)} · 1M {formatPct(s.ret1m, 1)}
            </p>
            <p class="small" style={{ margin: '4px 0' }}>
              Suggested stop {stop ? `₹${formatNumberIN(stop)}` : '—'} · qty {qty ?? '—'}
            </p>
            <div class="row">
              <button class="btn small" type="button" onClick={() => go('stock', d.key)}>
                Open
              </button>
              <button class="btn small primary" type="button" onClick={() => go('planner', d.key)}>
                Plan trade
              </button>
            </div>
          </section>
        );
      })}
    </>
  );
}
