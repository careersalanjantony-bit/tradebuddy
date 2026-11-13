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

export function MotionHost() {
  const [burst, setBurst] = useState(0);
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
