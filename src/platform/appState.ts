import { isNative } from './http';

/**
 * Is TradeBuddy on the screen right now? (app v1.9) On Android this follows the app's own
 * foreground / background state (the web page can stay "visible" while the app is in the background,
 * so the page's visibility is not used there); in a browser it is the tab's visibility.
 * While the app is on screen, alerts show inside the app with the chosen tone; otherwise Android shows
 * them as pop-up notifications with that tone.
 */
let active = true;

export function setAppActive(on: boolean): void {
  active = on;
}

export function appOnScreen(): boolean {
  if (typeof document === 'undefined') return false;
  if (isNative()) return active;
  return document.visibilityState === 'visible';
}
