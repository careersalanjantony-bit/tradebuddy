import { summarisePractice } from '../../practice/practice';
import { formatDuration } from '../../lib/time';
import { useLocal, useMarketState, useNow, useSessionValue } from '../hooks';
import { formatDateTimeIST, formatINR, formatTimeIST } from '../../lib/format';

type Tone = 'ok' | 'warn' | 'err' | 'idle';

function Item({ label, value, tone, title }: { label: string; value: string; tone: Tone; title?: string }) {
  return (
    <span class="status-item" title={title}>
      <span class={`dot ${tone}`} aria-hidden="true" />
      {label} <b>{value}</b>
    </span>
  );
}

/** Always-visible status (spec §15). Feed, sync and P&L fill in with M2–M8. */
export function StatusBar() {
  const auth = useLocal('auth');
  const now = useNow(15_000);
  const market = useMarketState();
  const marketLive = market.phase === 'open' || market.phase === 'pre_open';

  let login: { value: string; tone: Tone; title: string };
  if (auth?.status === 'logged_in' && auth.expiresAt && now < auth.expiresAt) {
    const left = auth.expiresAt - now;
    login = {
      value: `logged in · ${formatDuration(left)} left`,
      tone: left < 60 * 60_000 ? 'warn' : 'ok',
      title: `Upstox session ends ${formatDateTimeIST(auth.expiresAt)} (daily at 03:30 IST)`,
    };
  } else if (auth?.status === 'expired' || (auth?.status === 'logged_in' && auth.expiresAt && now >= auth.expiresAt)) {
    login = { value: 'session ended', tone: 'err', title: 'Log in to Upstox again (side panel → Log in)' };
  } else {
    login = { value: 'not logged in', tone: marketLive ? 'warn' : 'idle', title: 'Log in to Upstox from the side panel' };
  }
  if (auth?.analytics?.status === 'valid' && login.tone !== 'ok') login.title += ' · Market data works via your Analytics Token';

  const lastPoll = useSessionValue('lastPoll');
  const feed = useSessionValue('feedStatus');
  const instant = !!feed?.connected && now - feed.lastTickAt < 15_000;
  const quotes = useSessionValue('quotes') ?? {};
  const plans = useLocal('plans') ?? [];
  let prices: { value: string; tone: Tone; title: string };
  if (!lastPoll) prices = { value: 'not loaded', tone: marketLive ? 'err' : 'idle', title: 'Prices load after you log in (or with an Analytics Token)' };
  else if (market.phase === 'open') {
    const fresh = lastPoll.ok && now - lastPoll.at < 90_000;
    prices = fresh
      ? instant
        ? { value: `instant ⚡ ${formatTimeIST(lastPoll.at)}`, tone: 'ok', title: 'Prices arrive the moment they change (Upstox live feed); alerts are checked on every update' }
        : { value: `live ${formatTimeIST(lastPoll.at)}`, tone: 'ok', title: 'Prices refresh every 2 s while this panel is open (4 s for lists over 500 stocks; every 30 s when it is closed); alerts are checked on every refresh' }
      : { value: lastPoll.ok ? `stale ${formatTimeIST(lastPoll.at)}` : 'not updating', tone: 'err', title: lastPoll.error ?? 'No fresh prices for over 90 s — alerts are paused until prices are fresh. Check the login and internet.' };
  } else prices = { value: `${formatTimeIST(lastPoll.at)}`, tone: 'idle', title: 'Market closed — last prices' };
  const openPlans = plans.filter((p) => p.status === 'open' && !p.practice);
  const hasPractice = plans.some((p) => p.practice && p.status !== 'cancelled');
  const practice = hasPractice ? summarisePractice(plans, (k) => quotes[k]?.ltp ?? null, null) : null;
  const pnl = openPlans.length
    ? openPlans.reduce((sum, p) => {
        const q = quotes[p.key];
        return q ? sum + (q.ltp - (p.fillPrice ?? p.entry)) * p.qty : sum;
      }, 0)
    : null;

  const marketTitle = [
    market.session.reason ? `${market.session.reason}.` : '',
    market.nextOpenAt ? `Next open: ${formatDateTimeIST(market.nextOpenAt)}.` : '',
    market.session.confirmed ? '' : 'Holiday list not loaded yet (log in or add an Analytics Token); weekday rules assumed.',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div class="statusbar" role="status">
      <Item label="Upstox" value={login.value} tone={login.tone} title={login.title} />
      <Item
        label="Market"
        value={`${market.label}${market.session.confirmed ? '' : '?'}`}
        tone={market.phase === 'open' ? 'ok' : market.phase === 'pre_open' ? 'warn' : 'idle'}
        title={marketTitle || undefined}
      />
      <Item label="Prices" value={prices.value} tone={prices.tone} title={prices.title} />
      {practice && (
        <Item
          label="Practice"
          value={`${practice.realised + practice.openPnl >= 0 ? '+' : ''}${formatINR(practice.realised + practice.openPnl, 0)}`}
          tone={practice.realised + practice.openPnl >= 0 ? 'ok' : 'err'}
          title="Pretend-money practice trades: finished (after charges) + open at the latest price"
        />
      )}
      {pnl !== null && <Item label="My trades" value={`${pnl >= 0 ? '+' : ''}${formatINR(pnl, 0)}`} tone={pnl >= 0 ? 'ok' : 'err'} title="Profit or loss right now on trades you marked as bought (before charges)" />}
    </div>
  );
}
