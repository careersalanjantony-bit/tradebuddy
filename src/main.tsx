import './ui/styles.css';
import { fireStartupEvents, installChromeShim, storageReady } from './platform/chromeShim';

declare const __APP_VERSION__: string;

/**
 * App start-up. Order matters: the platform layer first (storage, messages, alarms), then the
 * background part (data, alerts, signals), then the screens.
 */
installChromeShim(__APP_VERSION__);

async function boot(): Promise<void> {
  await storageReady;
  const { initNative } = await import('./platform/nativeBindings');
  await import('./background/index');
  await fireStartupEvents(__APP_VERSION__);
  await initNative(() => {
    // back in front: catch up on prices, alerts and signals at once
    void chrome.runtime.sendMessage({ __swing: true, type: 'quotes:auto', payload: undefined });
  });
  const { startUi } = await import('./ui/main');
  startUi();
}

boot().catch((err: unknown) => {
  console.error(err);
  const el = document.getElementById('app');
  if (el) el.innerHTML = `<div style="padding:24px;font-family:sans-serif"><h2>TradeBuddy could not start</h2><pre style="white-space:pre-wrap">${String(err instanceof Error ? err.stack ?? err.message : err).replace(/</g, '&lt;')}</pre></div>`;
});
