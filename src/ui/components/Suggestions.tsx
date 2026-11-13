import { useMemo, useState } from 'preact/hooks';
import { suggestBuys, type BuySuggestion } from '../../advisor/suggest';
import { INDEX_LABEL } from '../../data/universeParse';
import { formatINR, formatNumberIN, formatPct } from '../../lib/format';
import { errorMessage } from '../../lib/serialize';
import { istDate } from '../../lib/time';
import { orderTicket } from '../../planner/plan';
import { callBackground } from '../../shared/messages';
import type { Go } from '../App';
import { useInstrumentMap, useStocksData, useStudyKeys } from '../data';
import { useLocal, useMarketState, useSessionValue, useSettings } from '../hooks';
import { StudyButton } from './Explain';
import { BoughtForm, GttBox, recordPurchase } from './Bought';
import { DownloadNote } from './DownloadNote';
import { PriceRange } from './PriceRange';
import { openTrade } from './TradeSheet';

const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);

/** Today's top picks (v0.7.0): the extension studies Nifty 50/100 by itself and ranks what to buy. */
export function TodaySuggestions({ go }: { go: Go }) {
  const settings = useSettings();
  const plans = useLocal('plans') ?? [];
  const byKey = useInstrumentMap();
  const market = useMarketState();
  const progress = useSessionValue('syncProgress');
  const { keys, listLabel } = useStudyKeys();
  const { data, loading } = useStocksData(keys);
  // Picks saved on this screen stay visible (with the Upstox steps) after they become "planned".
  const [pinned, setPinned] = useState<Array<{ s: BuySuggestion; practice: string | null; bought?: { price: number; qty: number } }>>([]);

  const result = useMemo(() => {
    if (!settings) return null;
    const stocks = keys.map((k) => ({ key: k, symbol: byKey.get(k)?.trading_symbol ?? k, data: data.get(k) }));
    return suggestBuys(stocks, settings, plans, istDate(Date.now()));
  }, [settings, keys.join(','), plans, data, byKey]);

  if (!settings || !result) return null;
  const split = settings.risk.sizing === 'split';
  const marketNote =
    market.phase === 'open'
      ? 'Prices are live and the ranking updates every few seconds while this panel is open.'
      : market.phase === 'pre_open' || market.phase === 'before_open'
        ? 'Prices are from the last close. Place orders after about 09:20, once prices settle — and only if the price is still close to the buy price.'
        : 'Prices are from the last close. These are ideas for the next market day — they will be re-checked with live prices after 09:20.';
  const syncing = progress?.running && progress.total > 0;

  return (
    <section class="card suggestions" data-testid="suggestions">
      <div class="row">
        <h2 style={{ margin: 0 }}>Today's top picks</h2>
        <span class="spacer" />
        <span class="small muted">
          studied {result.studied} of {listLabel}
        </span>
      </div>
      <p class="small" data-testid="swing-note">
        These picks are for <b>holding a few days to weeks</b> (until the profit target or the sell price). For buying and selling on the <b>same day</b>, use the{' '}
        <button class="link-btn" type="button" onClick={() => go('daytrade')}>
          Day trade
        </button>{' '}
        tab — it uses different rules.
      </p>
      <PriceRange />
      <DownloadNote tail="Picks improve as it finishes." />
      {result.blockedReason ? (
        <div class="banner info small">
          {result.blockedReason}{' '}
          {!settings.risk.capitalInr && (
            <button class="btn small" type="button" onClick={() => go('settings')}>
              Open Settings
            </button>
          )}
        </div>
      ) : loading && !result.suggestions.length ? (
        <p class="small muted">Studying {listLabel}…</p>
      ) : null}
      {pinned.map((x) => (
        <PickCard s={x.s} go={go} split={split} saved={!x.practice && !x.bought} practiced={x.practice} bought={x.bought ?? null} />
      ))}
      {result.blockedReason || (loading && !result.suggestions.length) ? null : result.suggestions.length === 0 ? (
        pinned.length ? null : (
          <p class="small" data-testid="no-buy">
            <b>No buy right now.</b> None of the {result.studied} companies in your price range passes all the checks. Not buying is a good decision on such days — your money stays safe.
          </p>
        )
      ) : (
        <>
          <p class="small muted">{marketNote}</p>
          <p class="small" data-testid="pick-order">
            {(settings.scanner.rankBy ?? 'safety') === 'safety' ? (
              <>
                <b>Order: safest first</b> — #1 is the stock that most often made money in situations like today's over the last year (counted cautiously, so a long record beats a
                lucky short one). It is not a promise that it will rise.
              </>
            ) : (
              <>
                <b>Order: highest earning first</b> — #1 had the highest average result per trade in situations like today's over the last year. Bigger average, usually bigger swings.
              </>
            )}{' '}
            <button class="link-btn" type="button" onClick={() => go('settings')}>
              change
            </button>
          </p>
          {result.suggestions.map((s, i) => (
            <PickCard
              s={s}
              rank={i + 1}
              go={go}
              split={split}
              onSaved={(x) => setPinned((p) => [...p, { s: x, practice: null }])}
              onPracticed={(x, text) => setPinned((p) => [...p, { s: x, practice: text }])}
              onBought={(x, b) => setPinned((p) => [...p, { s: x, practice: null, bought: b }])}
            />
          ))}
        </>
      )}
      {result.more.length > 0 && (
        <details class="small" style={{ marginTop: '8px' }} data-testid="more-picks">
          <summary>Next best picks ({result.more.length})</summary>
          <table class="simple">
            <thead>
              <tr>
                <th>Stock</th>
                <th>Price</th>
                <th>Made money</th>
                <th>Past average</th>
              </tr>
            </thead>
            <tbody>
              {result.more.map((m) => (
                <tr>
                  <td>
                    <button class="link-btn" type="button" onClick={() => go('stock', m.key)}>{m.symbol}</button>
                  </td>
                  <td>₹{formatNumberIN(m.plan.entry)}</td>
                  <td>
                    {m.record.profitable} of {m.record.samples} ({pct(m.record.profitChance)})
                  </td>
                  <td class="ok-text">{formatPct(m.expectedPct, 1)} per trade</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      {result.skipped.length > 0 && (
        <details class="small" style={{ marginTop: '8px' }}>
          <summary>Why not the others? ({result.skipped.length})</summary>
          <ul class="skipped">
            {result.skipped.map((x) => (
              <li>
                <b>{x.symbol}</b> — {x.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
      <p class="tiny muted">
        Picks follow fixed rules and each company's own last year of prices. "Possible earning" is not a promise — some trades will lose. Each trade's loss is limited by the sell price you set
        as a GTT in Upstox.
      </p>
    </section>
  );
}

function PickCard({
  s,
  go,
  split,
  rank,
  saved: savedInitially = false,
  practiced: practicedInitially = null,
  bought: boughtInitially = null,
  onSaved,
  onPracticed,
  onBought,
}: {
  s: BuySuggestion;
  go: Go;
  split: boolean;
  rank?: number;
  saved?: boolean;
  practiced?: string | null;
  bought?: { price: number; qty: number } | null;
  onSaved?: (s: BuySuggestion) => void;
  onBought?: (s: BuySuggestion, b: { price: number; qty: number }) => void;
  onPracticed?: (s: BuySuggestion, text: string) => void;
}) {
  const p = s.plan;
  const [saved, setSaved] = useState(savedInitially);
  const [msg, setMsg] = useState<string | null>(
    savedInitially && !practicedInitially && !boughtInitially ? 'Saved for later with alerts. When you have bought it in Upstox, click "I bought this in Upstox".' : null,
  );
  const [steps, setSteps] = useState(savedInitially);
  const [practiced, setPracticed] = useState<string | null>(practicedInitially);
  const [bought, setBought] = useState<{ price: number; qty: number } | null>(boughtInitially);
  const [buying, setBuying] = useState(false);
  const chaseLimit = Number((p.entry * 1.01).toFixed(2));

  const planMsg = () => ({
    key: s.key,
    symbol: s.symbol,
    entry: p.entry,
    stop: p.stop,
    target: p.target,
    qty: p.qty,
    riskRupees: p.riskRupees,
    rewardRupees: p.rewardRupees,
    rr: p.rr,
    targetMode: p.targetMode,
    holdTarget: p.holdTarget,
    ...(s.safeChance !== null ? { safeChance: s.safeChance } : {}),
    ...(s.holdChance !== null ? { holdChance: s.holdChance } : {}),
    ...(s.study ? { studySamples: s.study.samples } : {}),
    setup: 'Good setup',
    trend: null,
    ticket: orderTicket(s.symbol, p, 'NEW'),
  });

  const practice = async () => {
    // app: practice picks go into the practice-money wallet (kept overnight, sells at its safety price or target)
    openTrade({ key: s.key, symbol: s.symbol, side: 'buy', qty: p.qty, stop: p.stop, target: p.target, sellByClose: false, source: 'Top pick' });
  };
  // the extension's separate practice list (kept for older practice trades)
  const practiceOld = async () => {
    try {
      const r = await callBackground('practice:buy', { plan: planMsg() });
      const text =
        r.status === 'open'
          ? `Practice trade started: ${p.qty} shares at ₹${formatNumberIN(r.price)} (pretend money, nothing sent to Upstox). The extension sells it by itself — see "Practice trades" below.`
          : `Practice order placed: it buys at the next opening price, like an order placed while the market is closed (skipped if it opens more than 1% above ₹${formatNumberIN(p.entry)}). See "Practice trades" below.`;
      setPracticed(text);
      onPracticed?.(s, text);
    } catch (err) {
      setPracticed(null);
      setMsg(errorMessage(err));
    }
  };

  const save = async () => {
    try {
      await callBackground('plans:save', {
        plan: {
          key: s.key,
          symbol: s.symbol,
          entry: p.entry,
          stop: p.stop,
          target: p.target,
          qty: p.qty,
          riskRupees: p.riskRupees,
          rewardRupees: p.rewardRupees,
          rr: p.rr,
          targetMode: p.targetMode,
          holdTarget: p.holdTarget,
          ...(s.safeChance !== null ? { safeChance: s.safeChance } : {}),
          ...(s.holdChance !== null ? { holdChance: s.holdChance } : {}),
          ...(s.study ? { studySamples: s.study.samples } : {}),
          setup: 'Good setup',
          trend: null,
          ticket: orderTicket(s.symbol, p, 'NEW'),
        },
      });
      setSaved(true);
      setSteps(true);
      setMsg('Saved for later with alerts. When you have bought it in Upstox, click "I bought this in Upstox".');
      onSaved?.(s);
    } catch (err) {
      setMsg(errorMessage(err));
    }
  };

  return (
    <div class={`suggestion${saved ? ' saved' : ''}`} data-symbol={s.symbol}>
      <div class="row">
        {rank && <span class="rank">#{rank}</span>}
        <h3 style={{ margin: 0 }}>Buy {s.symbol}</h3>
        <span class="muted small">{s.name}</span>
        <span class="spacer" />
        <button class="link-btn" type="button" onClick={() => go('stock', s.key)}>chart</button>
      </div>
      <p class="small" style={{ margin: '4px 0' }}>{s.summary}</p>
      <dl class="kv simple-plan">
        <dt>Buy</dt>
        <dd>
          <b>{p.qty} shares</b> at <b>₹{formatNumberIN(p.entry)}</b> = {formatINR(p.positionValue, 0)}
          {split && <span class="muted"> (your share for this stock)</span>}
        </dd>
        <dt>Possible earning</dt>
        <dd class="ok-text">
          <b>+{formatINR(s.targetEarning, 0)}</b> when it reaches <b>₹{formatNumberIN(p.target)}</b>
          <span class="muted"> (reached in {pct(s.safeChance)} of similar past cases)</span>
          {p.holdTarget !== null && (
            <>
              <br />
              up to <b>+{formatINR(s.maxEarning, 0)}</b> at ₹{formatNumberIN(p.holdTarget)} if the rise continues <span class="muted">({pct(s.holdChance)} of cases)</span>
            </>
          )}
        </dd>
        <dt>Past average</dt>
        <dd>
          <b class="ok-text">+{formatINR(s.expectedRupees, 0)}</b> per trade ({formatPct(s.expectedPct, 1)}), after charges, over the last year's similar cases
        </dd>
        <dt>Past record</dt>
        <dd data-testid="pick-record">
          In <b>{s.record.samples}</b> similar situations in the last year, this exact plan <b class="ok-text">made money {s.record.profitable} times</b> ({pct(s.record.profitChance)}): profit target
          reached {s.record.reached}, sell price hit {s.record.stopped}, sold after 20 days {s.record.timed}.
        </dd>
        <dt>Most you could lose</dt>
        <dd class="err-text">
          <b>{formatINR(p.riskRupees, 0)}</b> if it falls to <b>₹{formatNumberIN(p.stop)}</b> — your GTT sells it automatically there
        </dd>
      </dl>
      {!saved && !practiced && !bought && !buying && (
        <div class="row">
          <button class="btn small primary" type="button" data-testid="i-bought" onClick={() => setBuying(true)} title="You bought it in the Upstox app: save it here">
            I bought this in Upstox
          </button>
          <button class="btn small practice-btn" type="button" data-testid="practice-buy" onClick={() => void practice()} title="Pretend money: no Upstox order">
            Practice buy
          </button>
          <button class="btn small" type="button" onClick={() => setSteps(!steps)}>
            {steps ? 'Hide' : 'How to buy in Upstox'}
          </button>
          <button class="link-btn small" type="button" onClick={() => void save()} title="Not bought yet: save it with price alerts">
            Save for later
          </button>
        </div>
      )}
      {buying && (
        <BoughtForm
          defaultPrice={p.entry}
          defaultQty={p.qty}
          onCancel={() => setBuying(false)}
          onSubmit={async (price, qty) => {
            await recordPurchase(planMsg(), price, qty);
            setBuying(false);
            setSteps(false);
            setBought({ price, qty });
            onBought?.(s, { price, qty });
          }}
        />
      )}
      {bought && <GttBox symbol={s.symbol} qty={bought.qty} price={bought.price} stop={p.stop} target={p.target} tick={s.tick} />}
      {saved && !bought && (
        <div class="row">
          <button class="btn small primary" type="button" data-testid="i-bought" onClick={() => setBuying(true)}>
            I bought this in Upstox
          </button>
          <button class="btn small" type="button" onClick={() => setSteps(!steps)}>
            {steps ? 'Hide' : 'How to buy in Upstox'}
          </button>
        </div>
      )}
      {msg && <p class="small ok-text">{msg}</p>}
      {practiced && (
        <p class="small ok-text" data-testid="practice-msg">
          {practiced}
        </p>
      )}
      {steps && (
        <ol class="small upstox-steps" data-testid="upstox-steps">
          <li>
            Upstox app → search <b>{s.symbol}</b> → <b>Buy</b>.
          </li>
          <li>
            Choose <b>Delivery</b> and <b>Limit</b>. Quantity <b>{p.qty}</b>, price <b>₹{formatNumberIN(p.entry)}</b>. Place the order.
          </li>
          <li>
            If the price is already above <b>₹{formatNumberIN(chaseLimit)}</b>, don't buy — skip it today.
          </li>
          <li>
            When the order shows <b>Executed / Complete</b>: open {s.symbol} → <b>Create GTT</b> → <b>Sell</b>, quantity <b>{p.qty}</b>, trigger price <b>₹{formatNumberIN(p.stop)}</b>, limit price{' '}
            <b>₹{formatNumberIN(p.stopLimit)}</b>. This sells automatically if the price falls — even when your computer is off.
          </li>
          <li>
            Come back here and click <b>I bought this in Upstox</b> (enter the price you paid and the number of shares). From then on the extension tells you when to hold or sell.
          </li>
        </ol>
      )}
      <StudyButton
        label="Ask Claude to double-check (free)"
        input={{
          symbol: s.symbol,
          name: s.name,
          ...(s.isin ? { isin: s.isin } : {}),
          snap: s.snap,
          priceTime: Date.now(),
          plan: { entry: p.entry, stop: p.stop, target: p.target, holdTarget: p.holdTarget, qty: p.qty, riskRupees: p.riskRupees, historyMode: p.targetMode === 'history' },
        }}
      />
    </div>
  );
}

export { INDEX_LABEL };
