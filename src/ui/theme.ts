import { getSettings, onLocalChanged, updateSettings } from '../storage/local';
import type { ThemePref } from '../storage/schema';
import { isNative } from '../platform/http';

/** Dark clock and battery icons on the light look, light ones on the dark look (Android status bar). */
async function syncSystemBars(): Promise<void> {
  if (!isNative()) return;
  const attr = document.documentElement.getAttribute('data-theme');
  const dark = attr === 'dark' || (attr === null && matchMedia('(prefers-color-scheme: dark)').matches);
  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    await StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light });
  } catch {
    /* an older phone without the plugin: keep the default */
  }
}

export function applyTheme(pref: ThemePref): void {
  const root = document.documentElement;
  if (pref === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', pref);
  void syncSystemBars();
}

/** The new look (DESIGN.md) is light; phones that were switched to dark by the old look start on light once. */
const LOOK_KEY = 'tb-look-2';

function firstTimeWithNewLook(): boolean {
  try {
    if (localStorage.getItem(LOOK_KEY)) return false;
    localStorage.setItem(LOOK_KEY, '1');
    return true;
  } catch {
    return false;
  }
}

/** Applies the stored theme and follows changes made in Settings (any open page). */
export async function initTheme(): Promise<void> {
  let pref = (await getSettings()).ui.theme;
  if (pref === 'dark' && firstTimeWithNewLook()) {
    pref = 'light';
    await updateSettings({ ui: { theme: 'light' } }).catch(() => undefined);
  }
  applyTheme(pref);
  onLocalChanged('settings', (s) => s?.ui?.theme && applyTheme(s.ui.theme));
  // "follow the phone": the icons switch when the phone's own light / dark setting changes
  if (typeof matchMedia !== 'undefined') matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => void syncSystemBars());
}
