# TradeBuddy (Android app)

Personal app for NSE stocks: day-trade signals, swing picks, a **₹10 lakh practice wallet**, a buyers
meter, news mood and **self-learning** that only switches itself on when it beats the plain rules on
days it has never seen.

> **Read-only towards the broker.** TradeBuddy never places, changes or cancels an order or a GTT.
> You place every real order yourself in the Upstox app. Not investment advice.

TradeBuddy grew out of the "Swing Trade Assistant" Chrome extension: all of its tested logic runs
inside the app (see *How it is built*).

## Install on an Android phone

1. Copy `TradeBuddy-<version>.apk` to the phone (or download it there).
2. Open it. Android asks to **allow installing from this source**. Allow it once, then tap **Install**.
3. Open **TradeBuddy**. The first-start guide explains the basics in 7 short steps.
4. **More → Settings**: paste your Upstox **Analytics Token** (Upstox → Developer Apps → Analytics;
   valid one year, read-only). Prices, history, news and the instant feed work with it.
5. Optional: the API key + secret and the daily **Log in to Upstox** let the app find the trades you
   make in the Upstox app by itself. The login uses the same redirect URL as the extension
   (`https://joalpejfcchnfbcjacmijbmmbmmnobio.chromiumapp.org/upstox`), so nothing changes in Upstox.
6. Allow notifications. During market hours a small "TradeBuddy is watching the market" notification
   keeps alerts working while the app is in the background.

