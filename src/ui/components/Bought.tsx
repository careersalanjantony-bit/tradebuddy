import { useMemo, useState } from 'preact/hooks';
import { formatINR, formatNumberIN } from '../../lib/format';
import { errorMessage } from '../../lib/serialize';
import { istDate } from '../../lib/time';
import { planForPurchase } from '../../planner/autoPlan';
import { roundDownToTick } from '../../planner/plan';
import { callBackground, type NewPlanMsg } from '../../shared/messages';
import { useInstrumentMap, useStockData, useStudyKeys } from '../data';
import { useLocal, useSettings } from '../hooks';

/**
 * "I bought this" in one step (owner, 11 Nov 2026: make it user friendly). Replaces the two-step
 * "Save & set alerts" → "I bought it" with a small form: price paid + number of shares. The trade is
 * saved as OPEN with its alerts, and the GTT safety sell is shown with the real quantity.
 */

/** Saves a bought trade (or turns an existing "planned" one into "open") with the real price and quantity. */
export async function recordPurchase(plan: NewPlanMsg, price: number, qty: number, existingPlannedId?: string): Promise<void> {
  const riskRupees = Number((qty * Math.max(0, price - plan.stop)).toFixed(2));
  const rewardRupees = Number((qty * (plan.target - price)).toFixed(2));
  const id = existingPlannedId ?? (await callBackground('plans:save', { plan: { ...plan, entry: price, qty, riskRupees, rewardRupees } })).id;
  await callBackground('plans:update', { id, patch: { status: 'open', fillPrice: price, qty, riskRupees, rewardRupees } });
}

export function stopLimitFor(stop: number, tick = 0.05): number {
  return Math.max(tick, roundDownToTick(stop * 0.995, tick));
}

