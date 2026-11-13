import { useEffect, useMemo, useState } from 'preact/hooks';
import { headlineSentiment, stockSentiment } from '../../data/sentiment';
import { formatNumberIN, formatPct, formatTimeIST } from '../../lib/format';
import { istDate } from '../../lib/time';
import { callBackground } from '../../shared/messages';
import type { NewsReason } from '../../background/newsJobs';
import type { Go } from '../App';
import { useInstrumentMap, useQuotes } from '../data';
import { useNow, useSessionValue } from '../hooks';
import { Icon } from '../components/Icon';
import { openTrade } from '../components/TradeSheet';

/**
 * News (app v1.2, owner: "stock news based on the rising stocks or high-chance-to-rise stocks, not
 * random news"). Only stocks that matter today, grouped, each with why it is here.
 */

const REASON_LABEL: Record<NewsReason, string> = { idea: 'Buy idea', rising: 'Rising now', pick: 'Top pick', holding: 'You hold (practice)', trade: 'You hold' };
const FILTERS: Array<{ id: 'all' | NewsReason; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'idea', label: 'Buy ideas' },
  { id: 'rising', label: 'Rising now' },
  { id: 'pick', label: 'Top picks' },
  { id: 'holding', label: 'My shares' },
];

export function NewsScreen({ go }: { go: Go }) {
  const news = useSessionValue('news');
  const signals = useSessionValue('daySignals');
  const flow = useSessionValue('flow');
  const quotes = useQuotes();
  const byKey = useInstrumentMap();
  const now = useNow(30_000);
  const [filter, setFilter] = useState<'all' | NewsReason>('all');
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
      if (now - i.at > 3 * 86_400_000) continue;
      const l = by.get(i.key) ?? [];
      l.push(i);
      by.set(i.key, l);
    }
    const order: NewsReason[] = ['idea', 'rising', 'pick', 'trade', 'holding'];
    return [...by.entries()]
      .map(([key, items]) => ({ key, items: items.sort((a, b) => b.at - a.at).slice(0, 4), reason: (reasons[key] ?? 'pick') as NewsReason, latest: Math.max(...items.map((x) => x.at)) }))
      .filter((g) => reasons[g.key])
      .sort((a, b) => order.indexOf(a.reason) - order.indexOf(b.reason) || b.latest - a.latest);
  }, [news, now]);
  const counts = (id: 'all' | NewsReason) => (id === 'all' ? groups.length : groups.filter((g) => g.reason === id || (id === 'holding' && g.reason === 'trade')).length);
  const shown = groups.filter((g) => filter === 'all' || g.reason === filter || (filter === 'holding' && g.reason === 'trade'));

  return (
    <div class="screen news-screen" data-testid="news-screen">
      <header class="page-head">
        <div>
          <h1>News</h1>
          <p class="small muted">Only for today's buy ideas, stocks rising now, top picks and your shares.</p>
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
          <b>{news ? 'No news for these stocks yet' : 'Loading news…'}</b>
          <p class="small muted">News follows today's buy ideas and rising stocks, so it fills up during market hours. It updates every 15 minutes.</p>
        </section>
      ) : (
        <div class="news-grid">
          {shown.map((g) => {
            const sym = byKey.get(g.key)?.trading_symbol ?? g.key;
            const q = quotes[g.key];
            const ch = q?.prevClose ? (q.ltp / q.prevClose - 1) * 100 : null;
            const mood = stockSentiment(g.items, now);
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
                  <div class={`mood-line ${mood.label}`}>{mood.label === 'good' ? '👍 Mostly good news today' : '👎 Mostly bad news today — be careful with a buy'}</div>
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
                  {g.reason === 'idea' && (
                    <button class="link-btn small" type="button" onClick={() => go('daytrade')}>
                      See the idea
                    </button>
                  )}
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
