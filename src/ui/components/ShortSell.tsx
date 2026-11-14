import { useMemo } from 'preact/hooks';
import { calibrate, historyPairs, shortSellList, type Calibration, type Pair, type ShortSellRow } from '../../advisor/shortSell';
import { stockChance } from '../../advisor/shortModel';
import type { StockData } from '../../data/stockData';
import { stockSentiment } from '../../data/sentiment';
import { formatPct } from '../../lib/format';
import { callBackground } from '../../shared/messages';
import type { Go } from '../App';
import { useLocal, useSessionValue } from '../hooks';
import { useNewsItems } from './NewsData';

/**
 * Stocks → "For short selling" (app v1.6, per-stock chance in v1.7): stocks most likely to fall today.
 * Each stock's chance comes from a model trained on a year of every listed stock's daily candles
 * (shortModel.ts); tapping a stock opens its full sell-first analysis.
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

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function ShortSellList({ keys, data, symbolOf, go }: { keys: string[]; data: Map<string, StockData>; symbolOf: (k: string) => string; go: Go }) {
  const newsItems = useNewsItems();
  const model = useLocal('shortModel');
  const breadth = useSessionValue('breadth');
  const { rows, cal } = useMemo(() => {
    const ready = keys.map((k) => ({ k, d: data.get(k) })).filter((x): x is { k: string; d: StockData } => !!x.d && x.d.candles.length > 60);
    const now = Date.now();
    const mood = (k: string) => {
      const s = stockSentiment(newsItems.filter((i) => i.key === k), now);
      return s ? (s.label === 'good' ? 1 : s.label === 'bad' ? -1 : 0) : 0;
    };
    // the old score bands, only until the per-stock model has been trained
    const pairs = model ? [] : ready.flatMap((x) => pairsOf(x.k, x.d));
    const live: Calibration = calibrate(pairs, 'score');
    const next: Calibration = calibrate(pairs, 'base');
    const list = shortSellList(
      ready.map((x) => ({ key: x.k, symbol: symbolOf(x.k), candles: x.d.candles, ltp: x.d.quote?.ltp ?? null, news: mood(x.k) })),
      live,
      next,
      model ? { chanceOf: (s) => stockChance(model, s.key, s.candles), minChance: model.baseRate } : undefined,
    );
    return { rows: list, cal: list[0]?.live === false ? next : live };
  }, [keys.join(','), data, newsItems, model]);
  const t = model?.test;
  const marketDown = breadth && breadth.declined > breadth.advanced * 1.25;

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
          Sell first, buy back lower the same day. Each stock has <b>its own chance</b> of ending at least 0.3% below its opening price{rows[0]?.live === false ? ' in the next session' : ' today'}, worked out from its own numbers (trend, RSI, volume, recent moves, volatility, opening gap, its own habit) by a model trained on {model ? `${model.samples.toLocaleString('en-IN')} past days of ${model.stocks} stocks` : 'the past year'}. Tap a stock for the full sell-first plan.
        </p>
        {model && t ? (
          <p class="tiny muted" style={{ margin: 0 }} data-testid="short-sell-honest">
            Checked on the newest {t.n.toLocaleString('en-IN')} days it never saw ({t.from} to {t.to}): the stocks it rated highest fell that much {pct(t.topRate)} of the time; an average day {pct(t.baseRate)}. No study can find stocks that fall 80–90% of the time — anyone showing that is guessing. Always use the safety net (buy back if it rises).
          </p>
        ) : (
          <p class="tiny muted" style={{ margin: 0 }} data-testid="short-sell-honest">
            {model ? '' : 'Studying the past year of every stock in the list (about a minute after the history has downloaded) — until then the chance is shared by similar setups. '}On an ordinary day about {pct(cal.baseRate || 0.4)} of stocks end that much below their open. No study can find stocks that fall 80–90% of the time — anyone showing that is guessing. Always use the safety net.
            {!model && (
              <>
                {' '}
                <button type="button" class="link-btn" onClick={() => void callBackground('shorts:model').catch(() => undefined)}>
                  Study now
                </button>
              </>
            )}
          </p>
        )}
        {marketDown && <p class="tiny" style={{ margin: '6px 0 0' }}>Most stocks are falling today ({breadth!.declined} down, {breadth!.advanced} up) — the wind is behind sell-first trades.</p>}
      </div>
      {rows.length === 0 ? (
        <div class="card empty">{keys.length && !data.size ? 'Studying…' : 'No stock looks like a good sell-first trade right now (falling below its opening price with a weak trend).'}</div>
      ) : (
        rows.slice(0, 25).map((r, i) => <ShortSellCard r={r} rank={i + 1} go={go} key={r.key} />)
      )}
    </section>
  );
}

function ShortSellCard({ r, rank, go }: { r: ShortSellRow; rank: number; go: Go }) {
  const chance = r.chance !== null ? Math.round(r.chance * 100) : null;
  const open = () => go('stock', `${r.key}~short`);
  return (
    <div
      class="card short-sell-card"
      data-symbol={r.symbol}
      data-testid="short-sell-row"
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter') open();
      }}
    >
      <div class="row">
        <span class="rank">#{rank}</span>
        <b class="sym">{r.symbol}</b>
        {r.changePct !== null && <span class={`chg ${r.changePct < 0 ? 'err-text' : 'ok-text'}`}>{formatPct(r.changePct, 1)}</span>}
        <span class="spacer" />
        <span class="fall-chance" title="its own chance from its own numbers">
          {chance !== null ? (
            <>
              <b data-testid="fall-chance">{chance}%</b>
              <span class="tiny">fall</span>
            </>
          ) : (
            <span class="tiny muted">few similar days</span>
          )}
        </span>
      </div>
      <div class="fall-bar" aria-hidden="true">
        <span style={{ width: `${chance ?? 0}%` }} />
      </div>
      <div class="tiny muted" style={{ margin: '4px 0' }}>
        {r.modelled
          ? `Its own past year: fell ≥0.3% from the open on ${r.ownFell} of ${r.ownDays} days. Setup score ${r.score}/100${r.live ? '' : ' · for the next session'}.`
          : r.chance !== null
            ? `Similar setups fell on ${r.fellCount} of ${r.similar} past days. Score ${r.score}/100${r.live ? '' : ' · for the next session'}.`
            : `Score ${r.score}/100.`}
      </div>
      <div class="reason-chips">
        {r.reasons.slice(0, 5).map((x) => (
          <span class="reason-pill">{x}</span>
        ))}
        {r.against.map((x) => (
          <span class="reason-pill against">⚠ {x}</span>
        ))}
      </div>
      <div class="row tiny open-analysis">
        <span class="spacer" />
        Full sell-first plan →
      </div>
    </div>
  );
}
