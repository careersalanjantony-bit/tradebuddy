import { render } from 'preact';
import { createLogger } from '../lib/log';
import { initLogging } from '../lib/logSetup';
import { App } from './App';
import { initTheme } from './theme';

/** Starts the screens (after the app's background part is running). */
export function startUi(): void {
  initLogging('sidepanel');
  initTheme();
  createLogger('ui').info('App screens opened');
  render(<App />, document.getElementById('app')!);
}
