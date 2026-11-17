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

**Updates (from 1.5):** the app looks for a new version on start and every 5 minutes (since 1.8). When one is
ready, Home shows **Update now** (also Me → App updates → Check now). The first time, Android asks once
to "Allow from this source" for TradeBuddy; after that it is Update now → Android's **Update** button.
Practice money, settings and login stay. Without the app, download the newest `TradeBuddy-x.y.z.apk`
from the [updates branch](https://github.com/careersalanjantony-bit/tradebuddy/tree/updates) and
open it — it installs over the old one. Uninstalling deletes all app data, including practice trades.

**Signing keys (from 1.5.1).** Android only installs an update signed with the app's key. The first
key became public when this repository was made public (14 Nov 2026), so 1.5.1 switched to a new
key using Android's key rotation: on Android 9+ the app is signed with the new key plus a record,
signed by the old key, that hands over to the new one. Phones keep their data, and after 1.5.1 they
refuse files signed with the old key alone (its "rollback" right is off). Android 7–8 keep the old
key. **No keys are in this repository any more:** they live in the private `tradebuddy-keys`
repository; `npm run apk` (`scripts/build-apk.mjs`) expects it cloned next to this one.

## New in 1.16

- **🌱 Early Movers is now the first card on Home** — the main trading tool, one clean list that
  follows the clock. Each stock is one line (symbol, stage, the plan in a few words, price, %, score);
  tap it for the numbers. Past test, record and data limits sit behind one "More". Day trade keeps a
  link to it (no second copy).
- **Pre-open rising candidates (9:00–9:15)** — no more waiting until 9:20. From 9:00 every stock of
  the five indices is read every ~15 seconds from Upstox Full Market Quotes V3 (500 per request; the
  live feed adds the same numbers in between): the indicative opening price (IEP), the quantity that
  would match there, the unmatched quantity, the reference price and the waiting buy / sell quantity.
  Ranked with the owner's fixed points (set in advance, **not** a chance of rising):
  IEP gap above yesterday 25 (1% at least to be listed) · buyers vs sellers waiting 20 · matched
  quantity (size vs a usual day, and growing) 15 · good news since yesterday's close 15 (bad news:
  never listed) · yesterday's volume vs usual 10 · its sector's pre-open gap 10 · IEP steady near the
  end 5. Schedule: first ranking 9:05, re-checked when order entry closes (9:07–9:08), recalculated
  while the opening price is worked out, **final top 10 fixed at 9:13** with one alert. Missing data
  counts 0 and says "not available".
- **Opening drive (from 9:15)** — the final picks, and any stock that opens 1%+ up, are followed on
  every live price from 30 seconds after the open: holding above its opening price and the day's
  average price, gap kept, volume at least 1.5× the usual pace, buyers ahead → a plan at once (buy only
  above the high since the open, stop under VWAP / the low, 0.3–1.2%, targets 1R and 2R), sized for
  ₹10,000 / ₹50 risk including every charge, with an alert. A stock that falls back below its open is
  removed for the day. Setups and breakouts follow from 9:20 as before.
- **Honest testing:** Upstox keeps no past pre-open data, so the ranking cannot be back-tested — the
  app now writes each day's final 10 and how they did in the first 30 minutes (did +1% come before
  −1%? where at 9:45?) to a record shown on the card. The opening-drive rule is tested on the stored
  5-minute days against "just buy any gap-up at 9:20", older and newer half separately; nothing tuned.

## New in 1.15

