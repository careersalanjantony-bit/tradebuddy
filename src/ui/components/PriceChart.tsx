import { useEffect, useRef } from 'preact/hooks';
import { CandlestickSeries, createChart, HistogramSeries, LineSeries, LineStyle, type IChartApi } from 'lightweight-charts';
import { smaSeries } from '../../indicators/core';
import type { Level } from '../../indicators/levels';
import type { Candle } from '../../indicators/types';

export interface ChartLine {
  price: number;
  title: string;
  color: string;
}

const css = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

/**
 * Daily candles with SMA 20/50/200 and volume (spec §15 stock view). TradingView Lightweight Charts™,
 * Apache-2.0 — the built-in logo link is kept, as the licence asks.
 */
export function PriceChart({ candles, supports, resistances, lines }: { candles: Candle[]; supports: Level[]; resistances: Level[]; lines: ChartLine[] }) {
  const el = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!el.current || !candles.length) return;
    const fg = css('--fg', '#111827');
    const border = css('--border', '#e2e8f0');
    const bg = css('--surface', '#ffffff');
    const chart = createChart(el.current, {
      height: 300,
      width: el.current.clientWidth,
      layout: { background: { color: bg }, textColor: fg, fontSize: 11, attributionLogo: true },
      grid: { vertLines: { color: border }, horzLines: { color: border } },
      rightPriceScale: { borderColor: border },
      timeScale: { borderColor: border },
      localization: { locale: 'en-IN', priceFormatter: (p: number) => p.toLocaleString('en-IN', { maximumFractionDigits: 2 }) },
    });
    chartRef.current = chart;

    // DESIGN.md's mint for gains and red for losses
    const up = css('--ok', '#10b981');
    const down = css('--err', '#ef4444');
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: up,
      downColor: down,
      borderVisible: false,
      wickUpColor: up,
      wickDownColor: down,
    });
    candleSeries.setData(candles.map((c) => ({ time: c.date, open: c.open, high: c.high, low: c.low, close: c.close })));

    const vol = chart.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    vol.setData(candles.map((c) => ({ time: c.date, value: c.volume, color: c.close >= c.open ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)' })));

    const closes = candles.map((c) => c.close);
    for (const [n, color] of [
      [20, fg],
      [50, '#64748b'],
      [200, '#f59e0b'],
    ] as const) {
      const s = smaSeries(closes, n);
      const line = chart.addSeries(LineSeries, { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, title: `SMA${n}` });
      line.setData(candles.flatMap((c, i) => (s[i] === null ? [] : [{ time: c.date, value: s[i]! }])));
    }

    for (const l of supports) candleSeries.createPriceLine({ price: l.price, color: up, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false, title: 'S' });
    for (const l of resistances) candleSeries.createPriceLine({ price: l.price, color: down, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false, title: 'R' });
    for (const l of lines) candleSeries.createPriceLine({ price: l.price, color: l.color, lineStyle: LineStyle.Solid, lineWidth: 2, axisLabelVisible: true, title: l.title });

    const total = candles.length;
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, total - 180), to: total + 3 });

    const ro = new ResizeObserver(() => el.current && chart.applyOptions({ width: el.current.clientWidth }));
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [candles, supports, resistances, lines]);

  return (
    <div>
      <div ref={el} class="chart" data-testid="chart" />
      <p class="tiny muted">
        Lines: <span style={{ color: 'var(--fg)' }}>SMA20</span> · <span style={{ color: '#64748b' }}>SMA50</span> · <span style={{ color: '#f59e0b' }}>SMA200</span> · dashed green S = support, red R = resistance. Charts: TradingView Lightweight Charts™ — Copyright © TradingView, Inc.,{' '}
        <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">
          tradingview.com
        </a>
      </p>
    </div>
  );
}
