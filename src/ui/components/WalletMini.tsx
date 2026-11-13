import { formatINR } from '../../lib/format';
import { istDate } from '../../lib/time';
import { newWallet, walletSummary } from '../../wallet/wallet';
import type { Go } from '../App';
import { useQuotes } from '../data';
import { useLocal, useNow } from '../hooks';

const signed = (x: number) => `${x >= 0 ? '+' : '−'}${formatINR(Math.abs(x), 0)}`;

/** Home screen: practice money at a glance. */
export function WalletMini({ go }: { go: Go }) {
  const w = useLocal('wallet');
  const quotes = useQuotes();
  const now = useNow(10_000);
  const s = walletSummary(w ?? newWallet(now), quotes, istDate(now));
  return (
    <section class="card wallet-card" data-testid="wallet-mini">
      <div class="row">
        <div>
          <div class="tiny muted">Practice money</div>
          <div class="big-num" style={{ fontSize: '20px' }}>
            {formatINR(s.total, 0)}
          </div>
          <div class="small">
            <span class={s.todayPnl >= 0 ? 'ok-text' : 'err-text'}>Today {signed(s.todayPnl)}</span> ·{' '}
            <span class={s.totalPnl >= 0 ? 'ok-text' : 'err-text'}>Overall {signed(s.totalPnl)}</span>
            {s.holdings.length > 0 && <span class="muted"> · {s.holdings.length} holding{s.holdings.length === 1 ? '' : 's'}</span>}
          </div>
        </div>
        <span class="spacer" />
        <button class="btn primary" type="button" onClick={() => go('practice')}>
          Open
        </button>
      </div>
    </section>
  );
}
