# Auto-trader v2 ("evidence first") — implementation plan

**Status: plan only, nothing is built yet.** Written 20 Nov 2026 against `main` (`ad54d2c`, app 1.20.2).
The auto-trader's files are identical on the PR #4 branch (`feature/firebase-push-m4`), so this work does
not clash with Milestone 4. The phone and the server run the same auto-trader code (the server through
`dataJobs.afterQuotes`), so every change below applies to both.

**What does not change:** pretend money only. Nothing here ever sends an order or a GTT to Upstox.
No rule here can guarantee a profit. The rules only stop the auto-trader from spending money on logic
that has not shown an edge after charges, and keep each loss small when it is wrong.

---

## 1. Why change it: what the code does today

| Today | Where | Problem |
|---|---|---|
| Most "chances" are set by hand (0.44–0.55) | `src/background/botJobs.ts:466–527` | With a 2R target, even a 45% guess looks profitable, so untested ideas get traded |
| Trades when EV > 0.05R, using that chance | `src/bot/policy.ts:154` | The filter is only as good as the guess |
| Charges are a flat 0.1% (intraday) or 0.25% (delivery) of the price | `src/bot/policy.ts:66` | Ignores the ₹20-per-order brokerage, so small trades look much cheaper than they are (§6) |
| Size is quarter-Kelly, 0.25–3% risk per trade | `src/bot/policy.ts:30–32, 82` | Kelly on a guessed chance over-bets; 3% is three times the 1% daily loss limit |
| A losing kind of trade pauses only below 35% wins | `src/bot/brain.ts:187` | A kind that wins 40% of 1R trades loses money forever, at 60% size |
| Market check: skip only when breadth ≤ −0.35 | `src/bot/protect.ts:150` | Ignores the market gate the alerts have used since 1.16.2 (`src/early/early.ts:335`) |
| 1 decision in 8 is a "test trade" with money, alerted for copying | `src/bot/policy.ts:28, 155` | Anyone copying the alerts pays real charges on experiments |
| The Intraday scanner (1.19/1.20) is not a source | `gatherIdeas`, `botJobs.ts:419` | The app's main tool is unused (correct until it is proven) |

## 2. The new logic in one paragraph

Every idea belongs to a **playbook** (a kind of trade). Each playbook gets a **state** from measured
results: its own finished trades (before charges) plus its past test on unseen days, counted
cautiously. Only **Trial** and **Proven** playbooks trade with money, at a fixed small risk (0.25% /
0.5% of the money).

A trade is taken only when two checks pass at its real size:
- the playbook's cautious average result, minus this trade's real Upstox charges, is still at least +0.05R;
- the charges are at most a quarter of the trade's risk.

On top of that:
- No buys while the market gate says the market is falling; no sell-first while it is rising.
- Total open risk at most 2%, and at most 2 open trades per industry.
- The daily loss limit and profit lock work as today; a drawdown brake is added.

Playbooks that are not allowed keep being followed as **shadow trades** (no money, no alerts), so they
can prove themselves, or prove themselves again after a pause.

## 3. Playbooks

New file `src/bot/playbooks.ts`:

```ts
export type PlaybookId =
  | 'day-buy' | 'rise-strong' | 'rise-flow' | 'swing-pick'
  | 'short-scan' | 'short-model' | 'breakout' | 'intraday-buy';
```

| Playbook | Source in `gatherIdeas` | Side | Brain `strategy` | Past test used as prior | Starts as |
|---|---|---|---|---|---|
| `day-buy` | day-trade signals (`daySignals`) | buy | `day-buy` | `dayTest.report.checkTrades` (unseen days), long side | from evidence |
| `rise-strong` | Rising now, tag "likely" (`rise.rows`) | buy | `rising` | `riseModel.report.strong` (unseen days) | from evidence |
| `rise-flow` | older flow risers (only when there is no rise model) | buy | `rising` | none | Watch |
| `swing-pick` | top picks (`studies.picks`) | buy | `swing` | none at trade level | Watch |
| `short-scan` | Falling now scan (`shortIdeas`) | sell first | `short` | `shortTest.newer` | from evidence |
| `short-model` | "For short selling" list (`studies.shortTop`) | sell first | `short` | none at trade level (its label is "the day ends 0.3% below the open", not a trade) | Watch |
| `breakout` | `breakouts`, when the breakout engine produces them | buy | `breakout` | `breakoutTest.newer` | from evidence |
| `intraday-buy` (new, §9) | Intraday scanner BUY rows (`intraday.rows`) | buy | `breakout` | `intradayTest` | Watch until proven |

