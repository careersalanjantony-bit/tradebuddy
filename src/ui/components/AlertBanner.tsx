import { useEffect, useState } from 'preact/hooks';
import { ALERT_EVENT } from '../../platform/chromeShim';
import { buzz } from './Motion';

/**
 * App v1.9: alerts while the app is on screen. Every notification also appears inside the app as a
 * banner at the top (with the chosen tone, played by the alert itself); tapping it opens the right
 * screen. Android keeps a quiet copy in the notification list. When the app is not on screen, Android
 * shows the alert as a pop-up notification instead.
 */

export interface InAppAlert {
  id: string;
  title: string;
  message: string;
  at: number;
}

/** The screen an alert belongs to (also used when a notification is tapped). */
export function routeForAlert(id: string): string {
  if (/^alert:(bo|day|daypractice|short|test-bo)-/.test(id)) return 'daytrade';
  if (/^alert:(practice|wallet|closed|sold)-/.test(id)) return 'practice';
  if (/^alert:(pick|advice)-/.test(id)) return 'today';
  if (/^alert:rising-/.test(id)) return 'watchlist';
  if (/^alert:update-/.test(id)) return 'account';
  if (/^alert:test-/.test(id) || id === 'login-reminder' || id === 'session-expired' || id === 'analytics-invalid') return 'settings';
  return 'alerts';
}

const iconFor = (a: InAppAlert): string => {
  const m = /^(\p{Extended_Pictographic})/u.exec(a.title);
  if (m) return m[1]!;
  if (/^alert:bo-/.test(a.id)) return '🚀';
  if (/^alert:(short|day)-/.test(a.id)) return '⚡';
  if (/^alert:(sold|closed|practice|wallet)-/.test(a.id)) return '💰';
  return '🔔';
};

const kindOf = (a: InAppAlert): string => (/stop-loss|fell|failed|loss/i.test(a.title) ? 'warn' : /^alert:bo-/.test(a.id) ? 'boost' : 'info');

const SHOW_MS = 9_000;

export function AlertBanner({ open }: { open: (id: string) => void }) {
  const [items, setItems] = useState<InAppAlert[]>([]);
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<InAppAlert>).detail;
      if (!d?.title) return;
      setItems((list) => [d, ...list.filter((x) => x.id !== d.id)].slice(0, 2));
      setTimeout(() => setItems((list) => list.filter((x) => x.at !== d.at)), SHOW_MS);
      void buzz('medium');
    };
    window.addEventListener(ALERT_EVENT, on);
    return () => window.removeEventListener(ALERT_EVENT, on);
  }, []);
  if (!items.length) return null;
  const dismiss = (a: InAppAlert) => setItems((list) => list.filter((x) => x.at !== a.at));
  return (
    <div class="alert-banners" role="alert" aria-live="assertive">
      {items.map((a) => {
        const icon = iconFor(a);
        const title = a.title.startsWith(icon) ? a.title.slice(icon.length).trim() : a.title;
        return (
          <div class={`alert-banner ${kindOf(a)}`} key={a.at}>
            <button
              type="button"
              class="alert-banner-body"
              onClick={() => {
                dismiss(a);
                open(a.id);
              }}
            >
              <span class="alert-banner-icon" aria-hidden="true">
                {icon}
              </span>
              <span class="alert-banner-text">
                <b>{title}</b>
                <span>{a.message}</span>
              </span>
            </button>
            <button type="button" class="alert-banner-close" aria-label="Close" onClick={() => dismiss(a)}>
              ×
            </button>
            <i class="alert-banner-timer" style={{ animationDuration: `${SHOW_MS}ms` }} aria-hidden="true" />
          </div>
        );
      })}
    </div>
  );
}
