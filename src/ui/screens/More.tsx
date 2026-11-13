import type { Go, ScreenId } from '../App';
import { Icon, type IconName } from '../components/Icon';

const ITEMS: Array<{ id: ScreenId; icon: IconName; label: string; about: string; expert?: boolean }> = [
  { id: 'swing', icon: 'calendar', label: 'Hold a few days', about: 'Top picks to keep for days or weeks, with their past record' },
  { id: 'alerts', icon: 'bell', label: 'Trades & alerts', about: 'Your real Upstox trades and price alerts' },
  { id: 'learning', icon: 'brain', label: 'Self-learning', about: 'How sure the app is, checked on days it never saw' },
  { id: 'guide', icon: 'help', label: 'Guide', about: 'The basics: practice money, day trades, ideas' },
  { id: 'settings', icon: 'gear', label: 'Settings', about: 'Upstox connection, your amount, alerts, look' },
  { id: 'diagnostics', icon: 'tool', label: 'Diagnostics', about: 'Connection checks and logs' },
  { id: 'shortlist', icon: 'list', label: 'Shortlist', about: 'Expert screen: the evening scan', expert: true },
  { id: 'planner', icon: 'chart', label: 'Planner', about: 'Expert screen: plan a trade by hand', expert: true },
];

/** "More" on a phone: everything that is not in the bottom bar. */
export function MoreScreen({ go, unread, simple }: { go: Go; unread: number; simple: boolean }) {
  return (
    <div class="screen" data-testid="more">
      <section class="card menu">
        {ITEMS.filter((i) => !(simple && i.expert)).map((i) => (
          <button type="button" class="menu-item" data-go={i.id} onClick={() => go(i.id)}>
            <span class="ic">
              <Icon name={i.icon} />
            </span>
            <span class="txt">
              <b>{i.label}</b>
              {i.id === 'alerts' && unread > 0 && <span class="count">{unread}</span>}
              <span class="small muted">{i.about}</span>
            </span>
            <span class="chev">
              <Icon name="chevron" size={18} />
            </span>
          </button>
        ))}
      </section>
    </div>
  );
}