- Intraday SELL is **not** added: it stays "practice only" until proven (the 1.20.2 rule).
- "From evidence" means the state is computed on the first run, from the bot's own past trades and the test (§4).
- The brain keeps its 5 strategies, so its saved weights do not change. The playbook is a separate field.
- Old trades have no `playbook` field. `playbookOf(trade)` maps them:
  - `day-buy` → `day-buy`; `breakout` → `breakout`; `swing` → `swing-pick`.
  - `rising` → `rise-strong` when `reasons[0]` is "Rising now: likely to keep rising", else `rise-flow`.
  - `short` → `short-scan` when `reasons[0]` starts with "falling now", else `short-model`.

## 4. Evidence and states — `src/bot/evidence.ts` (pure functions)

### 4.1 Samples

There is one sample per finished trade, real or shadow:

- `netR = pnl / riskRupees`. This is already stored as `BotTrade.r`.
- `grossR = (pnl + charges) / riskRupees`. `charges` is the sum of `Fill.charges` of the trade's
  closing fills (`src/wallet/wallet.ts`). It is computed in `settleClosed` and stored on the trade as
  `grossR`, so it survives the fills being trimmed (`slice(-600)`).
- Trades closed before this version have no `grossR`: their `netR` is used instead (lower, so on the safe side).
- A winner counts at most **+4R**, so one lucky trade cannot prove a playbook. Losses are never cut.
- Why "before charges": the charges of a future trade depend on its own size (§6). They are subtracted
  per trade, not baked into the playbook's average.

### 4.2 Past-test prior

`priorOf(playbook, stored) → { trades, avgR, label } | null`

| Playbook | trades | avgR |
|---|---|---|
| `day-buy` | long `checkTrades` that have a `stop` | mean of `pnl / (abs(entry − stop) × qty)`; needs the new optional `DayTestTrade.stop`, filled from the next evening's test run |
| `rise-strong` | `strong.n` | `strong.avgNetPct / (PLAN.stop × 100)`; `PLAN.stop` = 0.4% (`src/rising/momentum.ts:28`) |
| `short-scan` | `newer.trades` | `newer.pnl / newer.trades / riskRupees` |
| `breakout` | `newer.trades` | `newer.avgR` |
| `intraday-buy` | `trades` | `avgR`; its rules were fixed before the test (nothing was tuned), so all its days count as unseen |

- A result already after charges is used as it is: it is lower than the gross figure, so the error is on the safe side.
- A failed test is used too: its low numbers pull the estimate down.

### 4.3 Constants

```ts
export const EVIDENCE = {
  window: 60,          // newest finished samples per playbook (real + shadow)
  winCapR: 4,          // a winner counts at most +4 R
  sdFloorR: 0.8,       // the spread of results is never assumed smaller than this
  priorMin: 20,        // a past test needs at least 20 trades to count
  priorMax: 30,        // and counts as at most 30 trades
  priorHaircutR: 0.05, // live fills are worse than tested ones
  trialMinN: 20,
  provenMinN: 30,
  provenMinLcbR: 0.10,
  pauseLastN: 20,
  pauseBelowR: -0.05,
  pauseLcbBelowR: -0.15,
  resumeAboveR: 0.10,
} as const;
```

### 4.4 `evaluate(id, samples, prior, memo) → PlaybookEvidence`

