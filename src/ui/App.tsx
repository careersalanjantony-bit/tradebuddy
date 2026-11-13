import type { ComponentChildren } from 'preact';
import { useEffect } from 'preact/hooks';
import { callBackground } from '../shared/messages';
import { Disclaimer } from './components/Disclaimer';
import { LoginBanner } from './components/LoginBanner';
import { StatusBar } from './components/StatusBar';
import { useHashRoute, useSessionValue, useSettings } from './hooks';
import { AlertsScreen } from './screens/Alerts';
import { DiagnosticsScreen } from './screens/Diagnostics';
import { Placeholder } from './screens/Placeholder';
import { PlannerScreen } from './screens/Planner';
import { SettingsScreen } from './screens/Settings';
import { ShortlistScreen } from './screens/Shortlist';
import { StockScreen } from './screens/Stock';
import { WatchlistScreen } from './screens/Watchlist';
import { TodayScreen } from './screens/Today';
import { DayTradeScreen } from './screens/DayTrade';

const SCREENS = [
  { id: 'today', label: 'Today', milestone: null },
  { id: 'daytrade', label: 'Day trade', milestone: null },
  { id: 'watchlist', label: 'Stocks', milestone: null },
  { id: 'shortlist', label: 'Shortlist', milestone: null },
  { id: 'stock', label: 'Stock', milestone: null },
  { id: 'planner', label: 'Planner', milestone: null },
  { id: 'alerts', label: 'Trades & alerts', milestone: null },
  { id: 'holdings', label: 'Holdings', milestone: 'M4' },
  { id: 'journal', label: 'Journal', milestone: 'M8' },
  { id: 'settings', label: 'Settings', milestone: null },
  { id: 'diagnostics', label: 'Diagnostics', milestone: null },
] as const;

export type ScreenId = (typeof SCREENS)[number]['id'];
export type Go = (screen: ScreenId, param?: string | null) => void;
const IDS = SCREENS.map((s) => s.id) as readonly ScreenId[];

export function App() {
  const [route, param, go] = useHashRoute(IDS, 'today');
  const unread = useSessionValue('alertsUnread') ?? 0;
  const simple = (useSettings()?.ui.mode ?? 'simple') === 'simple';
  // Opening the panel fetches prices at once when they are due (the background also does it every 30 s).
  useEffect(() => {
    void callBackground('quotes:auto').catch(() => undefined);
    // While this panel is open: prices every ~2 seconds in market hours (the background alone can only do 30 s).
    const t = setInterval(() => void callBackground('quotes:fast').catch(() => undefined), 2_000);
    return () => clearInterval(t);
  }, []);
  const EXPERT: ScreenId[] = ['shortlist', 'stock', 'planner'];
  let content: ComponentChildren;
  switch (route) {
    case 'today':
      content = <TodayScreen go={go} />;
      break;
    case 'daytrade':
      content = <DayTradeScreen go={go} />;
      break;
    case 'watchlist':
      content = <WatchlistScreen go={go} />;
      break;
    case 'shortlist':
      content = <ShortlistScreen go={go} />;
      break;
    case 'stock':
      content = <StockScreen keyParam={param} go={go} />;
      break;
    case 'planner':
      content = <PlannerScreen keyParam={param} go={go} />;
      break;
    case 'alerts':
      content = <AlertsScreen go={go} />;
      break;
    case 'holdings':
      content = <Placeholder title="Holdings" milestone="M4" about="Your Upstox holdings and positions (read-only) with P&L and linked plans." />;
      break;
    case 'journal':
      content = (
        <Placeholder
          title="Journal"
          milestone="M8"
          about="Paper trading, statistics and the weekly review. Your saved plans and their status are already under Trades & alerts."
        />
      );
      break;
    case 'settings':
      content = <SettingsScreen />;
      break;
    default:
      content = <DiagnosticsScreen />;
  }

  return (
    <div class="app">
      <StatusBar />
      <nav class="nav" aria-label="Screens">
        {SCREENS.filter((s) => !s.milestone && !(simple && EXPERT.includes(s.id) && route !== s.id)).map((s) => (
          <button
            type="button"
            aria-current={route === s.id ? 'page' : undefined}
            onClick={() => go(s.id, s.id === 'stock' || s.id === 'planner' ? param : null)}
            title={s.milestone ? `Arrives in ${s.milestone}` : undefined}
          >
            {s.label}
            {s.milestone && <span class="soon">{s.milestone}</span>}
            {s.id === 'alerts' && unread > 0 && <span class="count">{unread}</span>}
          </button>
        ))}
      </nav>
      {route !== 'settings' && route !== 'today' && <LoginBanner onOpenSettings={() => go('settings')} />}
      <main>{content}</main>
      <Disclaimer />
    </div>
  );
}
