import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { isNative } from './http';
import { RELEASES_PAGE, type UpdateInfo } from '../update/update';

/**
 * The app's own Android plugin (android/app/src/main/java/in/tradebuddy/app/AppUpdaterPlugin.java):
 * download a newer TradeBuddy from its releases page, check it, and open Android's installer.
 * A small shared store keeps the progress so the Home banner and the Me tab show the same thing.
 */

interface AppUpdaterPlugin {
  download(o: { url: string; size: number; sha256: string }): Promise<{ versionName: string; versionCode: number; sha256: string; bytes: number }>;
  canInstall(): Promise<{ allowed: boolean; downloaded: boolean; downloadedVersion?: string }>;
  openInstallSettings(): Promise<void>;
  install(): Promise<void>;
  clear(): Promise<void>;
  addListener(event: 'downloadProgress', cb: (p: { done: number; total: number }) => void): Promise<PluginListenerHandle>;
}

const AppUpdater = registerPlugin<AppUpdaterPlugin>('AppUpdater');

export type UpdateStep =
  | { step: 'idle' }
  | { step: 'downloading'; version: string; pct: number }
  | { step: 'allow'; version: string }
  | { step: 'installing'; version: string }
  | { step: 'error'; version: string; message: string };

let state: UpdateStep = { step: 'idle' };
const subs = new Set<() => void>();
const set = (s: UpdateStep) => {
  state = s;
  subs.forEach((f) => f());
};
export const getUpdateStep = (): UpdateStep => state;
export function subscribeUpdateStep(f: () => void): () => void {
  subs.add(f);
  return () => subs.delete(f);
}

const plain = (e: unknown): string => {
  const m = e instanceof Error ? e.message : String(e);
  return /network|timeout|unable to resolve|failed to connect/i.test(m) ? 'No internet connection, or it is too slow. Try again on Wi-Fi.' : m;
};

/** "Update now": download → (one-time permission) → Android's "Update" screen. */
export async function startUpdate(info: UpdateInfo): Promise<void> {
  if (state.step === 'downloading' || state.step === 'installing') return;
  if (!isNative()) {
    // in a desktop browser there is nothing to install: show the releases page
    window.open(RELEASES_PAGE, '_blank', 'noopener');
    return;
  }
  // already downloaded (e.g. the app restarted after allowing installs): go straight to installing
  const have = await AppUpdater.canInstall().catch(() => null);
  if (have?.downloadedVersion === info.version) return continueInstall(info.version);
  set({ step: 'downloading', version: info.version, pct: 0 });
  let handle: PluginListenerHandle | undefined;
  try {
    handle = await AppUpdater.addListener('downloadProgress', (p) => {
      if (state.step === 'downloading') set({ step: 'downloading', version: info.version, pct: p.total > 0 ? Math.min(1, p.done / p.total) : 0 });
    });
    await AppUpdater.download({ url: info.apkUrl, size: info.size, sha256: info.sha256 });
  } catch (e) {
    set({ step: 'error', version: info.version, message: plain(e) });
    return;
  } finally {
    void handle?.remove();
  }
  await continueInstall(info.version);
}

/** After the download, or after the owner allowed installs in Android's settings. */
export async function continueInstall(version: string): Promise<void> {
  try {
    const { allowed, downloaded } = await AppUpdater.canInstall();
    if (!downloaded) {
      set({ step: 'error', version, message: 'The download is gone. Tap "Update now" again.' });
      return;
    }
    if (!allowed) {
      set({ step: 'allow', version });
      return;
    }
    set({ step: 'installing', version });
    await AppUpdater.install();
  } catch (e) {
    set({ step: 'error', version, message: plain(e) });
  }
}

export async function openInstallSettings(): Promise<void> {
  await AppUpdater.openInstallSettings();
}

/** Back from Android's settings page: carry on by itself if the switch is now on. */
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !isNative()) return;
    if (state.step === 'allow') {
      const v = state.version;
      void AppUpdater.canInstall()
        .then((r) => (r.allowed ? continueInstall(v) : undefined))
        .catch(() => undefined);
    } else if (state.step === 'installing') {
      // the installer was closed without updating: let the owner try again
      set({ step: 'idle' });
    }
  });
}

/** On start: remove a downloaded file that is no longer needed (already installed, or not the offered version). */
export async function cleanupDownloaded(offered: string | null): Promise<void> {
  if (!isNative()) return;
  try {
    const r = await AppUpdater.canInstall();
    if (r.downloaded && r.downloadedVersion !== offered) await AppUpdater.clear();
  } catch {
    /* older build without the plugin: nothing to clean */
  }
}

export function resetUpdateStep(): void {
  set({ step: 'idle' });
}
