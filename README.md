# Swing Trade Assistant (Chrome extension, MV3)

A personal assistant for swing trading NSE cash equities through Upstox. It does analysis, risk/profit
planning and alerts. **It never places, modifies or cancels orders**: it is read-only towards the
broker, and you place every order yourself in the Upstox app.

> This tool gives analysis and calculations, not investment advice. Markets carry risk of loss.
> You decide and place every order yourself.

Single user, never published to the Chrome Web Store. Keys stay on your machine.

## Build status

| # | Milestone | Status |
|---|---|---|
| M0 | Scaffold: Vite + TS + MV3, side panel, popup, storage layer, logging, stable key | **done — tested by owner** |
| M1 | Upstox auth + status bar + daily expiry + login reminder (+ optional Analytics Token) | **done — real login confirmed by owner; overnight expiry check pending** |
| M2 | Instruments + watchlist + REST LTP | **done (fast track, v0.3.0) — awaiting owner test** |
| M3 | Daily candles + corporate-action adjustment + indicators + chart | **done (fast track) — Data check in Diagnostics pending real data** |
| M4 | Live feed + stale detection + watchdog | **done (v0.12.0) — awaiting owner test on real data**: WebSocket feed with polling fallback, stale detection, automatic sync of today's Upstox positions; import of older holdings next |
| M5 | Alert engine + Chrome notifications + sound | mostly: stop/target/safe/hold-until/near-stop/1R/price/close-below-SMA20 alerts, trailing-stop advice, Chrome notifications, badge and sounds; quiet hours, % move and P&L alerts next |
| M6 | Scanner + planner + order ticket — version 1 | **done**: shortlist, evening scan + notification, planner with guardrails and ticket, saved plans; v0.4.0 history-based exit advice; v0.5.0 Today screen, plain words, Claude-chat study, sounds; v0.7.0 Nifty 100 studied automatically; v0.8.0 safest-first order and past-year test. **Data check passed 10/10 on real data (9 Nov 2026).** |
| M7 | Fundamentals + news + Analyze (Claude) + cost controls (version 2) | |
| M8 | Journal + paper mode + stats + Telegram + backup (version 3) | |
| M9 | Hardening, secret encryption option, README polish | |

## Install (load unpacked)

You need Chrome 120 or newer.

**Option A — prebuilt:** unzip `swing-trade-assistant-extension-<version>.zip` to a folder that will
not move (Windows: right-click the zip → **Extract All…** → e.g. `C:\Users\<you>\SwingAssist`).

**Option B — build from source** (Node 22+):

```bash
npm install
```

```bash
npm run build
```

The extension is then in `dist/`.

Then:

1. Open `chrome://extensions`, turn on **Developer mode** (top right).
2. Click **Load unpacked** and choose the folder (the unzipped folder, or `dist/`).
3. Pin the extension (puzzle icon → pin). Click it → **Open side panel**.

### Updating to a new version (Windows)

Your settings, keys and login are stored inside Chrome, not in the folder, so replacing the files is safe.

1. Open the extension folder and delete everything inside it (keep the folder).
2. Right-click the new zip → **Extract All…** → choose that same folder.
3. In `chrome://extensions`, click the round **reload** arrow on the Swing Trade Assistant card.

Never click **Remove** on the card: that deletes the saved settings, keys and data.

### Fixed extension ID (why there is a `key` in manifest.json)

`manifest.json` contains a public `key`. It fixes the extension ID, so the OAuth redirect URL does not
change when the folder moves:

- Extension ID: `joalpejfcchnfbcjacmijbmmbmmnobio`
- Upstox redirect URL: `https://joalpejfcchnfbcjacmijbmmbmmnobio.chromiumapp.org/upstox`

Print them at any time:

```bash
npm run ext-id
```

The private key is only needed to pack a `.crx`, which this project does not do. To make a **new** ID
(you would then have to update the redirect URL in your Upstox app):

```bash
npm run gen-key -- --force
```

That writes the new public key into `manifest.json` and the private key into `keys/` (git-ignored).

## Owner setup (spec §6)

1. **Upstox API app** (needed from M1): at <https://account.upstox.com/developer/apps>, create an app and
   note the **API key** and **API secret**. Set the redirect URL to the value shown in
   **Settings → Upstox → Redirect URL** (the URL above). No static IP is needed, because the extension
   uses no order APIs.
