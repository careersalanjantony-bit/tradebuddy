import { headlineSentiment, stockSentiment } from '../../data/sentiment';
import { formatTimeIST } from '../../lib/format';
import { istDate } from '../../lib/time';
import { useNewsItems } from './NewsData';

/**
 * App v1.7: one stock's headlines of the last 7 days with the news mood and what it means for a buy
 * or a sell-first trade (shown on the stock page, both views).
 */
export function StockNews({ stockKey, side, limit = 4, bare = false }: { stockKey: string; side: 'buy' | 'short'; limit?: number; bare?: boolean }) {
  const news = useNewsItems();
  const items = news.filter((i) => i.key === stockKey).sort((a, b) => b.at - a.at);
  const mood = stockSentiment(items, Date.now(), 72);
  const today = istDate(Date.now());
  const meaning =
    mood?.label === 'bad'
      ? side === 'buy'
        ? '👎 Mostly bad news — be careful with a buy'
        : '👎 Mostly bad news — supports selling first'
      : mood?.label === 'good'
        ? side === 'buy'
          ? '👍 Mostly good news — supports a buy (prices may have moved already)'
          : '👍 Mostly good news — selling first goes against it'
        : null;
  const body = (
    <>
      {items.length === 0 ? (
        <p class="small muted">No headlines in the last 7 days.</p>
      ) : (
        <>
          {meaning && <div class={`mood-line ${mood!.label}`}>{meaning}</div>}
          <ul class="headlines">
            {items.slice(0, limit).map((i) => {
              const m = headlineSentiment(i.heading).label;
              return (
                <li>
                  <span class="muted tiny">{istDate(i.at) === today ? formatTimeIST(i.at).slice(0, 5) : istDate(i.at).slice(5)}</span>
                  {m !== 'neutral' && <span>{m === 'good' ? '👍' : '👎'}</span>}
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
        </>
      )}
    </>
  );
  if (bare) return body;
  return (
    <section class="card" data-testid="stock-news">
      <h2>News</h2>
      {body}
      <p class="tiny muted" style={{ margin: '4px 0 0' }}>
        👍 / 👎 is a simple word check of the headlines, not advice.
      </p>
    </section>
  );
}