**Updates (from 1.5):** the app looks for a new version on start and every 6 hours. When one is
ready, Home shows **Update now** (also Me → App updates → Check now). The first time, Android asks once
to "Allow from this source" for TradeBuddy; after that it is Update now → Android's **Update** button.
Practice money, settings and login stay. Without the app, download the newest `TradeBuddy-x.y.z.apk`
from the [updates branch](https://github.com/careersalanjantony-bit/tradebuddy/tree/updates) and
open it — it installs over the old one. Uninstalling deletes all app data, including practice trades.

**Signing key — to be replaced.** This repository was made public on 14 Nov 2026, so the signing key
in `android/signing/` (and its password) can now be read by anyone. Android only accepts an update
signed with the same key; with this key someone could build a fake "TradeBuddy" that installs over
the real one *if you open their file*. Until the key is replaced: install TradeBuddy only from the
updates branch or through **Update now**. The plan is a new private key with Android's key rotation
(`apksigner --lineage`), which keeps your data and makes phones refuse files signed with the old key.
It needs a private place to keep the new key (a private repository), never this public one.

## New in 1.5

- **Updates inside the app.** Each version is published on this repository's `updates` branch, which
  holds only the newest `TradeBuddy-x.y.z.apk`, `latest.json` (version, link, size, SHA-256,
  plain-words notes) and a README. The app downloads `latest.json` from raw.githubusercontent.com (a
  plain file, not the rate-limited GitHub API), and if it is newer shows **Update now** on Home and
  in Me → App updates, plus one notification.
- **Checks before installing** (the app's own Android plugin, `AppUpdaterPlugin.java`): only this
  repository's `updates` branch is accepted; the file size and SHA-256 must match `latest.json`; the
  file must be TradeBuddy, a newer version, and signed with the app's key. Then Android's own installer
  asks "Do you want to update this app?" — nothing installs without that tap. Android also refuses
  any file not signed with the same key.
- **Publishing a version:** build the APK, copy it to `release/TradeBuddy-<version>.apk`, write
  `release-notes/<version>.txt` (one plain-words line per change), push, then `npm run release`
  (replaces the `updates` branch with the new files, one commit, so it never grows).

## New in 1.4

- **Are more stocks rising or falling?** (Home and Day trade): every minute during market hours the
  app counts how many Nifty 500 stocks are up and down (±0.05 % counts as unchanged) and says in plain
  words what that means for a day trade, a few-day hold and selling first.
- **Falling now — sell-first ideas** (Day trade): every 5 minutes from 9:35 to 2:30 the app takes the
  15 stocks falling most (below today's open, more than 0.3 % down, Nifty 100 or ≥ ₹20 cr traded),
  downloads today's 5-minute candles and scores each finished candle out of 100: below the day's
  average price (VWAP), below EMA 9, lower highs, a strong red candle, a bearish engulfing candle,
  a shooting star, heavy selling volume, RSI 25–45 (very oversold counts against), below today's open
  and yesterday's close. Score 60+ is listed, highest first, with: **sell first at**, **buy back if it
  rises to** (above the last 3 highs and VWAP, 0.3–1.2 % away), **target 1** (1×, half the shares)
  and **target 2** (2×, the rest), **quantity** so the loss at the stop stays within your chosen risk
  (₹50 / ₹100 / ₹200), and the result **after Upstox intraday charges**. Score 75+ sends an alert
  (at most 3 a day; switch "Sell-first ideas" under Alerts). A warning shows when most stocks are rising.
- **Past test of the sell-first rules** on the stored 5-minute history (Nifty 100, at most 3 trades a
  day, same split into older and newest days as the buy rules). Until it passes, the card says
  "use practice only".
- **Practice sell-first:** the practice wallet can now sell first. Half is bought back at target 1
  (the rest's stop moves to the entry so it can no longer lose), the rest at target 2, at the stop,
  or at 3:10 pm. A sell-first trade is never kept overnight. Practice tab → "Sold first — buy back
  today" with a "Buy back now" button.
- Selling first is **not** lower risk than holding: it must close the same day, a sudden jump up can
  pass the stop, and with ₹50 risk the charges (≈ ₹10–45 a trade, more when the stop is close) are a big part of each trade.

## New in 1.3

- **Login to the app:** after the guide you create a profile (name + colour) and an optional
  **4-digit PIN** and **fingerprint** unlock. The PIN is never stored — only a salted PBKDF2 hash
  (150,000 rounds); after 5 wrong tries it waits 30 s per try; it locks again after the chosen time
  away (at once / 1 min / 5 min / never). There is no online account: nothing leaves the phone. The
  lock hides the screens; it does not encrypt the stored data. "Forgot PIN" can only delete all data.
- **Me tab (My account):** profile, practice record (value, overall, trades, win %, best/worst trade),
  Upstox connection status, security (lock, fingerprint, auto-lock, change PIN, lock now), look
  (dark / light / phone), alert switches, all other screens, your data (copy/restore a backup without
  keys or tokens, reset practice money, delete all data).
- **New navbar:** the active tab rises into a floating circle in a curved notch that glides to the
  tapped tab (CSS `@property` animation); 6 tabs: Home, Day trade, Practice, Stocks, News, Me.
- **Scrolling fix:** removed a page-wide `overflow-x: hidden` on `html, body` (can stop scrolling in
  some Android web views) and gave the scroll-in effect a safety net so cards always appear.

## New in 1.2

- **News tab** (bottom bar): news only for today's buy ideas (highest chance first), stocks rising now,
  top picks and your shares — grouped per stock, each with why it is there, a 👍/👎 mood line, filter
  chips and a Practice-buy button. The news requests follow the same priority (`newsTargets`).
- **Day trade redesigned:** idea cards with an animated chance ring, three price tiles (buy around /
  take profit at / sell if it falls to), buyers line, details folded; rising stocks with a buyers bar.
- **Stocks redesigned:** cards with a 30-day line, flashing prices, change pills, one-tap filter chips;
  "Rising / Falling today" now work from the live price before the history has downloaded.
- **More motion:** cards slide in as they scroll into view, pages slide left/right by tab, one highlight
  slides between the tabs, tap ripples, the practice-money card tilts and shines under your finger,
  a slow glow behind the Home header, animated empty states. Two columns on wide screens.

## New in 1.1

- **New look:** dark, calm design with gradients, line icons, smooth page and card animations, numbers
  that count up, prices that flash green/red, a bottom sheet for trades, toasts, a small celebration
  on a profitable practice sale, phone vibration on buy/sell. Respects the phone's "reduce motion".
- **Home in one glance:** greeting and market status, practice money with its chart, **one best idea**
  (the strongest fresh buy idea, else the top stock rising now to watch), a rising-now carousel, quick
  tiles, news. Details (tests, tables, learning) are one tap away.
- **Plain words:** "take profit at" and "sell if it falls to" instead of target / stop-loss, "buy ideas"
  instead of signals; the past test is folded away on the Day trade tab, which starts with today's plan
  (9:15 wait → 9:30 ideas → 11:30 hold → 3:10 close).
- **Alerts:** buy ideas (⭐ "strong idea" when self-learning passed its check and is ≥ 60% sure), stocks
  rising fast with buyers in control (max 3 a day), practice take-profit / sell-if-falls hits, a morning
  reminder. Switches in Settings → Alerts.
- **With the app closed:** a background checker (Capacitor Background Runner, `public/runners/background.js`)
  runs about every 15 minutes in market hours (Android's minimum for this). It checks practice shares
  and fast risers and records any practice sale with its price and time; the app applies it when it
  opens. For instant alerts keep the app in the background (not swiped away); some phone brands'
  battery savers can delay or stop background checks — allow TradeBuddy to run in the background.
- Day trading is on by default.

## What is in the app

| Tab | What it does |
|---|---|
| **Home** | Today at a glance: market mood, swing top picks, news (👍/👎), practice-money summary |
| **Day trade** | Self-learning status, **Rising now** (stocks rising with more buyers than sellers and busier than usual — a list to watch), live **▲ BUY / ▼ SELL** signals 9:30–11:30 with buy price, safety sell, target, *chance %*, buyers meter, news mood; the past test of the rules |
| **Practice** | ₹10,00,000 of pretend money. Buy/sell any NSE stock at the live price (market or limit), keep overnight or "sell at 3:10 pm", safety sell + target that sell by themselves, P&L today and overall after Upstox charges |
| **Stocks** | Nifty 50 / 100 / Midcap 100 / Smallcap 100 / 500 lists with plain-words labels and filters |
| **More** | Trades & alerts (real Upstox trades, GTT steps), Self-learning details, Guide, Settings, Diagnostics |

Phones get a bottom bar; tablets and laptop-size screens a side menu.

## Self-learning — how it works, honestly

- Every past day-trade signal in the 5-minute history (Upstox has 5-minute candles from January 2022)
  becomes an example: 15 things the app could see at that moment (opening volume vs usual, size of
  the first 15 minutes, gap, distance from the day's average price, candle strength, volume pace,
  yesterday's and last week's move, how jumpy the stock is, time, market direction, side, position in
  the day's range) and whether the trade made money **after charges and slippage**.
- Two models — logistic regression and gradient-boosted trees (depth 2) — are averaged into a
  chance. Written in plain TypeScript (`src/ml/`), they run on the phone in about a second.
- **Check on unseen days:** it learns on the older 2/3 of the days, picks its chance bar on the last
  quarter of those, then trades the newest 1/3 it has never seen. It is used for live signals **only if**
  it made money there **and** beat both the plain rules and simply taking every signal. Otherwise the
  plain rules stay in charge and the app says so (More → Self-learning).
- It learns again every evening (and right after the day-trade test), so it follows the market.
- Live-only clues (buyers meter, volume pace, news mood) are written to a journal from day one and
  can join the learning once enough days exist.
- Realistic expectation: good short-term trading wins about 55–60% of the time with small losses.

## Safety and privacy

- Keys and tokens stay **on the phone** (app storage). Android backup is switched off for the app,
  so nothing is copied to Google Drive or another phone. Never logged (redaction as in the extension).
- The only network hosts: `api.upstox.com`, `assets.upstox.com`, `nsearchives.nseindia.com`.
- Permissions: internet, notifications, a foreground service during market hours, vibration, wake lock,
  exact alarms (scheduled checks). Camera, microphone and location, added by libraries, are removed.
- The background checker keeps its own copy of the Analytics Token in the app's private storage on the phone.
- No order, GTT, modify or cancel endpoint exists in the code; the app smoke test checks that none is called.

## Not yet verified on a real phone

Built and tested here with unit tests and a browser run against a simulated live market; **not yet
run on a physical Android phone**. To confirm on the phone: the Upstox login window (in-app browser),
notifications, the market-hours background service, the instant feed (WebSocket) from the app.
Practice money, signals, lists and learning use the same tested code as the browser run.

## How it is built

- Vite + TypeScript + Preact web app (`src/`), packaged with **Capacitor 8.6** (`android/`).
- `src/platform/` replaces the Chrome APIs the extension used: storage (IndexedDB), messages (direct
  calls), alarms (timer), notifications (Android), Upstox login (in-app browser), HTTP (native, no CORS).
- New in the app: `src/wallet/` (practice money), `src/ml/` (self-learning), `src/data/flow.ts`
  (buyers meter, rising now), `src/data/sentiment.ts` (news mood), `src/ui/screens/{Practice,Guide,More,Learning}.tsx`.

```bash
npm install
npm test                 # unit tests (vitest)
npm run build            # web build into dist/
npm run smoke            # browser run with a simulated live market (Playwright)
npm run cap:sync         # copy the build into the Android project
cd android && ./gradlew assembleRelease   # signed APK (needs the Android SDK; sdk.dir in android/local.properties)
```

`scripts/make-app-art.mjs` renders the icons and splash screens.

## Credits

Charts: TradingView Lightweight Charts™ — Copyright © TradingView, Inc. (Apache-2.0).
