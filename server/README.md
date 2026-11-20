# TradeBuddy server

Keeps watching the NSE market when the phone app is closed or the phone is off. It runs the app's own
code (no second copy of the trading logic) on Node 24, stores everything in SQLite, and answers a small
REST API. **Read-only towards Upstox:** it never places, changes or cancels an order or a GTT.

Status: milestone 1 (server, health checks, storage, logging, graceful stop, systemd), milestone 2
(live Upstox monitoring: Analytics Token, Market Data Feed V3 with heartbeat and reconnect, market hours
and holidays, `/v1/market/status`, `/v1/quotes`) and milestone 3 (the app's own jobs on the server:
history downloads, the 30-second price poll and every check after it, day-trade signals, breakouts,
Rising now, Falling now / short selling, Early Movers, pre-open, learning, protective stops and targets,
alerts — on SQLite, with a persistent IST schedule and catch-up) are done. Push notifications (FCM) and
the Android server mode are next — see [ARCHITECTURE.md](ARCHITECTURE.md).

## Run it on your computer

```bash
npm ci
npm run server:build
TB_API_TOKEN=$(openssl rand -hex 32) UPSTOX_ANALYTICS_TOKEN=... npm run server:start
curl http://127.0.0.1:8787/healthz
```

Or put the settings in `server/.env` (ignored by Git) and run `npm run server:dev`.
Checks: `npm run server:typecheck` and `npm run server:test` (also part of `npm test`).

## Settings (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `TB_API_TOKEN` | — | Bearer token for `/v1/*`, at least 32 characters. Empty = API off. |
| `UPSTOX_ANALYTICS_TOKEN` | — | Upstox Analytics Token (market data only). Empty = no prices. |
| `TB_HOST` / `TB_PORT` | `127.0.0.1` / `8787` | Where to listen. Keep it local; HTTPS comes from a proxy. |
| `TB_LIVE_FEED` | `on` | Live feed during pre-open and market hours. |
| `TB_HISTORICAL_REQUESTS_PER_MINUTE` | `30` | Shared requests per minute for daily and 5-minute candles and corporate actions. |
| `TB_JOBS` | `on` | The app's own jobs (scans, signals, alerts, learning). `off` = milestone 2 only. |
| `TB_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |
| `TB_DATA_DIR` | `STATE_DIRECTORY` or `./server-data` | SQLite database folder. |
| `TB_SHUTDOWN_TIMEOUT_MS` | `20000` | Longest graceful stop. |

Secrets are only ever read from the environment. The server never writes them to its database or its
logs (log entries are redacted).

## Deploy on AWS EC2 (Ubuntu 24.04)

```bash
# Node 24 (NodeSource) and git
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git

# a user without login, and the code in /opt/tradebuddy
sudo useradd --system --home /opt/tradebuddy --shell /usr/sbin/nologin tradebuddy
sudo git clone -b app-v1 https://github.com/careersalanjantony-bit/tradebuddy.git /opt/tradebuddy
cd /opt/tradebuddy && sudo npm ci && sudo npm run server:build && sudo npm run server:test

# settings (secrets) — readable by root and the service only
sudo install -d -m 750 -o root -g tradebuddy /etc/tradebuddy
sudo install -m 640 -o root -g tradebuddy server/deploy/server.env.example /etc/tradebuddy/server.env
sudo nano /etc/tradebuddy/server.env

