import type { Go, ScreenId } from '../App';

const ITEMS: Array<{ id: ScreenId; icon: string; label: string; about: string; expert?: boolean }> = [
  { id: 'alerts', icon: '🔔', label: 'Trades & alerts', about: 'Your real Upstox trades, alerts and the safety-sell (GTT) steps' },
  { id: 'learning', icon: '🧠', label: 'Self-learning', about: 'What the app learned, and whether it passed its check on unseen days' },
  { id: 'guide', icon: '❓', label: 'Guide', about: 'The basics again: practice money, day trades, signals' },
  { id: 'settings', icon: '⚙️', label: 'Settings', about: 'Upstox connection, amount, alerts, appearance' },
  { id: 'diagnostics', icon: '🛠️', label: 'Diagnostics', about: 'Connection checks, logs and data health' },
  { id: 'shortlist', icon: '📋', label: 'Shortlist', about: 'Expert screen: the evening scan', expert: true },
  { id: 'planner', icon: '🧮', label: 'Planner', about: 'Expert screen: plan a trade by hand', expert: true },
];

/** "More" on a phone: everything that is not in the bottom bar. */
export function MoreScreen({ go, unread, simple }: { go: Go; unread: number; simple: boolean }) {
  return (
    <div class="screen" data-testid="more">
      <section class="card menu">
        {ITEMS.filter((i) => !(simple && i.expert)).map((i) => (
          <button type="button" class="menu-item" data-go={i.id} onClick={() => go(i.id)}>
            <span class="ic">{i.icon}</span>
            <span class="txt">
              <b>{i.label}</b>
              {i.id === 'alerts' && unread > 0 && <span class="count">{unread}</span>}
              <span class="small muted">{i.about}</span>
            </span>
            <span class="chev">›</span>
          </button>
        ))}
      </section>
    </div>
  );
}