1. `W` = the newest 60 samples of the playbook; `n = |W|`.
2. `mean` = average `grossR` of `W`. `sd` = max(0.8, standard deviation of `W`); 0.8 when `n < 2`.
3. A prior with `trades ≥ 20` gives `n0 = min(trades, 30)` and `μ0 = avgR − 0.05`. Otherwise `n0 = 0`.
4. `μ = (n0·μ0 + n·mean) / (n0 + n)` and **`LCB = μ − sd / √(n0 + n)`**, the "safe estimate". The true
   average is above it about 84% of the time. If `n0 + n = 0`, the state is Watch.
5. `m20` = average `grossR` of the newest 20 samples; `liveLcb = mean − sd / √n`.
6. The state is the first rule that matches:
   1. `off`: the owner switched the playbook off.
   2. `paused`: `n ≥ 20` and (`m20 < −0.05`, or `n ≥ 30` and `liveLcb < −0.15`); **or** it was paused
      before and `m20 < +0.10` (it must recover clearly before it trades again).
   3. `proven`: `n ≥ 30` and `LCB ≥ +0.10`.
   4. `trial`: `LCB ≥ 0` and (`n ≥ 20` or `n0 ≥ 20`).
   5. `watch`: everything else.
7. The caller stores `paused` in `bot.playbooks[id].paused`, which rule 6.2 needs.

Worked examples (they become unit tests):

| Case | Result |
|---|---|
| Test only: 30 unseen-day trades at +0.20R | μ = 0.15; LCB = 0.15 − 0.8/√30 = +0.004 → **trial** |
| Test only: 30 trades at +0.15R | LCB = −0.046 → **watch** |
| 30 live trades, mean +0.30R, sd 1.0, no test | LCB = 0.30 − 0.18 = +0.12 → **proven** |
| 25 live trades; the newest 20 average −0.10R | **paused** |
| Paused; the newest 20 (shadow included) average +0.06R | stays **paused** (needs +0.10) |

### 4.5 Daily brake

After two losing real trades (`netR < 0`) from one playbook today, that playbook opens no more real
trades today. Its shadow trades continue.

## 5. Market gates

These apply to new trades only; open trades are managed as today.

- **Buys** (every buy playbook, `swing-pick` included): skipped while the market gate is weak. This is
  the same rule as the alerts: `marketGate`, `src/early/early.ts:335` (NIFTY 0.5% or more below
  yesterday's close, or 0.3% or more below today's open, or the scanned stocks 0.3% or more below their
  opens on average).
- **Sell-first:** skipped while the market is rising strongly (`marketRising`, `src/intraday/short.ts:144`).
- **Where the gate comes from**, first one available:
  1. The gate the Intraday scan saved (`intraday.gate` / `intraday.shortGate`), if saved today in the last 60 s.
  2. Rising now's gate (`rise.weak`), if saved in the last 60 s.
  3. Computed from the prices with a new shared helper, `marketInputs(quotes, scanKeys, now)`, moved
     out of `src/background/risingJobs.ts:320–338`. Rising now and the Intraday scan then use the same
     helper; their rules do not change.
- If the data is missing (no NIFTY price), nothing is blocked, the same as for the alerts.
- The existing skips for news against the trade and breadth against it (`skipIdea`) stay.

## 6. Size, charges and EV — `decideV2` in `src/bot/policy.ts`

Each idea that passed §5, whose playbook is Trial or Proven and not braked for the day, goes through
these steps in order:

1. `riskFrac` = **0.25%** (Trial) or **0.5%** (Proven) of the money; × 0.5 while the drawdown brake
   says "half" (§7). It is never above half the daily loss limit (default 1% → 0.5%).
2. `perShare = abs(price − stop)`; `qty = floor(equity × riskFrac / perShare)`.
3. Existing caps: `qty × fill price` ≤ min(its share of the free cash, `free × 0.995`,
   `maxPositionFor(equity)`, the swing room for `swing-pick`).
