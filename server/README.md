# TradeBuddy server

Keeps watching the NSE market when the phone app is closed or the phone is off. It runs the app's own
code (no second copy of the trading logic) on Node 24, stores everything in SQLite, and answers a small
REST API. **Read-only towards Upstox:** it never places, changes or cancels an order or a GTT.

Status: milestone 1 (server, health checks, storage, logging, graceful stop, systemd) and milestone 2
(live Upstox monitoring: Analytics Token, Market Data Feed V3 with heartbeat and reconnect, REST price
polls, market hours and holidays, `/v1/market/status`, `/v1/quotes`) are done. The signal endpoints
(rising, falling, breakouts, watch list, entry / stop-loss / targets, learning, alert history) and push
notifications are the next milestones — see [ARCHITECTURE.md](ARCHITECTURE.md).

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
| `GET /v1/health` | Everything: database, market phase, Upstox token and API status, feed (state, last price, subscription, reconnects, heartbeat), price poller, tasks |
| `GET /v1/market/status` | Phase (`pre_open`, `open`, `after_close`, `holiday`…), today's session times (IST), next open, holiday list, feed, last price poll |
| `GET /v1/quotes` | Latest prices of every watched instrument; `?keys=NSE_EQ\|INE…,NSE_INDEX\|Nifty 50` for some only |
| `GET /v1/quotes/{key}` | One instrument (URL-encode the key) |
| `GET /v1/events?limit=50` | The server's journal: starts, stops, alerts |

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
