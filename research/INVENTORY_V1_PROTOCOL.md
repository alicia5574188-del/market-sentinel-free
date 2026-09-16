# Inventory continuation V1 — frozen before reading results

Date: 2026-09-16. User's current objective: net account equity doubles over one month through compounding. Prior turnover/day, daily-win, trade-count and fixed-risk targets are superseded. The user authorizes inspecting the poorly active deployed strategy and replacing it only with a genuinely better researched successor; preserving the old strategy is not mandatory. Credentials, account/history integrity, existing protective orders and owner LIVE intent are not research parameters.

## Scope and limits

This is an isolated first mechanism experiment, not a release candidate. Main, production strategy, PAPER balances and LIVE must not change. New code does not import production strategy or invoke private Gate APIs. No shadow strategies, promotion streaks or daily fill quota are introduced. The research workflow has read-only repository permission, public GET data access, no secrets and no deployment job.

The first 1x-or-lower target-notional experiment isolates whether a decision mechanism has edge. This is not a new user risk restriction and not a claim that 1x is optimal for doubling. Leveraged sizing is intentionally not certified while actual funding, mark-price liquidation and Gate lot execution are missing. No multiplying the resulting equity curve by leverage is permitted.

## What differs from the recorded old routes

No old five-regime strategy entries, basis pairs, passive overshoot entries, candle-phase ensemble or compressed mother strategy is used. PR #276 already describes a daily-refit conditional signal/horizon selector; PR #280 describes fixed ATR stop/target/trailing path exits. Those are not renamed as this experiment. Here a finite-horizon Bellman controller learns a market transition and reward model, then chooses an inventory action conditional on its current inventory and the cost of changing it. This is only a locally identified mechanism difference, not a claim that all past chats or every possible historical branch have been exhaustively searched.

The available action set is cash or one of BTC/ETH/SOL perpetual long/short at 0.5x or 1x account equity. Partial exposure changes, exiting, reversal and cross-asset rotation are possible. Maintaining a target weight may cause small rebalancing fills, which are charged and reported separately from new entries. The current prototype does NOT yet include age/unrealized-PnL state; it is not the full eventual position-management architecture.

## Frozen data and accounting

- Use existing `scripts/fetch-gate-history.mjs` unchanged, Gate official hourly futures archives, BTC/ETH/SOL, July 2024–August 2026.
- Require identical uninterrupted hourly grids, no interpolation or hidden skipped valuation hours.
- Evaluate January 1, 2025 through August 1, 2026 UTC: 19 complete months. Older data warm the model; August data provide the final boundary price. All this history is research evaluation, never called pristine blind evidence.
- Completed-candle features only; place a decision after close, execute at open two candle indexes later (one full hour extra delay), and mark through the next open. Refit only with label end timestamps strictly before the decision.
- Shared 1,000-USDT account, no external flows, self-financing actual delta-notional fees, hourly mark-to-market equity and final-close cost at the final valuation timestamp.
- One-way modeled friction 8.25bp base and 13.5bp stress (not the user's actual fee tier). Additional adverse funding allowance 2bp/day times gross exposure on either side, not actual historical funding.
- No mark-price liquidation, book depth, integer contracts or live parity claim. These missing layers force `release_eligible=false` regardless of numerical performance.

## Three predeclared comparisons, no sweep

1. Same conditional reward model, one-step/myopic decision, refit weekly from previous 180 days.
2. Inventory-aware 24-step continuation controller, same weekly refit and data.
3. Same continuation controller frozen at the initial training cutoff.

State geometry, 64-observation zero-edge shrinkage, horizons and cost scenarios are fixed before the run. Output every comparison, not only the winner. Report full net result, all 19 complete UTC months, rolling 30-day median/worst/best and doubling fraction, drawdown at hourly close, turnover, fees, funding allowance, entries, switching and market participation. Overlapping 30-day windows are not independent observations. No result can authorize deployment in this stage, and a less-negative result is not a good replacement.

## Current production audit

Read only the existing public health and PAPER history endpoints. The known 08:22 UTC monitor showed all 11 markets ready, ten forming routes, zero blocked routes, zero open routes, and owner LIVE off. That timestamped sample is not a claim of continuous health over two days, and it does not itself verify the user's one closed losing trade. Verify that history separately. Existing schedule configuration still contains a temporary five-minute cron; actual scheduled redeploy jobs were observed. Its effect on trade selection remains unproven, and this branch does not silently alter it.

## Local checks before first PR

Ten deterministic causality/accounting/controller tests passed in the local environment. They establish neither trading profit nor a superior production strategy. Existing repository CI handles its normal verification; no complete local production build is claimed because the local runtime could not fetch the repository or market network.