4. **Heat cap.** `openRisk` = sum over open real trades of
   `sharesLeft × max(0, (entry − stop) × dir)`. A trade whose safety net is at its buy price adds 0.
   Then `qty ≤ floor((2% × equity − openRisk) / perShare)`.
5. **Industry cap.** Skip if 2 open real trades are already in its industry
   (`scanUniverse.industry`; an unknown industry has no cap).
6. Skip if `qty × price < ₹5,000` (`MIN_POSITION`, unchanged).
7. **Charges at this size.** `charges = estimateCharges(product, qty, price)` (`src/wallet/wallet.ts:270`;
   intraday for same-day trades, delivery for `swing-pick`); `chargesR = charges / (qty × perShare)`.
   **Skip if `chargesR > 0.25`.**
8. **`EV_net = LCB(playbook) − chargesR`. Skip if `EV_net < 0.05R`.**
9. Rank the remaining ideas by `EV_net`, with the brain's chance as the tie-break. Take up to
   `maxOpenFor(equity) − open trades`, as today. Free cash is shared by `EV_net`, as it is by EV today.

Kelly sizing (`riskFraction`, `KELLY_SHARE`, `MIN_RISK`, `MAX_RISK`) and exploration (`EXPLORE_RATE`,
`EXPLORE_RISK`) are removed. The brain stays, as a ranker and for "What it has learned".

**What step 7 means for small amounts.** These are exact Upstox Intraday charges
(`intradayCharges`) with the existing position cap (`maxPositionFor`):

| Safety-net distance | Smallest position that passes | Smallest money whose position cap allows it |
|---|---|---|
| 0.40% (the Rising now quick trade) | ₹72,900 | ₹4,86,000 |
| 0.75% | ₹31,100 | ₹89,000 |
| 1.00% | ₹22,000 | ₹63,000 |
| 2.00% | ₹5,000 (the minimum) | ₹15,000 |

Below those amounts, those trades are skipped with the reason shown. This is intended: at those sizes,
charges eat the edge.

## 7. Day, drawdown and other limits

| Limit | Value | Change |
|---|---|---|
| Risk per trade | 0.25% Trial / 0.5% Proven, at most half the daily loss limit | new (was 0.25–3% Kelly) |
| Total open risk ("heat") | 2% of the money | new |
| Same industry | at most 2 open trades | new |
| Open trades / one position | `maxOpenFor` / `maxPositionFor` | unchanged |
| Daily loss limit, profit lock | −1%; from +0.4%, gives back at most 50% | unchanged |
| Per playbook per day | 2 losing trades → that playbook stops for today | new |
| Drawdown brake | 4% or more below its peak → half size; 8% or more → no new real trades until the owner presses **Resume** | new |
| Charges | at most 25% of the trade's risk | new |
| Entry times | 9:30–2:30 same-day; until 3:15 for swing | unchanged |

- **Peak:** `bot.peak = max(bot.peak, total)` on every run. It is set to the new total by **Amount**
  and **Reset** (so adding money is not a gain) and by **Resume**.
- **Never**, kept or now explicit:
  - one open trade per stock (no averaging down);
  - safety nets only move in the trade's favour (`manageTrade`);
  - no leverage: same-day buys use `marginPct` 1, and no MTF.
- **With "Protect my money" off:** the daily loss limit, profit lock and the open-trade / position caps
  are off, as today. Evidence, charges, market gates, risk per trade, heat and the drawdown brake stay
  on (owner decision D1).

## 8. Shadow trades

- **Which ideas:** those that pass §5 (market) and have a fresh price, from playbooks in Watch or
  Paused, or braked for the day. Off playbooks get none.
- **How:** the same path as real trades, into a second wallet, `bot.shadow.wallet`. It is
  `newWallet` with ₹1,000 crore of pretend cash, so cash never limits it. Each trade is sized as Trial
  (0.25% of the real money), so its charges are realistic. They are managed by the same functions:
  `manageOpen`, `timeExits`, `processWallet`, `catchUp`, `settleClosed`.
- **Never** counted in the money, the open-trade count, heat, the day guard or the drawdown. Never
  alerted, never in Copy in Upstox.
