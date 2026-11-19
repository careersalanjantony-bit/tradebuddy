import { useEffect, useRef, useState } from 'preact/hooks';
import { alertDetail, getAlertHistory, type AlertDetail } from '../../alerts/history';
import { formatTimeIST } from '../../lib/format';
import { headlineOf, headOf, linesOf } from '../alertCard';
import { ALERT_EVENT } from '../../platform/chromeShim';
import { callBackground } from '../../shared/messages';
import type { Go } from '../App';
import { openAlertDetail } from './AlertDetail';
import { buzz } from './Motion';

/**
 * App v1.9: alerts while the app is on screen. Every notification also appears inside the app as a
 * card at the top (with the chosen tone, played by the alert itself). Android keeps a quiet copy in
 * the notification list. When the app is not on screen, Android shows the alert as a pop-up instead.
 *
 * App v1.18: swipe a card left, right or up to dismiss it (or tap ×); tap it for the full details.
 * A dismissed alert is not shown again. Alerts made while the app is starting or coming back to the
 * front are catch-up work, not news: they go to the Alerts tab without a card.
 *
 * App v1.20 — redesigned: one clean card under the top bar — what happened (NEW BUY OPPORTUNITY, NEW
 * SHORT-SELL OPPORTUNITY, TARGET REACHED, STOP-LOSS HIT…), the stock and score, then entry, stop-loss,
 * targets, quantity and the most it can lose on separate lines, with View stock / Dismiss. The page moves
 * down while a card is shown, so it never covers what you were looking at (positions, lists). More alerts
 * wait stacked behind the newest one ("+2 more"); each slides in and out.
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

const SHOW_MS = 9_000;
/** after a touch that did not dismiss it, the card stays this much longer */
const AFTER_TOUCH_MS = 4_000;
/** app start / back to the front: alerts in this window are catch-up — Alerts tab only, no card */
export const LAUNCH_QUIET_MS = 8_000;
/** alerts waiting behind the newest one (older ones are in the Alerts tab) */
const MAX_QUEUE = 5;
/** an alert that waited longer than this is not brought to the front any more */
const STALE_MS = 2 * 60_000;

type Done = 'dismiss' | 'timeout' | 'open' | 'stock';

