import { updateSettings } from '../../storage/local';
import type { Settings } from '../../storage/schema';
import { askNotificationPermission } from '../../platform/nativeBindings';

/** Settings → Alerts: four plain switches. */
export function AlertSettings({ settings }: { settings: Settings }) {
  const rows: Array<{ id: string; on: boolean; title: string; about: string; set: (v: boolean) => Promise<unknown> }> = [
    {
      id: 'ideas',
      on: settings.dayTrade.alerts,
      title: 'Buy ideas',
      about: 'When a stock breaks out with heavy buying (9:30–11:30). Marked ⭐ when self-learning is very sure.',
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
      about: 'A stock falling clearly (score 75+) with an entry, buy-back price and two targets. At most 3 a day.',
      set: (v) => updateSettings({ notifications: { shorts: v } }),
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
