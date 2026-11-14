import { useEffect, useRef, useState } from 'preact/hooks';
import { isNative } from '../../platform/http';

/**
 * Motion pieces for the app: numbers that count up, prices that flash green/red when they change,
 * a tiny chart line, a celebration burst for a profitable sale, and short toasts. All CSS/SVG — no
 * animation library. Respects "reduce motion" in the phone's settings.
 */

const reduceMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const easeOut = (x: number) => 1 - (1 - x) ** 3;

/** A number that glides to its new value. */
export function AnimatedNumber({ value, format, ms = 700 }: { value: number; format: (v: number) => string; ms?: number }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    if (reduceMotion() || from.current === value) {
      from.current = value;
      setShown(value);
      return;
    }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / ms);
      setShown(a + (value - a) * easeOut(k));
      if (k < 1) raf = requestAnimationFrame(step);
      else from.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <span class="num-anim">{format(shown)}</span>;
}

/** 'flash-up' / 'flash-down' for a moment after a value changes. */
export function useFlash(value: number | null | undefined): string {
  const prev = useRef(value);
  const [cls, setCls] = useState('');
  useEffect(() => {
    const p = prev.current;
    prev.current = value;
    if (p == null || value == null || p === value) return;
    setCls(value > p ? 'flash-up' : 'flash-down');
    const t = setTimeout(() => setCls(''), 750);
    return () => clearTimeout(t);
  }, [value]);
  return cls;
}

