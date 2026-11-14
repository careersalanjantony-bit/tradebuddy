import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { callBackground } from '../shared/messages';
import { Disclaimer } from './components/Disclaimer';
import { LoginBanner } from './components/LoginBanner';
import { StatusBar } from './components/StatusBar';
import { TradeSheetHost } from './components/TradeSheet';
import { useHashRoute, useLocal, useSessionValue, useSettings } from './hooks';
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
import { HomeScreen } from './screens/Home';
import { Icon, type IconName } from './components/Icon';
import { MotionHost, buzz, celebrate, toast } from './components/Motion';
import { AlertBanner, routeForAlert } from './components/AlertBanner';
import { NewsScreen } from './screens/News';
import { AccountScreen } from './screens/Account';
import { LockScreen, ProfileSetup } from './components/Lock';
import { lockDue } from '../account/account';
import { scrollMemory } from './persist';

/** Every screen. `main` ones are in the bottom bar on a phone; the rest are under "More". */
const SCREENS = [
  { id: 'today', label: 'Home', icon: 'home', main: true },
  { id: 'daytrade', label: 'Day trade', icon: 'bolt', main: true },
  { id: 'practice', label: 'Practice', icon: 'wallet', main: true },
  { id: 'watchlist', label: 'Stocks', icon: 'list', main: true },
  { id: 'news', label: 'News', icon: 'news', main: true },
  { id: 'account', label: 'Me', icon: 'user', main: true },
  { id: 'more', label: 'More', icon: 'more', main: false },
  { id: 'swing', label: 'Hold a few days', icon: 'calendar', main: false },
  { id: 'alerts', label: 'Trades & alerts', icon: 'bell', main: false },
  { id: 'learning', label: 'Self-learning', icon: 'brain', main: false },
  { id: 'guide', label: 'Guide', icon: 'help', main: false },
  { id: 'settings', label: 'Settings', icon: 'gear', main: false },
  { id: 'diagnostics', label: 'Diagnostics', icon: 'tool', main: false },
  { id: 'shortlist', label: 'Shortlist', icon: '', main: false },
  { id: 'stock', label: 'Stock', icon: '', main: false },
  { id: 'planner', label: 'Planner', icon: '', main: false },
] as const;

export type ScreenId = (typeof SCREENS)[number]['id'];
export type Go = (screen: ScreenId, param?: string | null) => void;
const IDS = SCREENS.map((s) => s.id) as readonly ScreenId[];
const MAIN = SCREENS.filter((s) => s.main);
const MORE_IDS: ScreenId[] = ['account', 'more', 'alerts', 'learning', 'guide', 'settings', 'diagnostics', 'shortlist', 'planner'];
const HOME_IDS: ScreenId[] = ['today', 'swing'];

/** Scrolls back to `y` as soon as the page is tall enough (the list may still be loading); stops if you touch the screen. */
// the app restores scroll positions itself; the browser's own restore on Back would fight it
if (typeof history !== 'undefined' && 'scrollRestoration' in history) history.scrollRestoration = 'manual';

