import { useState } from 'preact/hooks';
import { updateSettings } from '../../storage/local';
import type { Go } from '../App';
import { askNotificationPermission } from '../../platform/nativeBindings';

/**
 * First-launch guide (owner: "at the start of the app it should guide through an entry level
 * guide to learn the basics"). Short steps, plain words, can be skipped and opened again from More → Guide.
 */

const ART: Record<string, preact.ComponentChildren> = {
  hello: (
    <svg viewBox="0 0 160 140">
      <rect x="20" y="20" width="120" height="100" rx="18" fill="url(#g1)" class="float" />
      <polyline class="draw" points="38,92 64,66 84,80 122,44" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" pathLength={1} />
      <polyline class="draw" points="104,44 122,44 122,62" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" pathLength={1} />
      <defs>
        <linearGradient id="g1" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#6d5dfc" />
          <stop offset="1" stop-color="#3ba3ff" />
        </linearGradient>
      </defs>
    </svg>
  ),
  money: (
    <svg viewBox="0 0 160 140">
      <rect x="22" y="40" width="116" height="74" rx="14" fill="#16a34a" class="float" />
      <circle cx="80" cy="77" r="20" fill="none" stroke="#fff" stroke-width="5" />
      <text x="80" y="85" text-anchor="middle" font-size="24" font-weight="800" fill="#fff">₹</text>
      <circle cx="122" cy="34" r="12" fill="#facc15" class="float" />
      <circle cx="38" cy="28" r="8" fill="#facc15" class="float" />
    </svg>
  ),
  day: (
    <svg viewBox="0 0 160 140">
      <circle cx="80" cy="70" r="46" fill="none" stroke="#3ba3ff" stroke-width="6" opacity="0.35" />
      <circle class="draw" cx="80" cy="70" r="46" fill="none" stroke="#3ba3ff" stroke-width="6" stroke-linecap="round" pathLength={1} transform="rotate(-90 80 70)" />
      <line x1="80" y1="70" x2="80" y2="42" stroke="currentColor" stroke-width="5" stroke-linecap="round" />
      <line x1="80" y1="70" x2="100" y2="80" stroke="currentColor" stroke-width="5" stroke-linecap="round" />
    </svg>
  ),
  idea: (
    <svg viewBox="0 0 160 140">
      <rect x="24" y="22" width="112" height="96" rx="16" fill="none" stroke="#22c55e" stroke-width="4" class="float" />
      <rect x="38" y="38" width="44" height="12" rx="6" fill="#22c55e" />
      <rect x="38" y="60" width="84" height="10" rx="5" fill="currentColor" opacity="0.25" />
      <rect x="38" y="78" width="60" height="10" rx="5" fill="#22c55e" opacity="0.6" />
      <rect x="38" y="96" width="70" height="10" rx="5" fill="#f05252" opacity="0.6" />
    </svg>
  ),
  brain: (
    <svg viewBox="0 0 160 140">
      <circle cx="80" cy="70" r="44" fill="url(#g2)" class="float" />
      <path class="draw" d="M52 78 L68 62 L82 72 L108 50" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" pathLength={1} />
      <circle cx="118" cy="34" r="6" fill="#a78bfa" class="float" />
      <circle cx="40" cy="40" r="4" fill="#3ba3ff" class="float" />
      <defs>
        <linearGradient id="g2" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#a78bfa" />
          <stop offset="1" stop-color="#6d5dfc" />
        </linearGradient>
      </defs>
    </svg>
  ),
  link: (
    <svg viewBox="0 0 160 140">
      <rect x="30" y="50" width="46" height="40" rx="20" fill="none" stroke="#3ba3ff" stroke-width="7" class="float" />
      <rect x="84" y="50" width="46" height="40" rx="20" fill="none" stroke="#6d5dfc" stroke-width="7" class="float" />
      <line class="draw" x1="62" y1="70" x2="98" y2="70" stroke="currentColor" stroke-width="7" stroke-linecap="round" pathLength={1} />
    </svg>
  ),
  bell: (
    <svg viewBox="0 0 160 140">
      <g class="ring">
        <path d="M52 92c6-6 8-14 8-30a20 20 0 0 1 40 0c0 16 2 24 8 30z" fill="#facc15" />
        <circle cx="80" cy="100" r="8" fill="#facc15" />
      </g>
      <circle cx="108" cy="44" r="9" fill="#f05252" />
    </svg>
  ),
};

interface Step {
  art: keyof typeof ART;
  icon: string;
  title: string;
  body: preact.ComponentChildren;
}

const STEPS: Step[] = [
  {
    art: 'hello',
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
    art: 'money',
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
    art: 'day',
    icon: '⚡',
    title: 'How a day trade works',
    body: (
      <>
        <ol class="timeline">
          <li>
            <b>9:15</b> market opens — the first 15 minutes are wild, the app <b>waits</b>.
          </li>
          <li>
            <b>9:30 – 11:30</b> buy ideas appear: <span class="chip day buy">▲ BUY</span> with a buy price, a take-profit price and a sell-if-falls price.
          </li>
          <li>
            The trade ends at the <b>take-profit price</b>, the <b>sell-if-falls price</b> (a small loss) or at <b>3:10 pm</b>.
          </li>
        </ol>
        <p class="small">
          Buy as <b>Delivery</b> in Upstox (your own money): you are then allowed to keep it to the next day — do that only if the stock is also "Good to buy". Never keep a stock just because it is at a loss.
        </p>
      </>
    ),
  },
  {
    art: 'idea',
    icon: '🎯',
    title: 'Reading a buy idea',
    body: (
      <dl class="guide-dl">
        <dt>Buy price</dt>
        <dd>the price to buy at now</dd>
        <dt>Sell if it falls to</dt>
        <dd>your safety net: selling here keeps a loss small (traders call it a "stop-loss")</dd>
        <dt>Take profit at</dt>
        <dd>sell here and keep the profit</dd>
        <dt>Chance</dt>
        <dd>how often similar signals made money in the past (from self-learning)</dd>
        <dt>Buyers meter</dt>
        <dd>are more people buying or selling this stock right now?</dd>
      </dl>
    ),
  },
  {
    art: 'brain',
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
    art: 'link',
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
    art: 'bell',
    icon: '🔔',
    title: 'Allow alerts',
    body: (
      <>
        <p>TradeBuddy alerts you to a strong buy idea, a stock rising fast, and when a take-profit or sell-if-falls price is reached.</p>
        <p class="small">
          Keep the app in the background during market hours for instant alerts (a small "watching the market" notification shows). Even when the app is closed, it checks about every 15
          minutes.
        </p>
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
      <div class="guide-step" key={i}>
        <div class="guide-art">{ART[step.art]}</div>
        <h2 data-testid="guide-title">{step.title}</h2>
        <div class="guide-body">{step.body}</div>
      </div>
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
