import { useEffect, useMemo, useState } from 'preact/hooks';
import { headlineSentiment, stockSentiment } from '../../data/sentiment';
import { formatNumberIN, formatPct, formatTimeIST } from '../../lib/format';
import { istDate } from '../../lib/time';
import { callBackground } from '../../shared/messages';
import type { NewsReason } from '../../background/newsJobs';
import type { Go } from '../App';
import { useInstrumentMap, useQuotes } from '../data';
import { useMarketState, useNow, useSessionValue } from '../hooks';
import { useNews } from '../components/NewsData';
import { usePersistentState } from '../persist';
import { Icon } from '../components/Icon';
import { openTrade } from '../components/TradeSheet';

/**
 * News (app v1.2, owner: "stock news based on the rising stocks or high-chance-to-rise stocks, not
 * random news"; v1.7: "show the recent and live news even when the market is down"). The stocks that
 * matter today first, then the rest of your list; kept on the phone, so it is never empty.
 */

const REASON_LABEL: Record<NewsReason, string> = {
  idea: 'Buy idea',
  rising: 'Rising now',
  falling: 'Falling now',
  pick: 'Top pick',
  holding: 'You hold (practice)',
  trade: 'You hold',
  mover: 'Big move',
  market: 'In your list',
};
type Filter = 'all' | 'idea' | 'rising' | 'falling' | 'pick' | 'holding' | 'market' | 'bad';
const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'idea', label: 'Buy ideas' },
  { id: 'rising', label: 'Rising now' },
  { id: 'falling', label: 'Falling now' },
  { id: 'pick', label: 'Top picks' },
  { id: 'holding', label: 'My shares' },
  { id: 'bad', label: '👎 Bad news' },
  { id: 'market', label: 'Market' },
];
const ORDER: NewsReason[] = ['idea', 'rising', 'falling', 'pick', 'trade', 'holding', 'mover', 'market'];

