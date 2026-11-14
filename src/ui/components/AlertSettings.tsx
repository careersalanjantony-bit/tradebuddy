import { useState } from 'preact/hooks';
import { channelOf, TONES, toneOf, type ToneId } from '../../notify/toneList';
import { playAlertTone } from '../../notify/sound';
import { askNotificationPermission, scheduleTestAlert } from '../../platform/nativeBindings';
import { isNative } from '../../platform/http';
import { openNotificationSettings } from '../../platform/updater';
import { callBackground } from '../../shared/messages';
import { updateSettings } from '../../storage/local';
import type { Settings } from '../../storage/schema';
import { toast } from './Motion';

/** Settings → Alerts: plain switches, and the notification tone (app v1.9). */
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
      id: 'breakouts',
      on: settings.notifications.breakouts !== false,
      title: '🚀 Breakouts (buy first)',
      about: "The moment a stock breaks above today's high with a volume surge (9:20–3:00), then ✅ when the 5-minute candle confirms it. Each with entry, stop-loss, two targets and quantity.",
      set: (v) => updateSettings({ notifications: { breakouts: v } }),
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
      about: "About every 15 minutes in market hours: your practice take-profit / sell-if-falls prices, fast risers and breakouts above yesterday's high (max 3 a day).",
      set: (v) => updateSettings({ notifications: { background: v } }),
    },
    {
      id: 'sounds',
      on: settings.notifications.sounds,
      title: 'Sounds',
      about: 'Every alert plays the tone you choose below — also when the app is closed. Off: alerts still pop up, silently.',
      set: (v) => updateSettings({ notifications: { sounds: v } }),
    },
  ];
  return (
    <>
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
      <ToneSettings settings={settings} />
    </>
  );
}

/** "Notification tone": original money sounds, a preview, and a pop-up test. */
function ToneSettings({ settings }: { settings: Settings }) {
  const current = toneOf(settings.notifications.tone).id;
  const [playing, setPlaying] = useState<ToneId | null>(null);
  const preview = (id: ToneId) => {
    setPlaying(id);
    void playAlertTone(id).finally(() => setTimeout(() => setPlaying((p) => (p === id ? null : p)), 1200));
  };
  const choose = (id: ToneId) => {
    void updateSettings({ notifications: { tone: id, ...(settings.notifications.sounds ? {} : { sounds: true }) } });
    preview(id);
  };
  const testPopup = async () => {
    await askNotificationPermission().catch(() => false);
    const t = toneOf(current);
    const title = `${t.emoji} Test: TradeBuddy alert with "${t.name}"`;
    const body = 'This is how buy ideas, breakouts and targets will pop up — also when the app is closed.';
    if (isNative()) {
      const ok = await scheduleTestAlert(settings.notifications.sounds ? channelOf(current) : 'alerts-silent', 5, title, body).catch(() => false);
      toast(ok ? 'Now leave the app or lock the phone — the test alert pops up in 5 seconds.' : 'Allow notifications for TradeBuddy first (phone settings).', ok ? 'ok' : 'err');
    } else {
      toast('Test alert in 5 seconds…', 'info');
      setTimeout(() => void callBackground('diag:testAlert', { sound: 'target' }).catch(() => undefined), 5_000);
    }
  };
  return (
    <section class="card tone-card" data-testid="tone-settings">
      <h2>Notification tone</h2>
      <p class="small muted" style={{ marginTop: 0 }}>
        Pick the sound for every alert. It also plays when TradeBuddy is closed, and the alert pops up at the top of the screen.
      </p>
      <div class="tone-list" role="radiogroup" aria-label="Notification tone">
        {TONES.map((t) => (
          <div class={`tone-row ${current === t.id ? 'on' : ''} ${playing === t.id ? 'playing' : ''}`} data-tone={t.id}>
            <button type="button" role="radio" aria-checked={current === t.id} class="tone-pick" onClick={() => choose(t.id)}>
              <span class="tone-emoji" aria-hidden="true">
                {t.emoji}
              </span>
              <span class="tone-text">
                <b>{t.name}</b>
                <span class="tiny muted">{t.hint}</span>
              </span>
              <span class="tone-check" aria-hidden="true">
                {current === t.id ? '✓' : ''}
              </span>
            </button>
            <button type="button" class="icon-btn tone-play" aria-label={`Play ${t.name}`} data-play={t.id} onClick={() => preview(t.id)}>
              <span class="eq" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              ▶
            </button>
          </div>
        ))}
      </div>
      <div class="row" style={{ gap: '8px', marginTop: '10px', flexWrap: 'wrap' }}>
        <button class="btn small primary" type="button" data-testid="tone-test" onClick={() => void testPopup()}>
          Send a test alert
        </button>
        {isNative() && (
          <button class="btn small" type="button" onClick={() => void openNotificationSettings(channelOf(current))}>
            Allow pop-ups in phone settings
          </button>
        )}
      </div>
      <p class="tiny muted" style={{ marginBottom: 0 }}>
        No pop-up or sound? Some phones (Xiaomi, Realme, Oppo, Vivo, Samsung) switch off “pop on screen” / “floating notifications” for new apps — tap “Allow pop-ups in phone settings” and turn them on. Live breakout
        alerts need TradeBuddy open or in the background (not swiped away); when it is closed, a simpler check runs about every 15 minutes.
      </p>
    </section>
  );
}