- **Limits:**
  - one per stock per playbook per day;
  - at most 8 open at once, at most 30 opened a day;
  - `shadow.trades` kept to 400 and its fills to 600, like the real wallet.
- **Prices:** `trackedKeys` (`src/data/quotes.ts:14`, where open bot trades are already added) also
  adds open shadow trades.
- **The Rising now tag:** the 20-minute quick-trade rule needs it. `src/background/risingJobs.ts:299`
  also adds open shadow buys, with a new source `'shadow'`. The "slowing" alert
  (`risingJobs.ts:521`) skips that source.
- The brain learns from shadow results too; it only ranks now.

## 9. New source: Intraday scanner BUY

- Read from `intraday` (today, saved in the last 60 s): rows with `call` BUY, `side` not `'sell'`,
  and a plan.
- Entry only while the price is at most `plan.entry × 1.003` (no chasing). Stop = `plan.stop`,
  target = `plan.target`. Same-day trade.
- One idea per stock: when a stock comes from several sources, keep the playbook with the better
  state, then the higher `LCB`.
- **Money only when both are true:**
  1. the app's own rule says the BUY side is proven (`sideStats(intradayRecord, 'buy').proven`: 20+
     finished signals, more wins than losses, money made);
  2. its evidence state is Trial or Proven.

  Before that, shadow only.
- Live evidence comes from the auto-trader's own (shadow and real) intraday trades. The Intraday
  record is used only for the "proven" check in point 1, so the same signals are not counted twice.

## 10. Data model (all fields optional)

Older builds still read the stored state, so a rollback is safe.

- `BotTrade`: `playbook?: PlaybookId`, `grossR?: number`, `shadow?: true`.
- `BotState`: `shadow?: { wallet: WalletState; trades: BotTrade[] }`,
  `playbooks?: Partial<Record<PlaybookId, { off?: boolean; paused?: boolean }>>`, `peak?: number`,
  `ddStop?: { at: number; peak: number } | null`.
- `Idea`: `playbook: PlaybookId` (in memory only).
- `DayTestTrade`: `stop?: number`.
- No storage migration step: a missing value means the default, as with `intradayTest` and `intradayRecord`.

## 11. Files

| File | Change |
|---|---|
| `src/bot/playbooks.ts` (new) | ids, labels, `playbookOf(oldTrade)` |
| `src/bot/evidence.ts` (new, pure) | samples, priors, `evaluate`, constants |
| `src/bot/policy.ts` | `decideV2` (§6); remove Kelly and exploration |
| `src/bot/protect.ts` | heat, industry and drawdown helpers (pure) |
| `src/early/early.ts` | `marketInputs(quotes, keys, now)` helper |
| `src/background/risingJobs.ts`, `intradayJobs.ts` | use the helper (no rule change); the `'shadow'` held source |
| `src/background/botJobs.ts` | see the list below this table |
| `src/data/quotes.ts` | track open shadow trades |
| `src/daytrade/backtest.ts` | `stop` on the check trades |
| `src/ui/components/AutoTrader.tsx` | "Kinds of trade" table, Off switch per kind, drawdown brake + Resume, the charges line, the sizing words |
| `server/src/http/routes.ts` | `/v1/plans` → `autoTrader.playbooks` |
| `README.md`, `release-notes/1.22.0.txt`, `package.json` | app 1.22.0 (versionCode 12200, from the version) |

Changes in `src/background/botJobs.ts`:
- a playbook on each idea, and the Intraday source;
- the market gates;
- the shadow wallet and shadow trades;
- `grossR` stored at settle; the peak and drawdown brake;
- no exploration trades; alerts for real trades only;
- `suggestIdeas` shows each playbook's state, hides Paused / Off ideas and marks Watch ones "not proven".

The "Kinds of trade" table shows, per playbook: state, trades (real + shadow), wins, average result
before and after charges, the safe estimate (`LCB`), the past test it uses, and why it is in that state.

## 12. Tests