function restoreScroll(y: number): () => void {
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  // any touch, click, wheel or key means you are using the screen: stop pulling the page
  const events = ['touchstart', 'pointerdown', 'wheel', 'keydown'] as const;
  for (const ev of events) window.addEventListener(ev, stop, { passive: true, once: true });
  const start = performance.now();
  const step = () => {
    if (stopped) return;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo(0, Math.min(y, Math.max(0, max)));
    if (max >= y - 2 && Math.abs(window.scrollY - y) < 3) return;
    if (performance.now() - start < 8000) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  return () => {
    stopped = true;
    for (const ev of events) window.removeEventListener(ev, stop);
  };
}

export function App() {
  // each screen's scroll position is saved the moment you leave it (before the next screen is drawn)
  const [route, param, go] = useHashRoute(IDS, 'today', (from) => scrollMemory.set(from, window.scrollY));
  const unread = useSessionValue('alertsUnread') ?? 0;
  const settings = useSettings();
  // the app's own login: PIN / fingerprint lock (app v1.3)
  const account = useLocal('account');
  const [unlocked, setUnlocked] = useState(false);
  useEffect(() => {
    let leftAt: number | null = null;
    const onVis = () => {
      if (document.visibilityState === 'hidden') leftAt = Date.now();
      else if (lockDue(accountRef.current, leftAt, Date.now())) setUnlocked(false);
    };
    const onLock = () => setUnlocked(false);
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('tb-lock', onLock);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('tb-lock', onLock);
    };
  }, []);
  const accountRef = useRef(account);
  accountRef.current = account;
  const simple = (settings?.ui.mode ?? 'simple') === 'simple';
  // While the app is open: prices about every 2 seconds in market hours (instant when the live feed is on).
  useEffect(() => {
    void callBackground('quotes:auto').catch(() => undefined);
    const t = setInterval(() => void callBackground('quotes:fast').catch(() => undefined), 2_000);
    return () => clearInterval(t);
  }, []);
  // App v1.7 (owner: "when I open a stock and return to the stock list, keep the scroll position"):
  // each screen's scroll position is remembered; coming back from a stock page restores it, any
  // other move starts at the top.
  const prevRoute = useRef<string | null>(null);
  useEffect(() => {
    const from = prevRoute.current;
    prevRoute.current = route;
    const saved = scrollMemory.get(route);
    if ((from === 'stock' || from === 'planner') && route !== 'stock' && saved && saved > 0) return restoreScroll(saved);
    window.scrollTo(0, 0);
    return undefined;
  }, [route, param]);
  // app v1.9: tapping a notification opens the screen it belongs to (e.g. a breakout → Day trade)
  const goRef = useRef(go);
  goRef.current = go;
  useEffect(() => {
    const onClick = (id: string) => goRef.current(routeForAlert(id) as ScreenId);
    chrome.notifications.onClicked.addListener(onClick);
    return () => chrome.notifications.onClicked.removeListener(onClick);
  }, []);
  // a practice sale with a profit: a little celebration (and a toast for any sale)
  const wallet = useLocal('wallet');
  const seenFills = useRef<number | null>(null);
  useEffect(() => {
    const fills = wallet?.fills ?? [];
    if (seenFills.current === null) {
      seenFills.current = fills.length;
      return;
    }
    const fresh = fills.slice(seenFills.current);
    seenFills.current = fills.length;
    for (const f of fresh) {
      if (f.side !== 'sell' || f.pnl === undefined) continue;
      if (f.pnl > 0) {
        celebrate();
        void buzz('success');
        toast(`Profit +₹${Math.round(f.pnl).toLocaleString('en-IN')} on ${f.symbol}`);
      } else toast(`Sold ${f.symbol}: −₹${Math.abs(Math.round(f.pnl)).toLocaleString('en-IN')}`, 'info');
    }
  }, [wallet?.fills.length]);

  let content: ComponentChildren;
  switch (route) {
    case 'today':
      content = <HomeScreen go={go} />;
      break;
    case 'swing':
      content = <TodayScreen go={go} />;
      break;
    case 'daytrade':
      content = <DayTradeScreen go={go} />;
      break;
    case 'practice':
      content = <PracticeScreen go={go} view={param} />;
      break;
    case 'watchlist':
      content = <WatchlistScreen go={go} />;
      break;
    case 'account':
      content = <AccountScreen go={go} unread={unread} />;
      break;
    case 'news':
      content = <NewsScreen go={go} />;
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
  const activeMain = MORE_IDS.includes(route) ? 'account' : HOME_IDS.includes(route) ? 'today' : route === 'stock' ? 'watchlist' : route;
  // pages slide in from the side of the tab you came from
  const tabIndex = MAIN.findIndex((s) => s.id === activeMain);
  const lastTab = useRef(tabIndex);
  const slide = tabIndex > lastTab.current ? 'from-right' : tabIndex < lastTab.current ? 'from-left' : '';
  useEffect(() => {
    lastTab.current = tabIndex;
    void buzz('light');
  }, [tabIndex]);
  const sideItems = SCREENS.filter((s) => s.id !== 'more' && s.icon && !(simple && (s.id === 'diagnostics') && route !== s.id));

  return (
    <div class={`app ${account?.pin && !unlocked ? 'locked' : ''}`}>
      <aside class="side-nav" aria-label="Screens">
        <div class="brand">
          <span class="logo">
            <Icon name="up" size={18} />
          </span>{' '}
          TradeBuddy
        </div>
        {sideItems.map((s) => (
          <button type="button" aria-current={route === s.id ? 'page' : undefined} onClick={() => go(s.id)}>
            <Icon name={s.icon as IconName} size={20} /> {s.label}
            {s.id === 'alerts' && unread > 0 && <span class="count">{unread}</span>}
          </button>
        ))}
      </aside>
      <div class="content">
        <StatusBar />
        {route !== 'settings' && route !== 'today' && route !== 'practice' && route !== 'guide' && route !== 'more' && route !== 'learning' && <LoginBanner onOpenSettings={() => go('settings')} />}
        <main key={`${route}/${param ?? ''}`} class={`page ${slide}`}>
          {content}
        </main>
        <Disclaimer />
      </div>
      <nav class="bottom-nav" aria-label="Main screens" style={{ '--tabs': MAIN.length, '--tab': Math.max(0, MAIN.findIndex((s) => s.id === activeMain)) }}>
        <span class="nav-pill" aria-hidden="true">
          <span class="pill-icon" key={activeMain}>
            <Icon name={(MAIN.find((s) => s.id === activeMain)?.icon ?? 'home') as IconName} size={26} />
          </span>
        </span>
        {MAIN.map((s) => (
          <button type="button" data-nav={s.id} aria-current={activeMain === s.id ? 'page' : undefined} onClick={() => go(s.id)}>
            <span class="ic">
              <Icon name={s.icon as IconName} size={22} />
            </span>
            <span class="lbl">{s.label}</span>
            {s.id === 'account' && unread > 0 && <span class="count">{unread}</span>}
          </button>
        ))}
      </nav>
      <TradeSheetHost />
      <MotionHost />
      <AlertBanner open={(id) => go(routeForAlert(id) as ScreenId)} />
      {settings && !settings.ui.guideSeen && <GuideOverlay go={go} />}
      {settings?.ui.guideSeen && account === null && <ProfileSetup onDone={() => setUnlocked(true)} />}
      {account?.pin && !unlocked && <LockScreen account={account} onUnlock={() => setUnlocked(true)} />}
    </div>
  );
}
