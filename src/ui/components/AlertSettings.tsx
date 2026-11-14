import { updateSettings } from '../../storage/local';
import type { Settings } from '../../storage/schema';
import { askNotificationPermission } from '../../platform/nativeBindings';

/** Settings → Alerts: plain switches. */
export function AlertSettings({ settings }: { settings: Settings }) {
  const rows: Array<{ id: string; on: boolean; title: string; about: string; set: (v: boolean) => Promise<unknown> }> = [
    {
      id: 'ideas',
      on: settings.dayTrade.alerts,
      title: 'Day-trade BUY / SELL ideas',
      about: 'Every new signal the moment it appears (9:35–11:30), each with its prices. Marked ⭐ when self-learning is very sure.',
      set: (v) => updateSettings({ dayTrade: { alerts: v } }),
    },
    {
      id: 'rising',
      on: settings.notifications.rising,
      title: 'Stocks rising fast',
      about: 'Buyers clearly in control and much busier than usual. At most 3 a day.',
      set: (v) => updateSettings({ notifications: { rising: v } }),
    },
    {
      id: 'shorts',
      on: settings.notifications.shorts ?? true,
      title: 'Sell-first ideas',
      about: 'Every stock the "Falling now" scan finds (score 60+, every 5 minutes, 9:35–2:30) with an entry, buy-back price and two targets.',
      set: (v) => updateSettings({ notifications: { shorts: v } }),
    },
    {
      id: 'picks',
      on: settings.scanner.newPickAlerts,
      title: 'New top picks (hold a few days)',
      about: 'When a stock becomes a top pick during market hours, with its buy, sell-if-falls and target prices.',
      set: (v) => updateSettings({ scanner: { newPickAlerts: v } }),
    },
    {
      id: 'background',
      on: settings.notifications.background,
      title: 'Keep checking when the app is closed',
      about: 'About every 15 minutes in market hours: your practice take-profit / sell-if-falls prices and fast risers.',
      set: (v) => updateSettings({ notifications: { background: v } }),
    },
    {
      id: 'sounds',
      on: settings.notifications.sounds,
      title: 'Sounds',
      about: 'A chime for profit, a beep for a sell-if-falls price.',
      set: (v) => updateSettings({ notifications: { sounds: v } }),
    },
  ];
  return (
    <section class="card" data-testid="alert-settings">
      <h2>Alerts</h2>
      {rows.map((r) => (
        <label class="switch-row" data-alert={r.id}>
          <span>
            <b>{r.title}</b>
            <span class="small muted">{r.about}</span>
          </span>
          <input
            type="checkbox"
            role="switch"
            class="switch"
            checked={r.on}
            onChange={(e) => {
              const v = (e.currentTarget as HTMLInputElement).checked;
              if (v) void askNotificationPermission().catch(() => false);
              void r.set(v);
            }}
          />
        </label>
      ))}
    </section>
  );
}