/** A tiny line chart; green when it ends higher than it started. */
export function Sparkline({ values, width = 96, height = 32, class: cls = '' }: { values: number[]; width?: number; height?: number; class?: string }) {
  if (values.length < 2) return <svg class={`spark ${cls}`} width={width} height={height} aria-hidden="true" />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * width, height - 3 - ((v - min) / span) * (height - 6)] as const);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const up = values[values.length - 1]! >= values[0]!;
  return (
    <svg class={`spark ${up ? 'up' : 'down'} ${cls}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <path class="spark-fill" d={`${d} L${width},${height} L0,${height} Z`} />
      <path class="spark-line" d={d} pathLength={1} />
    </svg>
  );
}

// ---------- celebration + toasts (global, opened from anywhere)

const CELEBRATE = 'tb-celebrate';
const TOAST = 'tb-toast';

export function celebrate(): void {
  window.dispatchEvent(new Event(CELEBRATE));
}

export function toast(text: string, tone: 'ok' | 'err' | 'info' = 'ok'): void {
  window.dispatchEvent(new CustomEvent(TOAST, { detail: { text, tone } }));
}

/** A short vibration on the phone (buy, sell, alerts). */
export async function buzz(kind: 'light' | 'medium' | 'success' = 'light'): Promise<void> {
  if (!isNative()) return;
  try {
    const { Haptics, ImpactStyle, NotificationType } = await import('@capacitor/haptics');
    if (kind === 'success') await Haptics.notification({ type: NotificationType.Success });
    else await Haptics.impact({ style: kind === 'medium' ? ImpactStyle.Medium : ImpactStyle.Light });
  } catch {
    /* no vibration motor */
  }
}

const COLORS = ['#22c55e', '#3ba3ff', '#a78bfa', '#facc15', '#f472b6'];

/** Elements that slide in when they scroll into view (like a Webflow "scroll into view" interaction). */
const REVEAL = '.card, .idea-card, .hero-card, .holding, .stock-card, .news-item, .rise-tile, .quick, .menu-item, .day-signal, .plan-step, .nudge';
const RIPPLE = '.btn, .quick, .rise-tile, .menu-item, .stock-card, .chip-btn, .filter-chip, .bottom-nav button, .news-item';

function installGlobalMotion(): () => void {
  if (reduceMotion() || typeof IntersectionObserver === 'undefined') return () => undefined;
  const root = document.documentElement;
  root.classList.add('reveal-ready');
  let batch = 0;
  let batchTimer: ReturnType<typeof setTimeout> | null = null;
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const el = e.target as HTMLElement;
        // elements arriving together come in one after another
        el.style.setProperty('--rd', `${Math.min(batch, 8) * 55}ms`);
        batch++;
        el.classList.add('in');
        io.unobserve(el);
      }
      if (batchTimer) clearTimeout(batchTimer);
      batchTimer = setTimeout(() => (batch = 0), 120);
    },
    { rootMargin: '0px 0px -6% 0px', threshold: 0.06 },
  );
  const scan = (node: ParentNode) => {
    node.querySelectorAll?.(REVEAL).forEach((el) => {
      if (!el.classList.contains('in') && !(el as HTMLElement).dataset.rv) {
        (el as HTMLElement).dataset.rv = '1';
        io.observe(el);
      }
    });
  };
  scan(document);
  const mo = new MutationObserver((muts) => {
    for (const m of muts) m.addedNodes.forEach((n) => n.nodeType === 1 && (scan(n as Element), (n as Element).matches?.(REVEAL) && scan(n.parentNode ?? document)));
  });
  mo.observe(document.body, { childList: true, subtree: true });
  // safety net: anything on screen is shown even if the observer missed it (some phones' web views)
  const failsafe = () => {
    document.querySelectorAll('[data-rv]:not(.in)').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.top < innerHeight && r.bottom > 0) el.classList.add('in');
    });
  };
  addEventListener('scroll', failsafe, { passive: true, capture: true });
  const failTimer = setInterval(failsafe, 1200);

  // tap ripple
  const onDown = (e: PointerEvent) => {
    const el = (e.target as Element | null)?.closest?.(RIPPLE) as HTMLElement | null;
    if (!el || (el as HTMLButtonElement).disabled) return;
    const r = el.getBoundingClientRect();
    const size = Math.max(r.width, r.height) * 2;
    const dot = document.createElement('span');
    dot.className = 'ripple';
    dot.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    el.style.overflow = 'hidden';
    el.appendChild(dot);
    setTimeout(() => dot.remove(), 650);
  };
  // tilt + light glare that follows the finger / mouse ([data-tilt])
  const onMove = (e: PointerEvent) => {
    const el = (e.target as Element | null)?.closest?.('[data-tilt]') as HTMLElement | null;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    el.style.setProperty('--ry', `${(x - 0.5) * 10}deg`);
    el.style.setProperty('--rx', `${(0.5 - y) * 8}deg`);
    el.style.setProperty('--gx', `${x * 100}%`);
    el.style.setProperty('--gy', `${y * 100}%`);
    el.classList.add('tilting');
  };
  const onLeave = (e: PointerEvent) => {
    const el = (e.target as Element | null)?.closest?.('[data-tilt]') as HTMLElement | null;
    if (!el) return;
    el.classList.remove('tilting');
    el.style.setProperty('--rx', '0deg');
    el.style.setProperty('--ry', '0deg');
  };
  document.addEventListener('pointerdown', onDown, { passive: true });
  document.addEventListener('pointermove', onMove, { passive: true });
  document.addEventListener('pointerup', onLeave, { passive: true });
  document.addEventListener('pointerout', onLeave, { passive: true });
  return () => {
    clearInterval(failTimer);
    removeEventListener('scroll', failsafe, { capture: true });
    io.disconnect();
    mo.disconnect();
    document.removeEventListener('pointerdown', onDown);
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onLeave);
    document.removeEventListener('pointerout', onLeave);
  };
}

/** A ring that fills to a chance (0–1), drawn on mount. */
export function ChanceRing({ value, size = 54 }: { value: number; size?: number }) {
  const pct = Math.round(value * 100);
  const tone = value >= 0.55 ? 'hi' : value >= 0.45 ? 'mid' : 'lo';
  return (
    <span class={`ring ${tone}`} style={{ width: `${size}px`, height: `${size}px` }} title={`${pct}% chance`}>
      <svg viewBox="0 0 36 36" width={size} height={size} aria-hidden="true">
        <circle cx="18" cy="18" r="15.5" class="ring-bg" />
        <circle cx="18" cy="18" r="15.5" class="ring-fg" pathLength={100} style={{ '--p': pct }} />
      </svg>
      <b>{pct}%</b>
    </span>
  );
}

/** A bar that shows how much of the waiting orders are buys (green) vs sells (red). */
export function BuyersBar({ share }: { share: number | null }) {
  if (share === null) return null;
  const pct = Math.round(share * 100);
  return (
    <span class="buyers-bar" title={`${pct}% of waiting orders are buys`}>
      <span class="buy" style={{ width: `${pct}%` }} />
    </span>
  );
}

export function MotionHost() {
  const [burst, setBurst] = useState(0);
  useEffect(() => installGlobalMotion(), []);
  const [toasts, setToasts] = useState<Array<{ id: number; text: string; tone: string }>>([]);
  useEffect(() => {
    const onC = () => {
      if (reduceMotion()) return;
      setBurst((b) => b + 1);
      setTimeout(() => setBurst(0), 1600);
    };
    const onT = (e: Event) => {
      const d = (e as CustomEvent<{ text: string; tone: string }>).detail;
      const id = Date.now() + Math.random();
      setToasts((t) => [...t.slice(-2), { id, ...d }]);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
    };
    window.addEventListener(CELEBRATE, onC);
    window.addEventListener(TOAST, onT);
    return () => {
      window.removeEventListener(CELEBRATE, onC);
      window.removeEventListener(TOAST, onT);
    };
  }, []);
  return (
    <>
      {burst > 0 && (
        <div class="confetti" key={burst} aria-hidden="true">
          {Array.from({ length: 28 }, (_, i) => (
            <i style={{ '--x': `${(Math.random() - 0.5) * 320}px`, '--y': `${-120 - Math.random() * 260}px`, '--r': `${Math.random() * 540}deg`, '--d': `${Math.random() * 120}ms`, background: COLORS[i % COLORS.length] }} />
          ))}
        </div>
      )}
      <div class="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div class={`toast ${t.tone}`} key={t.id}>
            {t.tone === 'ok' ? '✓ ' : t.tone === 'err' ? '! ' : ''}
            {t.text}
          </div>
        ))}
      </div>
    </>
  );
}
