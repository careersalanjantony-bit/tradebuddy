import { useEffect, useRef, useState } from 'preact/hooks';
import { ALERT_EVENT } from '../../platform/chromeShim';
import { callBackground } from '../../shared/messages';
import { openAlertDetail } from './AlertDetail';
import { buzz } from './Motion';

/**
 * App v1.9: alerts while the app is on screen. Every notification also appears inside the app as a
 * banner at the top (with the chosen tone, played by the alert itself). Android keeps a quiet copy in
 * the notification list. When the app is not on screen, Android shows the alert as a pop-up instead.
 *
 * App v1.18: swipe a banner left, right or up to dismiss it (or tap ×); tap it for the full details.
 * A dismissed alert is not shown again. Alerts made while the app is starting or coming back to the
 * front are catch-up work, not news: they go to the Alerts tab without a banner.
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
  if (/^alert:(pick|advice|intraday)-/.test(id)) return 'today';
  if (/^alert:rising-/.test(id)) return 'watchlist';
  if (/^alert:update-/.test(id)) return 'account';
  if (/^alert:test-/.test(id) || id === 'login-reminder' || id === 'session-expired' || id === 'analytics-invalid') return 'settings';
  return 'alerts';
}

export const iconFor = (a: { id: string; title: string }): string => {
  const m = /^(\p{Extended_Pictographic})/u.exec(a.title);
  if (m) return m[1]!;
  if (/^alert:bo-/.test(a.id)) return '🚀';
  if (/^alert:(short|day)-/.test(a.id)) return '⚡';
  if (/^alert:(sold|closed|practice|wallet)-/.test(a.id)) return '💰';
  return '🔔';
};

const kindOf = (a: InAppAlert): string => (/stop-loss|fell|failed|loss/i.test(a.title) ? 'warn' : /^alert:bo-/.test(a.id) ? 'boost' : 'info');

const SHOW_MS = 9_000;
/** after a touch that did not dismiss it, the banner stays this much longer */
const AFTER_TOUCH_MS = 4_000;
/** app start / back to the front: alerts in this window are catch-up — Alerts tab only, no banner */
export const LAUNCH_QUIET_MS = 8_000;

type Done = 'dismiss' | 'timeout' | 'open';

export function AlertBanner() {
  const [items, setItems] = useState<InAppAlert[]>([]);
  const quietUntil = useRef(Date.now() + LAUNCH_QUIET_MS);
  const gone = useRef(new Set<string>());
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') quietUntil.current = Date.now() + LAUNCH_QUIET_MS;
    };
    const on = (e: Event) => {
      const d = (e as CustomEvent<InAppAlert>).detail;
      if (!d?.title || gone.current.has(d.id) || d.at < quietUntil.current) return;
      setItems((list) => [d, ...list.filter((x) => x.id !== d.id)].slice(0, 2));
      void buzz('medium');
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener(ALERT_EVENT, on);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener(ALERT_EVENT, on);
    };
  }, []);
  if (!items.length) return null;
  const finish = (a: InAppAlert, how: Done) => {
    setItems((list) => list.filter((x) => x.at !== a.at));
    if (how === 'timeout') return;
    // dismissed or opened: never shown again, and its copy leaves the phone's notification list
    gone.current.add(a.id);
    void callBackground('alerts:dismiss', { id: a.id }).catch(() => undefined);
    if (how === 'open') openAlertDetail(a);
  };
  return (
    <div class="alert-banners" role="alert" aria-live="assertive">
      {items.map((a) => (
        <BannerItem key={a.at} a={a} done={(how) => finish(a, how)} />
      ))}
    </div>
  );
}

interface Drag {
  x: number;
  y: number;
  t: number;
  pointer: number;
  axis: 'x' | 'y' | null;
}

function BannerItem({ a, done }: { a: InAppAlert; done: (how: Done) => void }) {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [leaving, setLeaving] = useState<'left' | 'right' | 'up' | null>(null);
  const [held, setHeld] = useState(false);
  const [touches, setTouches] = useState(0);
  const drag = useRef<Drag | null>(null);
  const moved = useRef(false);
  const doneRef = useRef(done);
  doneRef.current = done;

  // hides itself after a while; never while a finger is on it
  useEffect(() => {
    if (held || leaving) return undefined;
    const t = setTimeout(() => doneRef.current('timeout'), touches ? AFTER_TOUCH_MS : SHOW_MS);
    return () => clearTimeout(t);
  }, [held, leaving, touches]);

  const leave = (dir: 'left' | 'right' | 'up') => {
    setLeaving(dir);
    setTimeout(() => doneRef.current('dismiss'), 200);
  };

  const onDown = (e: PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, t: performance.now(), pointer: e.pointerId, axis: null };
    moved.current = false;
    setHeld(true);
  };
  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    const mx = e.clientX - d.x;
    const my = e.clientY - d.y;
    if (!d.axis) {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
      d.axis = Math.abs(mx) >= Math.abs(my) ? 'x' : 'y';
      moved.current = true;
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    }
    setOffset(d.axis === 'x' ? { x: mx, y: 0 } : { x: 0, y: Math.min(0, my) });
  };
  const onUp = (e: PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    setHeld(false);
    setTouches((n) => n + 1);
    if (!d?.axis) return;
    const el = e.currentTarget as HTMLElement;
    const ms = Math.max(1, performance.now() - d.t);
    if (d.axis === 'x') {
      const mx = e.clientX - d.x;
      // far enough, or a quick flick
      if (Math.abs(mx) > (el.offsetWidth || 320) * 0.35 || (Math.abs(mx) > 30 && Math.abs(mx) / ms > 0.5)) return leave(mx > 0 ? 'right' : 'left');
    } else {
      const my = e.clientY - d.y;
      if (my < -(el.offsetHeight || 80) * 0.4 || (my < -20 && -my / ms > 0.5)) return leave('up');
    }
    setOffset({ x: 0, y: 0 }); // not far enough: springs back
  };

  const icon = iconFor(a);
  const title = a.title.startsWith(icon) ? a.title.slice(icon.length).trim() : a.title;
  const dragging = drag.current !== null && moved.current;
  const transform = leaving === 'left' ? 'translateX(-115%)' : leaving === 'right' ? 'translateX(115%)' : leaving === 'up' ? 'translateY(-140%)' : `translate(${offset.x}px, ${offset.y}px)`;
  const fade = leaving ? 0 : 1 - Math.min(0.7, Math.abs(offset.x) / 360 + Math.abs(offset.y) / 160);

  return (
    <div
      class={`alert-banner ${kindOf(a)}${dragging ? ' dragging' : ''}${leaving ? ' leaving' : ''}`}
      style={{ transform, opacity: fade }}
      data-testid="alert-banner"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      <button
        type="button"
        class="alert-banner-body"
        onClick={() => {
          if (moved.current) return; // that was a swipe, not a tap
          done('open');
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
      <button type="button" class="alert-banner-close" aria-label="Dismiss" onClick={() => done('dismiss')}>
        ×
      </button>
      <i key={touches} class="alert-banner-timer" style={{ animationDuration: `${touches ? AFTER_TOUCH_MS : SHOW_MS}ms`, animationPlayState: held ? 'paused' : 'running' }} aria-hidden="true" />
    </div>
  );
}