Written first. Where they apply, they fail on today's code.

- `tests/botEvidence.test.ts`:
  - `grossR` / `netR` from fills; the +4R cap; the 60-sample window; the 0.8 spread floor;
  - the prior cap and haircut; the five worked examples;
  - the edges: n = 19/20/29/30 and `LCB` 0.099/0.100; pause and resume; mapping of old trades.
- `tests/botPolicyV2.test.ts`:
  - the charges cases (a ₹25,000 quick trade is skipped; ₹7.5 lakh passes) and the `EV_net` threshold;
  - risk 0.25% / 0.5% and at most half the day limit; heat trims or skips; the industry cap;
  - the drawdown brake (half, stop, Resume) and the peak after Amount;
  - Watch / Paused never get money; the daily brake;
  - buys blocked while the gate is weak; sell-first blocked while the market rises; no exploration.
- `tests/botShadow.test.ts`:
  - opens, manages and closes shadow trades;
  - never touches the money, counts, heat, day guard or alerts; the 8 / 30 limits;
  - their prices are tracked; Rising now tags them as `'shadow'` and never alerts.
- `tests/botIntraday.test.ts`: BUY rows → ideas; no chasing above +0.3%; one idea per stock; shadow
  until proven.
- **State from 1.21:** a stored auto-trader with 120 old trades loads, keeps its money and trades, and
  its playbooks are mapped.
- **Existing tests:**
  - `tests/bot.test.ts` and `tests/protect.test.ts` are updated only where they check Kelly or exploration;
  - `tests/upstoxOrders.test.ts` must still find no order or GTT call.
- **Server and smoke:** `/v1/plans` includes `playbooks`, and the smoke test checks that the table renders.

## 13. Order of work (one pull request into `main` per phase)

1. **Safety:**
   - the charges rule and the market gates;
   - fixed risk, heat, the industry cap and the drawdown brake;
   - no exploration trades;
   - a losing strategy pauses on its average R (newest 20 trades below −0.05R).
2. **Evidence:** playbooks, evidence, states, the "Kinds of trade" table and the suggestions.
3. **Shadow trades.**
4. **Intraday BUY source.**
5. *(Optional)* A replay of today's rules against these rules (open-trade limits, heat, gates) on the
   trades the past tests already list (day-trade check trades, breakout, Intraday), at the owner's
   amount, after charges. The screen states what cannot be replayed: news, the order book, live Rising
   tags and top picks.

**Release:** 1.22.0 after phases 1–3, built from `main` **after PR #4 is merged**. A phone on RC2
(1.21.0) that updated to a 1.22.0 without Milestone 4 would lose cloud alerts.

## 14. Done when

- Both type checks, all tests, both builds and the smoke test pass.
- Tests show that:
  - no real trade is opened from a Watch, Paused or Off playbook;
  - every real trade has `chargesR ≤ 0.25`, risk at most its state's %, and heat at most 2%;
  - no buy opens while the gate is weak, and no sell-first while the market rises;
  - no shadow trade is alerted;
  - a 1.21 state loads unchanged.
- There is still no Upstox order or GTT path.

## 15. What to expect

- Fewer trades, especially at first. Most kinds start in Watch unless their past test is strong.
- With small amounts, the quick trades are skipped (the table in §6).
- Not a profit guarantee. If no playbook is proven, the auto-trader does not trade — by design.

## 16. Owner decisions (recommended answer first)

- **D1** Evidence, charges, market gates, heat and the drawdown brake stay on even with "Protect my
  money" off: **yes** / no.
- **D2** Risk 0.25% (Trial) / 0.5% (Proven) per trade, 2% total open risk: **yes** / other numbers.
- **D3** Shadow trades: **yes** / no (Watch kinds then simply wait).
- **D4** Intraday BUY joins after its own record is proven: **yes** / never / now.
- **D5** Release 1.22.0 after PR #4 is merged: **yes**.
- **D6** This replaces the v1.8 "no limits" instruction (header of `src/bot/policy.ts`): **yes**.
