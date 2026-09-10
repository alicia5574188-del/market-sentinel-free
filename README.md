# State-conditioned Positive-Expectancy Controller V5

A Gate USDT perpetual market-regime and progressive strategy-rotation system. One `MarketStream` Durable Object is authoritative for market observations, the 1,000 U simulated futures account, and optional owner-controlled LIVE mirroring.

## V5 authority

- The first pass ranks eligible Gate USDT perpetuals by 24-hour turnover and forms a thirty-contract liquid universe. It does not decide trades or depend on anomaly feeds.
- One completed 5-minute candle series is refreshed every ten seconds, covering the full universe in about five minutes. Trend, range, compression and expansion are derived from those durable candles; missing optional high-frequency data cannot create a strategy-data gap.
- Each market event may test several hypotheses. One symbol can serve several mechanisms and one mechanism can serve several symbols; economically identical orders are still merged.
- Every refreshed 120-candle completed-5m series runs a chronological walk-forward over six materially different profit mechanisms and independently proposed long/short routes. The controller compares 10/20/30/45/60-minute horizons without lookahead and treats same-candle stop/target ambiguity as stop-first.
- PAPER authority requires at least eight similar paths, positive conservative after-cost expectation, profit factor at least 1.05, sufficient target reachability and no single oversized winner dominating the evidence. V4 three/six and mirrored-reverse records remain bounded research history but no longer authorize V5 PAPER.
- The aspirational 10% daily return is an internal portfolio objective used only to rank already-positive capacity. It is not a quota, display promise or permission to bypass risk and data gates.
- Several enabled same-direction playbooks may be attributed to one simulated Gate position. This preserves learning without duplicating economically identical orders.
- Every executable order still requires fresh bid/ask, contract metadata, integer Gate contracts, depth, full costs, a noise-safe stop and sufficient net reward/risk. LIVE remains owner-controlled and defaults OFF.

## Data architecture

- Every 10 seconds, the bulk futures-ticker request selects the 30 most liquid eligible Gate USDT perpetuals. Its timeout is isolated from position management.
- Position books and owner-controlled LIVE reconciliation run before the optional bulk scan. A failed bulk scan preserves the last good display snapshot, retries at most once per normal ten-second scan, never becomes a global execution fault, and cannot authorize a new order once that snapshot is older than 30 seconds. The stable core may still create a new observation from its own completed five-minute structure and fresh book. Partial candidate-book loss remains isolated per symbol and does not misreport the whole authority as recovering.
- The strategy layer uses completed 5-minute OHLCV as its stable source and locally derives structure. Up to ten priority symbols receive the fresh two-second order book required for executable validation; protected positions always retain priority.
- A bounded D1 runtime sample is written every five minutes and retained for 14 days. It records data coverage, strategy cadence/results, shadow activity, simulated equity and LIVE-off state without writing per market snapshot.

## Continuous hypothesis research retained from V4

The catalog contains 48 bounded strategy variants: 12 interpretable playbooks × two entry styles (`CONFIRM`/`RETEST`) × two exit profiles (`FAST`/`STRUCTURE`).

- Fast: anomaly continuation and compression release.
- Trend: continuation, shallow pullback, deep pullback, breakout retest and anomaly-pullback continuation.
- Range: range edge and sweep reclaim.
- Reversal: range false breakout, compression false breakout and anomaly exhaustion reversal.

All variants keep running in shadow. Incomplete routes are observation shadows and never score. Only signals that pass fresh executable bid/ask, unmissed entry location, structure/noise stop, full-cost target, depth, liquidity and Gate contract checks become effective shadows.

- Effective shadows never stop after a route enters PAPER. Normal and opposite directions are independent hypotheses; V5 never creates the opposite path by swapping the original stop and target.
- The 1,000 U account chooses the highest conservative state-conditioned objective among executable routes for a symbol/event and never hedges against itself.
- Frozen targets are capped by the exit profile's after-cost reward/risk and prior reachable excursion, but never relaxed below the 1.2 net reward/risk floor. The original structural target remains recorded for diagnosis.
- The old latest-three/latest-six fields remain review-only compatibility evidence. They cannot activate, reverse or deactivate a V5 route.
- A V5 decision admits only the current new executable signal; historical winners are never backfilled.
- Missing market opportunities produce no state transition and no synthetic loss. Enabled playbooks remain active until the explicit demotion rule fires.

Every result freezes its regime, candidate channel, entry/exit variant, executable bid/ask, modeled cost, structure source, net reward/risk, depth, spread, trend/volatility, open-interest change, funding, turnover, flow, confirmation, fakeout, MFE and MAE.

## Simulated futures account

The 1,000 U account records only routes that passed state-conditioned expectancy and immutable execution gates:

- structural stop and target must still be valid at the executable price;
- net reward/risk must be at least 1.2 after modeled full cost;
- modeled cost may consume at most 25% of target space;
- 24-hour turnover, spread and both sides of first-five-level depth must pass liquidity limits;
- the exact execution variant's recent conservative expectation must exceed the complete modeled cost.

Position size uses Gate's contract multiplier and integer contract lots. Risk targets 10–20 U and a portfolio order is rejected when the remaining risk or margin capacity cannot support at least 10 U; the simulator never opens a one-contract dust substitute. Dynamic position count is bounded by 10% total stop risk, 6.5% same-direction risk, 30% margin, 4× total notional and the ten-symbol management capacity. Fees, executable spread, conservative slippage and applicable funding are deducted. Research variants continue to collect bounded evidence; correlated cross-symbol results from the same completed-five-minute market lifecycle count once per variant.

The owner-only reset closes open simulated positions at fresh executable prices, archives the completed account cycle, resets visible equity to 1,000 U, and preserves all shadow research. Reset is rejected while LIVE is enabled or any system LIVE position/order remains.

## LIVE boundary

- `SYSTEM_VERSION=state-conditioned-expectancy-v5` preserves the evolved account and frozen open positions while replacing V4 promotion authority with completed-candle state-conditioned expectancy.
- Gate credentials and LIVE reconciliation state are preserved. Deployment never turns LIVE on.
- LIVE can be enabled only by the authenticated owner. It mirrors only new simulated-account orders opened after enablement and never backfills an existing simulated position.
- Direction, structural stop, target, proportional notional and modeled cost come from the exact simulated-account order. The real order is rechecked for current price geometry, integer Gate lot size, margin, account-wide risk, correlated-direction risk and after-cost economics.
- Owner authentication, encrypted credentials, read-only account visibility, reduce-only protection and system-tag-only cleanup remain unchanged.
- Old account trades, cycle summaries and V4 shadow records remain available for comparison. They do not authorize V5 entries.

## Bounded operation

- Effective-shadow trades and histories are bounded at 240; transitions at 200; signal deduplication keys at 2,000.
- 43,200 two-second alarm requests and alarm writes per day.
- 8,000 non-alarm DO write cap plus 2,880 watchdog reserve: 54,080 planned DO writes/day.
- 5,760 foreground requests at one continuous 15-second page poll plus 1,440 watchdog requests: 50,400 planned DO requests/day.
- D1 billed writes remain capped at 4,800/day. The five-minute strategy log adds at most 576 billed writes/day including retention pruning.

## Verification

```bash
npm run test:direct
npm test
npm run typecheck
npm run lint
git diff --check
```

Production releases use the GitHub-to-Cloudflare workflow and require advancing health checks with `state-conditioned-expectancy-v5`, completed-candle policy version 1, 30-market scanning, the retained 12/48 research catalog, unchanged account/risk limits and LIVE explicitly OFF.