/** Price paid + shares, prefilled. */
export function BoughtForm({
  defaultPrice,
  defaultQty,
  onSubmit,
  onCancel,
  priceLabel = 'Price you paid (per share)',
  submitLabel = 'Save my trade',
  fixedQty = false,
}: {
  defaultPrice: number;
  defaultQty: number;
  onSubmit: (price: number, qty: number) => Promise<void>;
  onCancel?: () => void;
  priceLabel?: string;
  submitLabel?: string;
  /** the number of shares cannot be changed (closing a trade) */
  fixedQty?: boolean;
}) {
  const [price, setPrice] = useState(String(defaultPrice));
  const [qty, setQty] = useState(String(defaultQty));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const pr = Number(price);
    const q = Math.floor(Number(qty));
    if (!(pr > 0)) return setErr('Enter the price you paid per share.');
    if (!(q >= 1)) return setErr('Enter how many shares you bought.');
    setBusy(true);
    setErr(null);
    try {
      await onSubmit(pr, q);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="bought-form" data-testid="bought-form">
      <div class="grid2">
        <label class="field">
          <span>{priceLabel}</span>
          <input type="number" step="0.05" min="0" value={price} data-field="bought-price" onInput={(e) => setPrice((e.currentTarget as HTMLInputElement).value)} />
        </label>
        <label class="field">
          <span>Number of shares</span>
          <input type="number" step="1" min="1" value={qty} data-field="bought-qty" disabled={fixedQty} onInput={(e) => setQty((e.currentTarget as HTMLInputElement).value)} />
        </label>
      </div>
      <div class="row">
        <button class="btn small primary" type="button" disabled={busy} data-testid="bought-save" onClick={() => void submit()}>
          {busy ? 'Saving…' : submitLabel}
        </button>
        {onCancel && (
          <button class="btn small" type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      <p class="tiny muted">Check the price in Upstox → Orders (the "average price" of the executed order).</p>
      {err && <p class="small err-text">{err}</p>}
    </div>
  );
}

/** The one thing to do in Upstox after buying: the GTT safety sell. */
export function GttBox({ symbol, qty, price, stop, target, tick = 0.05 }: { symbol: string; qty: number; price: number; stop: number; target: number; tick?: number }) {
  return (
    <div class="banner ok small" data-testid="gtt-box">
      <b>Saved — the extension is now watching your {qty} {symbol} shares.</b>
      <div style={{ marginTop: '6px' }}>
        <b>Last step, in the Upstox app — your safety sell (GTT):</b>
      </div>
      <ol class="small" style={{ margin: '4px 0 4px 18px', padding: 0 }}>
        <li>
          Open <b>{symbol}</b> → <b>Create GTT</b> → <b>Sell</b>
        </li>
        <li>
          Quantity <b>{qty}</b> · Trigger price <b>₹{formatNumberIN(stop)}</b> · Limit price <b>₹{formatNumberIN(stopLimitFor(stop, tick))}</b> → Place
        </li>
      </ol>
      <div>
        It sells by itself if the price falls to ₹{formatNumberIN(stop)} — even when your computer is off. Most you could lose: <b>{formatINR(Math.max(0, price - stop) * qty, 0)}</b>.
        Profit target ₹{formatNumberIN(target)} — you get an alert with a sound when it is reached.
      </div>
    </div>
  );
}

/**
 * Trades & alerts: record a stock already bought in Upstox (e.g. bought before saving it here, or no
 * longer shown as a pick). The sell price and target are worked out from the price paid and the stock's
 * own history, like a pick.
 */
export function AddPurchaseCard() {
  const settings = useSettings();
  const plans = useLocal('plans') ?? [];
  const byKey = useInstrumentMap();
  const { keys } = useStudyKeys();
  const [open, setOpen] = useState(false);
  const [sym, setSym] = useState('');
  const [done, setDone] = useState<{ symbol: string; qty: number; price: number; stop: number; target: number } | null>(null);

  const options = useMemo(() => keys.map((k) => ({ key: k, symbol: byKey.get(k)?.trading_symbol ?? '' })).filter((o) => o.symbol).sort((a, b) => a.symbol.localeCompare(b.symbol)), [keys.join(','), byKey]);
  const chosen = options.find((o) => o.symbol === sym.trim().toUpperCase()) ?? null;
  const { data, loading } = useStockData(chosen?.key ?? null);

  if (!settings) return null;
  const snap = data?.snapshot ?? null;
  const planned = chosen ? plans.find((p) => p.key === chosen.key && p.status === 'planned' && !p.practice) : undefined;
  const already = chosen ? plans.find((p) => p.key === chosen.key && p.status === 'open' && !p.practice) : undefined;

  const save = async (price: number, qty: number) => {
    if (!chosen || !data || !snap) throw new Error('Choose a stock from the list first.');
    if (already) throw new Error(`${chosen.symbol} is already saved as a trade you own.`);
    if (planned) {
      await recordPurchase({ ...planned } as NewPlanMsg, price, qty, planned.id);
      setDone({ symbol: chosen.symbol, qty, price, stop: planned.stop, target: planned.target });
      return;
    }
    const built = planForPurchase(data, settings, chosen.symbol, price, qty, istDate(Date.now()));
    if ('error' in built) throw new Error(built.error);
    await recordPurchase(built.plan, price, qty);
    setDone({ symbol: chosen.symbol, qty, price, stop: built.plan.stop, target: built.plan.target });
  };

  return (
    <section class="card" data-testid="add-purchase">
      <div class="row">
        <h2 style={{ margin: 0 }}>Bought a stock in Upstox?</h2>
        <span class="spacer" />
        {!open && (
          <button class="btn small primary" type="button" data-testid="add-purchase-open" onClick={() => (setOpen(true), setDone(null))}>
            Add it here
          </button>
        )}
      </div>
      {!open && !done && <p class="small muted">Tell the extension what you bought, so it can watch the price, alert you and tell you when to hold or sell.</p>}
      {done && <GttBox symbol={done.symbol} qty={done.qty} price={done.price} stop={done.stop} target={done.target} />}
      {open && (
        <>
          <label class="field">
            <span>Stock (type the symbol, e.g. MOTHERSON)</span>
            <input list="add-purchase-symbols" value={sym} data-field="bought-symbol" onInput={(e) => setSym((e.currentTarget as HTMLInputElement).value)} />
            <datalist id="add-purchase-symbols">
              {options.map((o) => (
                <option value={o.symbol} />
              ))}
            </datalist>
          </label>
          {sym && !chosen && <p class="small muted">Choose a stock from the list (any of the five indices or your own stocks).</p>}
          {chosen && loading && <p class="small muted">Loading {chosen.symbol}…</p>}
          {chosen && !loading && !snap && <p class="small err-text">No price history for {chosen.symbol} yet — wait for the history download, then try again.</p>}
          {chosen && snap && (
            <BoughtForm
              key={chosen.key}
              defaultPrice={Number(snap.price.toFixed(2))}
              defaultQty={1}
              onSubmit={async (price, qty) => {
                await save(price, qty);
                setOpen(false);
                setSym('');
              }}
              onCancel={() => setOpen(false)}
            />
          )}
        </>
      )}
    </section>
  );
}
