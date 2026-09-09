# Adaptive Shadow Strategy Arena V4

A Gate USDT perpetual market-regime and progressive strategy-rotation system. One `MarketStream` Durable Object is authoritative for market observations, the 1,000 U simulated futures account, and optional owner-controlled LIVE mirroring.

## Completed-candle multi-strategy V4.2

- The first pass ranks eligible Gate USDT perpetuals by 24-hour turnover and forms a thirty-contract liquid universe. It does not decide trades or depend on anomaly feeds.
- One completed 5-minute candle series is refreshed every ten seconds, covering the full universe in about five minutes. Trend, range, compression and expansion are derived from those durable candles; missing optional high-frequency data cannot create a strategy-data gap.
- Each market event may test several genuinely different base playbooks. One symbol can serve several playbooks and one playbook can serve several symbols. Only one execution variant per base playbook/event contributes a shadow result.
- Promotion requires three wins resolved within 24 hours or six after-cost results with positive total return resolved within 72 hours. Strategies too infrequent to form those windows stay research-only and never block higher-cadence strategies.
- Absence of a signal is not a strategy state. Enabled playbooks remain enabled until the reverse simulated-account loss rule demotes them.
- Several enabled same-direction playbooks may be attributed to one simulated Gate position. This preserves learning without duplicating economically identical orders.
- Every executable order still requires fresh bid/ask, contract metadata, integer Gate contracts, depth, full costs, a noise-safe stop and sufficient net reward/risk. LIVE remains owner-controlled and defaults OFF.

## Data architecture

- Every 10 seconds, the bulk futures-ticker request selects the 30 most liquid eligible Gate USDT perpetuals. Its timeout is isolated from position management.
- Position books and owner-controlled LIVE reconciliation run before the optional bulk scan. A failed bulk scan preserves the last good display snapshot, retries at most once per normal ten-second scan, never becomes a global execution fault, and cannot authorize a new order once that snapshot is older than 30 seconds. The stable core may still create a new observation from its own completed five-minute structure and fresh book. Partial candidate-book loss remains isolated per symbol and does not misreport the whole authority as recovering.
- The strategy layer uses completed 5-minute OHLCV as its stable source and locally derives structure. Up to ten priority symbols receive the fresh two-second order book required for executable validation; protected positions always retain priority.
- A bounded D1 runtime sample is written every five minutes and retained for 14 days. It records data coverage, strategy cadence/results, shadow activity, simulated equity and LIVE-off state without writing per market snapshot.

## Adaptive shadow strategy arena V4

The catalog contains 48 bounded strategy variants: 12 interpretable playbooks × two entry styles (`CONFIRM`/`RETEST`) × two exit profiles (`FAST`/`STRUCTURE`).

- Fast: anomaly continuation and compression release.
- Trend: continuation, shallow pullback, deep pullback, breakout retest and anomaly-pullback continuation.
- Range: range edge and sweep reclaim.
- Reversal: range false breakout, compression false breakout and anomaly exhaustion reversal.

All variants keep running in shadow. Incomplete routes are observation shadows and never score. Only signals that pass fresh executable bid/ask, unmissed entry location, structure/noise stop, full-cost target, depth, liquidity and Gate contract checks become effective shadows.

- The latest three independent effective shadows all winning within 24 hours, or the latest six producing positive after-cost total return within 72 hours, activates the base playbook and makes its four distinct execution variants selectable.
- Activation admits only the next new valid signal; completed winners are never backfilled.
- The latest three simulated orders all losing, or the latest six no longer positive after costs, stops new account entries and returns the whole base playbook to shadow. A demoted playbook needs new effective-shadow results before it can reactivate.
- Missing market opportunities produce no state transition and no synthetic loss. Enabled playbooks remain active until the explicit demotion rule fires.

Every result freezes its regime, candidate channel, entry/exit variant, executable bid/ask, modeled cost, structure source, net reward/risk, depth, spread, trend/volatility, open-interest change, funding, turnover, flow, confirmation, fakeout, MFE and MAE.

## Simulated futures account

The 1,000 U account records only strategies that passed promotion and immutable execution gates:

- structural stop and target must still be valid at the executable price;
- net reward/risk must be at least 1.2 after modeled full cost;
- modeled cost may consume at most 25% of target space;
- 24-hour turnover, spread and both sides of first-five-level depth must pass liquidity limits;
- recent empirical after-cost expectation must be positive.

Position size uses Gate's contract multiplier and integer contract lots. Risk varies continuously from 1% to 2% of equity (10–20 U at the initial balance). Dynamic position count is bounded by 10% total stop risk, 6.5% same-direction risk, 30% margin, 4× total notional and the ten-symbol management capacity. Fees, executable spread, conservative slippage and applicable funding are deducted.

The owner-only reset closes open simulated positions at fresh executable prices, archives the completed account cycle, resets visible equity to 1,000 U, and preserves all shadow research. Reset is rejected while LIVE is enabled or any system LIVE position/order remains.

## LIVE boundary

- `SYSTEM_VERSION=completed-candle-multi-strategy-v4.2` archives V3 research, settles V3 account exposure only from fresh executable bid/ask, archives the cycle and starts V4 at 1,000 U.
- Gate credentials and LIVE reconciliation state are preserved. Deployment never turns LIVE on.
- LIVE can be enabled only by the authenticated owner. It mirrors only new simulated-account orders opened after enablement and never backfills an existing simulated position.
- Direction, structural stop, target, proportional notional and modeled cost come from the exact simulated-account order. The real order is rechecked for current price geometry, integer Gate lot size, margin, account-wide risk, correlated-direction risk and after-cost economics.
- Owner authentication, encrypted credentials, read-only account visibility, reduce-only protection and system-tag-only cleanup remain unchanged.
- Old account trades and cycle summaries remain available for comparison; V4 scoring starts from new effective shadows in the bounded Durable Object checkpoint.

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

Production releases use the GitHub-to-Cloudflare workflow and require advancing health checks with `completed-candle-multi-strategy-v4.2`, 30-market scanning, the 12/48 catalog, V4 risk limits, 1,000 U cutover equity and LIVE explicitly OFF.
