import type { Candle } from '../indicators/types';
import { trainShortModel, type ShortModel } from './shortModel';

/**
 * Runs the training in a Web Worker where there is one (the app), else right here (unit tests,
 * very old WebViews). Either way the result is the same model.
 */
export async function trainShortModelAsync(stocks: Array<{ key: string; candles: Candle[] }>, date: string, now: number): Promise<ShortModel | null> {
  if (typeof Worker === 'undefined') return trainShortModel(stocks, date, now);
  try {
    const worker = new Worker(new URL('./shortModel.worker.ts', import.meta.url), { type: 'module' });
    try {
      return await new Promise<ShortModel | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('training took too long')), 120_000);
        worker.onmessage = (e: MessageEvent<{ ok: boolean; model?: ShortModel | null; error?: string }>) => {
          clearTimeout(timer);
          if (e.data.ok) resolve(e.data.model ?? null);
          else reject(new Error(e.data.error ?? 'training failed'));
        };
        worker.onerror = (e) => {
          clearTimeout(timer);
          reject(new Error(e.message || 'worker failed'));
        };
        worker.postMessage({ stocks, date, now });
      });
    } finally {
      worker.terminate();
    }
  } catch {
    // no worker support: train here (a second or two)
    return trainShortModel(stocks, date, now);
  }
}
