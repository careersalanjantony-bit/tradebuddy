import { getSettings, onLocalChanged } from '../storage/local';
import type { ThemePref } from '../storage/schema';

export function applyTheme(pref: ThemePref): void {
  const root = document.documentElement;
  if (pref === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', pref);
}

/** Applies the stored theme and follows changes made in Settings (any open page). */
export function initTheme(): void {
  void getSettings().then((s) => applyTheme(s.ui.theme));
  onLocalChanged('settings', (s) => s?.ui?.theme && applyTheme(s.ui.theme));
}
