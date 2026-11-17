# API facts verified against official docs

Each entry: what the spec said, what the docs say (with date checked), and what the code does.
Items still marked **VERIFY** need a real API response from the owner.

## Upstox — authentication (checked 9 Nov 2026)

Sources: upstox.com/developer/api-documentation/{authentication, authorize, get-token, logout, get-profile,
response-structure, error-codes, rate-limiting} (the `.md` versions).

| Item | Docs say | Code |
|---|---|---|
| Authorize URL | `GET https://api.upstox.com/v2/login/authorization/dialog` with `client_id`, `redirect_uri`, `response_type=code`, optional `state` | `src/upstox/oauth.ts` |
| Redirect | `<redirect_uri>?code=…&state=…`; docs advise a random `state` and checking it | state checked, max age 10 min |
| Token exchange | `POST https://api.upstox.com/v2/login/authorization/token`, `accept: application/json`, `Content-Type: application/x-www-form-urlencoded`, body `code, client_id, client_secret, redirect_uri, grant_type=authorization_code`. Code is single-use even on failure | `src/upstox/auth.ts` |
| Token response | Docs example is **flat** (not wrapped in `data`): `email, exchanges, products, broker, user_id, user_name, order_types, user_type, poa, is_active, access_token, extended_token` | parser accepts flat or `{data: …}` |
| Expiry | "valid until 3:30 AM the following day, regardless of when generated"; a token made at 2:30 AM expires 3:30 AM the same day. Timezone not stated | next 03:30 **IST** after issue time. **VERIFY** timezone (observe a real expiry) |
| extended_token | "designed for prolonged usage, primarily for read-only access". Error `UDAPI100067` = API not permitted with extended_token. Validity not documented | stored, **not used** |
| Logout | `DELETE https://api.upstox.com/v2/logout` → `{status:"success", data:true}` | best effort, then local tokens cleared |
| Profile | `GET https://api.upstox.com/v2/user/profile` → `{status, data:{user_id, user_name, …}}` | used by "Test connection" and startup check |
| Error format | `{status:"error", errors:[{error_code, message, property_path, invalid_value}]}` (camelCase variants deprecated) | `src/upstox/errors.ts` reads both |
| Error codes | `UDAPI100050` invalid token; `UDAPI100016` invalid credentials; `UDAPI100068` bad client_id/redirect_uri (authorize); `UDAPI100069` bad client_id/secret; `UDAPI100070` bad redirect_uri; `UDAPI100057` invalid auth code | friendly messages in `errors.ts` |
| Redirect URL rule | URLs ending in `.php` etc. may be blocked | ours ends in `/upstox` — fine |
| App console | `https://account.upstox.com/developer/apps` | README |

### Analytics Token (new since the spec was written)

- Generated at `https://account.upstox.com/developer/apps#analytics` → Analytics tab → Generate Token.
- **1-year validity, read-only (GET only), no OAuth flow.** One per account; generating a new one revokes the old.
- Works **without static IP** for: Charges, Margins, Market Quote, Historical Data, Option Chain, Market Information
  (holidays/timings/status), Fundamentals, News, IPO, **Websocket**.
- Account APIs (User/profile, Portfolio/holdings/positions, Orders, GTT, P&L) need a **whitelisted static IP**.
- Code: optional `upstoxAnalyticsToken` secret. Market-data calls prefer it; account calls always use the daily
  access token. Effect: prices, candles, scans and (M4) the live feed can keep working without the morning login.
- **VERIFY** with a real token: that `/v2/market/holidays` accepts it from a home connection (no static IP).

### Other ways to log in (not used)

- TOTP login: `POST /v2/totp-login/authorization/token` with header `x-api-key` and body `{totp, pin}`. Would need the
  owner's PIN and TOTP secret stored in the browser — rejected (too much power for a read-only tool).
- Manual token from the developer dashboard, or "Access Token Request" pushed to a notifier URL — need copy-paste
  or a server; not used.

