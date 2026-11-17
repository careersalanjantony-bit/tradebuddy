import { trainRise, type RiseModel, type RiseSample } from './momentum';

/**
 * Runs the learning in a Web Worker where there is one (the app), else right here (unit tests, very old
 * WebViews). Either way the result is the same model.
 */
export async function trainRiseAsync(samples: RiseSample[], now: number): Promise<RiseModel | null> {
  if (typeof Worker === 'undefined') return trainRise(samples, now);
  try {
    const worker = new Worker(new URL('./train.worker.ts', import.meta.url), { type: 'module' });
    try {
      return await new Promise<RiseModel | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('learning took too long')), 180_000);
        worker.onmessage = (e: MessageEvent<{ ok: boolean; model?: RiseModel | null; error?: string }>) => {
          clearTimeout(timer);
          if (e.data.ok) resolve(e.data.model ?? null);
          else reject(new Error(e.data.error ?? 'learning failed'));
        };
        worker.onerror = (e) => {
          clearTimeout(timer);
          reject(new Error(e.message || 'worker failed'));
        };
        worker.postMessage({ samples, now });
      });
    } finally {
      worker.terminate();
    }
  } catch {
    return trainRise(samples, now);
  }
}
