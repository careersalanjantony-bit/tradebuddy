# TradeBuddy server — architecture and compatibility plan

Status: milestones 1 and 2 are built and tested (see [README.md](README.md)); milestones 3–5 are next.
The live feed reuses `src/background/feed.ts` unchanged, driven by `src/market/feedSupervisor.ts`.
Goal: TradeBuddy keeps watching NSE, analysing stocks and making signals with the phone app closed or the
phone off. One user, one Upstox account, Node 24 on Ubuntu 24.04 (AWS EC2, systemd). **Read-only towards
the broker** (no order, no GTT) — same rule as the app.

## 1. What the existing code already gives us (checked in the repo)

* The browser/Chrome/Capacitor surface outside `src/ui` is small and sits in a few files:
  * `chrome.storage.local` → `src/storage/kv.ts`, `local.ts`; `chrome.storage.session` → `session.ts`
  * `chrome.alarms` → `src/background/scheduler.ts` (6 daily jobs + a 30 s price poll)
  * `chrome.notifications` → `src/notify/chrome.ts`; `chrome.action` badge → `src/alerts/engine.ts`
  * `chrome.runtime` (manifest, id, onMessage) → `src/background/index.ts`, `router.ts`
  * `chrome.identity` → `src/upstox/auth.ts` (OAuth login only; **not needed** with an Analytics Token)
  * Capacitor → `src/platform/*` (`http.ts` already falls back to plain `fetch` when not native, so it
    runs on Node as is)
* IndexedDB (`idb`) is used by 10 files, about 30 call sites: `src/storage/db.ts` (stores instruments,
  candles, intraday, corporateActions, adjustments, alertLog, logs). Calls used: `get`, `put`, `add`,
  `getAll(range)`, `getAllFromIndex`, `count`, `delete(range)`, `clear`, `transaction().store.openCursor(range, dir)`,
  and the global `IDBKeyRange`.
* The live feed (`src/background/feed.ts`) uses the global `WebSocket` (Node 24 has one) and keeps
  prices in session storage (`quotes`, `lastPoll`, `feedStatus`); the protobuf decoding is pure
  (`src/data/feedProto.ts`), as are `quotesParse.ts`, `calendar.ts`, `src/indicators/*`, `src/ml/*`.
* All schedule maths is already in IST helpers (`src/lib/time.ts`, `background/schedule.ts`).
* The ML training runs in two Web Workers (`src/rising/train.worker.ts`, `src/advisor/shortModel.worker.ts`):
  on Node call the same functions directly (or in `worker_threads`).
* `src/background/index.ts` must **not** be imported on Node: it registers Chrome listeners, starts
  itself and wires about ten timers. The server gets its own entry that repeats that wiring
  (migrations, `scheduleAll`, `catchUp`, then `learnIfDue` +60 s, `testBreakoutsIfDue` +90 s, `testProtect` +120 s,
  `trainRisingIfDue` +150 s, `earlyTick` every 60 s, `preopenTick` every 10 s, news checks, short model hourly;
  skip the in-app update checks).

## 2. Architecture: run the same engine without a phone

Do not rewrite the trading code. Give it the same "ports" the phone gives it, implemented on the server:

| Browser / phone port | Server replacement |
| --- | --- |
| `chrome.storage.local` + `session` | SQLite key-value tables (session one is persisted too, so state survives restarts) |
| IndexedDB (`getDb`) | SQLite-backed facade of the call surface above, swapped in at bundle time for `src/storage/db.ts` |
| `chrome.alarms` | persistent scheduler (next run times stored in SQLite, computed in IST) |
| `chrome.notifications`, Android local notifications | notification service: alert history table + Firebase Cloud Messaging push |
| Capacitor HTTP | plain `fetch` (already the fallback) |
| browser `WebSocket` | `ws`-based class with ping/pong heartbeat, installed as `globalThis.WebSocket` |
| Analytics Token in `secrets` | read from the environment, never written to disk or Git |

Why bundle: the app imports without file extensions (`'../storage/local'`), which Node cannot load, so the
server is built with the project's own Vite (SSR build, target `node24`) into `server/dist/main.js`; systemd
runs that file. Tests run through vitest, which already handles these imports.

