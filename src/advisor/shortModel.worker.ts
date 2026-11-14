/// <reference lib="webworker" />
import { trainShortModel } from './shortModel';
import type { Candle } from '../indicators/types';

/** Trains the short-selling model off the screen's thread, so scrolling stays smooth while it learns. */
self.onmessage = (e: MessageEvent<{ stocks: Array<{ key: string; candles: Candle[] }>; date: string; now: number }>) => {
  try {
    const m = trainShortModel(e.data.stocks, e.data.date, e.data.now);
    (self as unknown as Worker).postMessage({ ok: true, model: m });
  } catch (err) {
    (self as unknown as Worker).postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