2. **Upstox Analytics Token** (optional, recommended): same page → **Analytics** tab → Generate Token.
   It is read-only, lasts 1 year, and lets prices, charts, scans and the live feed work without the
   daily login. Paste it in **Settings → Upstox Analytics Token**; the extension tests it before saving.
3. **Claude API key** (needed from M7): from the Claude Console (platform.claude.com). This is
   separate from a Claude app subscription and billed per use. Set a monthly spend limit in the
   Console.
4. **Telegram** (optional, M8): create a bot with @BotFather, note the bot token, send the bot a
   message, and get the chat ID.
5. Load the extension (above), open the side panel, enter keys in **Settings**, and click **Log in to
   Upstox**.

## How the Upstox login works

1. **Log in to Upstox** opens Upstox's own login window. You type your mobile/ID, OTP and PIN there;
   the extension never sees them.
2. Upstox sends the browser to the redirect URL with a one-time code. Chrome hands that to the
   extension, which checks a random security value (`state`) and swaps the code for a token.
3. The token is stored in this Chrome profile and lasts until **03:30 IST** the next morning (Upstox's
   rule). After that the status bar says "session ended". On trading days a reminder appears at 08:45
   if you are not logged in.
4. If Upstox rejects the token during the day (HTTP 401), the session is marked ended, a notification
   appears and a red banner offers **Log in to Upstox**.

Market data calls use the Analytics Token when one is saved; account data (profile, holdings,
positions) always uses the daily login. Details and doc sources: `docs/VERIFIED.md`.

## How the data works (v0.3.0)

- **Stock list:** the public NSE instruments file is downloaded at 06:45 daily (and on first start).
  The watchlist starts with the ten stocks from the 9 Nov 2026 screen.
- **Prices:** every 30 s during market hours the extension asks Upstox for the last price and today's
  open/high/low/volume of every watchlist stock and planned/open trade (two requests per 500 stocks).
  A price older than 90 s during market hours is "stale": shown as such and never used for alerts.
- **History:** 3 years of daily candles per stock; refreshed at 16:00 (retry 18:00), and on demand.
- **Bonus/split adjustment:** for every bonus or split the price gap on the ex-date is checked; if the
  data is unadjusted it is fixed (including two actions on one day, e.g. bonus + split). Any other
  one-day move beyond ±18% is flagged until you confirm it was real.
- **Evening scan (16:00):** updates history, runs end-of-day alerts and sends one summary notification.
- **Alerts:** stop hit, target hit, within 1% of stop and +1R for every saved plan, plus price alerts you
  add on a stock page. Stop and target notifications stay on screen until dismissed.
