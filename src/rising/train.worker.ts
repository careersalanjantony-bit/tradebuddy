/// <reference lib="webworker" />
import { trainRise, type RiseSample } from './momentum';

/** Learns the Rising-now model off the screen's thread, so scrolling stays smooth while it learns. */
self.onmessage = (e: MessageEvent<{ samples: RiseSample[]; now: number }>) => {
  try {
    const m = trainRise(e.data.samples, e.data.now);
    (self as unknown as Worker).postMessage({ ok: true, model: m });
  } catch (err) {
    (self as unknown as Worker).postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
