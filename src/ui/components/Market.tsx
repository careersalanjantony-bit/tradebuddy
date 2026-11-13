import { marketMood } from '../../advisor/mood';
import { headlines } from '../../data/news';
import { formatPct, formatTimeIST } from '../../lib/format';
import { istDate } from '../../lib/time';
import { callBackground } from '../../shared/messages';
import { updateSettings } from '../../storage/local';
import { useInstrumentMap, useQuotes, useStudyKeys } from '../data';
import { useLocal, useNow, useSessionValue, useSettings } from '../hooks';

const DIRECTION = { rising: '📈 rising', falling: '📉 falling', mixed: '↔ mixed', unknown: '—' } as const;

/** One line: is the market up or down today, and how nervous is it? (v0.12.0) */
export function MoodLine() {
  const quotes = useQuotes();
  const { universeKeys } = useStudyKeys();
  const watchlist = useLocal('watchlist') ?? [];
  const m = marketMood(quotes, universeKeys.length ? universeKeys : watchlist);
  if (m.direction === 'unknown' && m.nerves === 'unknown') return null;
  return (
    <div class={`banner ${m.caution ? 'warn' : 'info'} small`} data-testid="mood">
      <b>Market today: {DIRECTION[m.direction]}</b>
      {m.niftyPct !== null && <> · Nifty 50 {formatPct(m.niftyPct, 2)}</>}
      {m.total > 0 && (
        <>
          {' '}
          · {m.up} of {m.total} stocks up
        </>
      )}
      {m.nerves !== 'unknown' && (
        <>
          {' '}
          · nervousness: <b>{m.nerves}</b>
        </>
      )}
      {m.caution && <div>{m.caution}</div>}
    </div>
  );
}

/** A few headlines for the stocks that matter today. No analysis — just the headline, time and link. */
export function NewsCard({ limit = 6 }: { limit?: number }) {
  const news = useSessionValue('news');
  const byKey = useInstrumentMap();
  const now = useNow(60_000);
  const items = headlines(news?.items ?? [], limit);
  const today = istDate(now);
  return (
    <section class="card" data-testid="news">
      <div class="row">
        <h2 style={{ margin: 0 }}>News</h2>
        <span class="spacer" />
        <button class="link-btn small" type="button" onClick={() => void callBackground('news:refresh').catch(() => undefined)}>
          refresh
        </button>
      </div>
      {items.length === 0 ? (
        <p class="small muted" style={{ margin: 0 }}>
          {news?.error ? `News not available: ${news.error}` : 'No news in the last 3 days for your stocks and today’s picks.'}
        </p>
      ) : (
        <ul class="news-list small">
          {items.map((i) => (
            <li>
              <span class="muted">{istDate(i.at) === today ? formatTimeIST(i.at).slice(0, 5) : istDate(i.at).slice(5)}</span> <b>{byKey.get(i.key)?.trading_symbol ?? ''}</b>{' '}
              {i.link ? (
                <a href={i.link} target="_blank" rel="noreferrer">
                  {i.heading}
                </a>
              ) : (
                i.heading
              )}
            </li>
          ))}
        </ul>
      )}
      <p class="tiny muted" style={{ margin: '4px 0 0' }}>Headlines from Upstox for stocks you hold, today's signals and top picks. A stock in the news can move sharply either way.</p>
    </section>
  );
}

/** "Find my Upstox trades automatically": status and switch (v0.12.0). */
export function UpstoxSyncLine() {
  const settings = useSettings();
  const st = useSessionValue('portfolioStatus');
  const auth = useLocal('auth');
  if (!settings) return null;
  const on = settings.portfolio.autoSync;
  const loggedIn = auth?.status === 'logged_in';
  let text: string;
  if (!on) text = 'off — you record trades yourself.';
  else if (!loggedIn) text = 'waits for today’s Upstox login.';
  else if (!st) text = 'will check in a moment.';
  else if (!st.ok) text = `Upstox did not allow it: ${st.error ?? 'unknown reason'}. Record trades yourself for now.`;
  else text = `working — last checked ${formatTimeIST(st.at)}, ${st.positions} position${st.positions === 1 ? '' : 's'} today.`;
  return (
    <div class={`banner ${on && st && !st.ok ? 'warn' : 'info'} small`} data-testid="upstox-sync">
      <label class="row" style={{ gap: '6px' }}>
        <input type="checkbox" checked={on} data-testid="upstox-sync-toggle" onChange={(e) => void updateSettings({ portfolio: { autoSync: (e.currentTarget as HTMLInputElement).checked } })} />
        <span>
          <b>Find my Upstox trades automatically:</b> {text}
        </span>
      </label>
      {on && loggedIn && (
        <div>
          When you buy or sell in the Upstox app, the trade appears here by itself within about 10 seconds, with its alerts. The extension only reads — it never places an order.{' '}
          <button class="link-btn" type="button" data-testid="upstox-sync-now" onClick={() => void callBackground('portfolio:sync').catch(() => undefined)}>
            check now
          </button>
        </div>
      )}
    </div>
  );
}