- **🌱 Early Movers — Before the Rally** (first card on Day trade): stocks getting ready to rise
  BEFORE the big move, across the same live list of all five indices (each stock once).
  - **Potential setup:** up less than 4% today (and < 2.5% since the open), at/above the day's average
    price and EMA 9, RSI 50–72, at least 2× its usual volume (today so far or the last 5 minutes), and
    pressing within 1.5% under its resistance (today's high, or yesterday's high just above) with
    higher lows.
  - **Breakout — live, not confirmed:** the moment a live price crosses the breakout price with the
    candle's volume ≥ 1.5× usual (checked on every live price, ~1.5 s). **Confirmed:** the 5-minute
    candle closes above. A close back below = false breakout (removed). Expired signals (no breakout
    in 45 min, ran more than 1× the risk above the entry, fell to the stop) are removed and counted.
  - Each stock shows name, NSE symbol, price, % change, catalyst, relative volume, VWAP, RSI, EMA 9,
    breakout price, entry, stop-loss, two targets, a score out of 100 (how many independent signs
    agree — not a chance), the reasons and any warnings.
  - **Your money:** capital ₹10,000 and at most ₹50 risk per trade including brokerage, every Upstox
    Intraday charge and one tick of slippage (both changeable on the card). The quantity is the most
    shares that keep that limit without borrowing; a trade that cannot keep it is not shown. During a
    live breakout the quantity is worked out from the live price.
  - **Catalysts:** Upstox news for every scanned stock (30 per request) before the open and every 30
    minutes, read by words into results / order win / upgrade / corporate action / approval / deal /
    trouble, with the headline shown. There is no results database: growth numbers only when a
    headline says so. Bad news keeps a stock out.
  - **Gap-ups:** the opening gap from 9:15 (an indicative pre-open price from 9:00, marked as such).
  - **Institutional signs:** NSE's end-of-day bulk and block deal files and the delivery % (dated, last
    trading day). **FII / DII: not available** (NSE publishes it only on its website).
  - **Alerts** with sound and the in-app banner: a setup forming (score 60+), its live breakout and the
    confirmation — each once (new switch in Settings → Alerts).
  - **Past test** on the stored 5-minute history with the rules as fixed (nothing tuned): early (live
    breakout), early (after confirmation), "late chasers" (already up 4%+) and a plain baseline, with
    your capital and ₹ risk after charges, and the older and newer half of the days separately. Only
    price and volume can be tested (news, deals and the order book have no stored history).
  - A "Data, delays and what is not available" panel on the card.
- Today's Buy Ideas, Falling Now and Rising now stay as they were. Breakout detection is part of
  Early Movers; the separate Breakout Today card stays switched off as asked on 17 Nov.
- Fix: stocks whose 5-minute history arrives after the open get their usual volume within a minute
  (it was missing for the rest of the day).

## New in 1.14

- **📈 Rising now — live** (the first card on Day trade, also on Home). Every stock of the five indices
  is read on each live price (about every 1.5 seconds) from its current 5-minute candle — not after a
  15-second full-quote round — so a rising stock is listed the moment it qualifies, with a
  **"Just starting (< 1%)"** view for the early ones.
- **"Will it keep rising?" tag** on every rising stock: **▲ Likely to keep rising**, **◆ Unclear** or
  **▼ Slowing**. It answers the owner's quick trade exactly: bought now, does it gain 0.6% before it
  loses 0.4%, within 20 minutes? A model (logistic regression + small boosted trees, on the phone)
  learns this from the stored 5-minute history of all scanned stocks — 17 numbers per moment (moves
  over 5/15/30 minutes, volume against its usual volume at that time of day, price vs the day's average
  price, place in the day range, candle shape, RSI, short vs longer trend, the whole market). The
  newest 30% of the days are kept aside; the card shows how "likely" did on those unseen days next to
  all rising moments and the old Rising-today list, after charges. "Likely" is only used when that
  band clearly beat the average and made money after charges; otherwise nothing is tagged "likely".
  Never "100%", never "confirmed". It learns again every day after the market closes.
- **Quick-trade plan** on each stock: buy around, take profit (+0.6%), stop (−0.4%), sell-by time,
  the number of shares for your amount, Practice buy (Intraday) and the Upstox steps.
- **Your stocks now:** practice, "I bought this", real day trades and the auto-trader's stocks get the
  same reading with advice — "Likely to keep rising — keep, sell if it drops to ₹…", "Unclear — keep
  a tight stop at ₹…" or "Slowing — take the profit". Alerts: when a stock becomes "likely" (at most 10
  a day) and when a stock you hold turns to "slowing".