export function NewsScreen({ go }: { go: Go }) {
  const news = useNews();
  const signals = useSessionValue('daySignals');
  const flow = useSessionValue('flow');
  const quotes = useQuotes();
  const byKey = useInstrumentMap();
  const market = useMarketState();
  const now = useNow(30_000);
  const [filter, setFilter] = usePersistentState<Filter>('news.filter', 'all');
  const [spinning, setSpinning] = useState(false);
  const refresh = () => {
    setSpinning(true);
    void callBackground('news:refresh')
      .catch(() => undefined)
      .finally(() => setTimeout(() => setSpinning(false), 500));
  };
  useEffect(refresh, []);

  const today = istDate(now);
  const reasons = news?.targets ?? {};
  const groups = useMemo(() => {
    const by = new Map<string, Array<{ heading: string; link: string; at: number }>>();
    for (const i of news?.items ?? []) {
      if (now - i.at > 7 * 86_400_000) continue;
      const l = by.get(i.key) ?? [];
      l.push(i);
      by.set(i.key, l);
    }
    return [...by.entries()]
      .map(([key, items]) => {
        const sorted = items.sort((a, b) => b.at - a.at);
        return { key, items: sorted.slice(0, 4), more: Math.max(0, sorted.length - 4), reason: (reasons[key] ?? 'market') as NewsReason, latest: sorted[0]!.at, mood: stockSentiment(sorted, now, 72) };
      })
      .sort((a, b) => {
        const ra = ORDER.indexOf(a.reason) < ORDER.indexOf('mover') ? ORDER.indexOf(a.reason) : 50;
        const rb = ORDER.indexOf(b.reason) < ORDER.indexOf('mover') ? ORDER.indexOf(b.reason) : 50;
        return ra - rb || b.latest - a.latest;
      });
  }, [news, now]);
  const match = (g: (typeof groups)[number], id: Filter) =>
    id === 'all' || g.reason === id || (id === 'holding' && g.reason === 'trade') || (id === 'market' && (g.reason === 'mover' || g.reason === 'market')) || (id === 'bad' && g.mood?.label === 'bad');
  const counts = (id: Filter) => groups.filter((g) => match(g, id)).length;
  const shown = groups.filter((g) => match(g, filter));
  const open = market.phase === 'open';

  return (
    <div class="screen news-screen" data-testid="news-screen">
      <header class="page-head">
        <div>
          <h1>News</h1>
          <p class="small muted" data-testid="news-sub">
            {open ? (
              <>
                <span class="live-dot inline" /> <b>Live</b> — today's ideas, rising and falling stocks are checked every 2 minutes, the rest of your list every 15.
              </>
            ) : (
              'Market closed — the latest news from the past 7 days for your list, checked every 15 minutes.'
            )}
            {news?.at ? ` Updated ${istDate(news.at) === today ? formatTimeIST(news.at) : istDate(news.at)}.` : ''}
          </p>
          {!open && <p class="tiny muted" data-testid="news-closed-note">Buy ideas, rising and falling stocks show 0 while the market is closed. They fill in by themselves on market days — buy ideas from 9:35 am, rising and falling stocks from the open.</p>}
          {news?.error && <p class="tiny err-text">Latest download failed: {news.error}</p>}
        </div>
        <button class={`icon-btn ${spinning ? 'spin' : ''}`} type="button" aria-label="Refresh" data-testid="news-refresh" onClick={refresh}>
          <Icon name="refresh" />
        </button>
      </header>
      <div class="filter-chips" role="tablist">
        {FILTERS.map((f) => (
          <button type="button" class={`filter-chip ${filter === f.id ? 'on' : ''}`} data-filter={f.id} onClick={() => setFilter(f.id)}>
            {f.label} <span class="count-pill">{counts(f.id)}</span>
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <section class="empty-state">
          <svg viewBox="0 0 120 100" width="120" height="100" aria-hidden="true">
            <rect x="20" y="16" width="70" height="68" rx="10" class="es-paper" />
            <rect x="32" y="30" width="34" height="8" rx="4" class="es-line strong" />
            <rect x="32" y="46" width="46" height="6" rx="3" class="es-line" />
            <rect x="32" y="58" width="40" height="6" rx="3" class="es-line" />
            <circle cx="92" cy="26" r="9" class="es-dot" />
          </svg>
          <b>{news?.items.length ? 'No news in this group' : 'Loading news…'}</b>
          <p class="small muted">News comes for the stocks in your list (Upstox keeps the last 7 days). It updates every 15 minutes in market hours and every 45 minutes otherwise — log in to Upstox if it stays empty.</p>
        </section>
      ) : (
        <div class="news-grid">
          {shown.map((g) => {
            const sym = byKey.get(g.key)?.trading_symbol ?? g.key;
            const q = quotes[g.key];
            const ch = q?.prevClose ? (q.ltp / q.prevClose - 1) * 100 : null;
            const mood = g.mood;
            const sig = signals?.date === today ? signals.signals.find((s) => s.key === g.key) : undefined;
            const rise = flow?.rising.find((r) => r.key === g.key);
            return (
              <article class="news-item" data-symbol={sym} data-reason={g.reason}>
                <div class="row">
                  <b class="news-sym">{sym}</b>
                  <span class={`reason-chip ${g.reason}`}>
                    {REASON_LABEL[g.reason]}
                    {g.reason === 'idea' && sig?.chance !== undefined ? ` · ${Math.round(sig.chance * 100)}%` : ''}
                    {g.reason === 'rising' && rise ? ` · ${formatPct(rise.fromOpenPct, 1)}` : ''}
                  </span>
                  <span class="spacer" />
                  {q && (
                    <span class="small">
                      ₹{formatNumberIN(q.ltp)} <span class={ch !== null && ch >= 0 ? 'ok-text' : 'err-text'}>{formatPct(ch, 1)}</span>
                    </span>
                  )}
                </div>
                {mood && mood.label !== 'neutral' && (
                  <div class={`mood-line ${mood.label}`}>
                    {mood.label === 'good' ? '👍 Mostly good news — counts against selling first' : '👎 Mostly bad news — be careful with a buy; counts for selling first'}
                  </div>
                )}
                <ul class="headlines">
                  {g.items.map((i) => {
                    const m = headlineSentiment(i.heading).label;
                    return (
                      <li>
                        <span class="muted tiny">{istDate(i.at) === today ? formatTimeIST(i.at).slice(0, 5) : istDate(i.at).slice(5)}</span>
                        {m !== 'neutral' && <span data-mood={m}>{m === 'good' ? '👍' : '👎'}</span>}
                        {i.link ? (
                          <a href={i.link} target="_blank" rel="noreferrer">
                            {i.heading}
                          </a>
                        ) : (
                          <span>{i.heading}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
                <div class="row" style={{ gap: '8px' }}>
                  <button class="btn small" type="button" onClick={() => openTrade({ key: g.key, symbol: sym, side: 'buy', source: 'News' })}>
                    Practice buy
                  </button>
                  <button class="btn small" type="button" onClick={() => go('stock', mood?.label === 'bad' || g.reason === 'falling' ? `${g.key}~short` : g.key)}>
                    {mood?.label === 'bad' || g.reason === 'falling' ? 'Sell-first analysis' : 'Full analysis'}
                  </button>
                  {g.reason === 'idea' && (
                    <button class="link-btn small" type="button" onClick={() => go('daytrade')}>
                      See the idea
                    </button>
                  )}
                  {g.more > 0 && <span class="tiny muted">+{g.more} older</span>}
                </div>
              </article>
            );
          })}
        </div>
      )}
      <p class="tiny muted">Headlines from Upstox. 👍 / 👎 is a simple word check, not advice. By the time news is out, prices have often moved already.</p>
    </div>
  );
}
