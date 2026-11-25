# TradeBuddy 1.25.0 (2026-11-25)

This branch only holds the newest TradeBuddy app file, for updates from inside the app.

## What's new

- Auto-trader: new "Opening rush" - from 9:15 it buys stocks from the pre-open list that keep rising after the market opens (the other kinds still start at 9:30).
- It buys only as the stock makes a new high since the open, never after it fell back.
- Its safety net is close (0.3-1.2% below), so a wrong trade is a small loss and the position can be bigger for the same money at risk.
- How it sells is tested on past prices three ways - quick profit, half and half, or let it run - and it uses the one that did best after Upstox charges.
- "Kinds of trade" shows all three results.
- Fix: no second try in a stock that already lost money today.
- Fix: a late price no longer blocks a new trade again and again.
- Kept: the daily loss limit, keeping the day's profit and the drawdown brake.
- Not a guarantee - you place every order yourself.

## How to update

- **In TradeBuddy:** tap **Update now** on Home (or Me → App updates → Check now). Your practice money, settings and login stay.
- **Without the app:** open [TradeBuddy-1.25.0.apk](TradeBuddy-1.25.0.apk) on the phone → **View raw** to download → open the file → Install.

SHA-256 of the app file: `c70b9d2f9e54d8fbe9bc98bf0914112970bc178dc21f249e15c953e68721ba60` · built from commit `11ec1de` (tag `v1.25.0`) by the release pipeline.
