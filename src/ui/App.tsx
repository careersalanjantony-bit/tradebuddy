import type { ComponentChildren } from 'preact';
import { useEffect } from 'preact/hooks';
import { callBackground } from '../shared/messages';
import { Disclaimer } from './components/Disclaimer';
import { LoginBanner } from './components/LoginBanner';
import { StatusBar } from './components/StatusBar';
import { TradeSheetHost } from './components/TradeSheet';
import { useHashRoute, useSessionValue, useSettings } from './hooks';
import { AlertsScreen } from './screens/Alerts';
import { DiagnosticsScreen } from './screens/Diagnostics';
import { PlannerScreen } from './screens/Planner';
import { SettingsScreen } from './screens/Settings';
import { ShortlistScreen } from './screens/Shortlist';
import { StockScreen } from './screens/Stock';
import { WatchlistScreen } from './screens/Watchlist';
import { TodayScreen } from './screens/Today';
import { DayTradeScreen } from './screens/DayTrade';
import { PracticeScreen } from './screens/Practice';
import { GuideOverlay, GuideScreen } from './screens/Guide';
import { MoreScreen } from './screens/More';
import { LearningScreen } from './screens/Learning';

/** Every screen. `main` ones are in the bottom bar on a phone; the rest are under "More". */
const SCREENS = [
  { id: 'today', label: 'Home', icon: '⌂', main: true },
  { id: 'daytrade', label: 'Day trade', icon: '⚡', main: true },
  { id: 'practice', label: 'Practice', icon: '₹', main: true },
  { id: 'watchlist', label: 'Stocks', icon: '☰', main: true },
  { id: 'more', label: 'More', icon: '⋯', main: true },
  { id: 'alerts', label: 'Trades & alerts', icon: '🔔', main: false },
  { id: 'learning', label: 'Self-learning', icon: '🧠', main: false },
  { id: 'guide', label: 'Guide', icon: '?', main: false },
  { id: 'settings', label: 'Settings', icon: '⚙', main: false },
  { id: 'diagnostics', label: 'Diagnostics', icon: '🛠', main: false },
  { id: 'shortlist', label: 'Shortlist', icon: '', main: false },
  { id: 'stock', label: 'Stock', icon: '', main: false },
  { id: 'planner', label: 'Planner', icon: '', main: false },
] as const;

export type ScreenId = (typeof SCREENS)[number]['id'];
export type Go = (screen: ScreenId, param?: string | null) => void;
const IDS = SCREENS.map((s) => s.id) as readonly ScreenId[];
const MORE_IDS: ScreenId[] = ['more', 'alerts', 'learning', 'guide', 'settings', 'diagnostics', 'shortlist', 'planner'];

export function App() {
  const [route, param, go] = useHashRoute(IDS, 'today');
  const unread = useSessionValue('alertsUnread') ?? 0;
  const settings = useSettings();
  const simple = (settings?.ui.mode ?? 'simple') === 'simple';
  // While the app is open: prices about every 2 seconds in market hours (instant when the live feed is on).
  useEffect(() => {
    void callBackground('quotes:auto').catch(() => undefined);
    const t = setInterval(() => void callBackground('quotes:fast').catch(() => undefined), 2_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [route, param]);

  let content: ComponentChildren;
  switch (route) {
    case 'today':
      content = <TodayScreen go={go} />;
      break;
    case 'daytrade':
      content = <DayTradeScreen go={go} />;
      break;
    case 'practice':
      content = <PracticeScreen go={go} />;
      break;
    case 'watchlist':
      content = <WatchlistScreen go={go} />;
      break;
    case 'more':
      content = <MoreScreen go={go} unread={unread} simple={simple} />;
      break;
    case 'learning':
      content = <LearningScreen go={go} />;
      break;
    case 'guide':
      content = <GuideScreen go={go} />;
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
    case 'settings':
      content = <SettingsScreen />;
      break;
    default:
      content = <DiagnosticsScreen />;
  }
  const activeMain = MORE_IDS.includes(route) ? 'more' : route === 'stock' ? 'watchlist' : route;
  const sideItems = SCREENS.filter((s) => s.id !== 'more' && s.icon && !(simple && (s.id === 'diagnostics') && route !== s.id));

  return (
    <div class="app">
      <aside class="side-nav" aria-label="Screens">
        <div class="brand">
          <span class="logo">▲</span> TradeBuddy
        </div>
        {sideItems.map((s) => (
          <button type="button" aria-current={route === s.id ? 'page' : undefined} onClick={() => go(s.id)}>
            <span class="ic">{s.icon}</span> {s.label}
            {s.id === 'alerts' && unread > 0 && <span class="count">{unread}</span>}
          </button>
        ))}
      </aside>
      <div class="content">
        <StatusBar />
        {route !== 'settings' && route !== 'today' && route !== 'practice' && route !== 'guide' && route !== 'more' && <LoginBanner onOpenSettings={() => go('settings')} />}
        <main>{content}</main>
        <Disclaimer />
      </div>
      <nav class="bottom-nav" aria-label="Main screens">
        {SCREENS.filter((s) => s.main).map((s) => (
          <button type="button" data-nav={s.id} aria-current={activeMain === s.id ? 'page' : undefined} onClick={() => go(s.id)}>
            <span class="ic">{s.icon}</span>
            <span class="lbl">{s.label}</span>
            {s.id === 'more' && unread > 0 && <span class="count">{unread}</span>}
          </button>
        ))}
      </nav>
      <TradeSheetHost />
      {settings && !settings.ui.guideSeen && <GuideOverlay go={go} />}
    </div>
  );
}
