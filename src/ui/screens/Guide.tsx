import { useState } from 'preact/hooks';
import { updateSettings } from '../../storage/local';
import type { Go } from '../App';
import { askNotificationPermission } from '../../platform/nativeBindings';

/**
 * First-launch guide (owner: "at the start of the app it should guide through an entry level
 * guide to learn the basics"). Short steps, plain words, can be skipped and opened again from More → Guide.
 */

interface Step {
  icon: string;
  title: string;
  body: preact.ComponentChildren;
}

const STEPS: Step[] = [
  {
    icon: '👋',
    title: 'Welcome to TradeBuddy',
    body: (
      <>
        <p>TradeBuddy watches NSE share prices for you, finds trade ideas, tells you where to <b>buy</b>, where to <b>sell if it goes wrong</b> and where to <b>take profit</b> — and alerts you.</p>
        <p>
          You decide. Real orders are always placed <b>by you</b> in the Upstox app. TradeBuddy never places, changes or cancels an order.
        </p>
        <p class="small muted">Not investment advice. Share prices can fall; you can lose money.</p>
      </>
    ),
  },
  {
    icon: '₹',
    title: 'Start with ₹10 lakh of practice money',
    body: (
      <>
        <p>
          The <b>Practice</b> tab gives you <b>₹10,00,000 of pretend money</b>. Buy and sell any stock at the <b>live price</b>. Profit and loss are calculated exactly, including Upstox charges.
        </p>
        <p>Practise for 2–4 weeks. Use real money only when the practice results are good.</p>
      </>
    ),
  },
  {
    icon: '⚡',
    title: 'How a day trade works',
    body: (
      <>
        <ol class="timeline">
          <li>
            <b>9:15</b> market opens — the first 15 minutes are wild, the app <b>waits</b>.
          </li>
          <li>
            <b>9:30 – 11:30</b> signals appear: <span class="chip day buy">▲ BUY</span> or <span class="chip day sell">▼ SELL</span> with a buy price, a safety sell price and a target.
          </li>
          <li>
            The trade ends by itself at the <b>target</b> (profit), the <b>safety sell price</b> (small loss) or at <b>3:10 pm</b>.
          </li>
        </ol>
        <p class="small">
          Buy as <b>Delivery</b> in Upstox (your own money): you are then allowed to keep it to the next day — do that only if the stock is also "Good to buy". Never keep a stock just because it is at a loss.
        </p>
      </>
    ),
  },
  {
    icon: '🎯',
    title: 'Reading a signal',
    body: (
      <dl class="guide-dl">
        <dt>Buy price</dt>
        <dd>the price to buy at now</dd>
        <dt>Safety sell (stop-loss)</dt>
        <dd>if the price falls here, sell — this keeps a loss small</dd>
        <dt>Target</dt>
        <dd>sell here to take the profit</dd>
        <dt>Chance</dt>
        <dd>how often similar signals made money in the past (from self-learning)</dd>
        <dt>Buyers meter</dt>
        <dd>are more people buying or selling this stock right now?</dd>
      </dl>
    ),
  },
  {
    icon: '🧠',
    title: 'Self-learning — with a safety check',
    body: (
      <>
        <p>The app studies months of 5-minute prices, learns which signals worked and which did not, and gives each new signal a chance in %.</p>
        <p>
          It then <b>tests itself on days it has never seen</b>. A learned version is used only if it beats the plain rules there. Every week it learns again from the newest days.
        </p>
        <p class="small muted">Realistic: good short-term trading wins about 55–60% of the time with small losses. Nobody can promise more.</p>
      </>
    ),
  },
  {
    icon: '🔗',
    title: 'Connect Upstox (for live prices)',
    body: (
      <>
        <p>
          In <b>More → Settings</b>, paste your Upstox <b>Analytics Token</b> (Upstox Developer Apps → Analytics). It works for one year and only reads prices.
        </p>
        <p>
          Optional: log in to Upstox each morning so TradeBuddy finds the trades you make in the Upstox app by itself. It only reads — it never places an order.
        </p>
      </>
    ),
  },
  {
    icon: '🔔',
    title: 'Allow alerts',
    body: (
      <>
        <p>TradeBuddy alerts you when a signal appears, when a target or safety sell price is reached, and when a trade you made in Upstox is found.</p>
        <p class="small">During market hours a small "watching the market" notification keeps the alerts working while the app is in the background.</p>
      </>
    ),
  },
];

function Steps({ onDone, go }: { onDone: () => void; go: Go }) {
  const [i, setI] = useState(0);
  const step = STEPS[i]!;
  const last = i === STEPS.length - 1;
  return (
    <div class="guide" data-testid="guide">
      <div class="guide-icon">{step.icon}</div>
      <h2 data-testid="guide-title">{step.title}</h2>
      <div class="guide-body">{step.body}</div>
      <div class="dots" aria-label={`Step ${i + 1} of ${STEPS.length}`}>
        {STEPS.map((_, j) => (
          <span class={j === i ? 'on' : ''} />
        ))}
      </div>
      <div class="row guide-buttons">
        {i > 0 ? (
          <button class="btn" type="button" onClick={() => setI(i - 1)}>
            Back
          </button>
        ) : (
          <button class="btn" type="button" data-testid="guide-skip" onClick={onDone}>
            Skip
          </button>
        )}
        <span class="spacer" />
        {last ? (
          <>
            <button
              class="btn"
              type="button"
              onClick={() => {
                void askNotificationPermission().catch(() => false);
                onDone();
                go('settings');
              }}
            >
              Set up Upstox
            </button>
            <button
              class="btn primary"
              type="button"
              data-testid="guide-done"
              onClick={() => {
                void askNotificationPermission().catch(() => false);
                onDone();
                go('practice');
              }}
            >
              Start practising
            </button>
          </>
        ) : (
          <button class="btn primary" type="button" data-testid="guide-next" onClick={() => setI(i + 1)}>
            Next
          </button>
        )}
      </div>
    </div>
  );
}

/** Shown once, over everything, on the first start. */
export function GuideOverlay({ go }: { go: Go }) {
  const done = () => void updateSettings({ ui: { guideSeen: true } });
  return (
    <div class="guide-overlay">
      <Steps onDone={done} go={go} />
    </div>
  );
}

/** More → Guide: the same steps again, any time. */
export function GuideScreen({ go }: { go: Go }) {
  return (
    <div class="screen">
      <section class="card">
        <Steps onDone={() => go('today')} go={go} />
      </section>
    </div>
  );
}