## Upstox — rate limits (checked 9 Nov 2026)

Standard APIs: 50/s, 500/min, 2000/30 min, per API per user (unchanged from spec). Client limiter: 40/s, 450/min,
1800/30 min. Order APIs: 10/s for regular algos — irrelevant (no order APIs).

## Upstox — market calendar (checked 9 Nov 2026)

| Item | Docs say | Code |
|---|---|---|
| Holidays | `GET /v2/market/holidays` (current year) and `/v2/market/holidays/{YYYY-MM-DD}`. Each entry: `date`, `description`, `holiday_type` (`SETTLEMENT_HOLIDAY` / `TRADING_HOLIDAY` / `SPECIAL_TIMING`), `closed_exchanges[]`, `open_exchanges[{exchange,start_time,end_time}]` (epoch ms) | `src/data/calendar.ts` |
| Holiday quirk | The docs' own example lists "New Year Day" as `TRADING_HOLIDAY` with NSE in `open_exchanges` 09:15–15:30, and a Saturday "Special DR Trading" with NSE open | NSE is **closed** only if listed in `closed_exchanges`; if listed in `open_exchanges`, its times are used (weekends included). `holiday_type` alone is not trusted |
| Timings | `GET /v2/market/timings/{date}` → `[{exchange, start_time, end_time}]` (spec's "VERIFY path" resolved) | not needed in M1 (holidays carry special times) |
| Exchange status | `GET /v2/market/status/{exchange}` → `NORMAL_OPEN`, `NORMAL_CLOSE`, `PRE_OPEN_START`, `PRE_OPEN_END`, `CLOSING_START`, `CLOSING_END`; NSE_EQ also `cas_eligible_status` | not used in M1 |
| Closing Auction Session | For CAS-eligible stocks continuous trading closes ~15:15 IST, auction 15:20–15:30 | noted for M4/M5 (alerts after 15:15 may see auction prices) |
| Auth | All market-information endpoints need `Authorization: Bearer` (daily or analytics token) | holidays fetched after login or with analytics token |

## Confirmed with the owner's real account

| Date | What | Result |
|---|---|---|
| 9 Nov 2026, 17:21 IST | Real OAuth login from Chrome (Windows) via `launchWebAuthFlow` + token exchange from the service worker | **Works.** Token response parsed, user name returned. The token POST from the extension is accepted (no Origin/CORS problem). |
| 9 Nov 2026 | `GET /v2/market/holidays` with the daily token | **Works.** 22 entries for 2026. |
| pending | Expiry at 03:30 **IST** | Check on 10 Nov after 03:30 IST: the status should show "session ended", and a call with the old token should get 401. |
| pending | Analytics Token from a home connection (no static IP) | Not tried yet. |

## Upstox — market data (checked 9 Nov 2026, from docs + the real instruments file)

| Item | Finding | Code |
|---|---|---|
| Instruments file | `https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz` — JSON array, 84,868 rows; 2,754 `NSE_EQ`/`EQ`. Fields: `instrument_key`, `trading_symbol`, `name`, `short_name`, `isin`, `tick_size`, `lot_size`, `security_type`, `cas_eligible`… | `src/data/instruments.ts` |
| **tick_size unit** | **Paise, not rupees.** Real values: 1, 5, 10, 50, 100, 500 (SBIN 5 = ₹0.05, RELIANCE 10 = ₹0.10, EICHERMOT 50 = ₹0.50, MRF 500 = ₹5). Same stock shows 5.0 on NSE and 1.0 on BSE. Docs don't state the unit | `tick = tick_size / 100` |
| Nifty 50 key | `NSE_INDEX|Nifty 50` (spec's VERIFY resolved) | |
| LTP v3 | `GET /v3/market-quote/ltp?instrument_key=k1,k2` (≤500). Response `data` is keyed by `EXCHANGE:SYMBOL`, **not** by instrument key; each item has `instrument_token` (= instrument key), `last_price`, `ltq`, `volume`, `cp` (previous close) | map by `instrument_token` |
| OHLC v3 | `GET /v3/market-quote/ohlc?instrument_key=…&interval=1d` → `last_price`, `instrument_token`, `live_ohlc{open,high,low,close,volume,ts}`, `prev_ohlc{…}` | today's partial candle from `live_ohlc` (spec's "which mode carries day OHLC" answered for REST) |
| Daily candles v3 | `GET /v3/historical-candle/{key}/days/1/{to}/{from}`; days available from Jan 2000, max 1 decade per request; candle = `[ts "YYYY-MM-DDT00:00:00+05:30", o, h, l, c, volume, oi]`. Docs example is oldest-first; code sorts anyway. Adjusted or not: **not stated** | gap-checked adjustment |
| Corporate actions | `GET /v2/fundamentals/{isin}/corporate-actions` → `[{name, expiry_date "14 Aug 2025", amount, ratio "1:1"|null, event_details[{name,value}]}]` | ratio direction not documented → each reading is tested against the price gap |

## Still to confirm with real data (v0.3.0)

| Item | How it will show | What the code does meanwhile |
|---|---|---|
| Are Upstox daily candles adjusted for bonus/split? | Diagnostics → Data check: SMA200 within ±0.5% of the 9 Nov values; stock page says "Adjusted for: …" when the app fixed it | gap-checks every bonus/split |
| `ratio` direction for bonus/split | same | tries every reading, keeps the one that matches the gap |
| `prev_ohlc` with `interval=1d` = previous day? | day % on the watchlist vs Upstox app | uses LTP v3 `cp` first, `prev_ohlc.close` only as fallback |
| When the day's candle is final | candle for today appears after the 16:00 / 18:00 sync | today's candle is only stored ≥ 30 min after the close; until then the live quote stands in |
| Analytics Token from a home connection | Settings → Analytics Token → "Token works" | falls back to the daily login |

## Confirmed with the owner's real data — 9 Nov 2026, ~19:00 IST (v0.4.0)

| Item | Result |
|---|---|
| Data check (spec §9 SMA200 on 8 Nov 2026) | **10/10 pass, all within ±0.01%** (ICICIBANK 1356.2, HDFCBANK 783.9, SBIN 1038.4, AXISBANK 1282.9, BAJFINANCE 974.6, BSE 3394.9, EICHERMOT 7394.0, SUNPHARMA 1811.4, ETERNAL 282.3, TRENT 2794.7) |
| Are Upstox v3 daily candles adjusted? | **Yes.** TRENT (1:2 bonus, Jun 2026), BAJFINANCE (bonus + split, Jun 2025), HDFCBANK and BSE bonuses all match without the app adjusting anything (no "(adj.)" shown). The gap-check stays as a safety net. |
| Instruments download, watchlist seeding, LTP/OHLC polling, history sync (11 stocks) | Work from Windows Chrome. |
| When is the day's candle available? | **Not by 19:03 IST on the same day** (last daily candle was 8 Nov at 19:03 on 9 Nov). Fix in v0.5.0: history sync right after login and at 09:20; day % taken from the quote's `cp` (previous close). |

## Upstox — funds (checked 9 Nov 2026, v0.5.1 capital helper)

| Item | Docs say | Code |
|---|---|---|
| Fund and Margin V3 | `GET https://api.upstox.com/v3/user/get-funds-and-margin`, headers `Accept: application/json`, `Api-Version: 3.0`, `Authorization: Bearer` → `data.available_to_trade.total` and `data.available_to_trade.cash_available_to_trade.total` (net cash available to trade) | `src/advisor/capital.ts` `parseFunds`; daily login only (User APIs need a static IP with the Analytics Token) |
| Old V2 response change | From 19 Jul 2025 V2 returns equity + commodity combined in `equity` | not used |
| **VERIFY** | real response shape from the owner's account | the helper also accepts a typed amount |

## NSE index constituents (checked 9 Nov 2026, v0.7.0)

| Item | Finding | Code |
|---|---|---|
| Nifty 50 list | `https://nsearchives.nseindia.com/content/indices/ind_nifty50list.csv` (also on `archives.nseindia.com`) — CSV `Company Name,Industry,Symbol,Series,ISIN Code`, 50 rows | `src/data/universeParse.ts` |
| Nifty 100 list | `…/ind_nifty100list.csv`, same format, 100 rows | bundled copy in `src/data/indexLists.ts` |
| Match with Upstox | all 150 ISINs exist as `NSE_EQ|<ISIN>` in the Upstox instruments file | `memberKey` |

## Prices outside market hours (v0.8.0)

| Item | Finding | Code |
|---|---|---|
| Owner report, 9 Nov 2026 evening | after installing 0.7.0 the screens showed older prices until "Refresh prices" was clicked: the poll only ran in market hours (plus one hour after the close), and the stored daily candle for the day is not published until late at night | `pollDue` in `src/data/calendar.ts` |
| Fix | closed market: one poll when no poll happened since the last session's close (retry every 5 min after a failure); also at service-worker start and when the panel opens. The quote then supplies the last session's candle until the daily candle is stored | `quoteSessionDate`, `liveCandle` |
| **Not yet verified on real data** | what LTP v3 `cp` and OHLC v3 `live_ohlc` return between midnight and 09:00 (assumed: the last session's values). If `live_ohlc` is empty then, the last price alone is used for the candle | `liveCandle` falls back to `ltp` |

## Day-trade mode (checked 11 Nov 2026, v0.11.0)

| Item | Finding | Code |
|---|---|---|
| 5-minute history | `GET /v3/historical-candle/{key}/minutes/5/{to}/{from}`; minutes data "Available from January, 2022"; "1 month - Applicable for intervals ranging from 1 to 15 minutes"; candle `[ "2025-01-12T15:15:00+05:30", o, h, l, c, volume, oi ]` (bar start time) | `src/data/intraday.ts` (28-day requests) |
| Today's candles | `GET /v3/historical-candle/intraday/{key}/minutes/5` — "current trading day"; docs example is newest-first; code sorts | `fetchTodayBars` |
| Upstox intraday charges | upstox.com/brokerage-charges: Equity Intraday brokerage "₹20 per executed order or 0.1% (whichever is lower)"; STT 0.025% on the sell side; NSE transaction 0.00297% buy & sell (from 1 Oct 2024); stamp duty 0.003% buy side; GST 18% on brokerage + transaction charges; SEBI ₹10/crore assumed | `intradayCharges` in `src/daytrade/rules.ts` |
| Equity Delivery brokerage | "₹20 per executed order" (the swing estimate of 0.25% per round trip is on the safe side for trades above ~₹20,000) | settings `chargesEstimatePct` |
| NSE lists | `ind_nifty50list.csv` (50), `ind_nifty100list.csv` (100), `ind_niftymidcap100list.csv` (100), `ind_niftysmallcap100list.csv` (98 with series EQ), `ind_nifty500list.csv` (495 with series EQ) — same columns | `src/data/universeParse.ts`, bundled in `src/data/indexLists.ts` |
| **Not verified on real data** | how soon after 09:30 the 09:25 candle is published (the engine waits until 09:30:45); whether the first candle includes pre-open volume; whether candles are missing for 5-minute slots without trades (handled: bars are matched by time) | `dayTick`, `openingRange` |
| **Not verified** | that the rules make money: only the owner's machine has real 5-minute data. The in-app past test (older days → choose, newest days → verdict) is the check | `DayTestCard` |

## Account sync, live feed, news, market mood (checked 12 Nov 2026, v0.12.0)

| Item | Finding | Code |
|---|---|---|
| Today's positions | `GET /v2/portfolio/short-term-positions` — per position: `exchange`, `product` ("I" intraday, "D" delivery, "CO", "MTF"), `instrument_token` ("NSE_EQ\|ISIN"), `trading_symbol`, `quantity` (net), `day_buy_quantity`, `day_buy_price`, `day_sell_quantity`, `day_sell_price`, `last_price` | `src/portfolio/sync.ts` `parsePositions` (NSE/BSE equity, products I and D; BSE mapped to the NSE key) |
| Which token | Analytics Token: Portfolio and Orders APIs need a static IP; Market Quote, Historical, Fundamentals, News and Websocket do not. So positions are read with the **daily login token** | `tokenKind: 'account'` in `syncPortfolio` |
| Live feed | `GET /v3/feed/market-data-feed/authorize` → `data.authorized_redirect_uri` (one-time `wss://` address); subscribe with a **binary** frame `{guid, method:"sub", data:{mode:"ltpc", instrumentKeys}}`; messages are protobuf per `https://assets.upstox.com/feed/market-data-feed/v3/MarketDataFeed.proto` (copy in `tests/fixtures/`): `FeedResponse{type=1, feeds=2 (map), currentTs=3, marketInfo=4}`, `Feed{ltpc=1, …}`, `LTPC{ltp=1, ltt=2, ltq=3, cp=4}`; limits: 2 connections, 5000 keys in ltpc mode | `src/data/feedProto.ts`, `src/background/feed.ts` |
| News | `GET /v2/news?category=instrument_keys&instrument_keys=k1,k2` (at most 30 keys; past 7 days); response `data: { "<key>": [ { heading, summary, thumbnail, article_link, published_time (ms) } ] }` | `src/data/news.ts` |
| Index keys | `NSE_INDEX\|Nifty 50`, `NSE_INDEX\|India VIX` — both present in the real instruments file | `src/data/indices.ts` |
| No results calendar | the Fundamentals APIs have no "next results date" endpoint, so there is no "results today" warning; the only event flag is "in the news in the last 24 hours" (from the headlines) | — |
| Tested how | unit tests (parse, reconcile, the full "bought in Upstox → found → watched → sold → result" flow, decoder against protobufjs) and the browser smoke test against a fake Upstox with a fake positions endpoint, news endpoint and WebSocket feed | `tests/portfolio.test.ts`, `tests/feed.test.ts`, `scripts/smoke-test.mjs` |
| **Not verified on real data** | (1) whether Upstox lets this app read positions with the daily token (no static IP) — if not, the sync line shows Upstox's reason and trades are recorded by hand; (2) the real feed: how soon ticks start, whether index ticks arrive in ltpc mode, how long Chrome keeps the service worker's connection open (the 30-second check reconnects); (3) the real News API answers for these stocks; (4) how `day_buy_price` is reported after several partial fills (assumed: the average) | `UpstoxSyncLine`, Diagnostics → "Instant prices" |

## TradeBuddy app (checked 14 Nov 2026, app v1.0.0)

| Item | Finding | Code |
|---|---|---|
| Full market quote | `GET /v2/market-quote/quotes?instrument_key=…` — "up to 500 instruments in one go"; per stock `last_price`, `volume`, `average_price`, `net_change`, `total_buy_quantity` ("total number of bid quantity available for trading"), `total_sell_quantity`, `ohlc`, top-5 `depth` | `src/data/flow.ts` |
| Upstox charges used by practice money | Intraday as before; Delivery: ₹20 per executed order, STT 0.1% both sides, stamp 0.015% buy side, DP ₹20 + GST per sell | `src/wallet/wallet.ts` |
| MTF | Upstox: "Interest ₹20/day for every slab of ₹40,000 taken as MTF"; pledge/unpledge ₹20 + GST per scrip (owner question; the app does not model MTF) | — |
| Android build | Capacitor 8.6.0 (compileSdk/targetSdk 36, minSdk 24), signed release APK verified with `apksigner` | `android/` |
| **Not verified on a real phone** | in-app browser login redirect capture, local notifications, the special-use foreground service during market hours, WebSocket feed from the app's WebView | `src/platform/nativeBindings.ts` |

## Pre-open call auction (checked 17 Nov 2026, app v1.16.0)

upstox.com could not be opened from the build machine, so the fields were read from Upstox's own SDKs
(public GitHub repositories, both updated 17 Nov 2026): `upstox/upstox-nodejs`
(`src/feeder/proto/MarketDataFeedV3.proto`, `src/api/MarketQuoteV3Api.js`, `src/model/MarketQuoteSymbolV3.js`)
and `upstox/upstox-python` (`upstox_client/models/market_quote_symbol_v3.py`, its feed proto — identical
except for whitespace). `tests/fixtures/MarketDataFeed.proto` already matches them.

| Item | Finding | Code |
|---|---|---|
| Full Market Quotes V3 | `GET /v3/market-quote/quotes?instrument_key=k1,k2` — "up to 500 instruments in one go"; `data` keyed by "EXCHANGE:SYMBOL", each with `instrument_token`, `last_price`, `volume`, `average_price`, `total_buy_quantity`, `total_sell_quantity`, `prev_close_price`, `indicative_equilibrium_price` ("discovered during the call auction session"), `reference_price` ("against which the call auction price band is applied"), `indicative_equilibrium_quantity` ("matched at the indicative equilibrium price"), `indicative_imbalance_quantity_total` ("total indicative imbalance quantity in the call auction order book"), `indicative_imbalance_quantity_market` ("market-order component"), `cas_eligible` | `src/data/quotesParse.ts` `mergeFullQuotes`, `src/background/preopenJobs.ts` |
| Live feed (full mode) | `MarketFullFeed` adds `double iep = 11; double rp = 12; int64 ieq = 13; int64 iiqTotal = 14; int64 iiqM = 15; bool casEligible = 16;` and `LTPC.iep = 5` (`google.protobuf.DoubleValue`, set only in an auction); `MarketInfo.preOpenSessionStatus = 3` (`map<string, StatusInfo{string status = 1; int64 updatedTime = 2}>`) | `src/data/feedProto.ts` (signed int64 read with BigInt) |
| Imbalance sign | int64, so it can be negative, but neither SDK says which side a + or − means → shown as a size only; the buy / sell direction comes from `total_buy_quantity` vs `total_sell_quantity` | `PreDetail` |
| NSE pre-open timing | orders 9:00 to ~9:07–9:08 (random close in the last minute), then price discovery, trading from 9:15 (the owner's plan of 17 Nov 2026 uses the same schedule) | `src/early/preopen.ts` `PRE` |
| Tested how | decoder against protobufjs with Upstox's definition (incl. a negative imbalance and the session status), the V3 quote parser, the ranking points, the opening drive, a full fake morning (8:50 → 9:13 final → 9:15 drive → 9:47 record) and a phone-size browser run at 9:06 and 9:13 | `tests/preopen.test.ts`, `tests/preopenLive.test.ts`, `scripts/app-smoke.mjs` |
| **Not verified on real data** | (1) that Upstox fills these fields for every stock during 9:00–9:15 with the Analytics Token; (2) whether `total_buy_quantity` / `total_sell_quantity` show the auction's order book in the pre-open; (3) the exact `preOpenSessionStatus` words (`PRE_OPEN_START`, `PRE_OPEN_M_END`, `PRE_OPEN_END` from search results; shown as received); (4) whether the feed sends pre-open ticks before 9:15 — the app reads the quotes API every 15 s anyway | Home → Early Movers → More → data limits |
| No past pre-open data | Upstox's historical candles start at 9:15, so the ranking itself cannot be back-tested; the app writes each day's final 10 and their first 30 minutes to a record (`preopenRecord`) and tests the opening-drive rule on stored 5-minute days | `recordOutcomes`, `runOpenTest` |