# the service
sudo cp server/deploy/tradebuddy-server.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now tradebuddy-server
systemctl status tradebuddy-server
journalctl -u tradebuddy-server -f
curl http://127.0.0.1:8787/readyz
```

HTTPS: see [deploy/Caddyfile.example](deploy/Caddyfile.example). Open only 443 (and 80) in the security
group, never 8787.

Update: `cd /opt/tradebuddy && sudo git pull && sudo npm ci && sudo npm run server:build && sudo systemctl restart tradebuddy-server`.

### Updating a milestone 2 server to milestone 3

```bash
sudo systemctl stop tradebuddy-server
sudo cp -a /var/lib/tradebuddy /var/lib/tradebuddy.bak-m2      # the database, to go back if needed
cd /opt/tradebuddy && sudo git fetch && sudo git checkout server-backend && sudo git pull
sudo npm ci && sudo npm run server:typecheck && sudo npm run server:test && sudo npm run server:build
echo 'TB_JOBS=on' | sudo tee -a /etc/tradebuddy/server.env      # on is also the default
sudo systemctl start tradebuddy-server && journalctl -u tradebuddy-server -f
curl -s -H "Authorization: Bearer $TB_API_TOKEN" http://127.0.0.1:8787/v1/health | head -c 600
```

The database moves to schema 2 by itself on the first start (new tables only). The first start also
downloads the price history (daily candles and 5-minute days for about 535 stocks) within Upstox's
limits — that takes a while. `/v1/health` reports the daily and 5-minute stock counts and retry state
under `upstox.historical`, alongside the queue's request rate and cooldown. Downloads resume from
SQLite checkpoints after a restart. Live prices use their own request budget. To go back: stop the
service, restore `/var/lib/tradebuddy.bak-m2`, check out the previous commit, build, start (a milestone 2
server refuses a schema 2 database, so the restore is needed). Only one server may use a database:
a second start on the same data folder is refused.

What systemd does: starts the server at boot, restarts it 5 s after a crash (not after exit code 78,
which means a bad setting), sends SIGTERM on stop and waits 30 s. On SIGTERM the server stops taking
requests, finishes running tasks, closes the feed, saves everything and exits.

## API

Health checks need no token. Everything under `/v1` needs `Authorization: Bearer <TB_API_TOKEN>`.
Answers are JSON. 20 wrong tokens from one address within 10 minutes → `429` for a while.

| Call | Answer |
| --- | --- |
| `GET /healthz` | Process alive: `{status, version, uptimeSeconds}` |
| `GET /readyz` | `200` when the database is open and start-up finished, else `503` |
| `GET /v1/health` | Everything: database, market phase, Upstox token, API status and historical progress, feed (state, last price, subscription, reconnects, heartbeat), price poller, tasks |
| `GET /v1/market/status` | Phase (`pre_open`, `open`, `after_close`, `holiday`…), today's session times (IST), next open, holiday list, feed, last price poll |
| `GET /v1/quotes` | Latest prices of every watched instrument; `?keys=NSE_EQ\|INE…,NSE_INDEX\|Nifty 50` for some only |
| `GET /v1/quotes/{key}` | One instrument (URL-encode the key) |
| `GET /v1/events?limit=50` | The server's journal: starts, stops, alerts |
| `GET /v1/rising` | Rising now (`rise`: rows with the learned keep/sell tag, plans, held stocks), Early Movers (`early`), the pre-open list (`preopen`), flow risers |
| `GET /v1/intraday` | The Intraday scanner (app 1.19): the latest 15-second round over every NSE EQ stock — BUY / WAIT / NO TRADE rows with breakout time, VWAP, volume surge, entry, stop-loss, target, risk : reward — the BUY alerts sent today, and the past test |
| `GET /v1/falling` | Falling now / sell-first ideas (`shortIdeas`: score, reasons, plan with entry, buy-back stop, targets, quantity, risk) and market breadth |
| `GET /v1/breakouts` | Today's breakout ideas (`breakouts`) and day-trade signals (`daySignals`: entry, stop-loss, target) |
| `GET /v1/watchlist` | Your stocks with their latest prices, and the scan list summary |
| `GET /v1/plans` | Trade plans (entry, stop-loss, target, quantity, status), day trades, the auto-trader's trades |
| `GET /v1/learning` | The learned models and every past test (day trade, breakout, Early Movers, short, auto-trader protection) |
| `GET /v1/alerts?limit=100` | Every notification (newest first), the price-alert rules, unread count |

The `/v1` signal answers are the app's own stored data structures, unchanged (`at` = when the server
answered). `/v1/health` also lists the scheduled jobs (`jobs`) and every repeating task.

## How it works

* `src/engine.ts` starts everything in order and stops it in reverse order.
* `src/adapters/` gives the shared app code what a phone gives it: `chrome.storage` on SQLite
  (`storage/kv.ts`), secrets from the environment, a WebSocket with a ping/pong heartbeat.
* `src/market/feedSupervisor.ts` drives the app's own feed code (`src/background/feed.ts`) every 5 s:
  connects in pre-open and market hours only, reconnects after 90 s without prices, reports health.
* `src/market/quotePoller.ts` polls prices over REST with the app's functions: a full poll every 30 s,
  light polls every 5 s while the feed is not delivering, the closing prices once after the close.
* Holidays come from Upstox (`/v2/market/holidays`, checked hourly, refreshed weekly); all times are IST.

Upstox allows 2 feed connections per user: this server and one phone with the app open use both.