- **Exit logic (owner's choice, v0.4.0) — no fixed target:** the planner studies the last year of the
  stock's own history. For every past day in the same trend state it pretends to buy with a 2×ATR stop and
  measures how far the price rose in the next 20 trading days before the stop would have hit.
  *Safe target* = the level reached before the stop in about 60% of those cases; *hold-until target* = about
  25% (the top of the usual range). The GTT in Upstox holds only the stop-loss. While you hold, the
  extension advises **HOLD** (trend healthy), **BOOK PROFIT** (hold-until reached, or safe target reached
  with momentum fading), **SELL** (close below the trailing stop = highest close − 2×ATR, never below
  breakeven after +1R), **EXIT** (stop hit) or **REVIEW** (no progress in 15 sessions), and every evening
  tells you if the GTT stop should move up. Fixed targets (2R, 3R, resistance, manual) are still available.
- **Today screen (v0.5.0):** the home screen. A setup checklist (keys, daily login, capital, optional
  Analytics Token), the routine for the time of day, open trades with their hold/sell advice, planned
  orders, today's candidates in plain words (Good setup / Wait / Avoid) and recent alerts.
- **Plain words:** every stock gets a short reading of its numbers and a verdict chip; the full numbers
  are one click away ("All the numbers").
- **Free company study:** "Copy study question for Claude" packs the stock's numbers (and your plan) into a
  question for Claude chat, which searches the latest results, news and risks — covered by a Claude
  subscription, no API billing.
- **Sounds:** falling beeps for a stop-loss, a rising chime for targets, a soft beep for other alerts
  (Settings → Alerts; test them in Diagnostics).
- **History freshness:** Upstox publishes the day's candle after the evening, so history is refreshed right
  after you log in and again at 09:20; the day's change uses Upstox's own previous close.
- **Simple mode (v0.6.0, default):** the owner enters only the **amount to invest**. Careful defaults are
  applied behind the scenes (at most 3 trades at once; each limited so a failed trade loses about 0.5% of
  the amount; daily/weekly loss limits). The Today screen shows **Today's buy suggestions**: for each stock,
  how many shares at what price, the sell-if-it-falls price (GTT), the most that can be lost, the profit
  target with how often it was reached in similar past cases, the average past result after charges, and
  step-by-step Upstox instructions. A stock is suggested only if it is a "Good setup", has a year of
  history, fits the amount and free trade slots, and — in similar situations over the last year — buying
  and following the exit plan made money on average after charges. Expert screens (Shortlist, Stock,
  Planner) and all settings are one checkbox away (Settings → Screens).
- **Trades made in Upstox are found by themselves (v0.12.0, on by default):** while the market is open
  and you are logged in, the extension reads today's positions about every 10 seconds
  (`GET /v2/portfolio/short-term-positions` — **read-only**, with the daily login token). An **Intraday**
  buy or short sale becomes a watched day trade (stop, target, 3:10 pm alerts); a **Delivery** purchase
  becomes a trade with its sell-if-falls price, profit target, alerts and the GTT reminder; a position
  you close in Upstox is closed here with its result, and a notification with a sound tells you each
  time. Nothing is ever sent to Upstox. Switch: Trades & alerts → "Find my Upstox trades automatically".
  If Upstox refuses the request, the line says so and trades are recorded by hand as before. Code:
  `src/portfolio/sync.ts` (pure), `src/background/portfolioJobs.ts`, `src/planner/autoPlan.ts`.
- **Instant prices (v0.12.0):** in market hours the extension opens the Upstox Market Data Feed V3
  (WebSocket, "ltpc" mode) for every tracked stock and the two indices; prices then arrive the moment
  they change and the status bar says "instant ⚡". The messages are protobuf and are read by a small
  hand-written decoder (`src/data/feedProto.ts`, no library, no generated code), checked in the tests
  against the standard protobuf library and Upstox's own definition. The feed is an extra: if it is not
  connected or goes silent for 5 s, the 2-second polling continues. Only `wss://…upstox.com` addresses
  are accepted, and the address (it holds a one-time code) is never logged. Code: `src/background/feed.ts`.
- **Market mood (v0.12.0):** one line on Today and Day trade — rising / falling / mixed, the Nifty 50
  change, how many studied stocks are up, and how nervous the market is (India VIX: below 13 calm,
  13–17 normal, 17–22 nervous, above 22 very nervous). A nervous market adds a "Be careful" line to
  day-trade signals; it never creates or blocks a trade by itself. Code: `src/advisor/mood.ts`.
- **News (v0.12.0):** a small box with at most 6 headlines (time, stock, headline, link) for the stocks
  you hold, today's signals and the top picks, from the Upstox News API, refreshed every 15 minutes.
  No analysis is shown. In the background a stock with news in the last 24 hours marks its day-trade
  signal with "in the news today — its price can jump either way". Code: `src/data/news.ts`,
  `src/background/newsJobs.ts`.
- **Plain words (v0.12.0, simple mode):** every stock in the Stocks list is one label (Good to buy /
  Wait / Avoid / Nothing to do / Ignore for now) and one short sentence; the indicator line (RSI, SMA)
  is shown in advanced mode only. A download counter that has not moved for 90 s now says it is waiting
  for Upstox and carries on by itself, and a "downloading" flag left over by a stopped service worker
  is cleared at start-up.
- **Day-trade mode (v0.11.0, "Day trade" tab, off until turned on):** for buying and selling — or
  selling short and buying back — on the same day. The swing picks on Today are NOT day-trade logic.
  - Rules (`src/daytrade/rules.ts`, "opening range breakout with volume"): opening range = first 15
    minutes; only stocks whose opening volume is ≥ N× their own 10-day average; BUY on the first 5-minute
    close above the range (and above VWAP) while the average studied stock is up from its open, SELL short
    on the mirror image (Nifty 100 companies only); signals 09:35–11:30; stop = other side of the range,
    0.25%–1% away; target = a multiple of the stop distance; everything closed at 15:10.
  - Past test (`src/daytrade/backtest.ts`): ~6 months of 5-minute candles per stock (IndexedDB store
    `intraday`), entry at the NEXT bar's open, slippage both ways, Upstox intraday charges, the amount
    split into N trades a day, stop after 2 losing trades. 36 settings (4 targets × 3 volume levels ×
    buy/short/both) are compared on the OLDER two thirds of the days only; the verdict is the chosen
    setting's result on the NEWEST third. Not passed → signals are labelled "practice only".
  - Live (`src/background/dayJobs.ts`, `src/daytrade/live.ts`): at 09:30:45 today's bars are loaded from
    Upstox; at every 5-minute mark the finished bar is added from the latest prices and the same
    `findBreakout` runs; a missed mark (sleep) reloads. Signals: notification + sound, "▲ BUY today" /
    "▼ SELL today" tags on the Stocks tab. Day trades are recorded with "I took this trade in Upstox"
    (real: alerts at stop, target and 15:05) or "Practice" (closed by the extension at stop / target /
    15:10). No order is ever sent.
- **More lists (v0.11.0):** Nifty 50, Nifty 100, Nifty Midcap 100, Nifty Smallcap 100, Nifty 500 (NSE
  CSVs, bundled copies of 11 Nov 2026 as fallback); list picker, filter dropdown (picks, day-trade
  signals, Good setup / Wait / Avoid, trend, breakout, pullback, stretched, rising / falling today) and a
  Refresh button on the Stocks tab; every row is tagged NSE (all instruments are `NSE_EQ`).
- **Faster prices (v0.11.0):** while the side panel is open, last prices every 2 s per 500 stocks (LTP
  only), with a full poll (day open/high/low/volume) every ~10 s. Price polls have their own rate limiter
  (Upstox limits are per API), so history downloads no longer slow them down.
- **Practice trades (v0.9.0):** every pick has a **Practice buy** button — pretend money, nothing is
  sent to Upstox and no price alerts are created. During market hours it "buys" at the live price (refused
  if the price is already more than 1% above the pick's buy price, as the Upstox steps say); when the
  market is closed it waits and buys at the next session's opening price (skipped if that opens more than
  1% higher). The service worker then sells it by itself on every price poll and after the end-of-day
  sync, with the same rules as the past-year test (`exitOnBar`): at the opening price after a gap below
  the sell price, at the sell price, at the profit target, or at the close after 20 sessions; on the buy
  day only prices seen after the buy count; days missed while Chrome was closed are caught up from the
  daily history. Practice results (after the estimated charges), per day and per trade, are on Today and
  Trades & alerts, and in the status bar ("Practice"), kept apart from real trades. Code:
  `src/practice/practice.ts` (pure), `src/background/practiceJobs.ts`.
- **Prices refresh by themselves (v0.8.0):** every 30 s while the market is open (as before), and now
  also once when the market is closed if the last session's closing prices were not fetched yet — after
  an evening install, a browser restart or on a weekend — and as soon as the panel opens. Until Upstox
  publishes the day's daily candle (late at night), the last session is built from the quote, so the
  screens never fall back to the previous day's close. Nothing needs to be refreshed by hand.
- **Safest first (v0.8.0, default):** picks are ordered by how often the same plan made money (after
  charges) in similar situations over the last year, counted cautiously (Wilson lower bound, so a long
  record beats a lucky short one); ties go to the smaller possible loss. "Highest earning first" (v0.7.0
  order) is one choice away in Settings. Every pick shows its past record: N similar cases, how many made
  money, reached the profit target, hit the sell price, or were sold after 20 days.
- **Past-year test (v0.8.0):** the Today screen replays the last ~250 trading days with the same rules
  (`evaluateCandidate`, shared with the live picks), using only data known on each day, the owner's
  amount, split and price range; it buys at the close, sells at the target / the sell price (at the open
  after a gap down) / after 20 sessions, subtracts charges, and compares both orders with simply buying
  every studied company and holding. It runs by itself after the history download (≈ 1–4 s) and lists
  every trade. Limits are shown on the card (today's index list → survivorship; daily candles only).
- **Studies Nifty 50 / Nifty 100 by itself (v0.7.0):** the official constituent lists are downloaded
  weekly from NSE (`nsearchives.nseindia.com`, CSV), with a copy bundled from 9 Nov 2026 as fallback. Price
  history for every company is downloaded in the background (≈10 s for 100 companies), prices are polled
  every 30 s, and the **Stocks** tab ranks the whole list: buy picks first (by past average earning per
  rupee, after charges), then Good setup / Wait / others. A **price drag bar** limits picks to a share-price
  range. During market hours a **"New top pick"** alert fires when a stock newly qualifies (checked every
  5 minutes from 09:20, once per stock per day).
- **Full-amount mode (v0.7.0, default):** the amount is split equally into the top 1–5 picks (Settings →
  "Split my amount into"). Each pick shows the possible earning at the profit target and at the higher
  "can go up to" level, the past average result, and the most that could be lost at its GTT sell price.
  "Careful" mode (lose at most 0.5% of the amount per trade) is still one choice away.
- **Charts:** TradingView Lightweight Charts™ — Copyright © TradingView, Inc., https://www.tradingview.com/
  (Apache-2.0; the attribution logo is kept on the chart).

## Development

| Command | What it does |
|---|---|
| `npm test` | Unit tests (Vitest; IndexedDB simulated with `fake-indexeddb`) |
| `npm run typecheck` | TypeScript strict check |
| `npm run build` | Type-check, then build to `dist/` |
| `npm run watch` | Rebuild on change (then reload the extension in `chrome://extensions`) |
| `npm run smoke` | Loads `dist/` into Chromium (Playwright) and drives the extension end to end against a local fake Upstox server (login, token exchange, holidays, 401, expiry, logout, Analytics Token, stock list, watchlist, history, Trent bonus adjustment, chart, planner, saved plan, alerts, scan); screenshots in `smoke-output/` |
| `npm run icons` | Re-render the toolbar icons (needs Playwright) |

`.npmrc` sets `legacy-peer-deps=true` to avoid an npm bug when it resolves Vitest's optional peer
dependencies. Every dependency is listed explicitly and pinned to an exact version.

### Layout

```
manifest.json            source manifest (version comes from package.json at build time)
src/background/          service worker entry + message router
src/storage/             chrome.storage.local wrapper, settings defaults, migrations, IndexedDB schema, log store
src/lib/                 logger, secret redaction, serialisation, en-IN / IST formatting
src/shared/              typed messages between UI and service worker
src/ui/                  side panel (Preact), popup, styles, screens
src/upstox, data, indicators, scanner, planner, alerts, analyze, journal, notify, offscreen
                         (filled milestone by milestone)
tests/                   unit tests
scripts/                 key/ID tools, icon renderer, smoke test
```

### Storage

- `chrome.storage.local` (schema v2): `meta` (schema version), `settings`, `secrets`, `auth`, `watchlist`,
  `alerts`, `plans`, `scheduleState`, `marketCalendar`.
- `chrome.storage.session` (cleared when Chrome closes): pending login `state`, rate-limiter history,
  API status. Changes go through versioned migrations
  (`src/storage/migrations.ts`), which run every time the service worker starts and are idempotent.
- IndexedDB `swing-assistant` v1: `instruments`, `candles` (key instrument_key + date),
  `adjustments`, `corporateActions`, `fundamentals`, `news`, `reports`, `journal`, `alertLog`, `logs`.
  Upgrades are versioned steps in `src/storage/db.ts`.
- Logs: a ring buffer of the last 5,000 entries, viewable in **Diagnostics**, exportable as JSON.

The service worker keeps no important state in memory: MV3 restarts it at any time.

## Security and privacy

- Secrets (Upstox secret and tokens, Analytics Token, Claude key, Telegram token) are stored **only** in
  `chrome.storage.local` on this machine: never `storage.sync`, never in code or git.
- **Risk to note:** the Upstox client secret has to be stored locally for the token exchange. Anyone
  with access to your Chrome profile could read it. That is acceptable for a personal, unpublished
  tool; an optional passphrase encryption comes in M9.
- Every log entry is redacted before it is stored or printed: `Authorization`, `x-api-key`, bearer
  tokens, Telegram bot tokens, the OAuth `code`, `client_secret`, access/extended tokens, and the
  exact values of your stored secrets.
- No content scripts, no remote code, no `eval`. Host permissions are limited to Upstox, NSE archives,
  Anthropic and Telegram API hosts.
- **Read-only towards the broker.** Apart from logging in and out, the only account requests are GETs (profile, funds, today's
  positions). There is no code path that places, changes or cancels an order or a GTT; the smoke test
  checks that no such request is ever made.
- Keep this repository private.