export function AlertBanner({ go }: { go?: Go }) {
  const [items, setItems] = useState<InAppAlert[]>([]);
  const quietUntil = useRef(Date.now() + LAUNCH_QUIET_MS);
  const gone = useRef(new Set<string>());
  const stackRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') quietUntil.current = Date.now() + LAUNCH_QUIET_MS;
    };
    const on = (e: Event) => {
      const d = (e as CustomEvent<InAppAlert>).detail;
      if (!d?.title || gone.current.has(d.id) || d.at < quietUntil.current) return;
      setItems((list) => [d, ...list.filter((x) => x.id !== d.id)].slice(0, MAX_QUEUE));
      void buzz('medium');
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener(ALERT_EVENT, on);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener(ALERT_EVENT, on);
    };
  }, []);

  // the cards sit under the top bar (its height, safe area included, is measured)
  useEffect(() => {
    const bar = document.querySelector<HTMLElement>('.topbar');
    if (!bar || typeof ResizeObserver === 'undefined') return undefined;
    const set = () => document.documentElement.style.setProperty('--topbar-h', `${Math.round(bar.getBoundingClientRect().height)}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(bar);
    return () => ro.disconnect();
  }, []);

  // while cards are shown, the page moves down by their height — nothing on it is covered
  const shown = items.length > 0;
  useEffect(() => {
    const root = document.documentElement;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const space = (h: number) => {
      // the browser must not "keep the page still" here: moving it down is the point
      root.style.overflowAnchor = 'none';
      root.style.setProperty('--alert-space', `${Math.ceil(h)}px`);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => (root.style.overflowAnchor = ''), 450);
    };
    const el = stackRef.current;
    if (!shown || !el || typeof ResizeObserver === 'undefined') {
      space(0);
      return () => timer && clearTimeout(timer);
    }
    const ro = new ResizeObserver(() => space(el.offsetHeight + 8));
    ro.observe(el);
    return () => {
      ro.disconnect();
      space(0);
    };
  }, [shown]);

  if (!items.length) return null;
  const finish = (a: InAppAlert, how: Done, d: AlertDetail | null) => {
    const now = Date.now();
    setItems((list) => list.filter((x) => x.at !== a.at && now - x.at < STALE_MS));
    if (how === 'timeout') return;
    // dismissed or opened: never shown again, and its copy leaves the phone's notification list
    gone.current.add(a.id);
    void callBackground('alerts:dismiss', { id: a.id }).catch(() => undefined);
    if (how === 'open') openAlertDetail(a);
    if (how === 'stock' && d?.key && go) go('stock', d.side === 'sell' ? `${d.key}~short` : d.key);
  };
  const front = items[0]!;
  const waiting = items.length - 1;
  return (
    <div class="alert-banners" ref={stackRef} role="region" aria-label="New alerts" aria-live="assertive" data-testid="alert-stack">
      <div class={`alert-stack-wrap ${waiting ? `behind-${Math.min(2, waiting)}` : ''}`}>
        <BannerItem key={`${front.id}@${front.at}`} a={front} canOpenStock={!!go} done={(how, d) => finish(front, how, d)} />
      </div>
      {waiting > 0 && (
        <button type="button" class="alert-more" data-testid="alert-more" onClick={() => go?.('alerts')}>
          +{waiting} more {waiting === 1 ? 'alert' : 'alerts'}
        </button>
      )}
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

function BannerItem({ a, done, canOpenStock }: { a: InAppAlert; done: (how: Done, d: AlertDetail | null) => void; canOpenStock: boolean }) {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [leaving, setLeaving] = useState<'left' | 'right' | 'up' | null>(null);
  const [held, setHeld] = useState(false);
  const [touches, setTouches] = useState(0);
  // the details saved with the alert (read from its words until the stored copy is found)
  const [stored, setStored] = useState<AlertDetail | null>(null);
  const drag = useRef<Drag | null>(null);
  const moved = useRef(false);
  const doneRef = useRef(done);
  doneRef.current = done;
  const d = stored ?? alertDetail({ title: a.title, message: a.message });
  const dRef = useRef(d);
  dRef.current = d;

  useEffect(() => {
    let alive = true;
    void getAlertHistory()
      .then((h) => {
        const rec = h.items.find((x) => x.id === a.id);
        if (alive && rec?.detail) setStored(rec.detail);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [a.id]);

  const leave = (dir: 'left' | 'right' | 'up', how: Done) => {
    setLeaving(dir);
    setTimeout(() => doneRef.current(how, dRef.current), 220);
  };

  // hides itself after a while (sliding up); never while a finger is on it
  useEffect(() => {
    if (held || leaving) return undefined;
    const t = setTimeout(() => leave('up', 'timeout'), touches ? AFTER_TOUCH_MS : SHOW_MS);
    return () => clearTimeout(t);
  }, [held, leaving, touches]);

  const onDown = (e: PointerEvent) => {
    if ((e.target as Element).closest?.('button.ab-action, button.alert-banner-close')) return;
    drag.current = { x: e.clientX, y: e.clientY, t: performance.now(), pointer: e.pointerId, axis: null };
    moved.current = false;
    setHeld(true);
  };
  const onMove = (e: PointerEvent) => {
    const g = drag.current;
    if (!g || g.pointer !== e.pointerId) return;
    const mx = e.clientX - g.x;
    const my = e.clientY - g.y;
    if (!g.axis) {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
      g.axis = Math.abs(mx) >= Math.abs(my) ? 'x' : 'y';
      moved.current = true;
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    }
    setOffset(g.axis === 'x' ? { x: mx, y: 0 } : { x: 0, y: Math.min(0, my) });
  };
  const onUp = (e: PointerEvent) => {
    const g = drag.current;
    drag.current = null;
    setHeld(false);
    if (!g) return;
    setTouches((n) => n + 1);
    if (!g.axis) return;
    const el = e.currentTarget as HTMLElement;
    const ms = Math.max(1, performance.now() - g.t);
    if (g.axis === 'x') {
      const mx = e.clientX - g.x;
      // far enough, or a quick flick
      if (Math.abs(mx) > (el.offsetWidth || 320) * 0.35 || (Math.abs(mx) > 30 && Math.abs(mx) / ms > 0.5)) return leave(mx > 0 ? 'right' : 'left', 'dismiss');
    } else {
      const my = e.clientY - g.y;
      if (my < -(el.offsetHeight || 80) * 0.4 || (my < -20 && -my / ms > 0.5)) return leave('up', 'dismiss');
    }
    setOffset({ x: 0, y: 0 }); // not far enough: springs back
  };

  const icon = iconFor(a);
  const title = a.title.startsWith(icon) ? a.title.slice(icon.length).trim() : a.title;
  const head = headOf(a, d);
  const headline = headlineOf(title, d);
  const lines = d ? linesOf(d) : [];
  const note = d?.event && d.event !== 'new' ? d.reasons[0] : null;
  const dragging = drag.current !== null && moved.current;
  const transform = leaving === 'left' ? 'translateX(-115%)' : leaving === 'right' ? 'translateX(115%)' : leaving === 'up' ? 'translateY(-130%)' : `translate(${offset.x}px, ${offset.y}px)`;
  const fade = leaving ? 0 : 1 - Math.min(0.7, Math.abs(offset.x) / 360 + Math.abs(offset.y) / 160);
  const score = d && d.score !== null ? (d.scoreKind === 'chance' ? `${d.score}% chance` : `Score ${d.score}`) : null;

  return (
    <div
      class={`alert-banner tone-${head.tone}${dragging ? ' dragging' : ''}${leaving ? ' leaving' : ''}`}
      style={{ transform, opacity: fade }}
      data-testid="alert-banner"
      data-kind={head.kicker}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      <div class="ab-head">
        <span class="alert-banner-icon" aria-hidden="true">
          {icon}
        </span>
        <button
          type="button"
          class="alert-banner-body"
          onClick={() => {
            if (moved.current) return; // that was a swipe, not a tap
            leave('up', 'open');
          }}
        >
          <span class="ab-kicker" data-testid="alert-kicker">
            {head.kicker}
          </span>
          {d?.symbol ? (
            <span class="ab-title">
              <b>{d.symbol}</b>
              {score && <span class="ab-score">{score}</span>}
            </span>
          ) : (
            <b class="ab-title ab-title-text">{title}</b>
          )}
          {d?.symbol && headline && <span class="ab-headline">{headline}</span>}
        </button>
        <button type="button" class="alert-banner-close" aria-label="Dismiss" onClick={() => leave('right', 'dismiss')}>
          <span aria-hidden="true">×</span>
        </button>
      </div>
      {note && <p class="ab-note">{note}</p>}
      {lines.length > 0 ? (
        <dl class="ab-lines" data-testid="alert-lines">
          {lines.map(([k, v]) => (
            <div>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      ) : (
        a.message && <p class="ab-msg">{a.message}</p>
      )}
      <div class="ab-foot">
        <span class="ab-time">
          {d?.source ? `${d.source} · ` : ''}
          {formatTimeIST(a.at).slice(0, 5)}
        </span>
        <span class="spacer" />
        {d?.key && canOpenStock ? (
          <button type="button" class="btn small primary ab-action" data-testid="alert-view-stock" onClick={() => leave('up', 'stock')}>
            View stock
          </button>
        ) : (
          <button type="button" class="btn small primary ab-action" onClick={() => leave('up', 'open')}>
            Details
          </button>
        )}
        <button type="button" class="btn small ab-action" data-testid="alert-dismiss" onClick={() => leave('right', 'dismiss')}>
          Dismiss
        </button>
      </div>
      <div class="ab-progress" aria-hidden="true">
        <i key={touches} class="alert-banner-timer" style={{ animationDuration: `${touches ? AFTER_TOUCH_MS : SHOW_MS}ms`, animationPlayState: held ? 'paused' : 'running' }} />
      </div>
    </div>
  );
}
