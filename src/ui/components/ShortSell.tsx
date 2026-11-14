import { useMemo } from 'preact/hooks';
import { calibrate, historyPairs, shortSellList, type Calibration, type Pair, type ShortSellRow } from '../../advisor/shortSell';
import type { StockData } from '../../data/stockData';
import { stockSentiment } from '../../data/sentiment';
import { formatNumberIN, formatPct } from '../../lib/format';
import { errorMessage } from '../../lib/serialize';
import { callBackground } from '../../shared/messages';
import type { Go } from '../App';
import { useSessionValue } from '../hooks';
import { buzz, toast } from './Motion';

/**
 * Stocks → "For short selling" (app v1.6): stocks most likely to fall today, with the chance measured
 * on the past year of every stock in the list (not guessed).
 */

const pairCache = new Map<string, Pair[]>();
function pairsOf(key: string, d: StockData): Pair[] {
  const finished = d.candles.filter((c) => !c.partial);
  const id = `${key}:${finished.length}:${finished[finished.length - 1]?.date ?? ''}`;
  let p = pairCache.get(id);
  if (!p) {
    p = historyPairs(finished);
    pairCache.set(id, p);
  }
  return p;
}

export function ShortSellList({ keys, data, symbolOf, go }: { keys: string[]; data: Map<string, StockData>; symbolOf: (k: string) => string; go: Go }) {
  const news = useSessionValue('news');
  const ideas = useSessionValue('shortIdeas');
  const { rows, calLive, calNext } = useMemo(() => {
    const ready = keys.map((k) => ({ k, d: data.get(k) })).filter((x): x is { k: string; d: StockData } => !!x.d && x.d.candles.length > 60);
    const pairs = ready.flatMap((x) => pairsOf(x.k, x.d));
    const live: Calibration = calibrate(pairs, 'score');
    const next: Calibration = calibrate(pairs, 'base');
    const now = Date.now();
    const mood = (k: string) => {
      const s = stockSentiment((news?.items ?? []).filter((i) => i.key === k), now);
      return s ? (s.label === 'good' ? 1 : s.label === 'bad' ? -1 : 0) : 0;
    };
    const list = shortSellList(
      ready.map((x) => ({ key: x.k, symbol: symbolOf(x.k), candles: x.d.candles, ltp: x.d.quote?.ltp ?? null, news: mood(x.k) })),
      live,
      next,
    );
    return { rows: list, calLive: live, calNext: next };
  }, [keys.join(','), data, news]);
  const cal = rows[0]?.live === false ? calNext : calLive;
  const best = Math.max(0, ...cal.bins.filter((b) => b.n >= 30).map((b) => b.fell / b.n));
  const ideaOf = new Map((ideas?.ideas ?? []).map((i) => [i.key, i]));

  return (
    <section class="list" data-testid="short-sell-list">
      <div class="card short-sell-intro">
        <h2>
          <span class="down-arrow" aria-hidden="true">
            ▼
          </span>{' '}
          Stocks for short selling
        </h2>
        <p class="small" style={{ margin: '0 0 6px' }}>
          Sell first, buy back lower the same day. Ranked by how often <b>similar days in the past year</b> ended at least 0.3% below the opening price — measured on {cal.total.toLocaleString('en-IN')} past days of these stocks.
        </p>
        <p class="tiny muted" style={{ margin: 0 }} data-testid="short-sell-honest">
          Honest numbers: on an ordinary day {Math.round(cal.baseRate * 100)}% of stocks end that much below their open; the best setups here did so {Math.round(best * 100)}% of the time. No study can find stocks that fall 80–90% of the time — anyone showing that is guessing. Always use the safety net (buy back if it rises).
        </p>
      </div>
      {rows.length === 0 ? (
        <div class="card empty">{keys.length && !data.size ? 'Studying…' : 'No stock looks like a good sell-first trade right now (falling below its opening price with a weak trend).'}</div>
      ) : (
        rows.slice(0, 25).map((r, i) => <ShortSellCard r={r} rank={i + 1} idea={ideaOf.get(r.key)} go={go} key={r.key} />)
      )}
    </section>
  );
}

function ShortSellCard({ r, rank, idea, go }: { r: ShortSellRow; rank: number; idea: import('../../background/shortJobs').ShortIdea | undefined; go: Go }) {
  const pct = r.chance !== null ? Math.round(r.chance * 100) : null;
  const practice = async () => {
    if (!idea) return;
    try {
      const res = await callBackground('wallet:short', { key: idea.key, symbol: idea.symbol, qty: idea.plan.qty, stop: idea.plan.stop, t1: idea.plan.t1, t2: idea.plan.t2, source: 'For short selling' });
      void buzz('success');
      toast(`Sold ${idea.plan.qty} ${idea.symbol} first at ₹${formatNumberIN(res.price)} (practice)`);
    } catch (e) {
      toast(errorMessage(e), 'err');
    }
  };
  return (
    <div class="card short-sell-card" data-symbol={r.symbol} data-testid="short-sell-row">
      <div class="row">
        <span class="rank">#{rank}</span>
        <button type="button" class="link-btn sym" onClick={() => go('stock', r.key)}>
          {r.symbol}
        </button>
        {r.changePct !== null && <span class={`chg ${r.changePct < 0 ? 'err-text' : 'ok-text'}`}>{formatPct(r.changePct, 1)}</span>}
        <span class="spacer" />
        <span class="fall-chance" title="measured on similar past days">
          {pct !== null ? (
            <>
              <b>{pct}%</b>
              <span class="tiny">fell</span>
            </>
          ) : (
            <span class="tiny muted">few similar days</span>
          )}
        </span>
      </div>
      <div class="fall-bar" aria-hidden="true">
        <span style={{ width: `${pct ?? 0}%` }} />
      </div>
      <div class="tiny muted" style={{ margin: '4px 0' }}>
        {r.chance !== null ? `Fell ≥0.3% from the open on ${r.fellCount} of ${r.similar} similar past days (avg ${r.avgMove >= 0 ? '+' : ''}${r.avgMove.toFixed(2)}% open→close).` : 'Not enough similar past days to measure a chance.'} Score {r.score}/100{r.live ? '' : ' · for the next session'}.
      </div>
      <div class="reason-chips">
        {r.reasons.slice(0, 5).map((x) => (
          <span class="reason-pill">{x}</span>
        ))}
        {r.against.map((x) => (
          <span class="reason-pill against">⚠ {x}</span>
        ))}
      </div>
      {idea && (
        <div class="row small short-plan">
          <span class="grow">
            Plan (5-min study): sell <b>{idea.plan.qty}</b> at ₹{formatNumberIN(idea.plan.entry)}, buy back if it rises to <b class="err-text">₹{formatNumberIN(idea.plan.stop)}</b>, targets <b class="ok-text">₹{formatNumberIN(idea.plan.t1)}</b> / <b class="ok-text">₹{formatNumberIN(idea.plan.t2)}</b>
          </span>
          <button class="btn small sell" type="button" onClick={() => void practice()}>
            Practice
          </button>
        </div>
      )}
    </div>
  );
}
