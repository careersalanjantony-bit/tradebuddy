import { useEffect, useRef, useState } from 'preact/hooks';
import { PRICE_STOPS } from '../../advisor/suggest';
import { updateSettings } from '../../storage/local';
import { useSettings } from '../hooks';

const LAST = PRICE_STOPS.length - 1;
const label = (v: number | null) => (v === null ? 'no limit' : `₹${v.toLocaleString('en-IN')}`);
const idxOfMin = (v: number) => Math.max(0, PRICE_STOPS.findIndex((s) => s !== null && s >= v));
const idxOfMax = (v: number | null) => (v === null ? LAST : Math.max(1, PRICE_STOPS.findIndex((s) => s !== null && s >= v)));

/** Two-handle drag bar for the share-price range (saved in Settings, used by picks and lists). */
export function PriceRange() {
  const settings = useSettings();
  const [lo, setLo] = useState(0);
  const [hi, setHi] = useState(LAST);
  // Load the saved range once; afterwards the handles are driven by the user (saving must not jump them back mid-drag).
  const loaded = useRef(false);
  useEffect(() => {
    if (!settings || loaded.current) return;
    loaded.current = true;
    setLo(idxOfMin(settings.ui.priceMin));
    setHi(idxOfMax(settings.ui.priceMax));
  }, [settings]);

  const commit = (l: number, h: number) => void updateSettings({ ui: { priceMin: PRICE_STOPS[l] ?? 0, priceMax: PRICE_STOPS[h] ?? null } });
  const pct = (i: number) => (i / LAST) * 100;

  return (
    <div class="price-range" data-testid="price-range">
      <div class="row small">
        <b>Share price</b>
        <span data-testid="price-range-label">
          {label(PRICE_STOPS[lo] ?? 0)} – {label(PRICE_STOPS[hi] ?? null)}
        </span>
        <span class="spacer" />
        {(lo !== 0 || hi !== LAST) && (
          <button class="link-btn" type="button" onClick={() => { setLo(0); setHi(LAST); commit(0, LAST); }}>
            any price
          </button>
        )}
      </div>
      <div class="dual-range">
        <div class="track" />
        <div class="fill" style={{ left: `${pct(lo)}%`, width: `${pct(hi) - pct(lo)}%` }} />
        <input
          type="range"
          min={0}
          max={LAST}
          step={1}
          value={lo}
          aria-label="Lowest share price"
          data-testid="price-min"
          onInput={(e) => setLo(Math.min(Number((e.currentTarget as HTMLInputElement).value), hi - 1))}
          onChange={(e) => commit(Math.min(Number((e.currentTarget as HTMLInputElement).value), hi - 1), hi)}
        />
        <input
          type="range"
          min={0}
          max={LAST}
          step={1}
          value={hi}
          aria-label="Highest share price"
          data-testid="price-max"
          onInput={(e) => setHi(Math.max(Number((e.currentTarget as HTMLInputElement).value), lo + 1))}
          onChange={(e) => commit(lo, Math.max(Number((e.currentTarget as HTMLInputElement).value), lo + 1))}
        />
      </div>
    </div>
  );
}
