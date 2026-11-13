import type { Flag, SetupLabel } from '../../indicators/snapshot';

const SETUP_TONE: Record<SetupLabel, string> = {
  Breakout: 'good',
  'Pullback in uptrend': 'good',
  'Clean uptrend': 'good',
  'Recovering — trend not confirmed': 'neutral',
  'No setup': 'none',
};

const SETUP_TIP: Record<SetupLabel, string> = {
  Breakout: 'Price above the prior 20-day high with volume ≥ 1.5× normal, in an uptrend or recovery.',
  'Pullback in uptrend': 'Uptrend, price within 1 ATR of the 20-day average, RSI 40–55, above the 50-day.',
  'Clean uptrend': 'Price > SMA20 > SMA50 > SMA200.',
  'Recovering — trend not confirmed': 'Above the 200-day but the 50-day is still below the 200-day.',
  'No setup': 'None of the setup rules match.',
};

const FLAG_TIP: Record<Flag, string> = {
  Stretched: 'Far above the 20-day average (> 2 ATR) or RSI above 70 — wait for a pullback.',
  'Below 200-day': 'Below the 200-day average — no swing longs.',
  'Low liquidity': 'Under ₹10 crore traded per day.',
  'Possible unadjusted action': 'A big one-day move with no matching bonus/split — indicators may be wrong. Check the stock view.',
  'Stale data': 'Price is more than 90 s old during market hours. No price alerts on stale data.',
  'Not enough data': 'Less than 200 days of history — some indicators are missing.',
};

export function SetupBadge({ setup }: { setup: SetupLabel }) {
  return (
    <span class={`chip setup ${SETUP_TONE[setup]}`} title={SETUP_TIP[setup]}>
      {setup}
    </span>
  );
}

export function Flags({ flags }: { flags: Flag[] }) {
  return (
    <>
      {flags.map((f) => (
        <span class={`chip flag${f === 'Possible unadjusted action' || f === 'Stale data' ? ' bad' : ''}`} title={FLAG_TIP[f]}>
          {f}
        </span>
      ))}
    </>
  );
}
