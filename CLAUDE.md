# Working on TradeBuddy (instructions for Claude Code)

TradeBuddy is a personal Android app (Capacitor + Preact) and its AWS server (`server/`), sharing `src/`.
The owner reads plain words; keep explanations simple.

## Never

* Place, change or cancel a broker order or GTT; the app and server are read-only towards Upstox.
* Put a secret (Upstox, Claude, Telegram, Firebase server key, `TB_API_TOKEN`, signing passwords) in code,
  git, logs or chat. Signing keys live only in the private `tradebuddy-keys` repository.
* Promise returns; this is not financial advice. Use only verified, real market data.
* Move or delete a tag; push to `main` or `updates` directly; create release tags yourself; run a deploy or
  touch production (`/opt/tradebuddy`, `/var/lib/tradebuddy`, AWS) — the release pipeline does that.

## Releasing a feature (docs/RELEASE_PIPELINE.md)

A release = a merged commit on `main` whose `package.json` version is higher than the newest `v*` tag.
1. Branch from `main`. Implement with tests.
2. Raise the version: `npm version x.y.z --no-git-tag-version --ignore-scripts` (versionCode = x·10000 +
   y·100 + z; patch for fixes, minor for features). Write `release-notes/x.y.z.txt`: 1–12 plain lines, the
   last one "Not a guarantee - you place every order yourself." for trading features.
3. Run all checks: `npm run typecheck && npm run server:typecheck && npx vitest run && npm run build &&
   npm run server:build && node scripts/release/gate.mjs && npm run smoke`.
4. Push the branch and open a pull request to `main`. The owner merges it (that is the approval; merge only
   when the owner explicitly asks). CI, the tag, the signed APK, the server deploy and the in-app update
   then happen automatically.
5. A server change that alters the database adds a NEW migration at the end of `server/src/storage/sqlite.ts`
   (never edit a released one) with a migration test; the deploy never rolls a migrated database back.