## 3. Proposed layout

```
server/
  ARCHITECTURE.md  README.md
  src/
    main.ts            entry: config -> logger -> storage -> engine -> http -> signals
    config.ts          env parsing and validation (secrets are never logged)
    log.ts             JSON logger, reuses src/lib/redact.ts
    lifecycle.ts       graceful shutdown (SIGTERM/SIGINT), fatal-error handling
    http/              server.ts router.ts auth.ts routes/{health,market,quotes,signals,alerts,learning}.ts
    storage/           sqlite.ts (WAL, migrations)  kv.ts (storage.local/session)  idb.ts (IndexedDB facade)
    adapters/          chrome.ts (storage, alarms, notifications, action, runtime)  secrets.ts  websocket.ts  notifier.ts
    engine/            engine.ts (boot, replaces background/index.ts)  scheduler.ts  marketClock.ts  feedSupervisor.ts
  tests/               vitest (also run by the root `npm test`)
  deploy/              tradebuddy.service  server.env.example  Caddyfile.example
vite.server.config.ts  SSR bundle -> server/dist/main.js
```

REST API (Bearer token from the environment, constant-time compare, bind to 127.0.0.1 behind Caddy/nginx
for HTTPS): `GET /healthz`, `/readyz`, `/v1/health`, `/v1/market/status`, `/v1/quotes`, `/v1/rising`,
`/v1/falling`, `/v1/breakouts`, `/v1/watchlist`, `/v1/plans`, `/v1/learning`, `/v1/alerts`. The signal
endpoints read what the shared jobs already store (`rise`, `shortIdeas`, `breakouts`, `early`, `preopen`, …).

## 4. Milestones

1. **Foundation** — config, JSON logging, SQLite KV + session, `/healthz` `/readyz` `/v1/health`, graceful shutdown,
   systemd unit, tests. *(first milestone you asked for)*
2. **Live Upstox monitoring** — Analytics Token from the environment, `ws` transport with heartbeat, feed supervisor
   (reconnect with backoff, silence watchdog, subscription plan with the 1500 "full" / 2000 mixed limits, health
   numbers), market clock with holidays, quotes persisted, `/v1/market/status` and `/v1/quotes`; tested against a
   local fake feed. *(second milestone you asked for)*
3. **Headless jobs** — chrome adapter, IndexedDB facade, scheduler; run `dataJobs`, `dayJobs`, `breakoutJobs`,
   `risingJobs`, `shortJobs`, `earlyJobs`, `preopenJobs`, `mlJobs` unchanged; signal endpoints.
4. **Alerts and push** — notification service, alert history, FCM (HTTP v1, service-account file kept outside Git).
5. **Android server mode** — the app reads the REST API and registers a push token, without breaking the
   stand-alone mode; stop duplicate alerts between phone and server.

## 5. Compatibility issues and decisions to confirm

* **No real IndexedDB on Node.** `fake-indexeddb` is memory only and the 5-minute history is large (hundreds of MB),
  so a disk-backed SQLite facade is planned.
* **`node:sqlite`** (built into Node 24) avoids native builds but still prints an "experimental" warning;
  `better-sqlite3` is the alternative if that is a problem.
* **Nobody drives the polls.** On the phone the open screen calls the fast 2-second price poll; the server needs its own
  cadence (30 s poll, faster while the market is open and the feed is silent).
* **Upstox limits:** at most 2 feed connections per user and shared request limits per token. Server + phone feed = 2
  connections; a second phone or a test client would break it.
* **Duplicate alerts** while both phone and server run: pick one sender (server) or de-duplicate by alert id.
* **Token:** the Analytics Token only reads market data (no account or funds); the server must not persist it.
* **FCM** needs `google-services.json` in the Android app and a service-account key on the server (neither in Git).
* **Dependencies to add:** `ws` (+ `@types/ws`) at least. Everything else uses Node built-ins.
* Set `TZ=Asia/Kolkata` for readable logs, but the code must keep using the IST helpers, not the machine zone.