- **Long-term labels are marked as such:** "Clean uptrend · months", "Few days: Good to buy" — they
  come from months of daily prices, so a stock can carry them and still be down today. The live tag
  shows today's picture next to them on the Stocks tab.
- **Breakout Today is switched off** (card, alerts and the closed-app breakout check).
- The auto-trader takes "Rising now" quick trades from the "likely" stocks: after 20 minutes it keeps a
  trade only while it is still "likely to keep rising" (its safety net following the price), and sells
  at once when it turns to "slowing".

## New in 1.13

- **Amount to auto-trade.** A box at the top of the Auto-trader: type an amount, or tap **Use my
  Upstox balance** (reads "cash available to trade", read only, needs today's login). It changes the
  money without starting again — more is added to its cash, less is taken from its free cash; open
  trades and what it learned stay. Every trade is then sized for that money, so you can copy it share
  for share. It holds at most one stock per ₹25,000 (up to 10 at once), each at most a fair share.
- **Protect my money** (on by default; off = as before):
  - **keep the day's profit** — once the day is up +0.4% of the money, it may give back at most half
    of its best result; then it sells everything bought today and stops until tomorrow;
  - **daily loss limit** — at −1% it does the same;
  - **each trade** — the safety net moves to the buy price at 0.75× the risk in profit and then follows
    the best price; half is sold at 1× the risk; a same-day trade that is not working (or going
    nowhere) after 45 minutes is closed early;
  - **new trades** — "hold a few days" picks only up to 30% of the money; no buy on a stock with bad
    news today; nothing against a market clearly going the other way;
  - same-day buys are booked as Upstox **Intraday** (lower charges), paid in full (no borrowing).
  The levels can be changed on the card (+0.2/0.4/0.75/1%, −0.5/1/1.5/2%, 0/30/50/100%, 30/45/60 min).
- **Past test of the protection** on the stored 5-minute history (Nifty 100 + your stocks, up to 120
  days): the same same-day trades handled the old way and the protected way, after charges — total,
  worst day, days that gave back a good start. Shown honestly even when the protection earns less.
- **Copy in Upstox** on every open auto-trade (product, quantity, limit price, stop-loss trigger,
  target) and an **alert** each time it buys, sells half, sells or stops for the day (new switch in
  Settings → Alerts). The app still never places orders.
- **Not running** notice: when the app was closed or the phone asleep during market hours, the card
  says from when to when, that safety nets were checked against the missed 5-minute prices but no
  trades were opened, and how to keep it running (battery: Unrestricted).

## New in 1.12

- **Everything studies all five indices at once — there is no index to pick any more.** Nifty 50,
  Nifty 100, Nifty Midcap 100, Nifty Smallcap 100 and Nifty 500 are watched together (about 535
  companies, each once), by the Day Trade scanners, the Stocks tab, the top picks, prices and alerts.
  Phones that had one index chosen are moved to all five when they update (an old choice from a
  restored backup is ignored too).
- **Stocks tab:** the "List" picker is now **Show only** — All five / Nifty 50 / Nifty 100 / Midcap 100 /
  Smallcap 100 / Nifty 500. It only hides rows from the list; nothing stops being studied or scanned.
  Each stock shows its index ("Nifty 50", "Midcap 100"…).
- **Settings:** "Companies to study" is a plain line (all five indices) instead of a choice. The Day
  trade tab's "All five indices" switch from 1.11 is gone (it is always all five).
- **Past tests and the self-learning** use the Nifty 100 plus your own stocks: about 6 months of
  5-minute prices for every one of the ~535 companies would be too much for a phone. The other
  companies keep about 5 weeks of 5-minute prices (enough for the live scanners) and their full daily
  history (for the Stocks tab and top picks — one download per company, a few minutes the first time).

## New in 1.11

- **All three Day Trade scanners — Today's buy ideas, Falling now and Breakout today — watch every
  stock of Nifty 50, Nifty 100, Nifty Midcap 100, Nifty Smallcap 100 and Nifty 500 together**
  (about 500–540 stocks; the lists overlap, so each stock is counted and scanned **once**). The
  lists come from NSE once a week, with the copy bundled in the app as the fallback. Your own stocks
  outside these lists are scanned too. The Stocks-tab list no longer limits the scanners (from 1.12
  there is no list to pick at all).
- **Every idea card shows the stock's index** — the narrowest one it belongs to: "Nifty 50" for
  Reliance, "Midcap 100", "Smallcap 100", "Nifty 500", or "Your list". When two scanners find the same
  stock, both cards show it ("also in Breakout today") but **you get one alert**, not two: a stock
  already announced as a BUY (or SELL) by one scanner is not announced again in the same direction by
  another for 30 minutes. One card per stock in Breakout today (earlier breakouts are counted on it).
- **Upstox's live-feed limits, handled openly.** The feed takes up to 1,500 stocks with full details
  plus 500 more prices-only on one connection (5,000 prices-only with "Save mobile data"). The most
  important stocks go first (your trades and holdings, then your stocks, then the scan list). Any
  stock over the limit, or one without a tick for 15 seconds, gets its price by a normal price request
  every 3 seconds — also with the app in the background. The Day trade tab says how many stocks are
  on the feed and how many are checked by price request. No stock is skipped silently.
- **Nothing dropped for the day:** a stock whose 5-minute candles fail to load (or that joins the
  list during the day) is tried again at every 5-minute mark; the tab shows "N of M loaded", and how
  many have no past volume yet. Falling now says how many stocks it checked, how many are falling
  below today's open, and how many were scored in depth (the 150 falling most, when more fall).
- **History stays small on the phone:** the Stocks-tab list and the Nifty 100 keep about 6 months of
  5-minute prices (the past tests and the self-learning use them); the other scan stocks keep about
  5 weeks — enough for the live scanners. A stock that joins the Stocks-tab list gets its older
  history filled in. The closed-app breakout check covers the whole scan list too.
- **Mobile data:** live details for ~500 stocks are a lot of data (roughly 250–650 MB an hour on a busy
  day). On mobile data, turn on **Save mobile data** (prices only, about 125 MB an hour; volume checked
  every ~10 seconds).
- Risk controls are unchanged: the past tests, "practice only" until they pass, two losing day trades
  a day stop new trades, the risk-per-trade choices, the 3:10 pm close. The app still never places,
  changes or cancels an order.

## New in 1.10

- **Practice Buy / Sell works like the Upstox order window.**
  - **Product:** **Delivery** (pay the full price, keep the shares as long as you like), **Intraday**
    (pay only a margin — up to **5×** leverage for the biggest companies, 4× for the rest of the
    Nifty 500, 2× for others — and close the same day) and **MTF** (pay a margin — up to **4×**, 2.5× for
    the rest of the Nifty 500, not offered for small stocks — Upstox lends the rest at **₹20 a day for
    every ₹40,000** lent, every calendar day; the shares are pledged and unpledged for ₹20 + GST each).
    Upstox's exact leverage differs per stock and day; the order window says so.
  - **Order type:** Market, Limit (your price or better; slippage never crosses the limit), **SL**
    (when the price reaches the trigger, a limit order) and **SL-M** (at the trigger, a market order) —
    a stop-loss buy waits for the price to rise to its trigger, a sell for it to fall. **Validity:**
    Day or **IOC** (fills at once or is cancelled). Orders placed while the market is closed are
    **after-market orders (AMO)** that work from the next opening.
  - **Intraday rules:** no new Intraday trades after 3:15 pm; an Intraday trade still open at
    **3:20 pm is squared off by "Upstox" with a ₹59 charge** (₹50 + GST; Upstox's own time since
    22 June 2026) unless you tick "Close by itself at 3:10 pm"; a loss that eats 80% of the margin
    closes it (margin shortfall). Selling a stock you do not hold = Intraday **sell first** with the
    same margin; an Intraday buy buys it back.
  - **MTF rules:** interest taken from the cash every day; a big fall that leaves too little of your
    own money in it is shown as a margin shortfall and sells it for you if it gets worse.
  - **Money:** the window shows the order value, the margin you pay, what Upstox lends and its
    interest a day (MTF), **what is free now and the balance after this buy**, and the charges for
    buying and selling. The confirmation says the balance left.
- **Practice tab:** Available / Used margin / Positions at the top; each position has its product
  (Delivery, Intraday 5×, MTF 4×) with its margin, loan and interest; **Convert** like Upstox
  (Intraday → Delivery to keep it overnight, or Delivery bought today → Intraday); waiting orders in
  plain words (limit, stop-loss trigger → limit, AMO, IOC); **History shows the balance after every
  trade**, its charges and MTF interest.
- The auto-trader keeps trading with its own money only (Delivery, no leverage), so its record stays
  comparable.
- 1.10.1: **Used margin** includes the money kept aside for waiting orders (like Upstox); each waiting
  order shows how much it keeps aside (a market order: its margin + 1% in case the price opens higher;
  the price when it was placed is used until a live price arrives); the Buy window's "Balance after"
  matches it; "Today" counts MTF interest taken today.

## New in 1.9

- **🚀 Breakout Today — buy-first ideas** (Day trade tab, right below "Falling now"). From 9:15 the
  app builds every stock's 5-minute candle from the live Upstox prices and checks it on **every
  price update** (about once a second with the WebSocket feed, every 2 seconds without it):
  - **Breakout alert at once** — no waiting for the 5-minute scan — when the price goes at least
    0.05 % above the resistance (today's high of the finished candles; with only the first candle,
    the higher of it and yesterday's high; never below the day's high Upstox reports) **with a sudden
    volume surge** (this candle's volume ≥ 2× a normal candle's for the time elapsed, or a 1-minute
    candle ≥ 2× a normal minute), above **VWAP** and **EMA 9**, **RSI** 55–80, **momentum** (above
    today's open and +0.2 % over 15 minutes) and enough trading (₹25 lakh per candle).
  - **✅ Confirmed breakout** — a separate alert when the 5-minute candle **closes** above the
    resistance with ≥ 1.5× normal volume, above VWAP and EMA 9. Closing back below = failed.
  - Each idea shows the stock, **breakout price, current price, breakout time, volume increase,
    entry, stop-loss** (just under the broken level, 0.35 %–1.5 % below), **target 1** (1× the risk,
    half) and **target 2** (2×, the rest), and the **quantity for your ₹ risk** (₹50/100/200/500),
    with the result after charges at both targets and at the stop. Practice buy and Upstox steps.
  - **Too late** when the price already ran more than 0.8 % above the level (no alert), after
    10 minutes, or after 3:00 pm; marked when the stop-loss or target 2 is reached; old ideas are
    removed after 30 minutes. Each alert is sent **once** (remembered across app restarts).
  - **Genuine data only:** a price older than 15 seconds is never used; a candle the app could not
    follow from its start (app opened late, phone asleep) is read again from Upstox instead of being
    guessed, and confirmed from that real candle.
  - **Past test:** the confirmed rule (bought at the next candle's open, half at target 1 then the
    stop moves to the buy price, the rest at target 2, the stop or 3:10 pm) on the stored 5-minute
    history, older half vs newest half.
  - With the app closed, the background checker (about every 15 minutes) also looks for stocks
    breaking above **yesterday's** high with 1.5× the usual volume for the time of day, above the day's
    average price and with more buyers — at most 3 alerts a day.
- **Notification tones:** six original money sounds made for TradeBuddy (Cash register, Falling
  coins, Jackpot, Market bell, Profit chime, Soft pop) or the phone's own sound, with a preview, in
  Settings → Notification tone. Each tone has its own Android notification channel ("high
  importance"), so it also plays when the app is closed and the alert **pops up at the top of the
  screen**. "Send a test alert" and "Allow pop-ups in phone settings" (some phones switch pop-ups off
  for new apps). While the app is on screen, alerts appear as a banner inside the app with the tone,
  and tapping any alert opens its screen.
- **The auto-trader learns from breakouts** (a new kind of trade with its own weight and scorecard;
  its starting chance comes from the breakout past test) and from the Stocks tab's live **"For short
  selling"** list (each stock's own fall chance), besides the day-trade signals, Rising today, top
  picks and Falling now it already used. Older saved brains keep everything they learned.
- **Live feed in full mode** (volume, VWAP, waiting buy / sell quantities, 1-minute candles) for the
  breakout engine. It uses more mobile data (about 1.3 MB an hour per stock); **"Save mobile data"**
  on the Breakout card switches the feed to prices only (about 0.25 MB an hour per stock) — volume
  then comes from the ~10-second check, so alerts can be a few seconds later.

## New in 1.8

- **Auto-trader without limits:** no cap on open trades, on new trades a day, on a day's loss or on
  the share of money in one stock. Each trade risks a quarter of the Kelly fraction of its money
  (0.25 %–3 %, from its own chance and the reward), and it may put any amount in — up to all its free
  cash (no borrowing); when several good ideas appear at once, the free cash is shared by how good
  each one is. The time rules stay (same-day trades until 2:30 pm because they must close by 3:10).
  "New amount" starts it again with any amount you type (at least ₹10,000), keeping or forgetting
  what it learned.
- **Practice: Sell is always on.** It sells shares you hold, or — for any other stock — sells first
  and buys back the same day (buy-back-if-it-rises price, target 1 for half, target 2 for the rest,
  3:10 pm at the latest; market hours only). Both Buy and Sell open with **suggestions** ranked by the
  same analysis the auto-trader uses: the app's studies (day-trade model, top picks' record, the
  per-stock fall model, the 5-minute "Falling now" scan) corrected by what the auto-trader learned
  from its own results, live buyers vs sellers, the market's mood and today's news. Each shows its
  chance, plan, reasons and news mood; tapping one fills the form (sized so the loss at the safety
  net is about 1 % of the practice money, within the free cash).
- **News closer to real time:** Upstox has no live news stream, so the app asks often — today's
  ideas, rising and falling stocks and your shares every 2 minutes in market hours, the whole list
  every 15 minutes (also when the market is closed). The News tab shows a live dot and the time of
  the last update, and says why buy ideas / rising stocks show 0 while the market is closed (they
  fill in by themselves from the open).
- **Updates:** the app looks for a new version every 5 minutes (was 6 hours).
- **Lock screen and Home:** a drawn fingerprint (ridges draw in, a light scans over them, a soft ring
  pulses) instead of the ☝ sign; "Good evening Alan!" with your first name on Home and on the lock
  screen, and one short line under it that changes daily ("Plan the trade. Trade the plan.").

## New in 1.7

- **An instant alert for every new idea:** every day-trade BUY / SELL-first signal that is not late
  (no daily cap any more; ideas beyond your planned number of day trades or after your losing-trades
  limit still alert, with a note), every sell-first idea from the "Falling now" scan (score 60+, each
  stock once a day, safety cap 25), and new top picks (now also before an amount is set, sized for
  ₹1 lakh). Alerts → "New top picks" is a new switch.
- **Short selling: each stock its own chance** (`src/advisor/shortModel.ts`): a logistic regression +
  boosted trees ensemble trained once a day (in a Web Worker) on ≈ a year of daily candles of every
  stock in the list, on eleven numbers known at the open (distance from the 20-day average, 20 vs 50-day
  average, 4-week and 1-week move, RSI, lower highs, red-candle volume, yesterday's move, ATR %, the
  opening gap, the stock's own habit of falling). Label: the day ended ≥ 0.3 % below its open. It is
  first trained on the older two thirds of the days and tested on the newest third; the screen shows
  how its top-rated stocks really did on those unseen days. The old score bands are only used until
  the first model exists.
- **Tap a short-selling stock → full sell-first analysis** (Stock page → "Sell-first view"): entry,
  stop-loss (buy back if it rises to), target 1 / target 2, quantity for your ₹ risk, most you lose,
  risk : reward, results after charges; RSI 14 (daily and 5-minute), VWAP and price vs VWAP, EMA 9,
  today's high / low, volume (vs 20-day average, today's pace, last candle), trend, ATR, support and
  resistance, why it may fall, news with its mood, a practice button and the Upstox steps. During
  market hours the plan comes from today's 5-minute candles; otherwise from daily data (stop half an
  ATR above, 0.5–2 %).
- **News always there:** Upstox's News API only gives news per stock (30 per request, last 7 days), so
  the app asks for today's ideas, rising and falling stocks, top picks and your shares first, then
  the day's biggest movers and the rest of the list (up to 90 stocks) — every 15 minutes in market
  hours and every 45 minutes otherwise, weekends included. Headlines are kept for 7 days and saved on
  the phone. News mood is shown on every stock page (buy and sell-first views) and used by the
  short-selling list and the auto-trader.
- **Look:** a softer, darker red (less bright, less saturated); the bottom bar's active icon is round
  again (v1.6 drew a square frame around it); chart candles use the same colours.
- **120 Hz:** the app asks Android for the screen's fastest refresh rate at the current resolution
  (`preferredDisplayModeId`), and on Android 15+ marks the web view as wanting a high frame rate.
  The phone still decides (battery saver, its own smoothness setting).
- **Remembers where you were:** the Stocks tab keeps its view, filter, search and list length (also
  after a restart), the last-built list is shown at once when you come back, and the scroll position
  is restored when you return from a stock page (any tap stops the restore; the browser's own
  restore is switched off so they do not fight).

## New in 1.6

- **Black and red look:** deep black screens, red accents and gradients everywhere, a slow red glow
  behind the app, a light sweep across the main buttons, a glowing tab circle, cards that flash red as
  they slide in, live pulsing dots. Everyone is switched to the dark theme once (Me → Look still works).
- **Auto-trader (Practice → Auto-trader, and a live card on Home):** ₹50 lakh of pretend money that
  trades by itself during market hours, with no taps. Every minute from 9:30 it takes the ideas the
  app already finds — day-trade buy signals, "Rising today", the top picks and the "Falling now"
  sell-first ideas — and for each one works out a chance of making money and the expected result
  after charges (in R: 1 R = the planned loss at the safety net). It only takes ideas worth more than
  their risk, best first.
  - **Size (it decides):** about 0.5 % of its money at risk per trade (0.15 % unsure … 0.75 %
    confident), never more than 20 % of its money in one stock; at most 6 open trades and 10 new a
    day; no new same-day trades after 2:30; it stops for the day after losing 1.5 %.
  - **Managing trades:** safety net and target on every trade; once 1 R up the safety net moves to
    the buy price; same-day trades close by 3:10, top picks after 10 market days, sell-first trades
    buy back half at target 1. If the phone stopped the app during market hours, it replays the
    5-minute candles it missed (worst price first) so a hit safety net counts as hit.
  - **Learning (`src/bot/brain.ts`):** a small logistic model on 13 inputs (kind of trade, the
    studies' chance, today's move, buyers vs sellers, the whole market, time of day, news, distance
    from the day's average price, size of the safety net). It starts out equal to the studies'
    chance and takes one learning step after every finished trade (bigger surprises teach a little
    more), pulled gently back toward the studies so a few lucky trades do not swing it. A scorecard
    per kind of trade sizes down kinds that lose and pauses a kind after 10+ trades under 35 % wins
    with a loss. About 1 decision in 8 is a small test trade so it keeps learning.
  - **On screen:** money, today, overall, win rate, open trades moving live on a bar (safety net ←
    price → target), "What it did" timeline, finished trades with the lesson each one taught, "What
    it has learned" in plain words, a pause switch and resets (money only, or everything).
  - Pretend money only — it never sends anything to Upstox.
- **Stocks → "For short selling":** stocks that look most likely to fall today, scored on their
  trend (20/50-day averages, 4-week move, lower highs, RSI, heavy selling), today's opening gap, live
  price below the open and today's news. The chance shown is **measured**: the same score on every
  past day of every stock in the list (about a year), and how often those days ended ≥ 0.3 % below
  their open. Typical results are 40–60 %, not 80–90 %; the screen says so.

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
- **Publishing a version:** `npm run apk` (builds and signs `release/TradeBuddy-<version>.apk`), write
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
