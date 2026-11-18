import { useMemo } from 'preact/hooks';
import { majorSupport } from '../../indicators/levels';
import type { TechSnapshot } from '../../indicators/snapshot';
import type { Candle } from '../../indicators/types';
import { formatNumberIN, formatTimeIST } from '../../lib/format';
import { useQuotes } from '../data';
import { useSettings } from '../hooks';
import { useFlash } from './Motion';

/**
 * App v1.18 — support and resistance on every stock page: Resistance 2 and 1 above, the live price in
 * the middle (from the Upstox live feed / price polls, the same prices as the rest of the app), Support
 * 1 and 2 and the major support below. Resistance and support 1–2 are the app's existing levels (the
 * stock's own turning points); nothing about them is changed.
 */
export function LevelsCard({ stockKey, snap, candles }: { stockKey: string; snap: TechSnapshot | null; candles: Candle[] }) {
  const quote = useQuotes()[stockKey];
  const settings = useSettings();
  const live = quote?.ltp ?? null;
  const flash = useFlash(live);
  const [r1, r2] = [snap?.resistances[0]?.price ?? null, snap?.resistances[1]?.price ?? null];
  const [s1, s2] = [snap?.supports[0]?.price ?? null, snap?.supports[1]?.price ?? null];
  const ind = settings?.indicators;
  const major = useMemo(() => {
    if (!snap?.atr14) return null;
    return majorSupport(candles, s2 ?? s1 ?? snap.price, snap.atr14, { k: ind?.swingK ?? 3, clusterAtr: ind?.srClusterAtr ?? 0.5 })?.price ?? null;
  }, [candles, s1, s2, snap?.atr14, snap?.price, ind?.swingK, ind?.srClusterAtr]);
  const rs = (v: number | null) => (v === null ? '—' : `₹${formatNumberIN(v)}`);

  return (
    <section class="card levels-card" data-testid="levels">
      <h2>Support &amp; resistance</h2>
      <dl class="levels">
        <div class="lv res">
          <dt>Resistance 2</dt>
          <dd data-level="r2">{rs(r2)}</dd>
        </div>
        <div class="lv res">
          <dt>Resistance 1</dt>
          <dd data-level="r1">{rs(r1)}</dd>
        </div>
        <div class="lv now">
          <dt>
            {live !== null ? 'Live price' : 'Last price'}
            {live !== null && <i class="live-dot" aria-hidden="true" />}
          </dt>
          <dd data-level="live" class={flash}>
            {rs(live ?? snap?.price ?? null)}
          </dd>
        </div>
        <div class="lv sup">
          <dt>Support 1</dt>
          <dd data-level="s1">{rs(s1)}</dd>
        </div>
        <div class="lv sup">
          <dt>Support 2</dt>
          <dd data-level="s2">{rs(s2)}</dd>
        </div>
        <div class="lv sup">
          <dt>Major support</dt>
          <dd data-level="major">{rs(major)}</dd>
        </div>
      </dl>
      <p class="tiny muted">
        {quote ? `Live price at ${formatTimeIST(quote.fetchedAt)} IST.` : 'No live price yet — showing the last close.'}{' '}
        {snap
          ? `Levels are where the price turned before (last ${ind?.srLookbackSessions ?? 120} trading days); major support is the floor it bounced from most often in the past year.`
          : 'The levels appear once this stock’s daily price history is downloaded (Refresh data).'}
      </p>
    </section>
  );
}
