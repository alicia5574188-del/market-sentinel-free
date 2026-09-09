# Market Regime Strategy Arena

A Gate USDT perpetual market-regime and progressive strategy-rotation system. One `MarketStream` Durable Object is authoritative for market observations, the 1,000 U simulated futures account, and optional owner-controlled LIVE mirroring.

## Data architecture

- Every 10 seconds, the existing bulk futures-ticker request scans all eligible USDT perpetuals. It maintains compact profiles for trend, range, compression and expansion while continuing to detect anomalies.
- The bulk scan uses price, turnover, funding and open interest. A profile needs 18 observations and three confirmations before a regime change is accepted.
- Up to three priority symbols receive the existing two-second order book plus rotating completed 1m/15m/1h data, locally aggregated 4h structure, signed trades, open interest, funding and liquidation observations.
- Deep slots are diversified across trend, rotation and event groups. Anomaly is one candidate channel, not a universal prerequisite. Arena positions do not reserve a scarce deep-data slot because the bulk ticker can continue marking them.
- No additional market request, alarm cadence, per-snapshot D1 write or request budget was introduced.

## Strategy arena V3

The catalog contains 48 bounded strategy variants: 12 interpretable playbooks × two entry styles (`CONFIRM`/`RETEST`) × two exit profiles (`FAST`/`STRUCTURE`).

- Trend: steady continuation, shallow pullback and deep reclaim.
- Range: edge reversal, sweep reclaim and failed break.
- Compression: breakout, breakout retest and failed breakout.
- Event: anomaly follow, anomaly pullback and anomaly fade.

All variants run in isolated shadow ledgers. Evidence is counted by base playbook and independent market event, so four variants reacting to the same event count once rather than four times.

- A playbook needs at least four independent events, at least two wins, positive after-cost return, positive conservative recent expectation and profit factor of at least 1.0 before its best actual variant enters `TRIAL`.
- A trial position uses one third of normal risk. The account can hold at most one probation challenger, leaving room for qualified normal strategies.
- `VERIFIED` requires at least eight independent events across two symbols, positive recent after-cost expectation and profit factor of at least 1.15.
- Two consecutive trial/verified losses, or a non-positive recent six-result window, demote the variant to shadow. If no strategy qualifies, the account remains in cash; it never promotes the least-bad strategy just to create activity.

Every result freezes its regime, candidate channel, entry/exit variant, executable bid/ask, modeled cost, structure source, net reward/risk, depth, spread, trend/volatility, open-interest change, funding, turnover, flow, confirmation, fakeout, MFE and MAE.

## Simulated futures account

The 1,000 U account records only strategies that passed promotion and immutable execution gates:

- structural stop and target must still be valid at the executable price;
- net reward/risk must be at least 1.2 after modeled full cost;
- modeled cost may consume at most 25% of target space;
- 24-hour turnover, spread and both sides of first-five-level depth must pass liquidity limits;
- recent empirical after-cost expectation must be positive.

Position size uses Gate's contract multiplier and integer contract lots. Leverage is selected from exchange limits and stop distance, while stop risk remains capped at 10% of account equity in total and 6.5% for the same direction. At most three account positions may be open. Fees and modeled slippage are deducted from account equity.

The owner-only reset closes open simulated positions at fresh executable prices, archives the completed account cycle, resets visible equity to 1,000 U, and preserves all shadow research. Reset is rejected while LIVE is enabled or any system LIVE position/order remains.

## LIVE boundary

- `SYSTEM_VERSION=market-regime-arena-v3` starts a fresh V3 account/research state and archives the previous account summary when present.
- Gate credentials and LIVE reconciliation state are preserved. Deployment never turns LIVE on.
- LIVE can be enabled only by the authenticated owner. It mirrors only new simulated-account orders opened after enablement and never backfills an existing simulated position.
- Direction, structural stop, target, proportional notional and modeled cost come from the exact simulated-account order. The real order is rechecked for current price geometry, integer Gate lot size, margin, account-wide risk, correlated-direction risk and after-cost economics.
- Owner authentication, encrypted credentials, read-only account visibility, reduce-only protection and system-tag-only cleanup remain unchanged.
- No new D1 migration is required; V3 state remains in the bounded Durable Object checkpoint.

## Bounded operation

- Isolated open trades are capped at 240; shadow, trial/verified and account histories at 240 each; transitions at 200; signal deduplication keys at 2,000.
- 43,200 two-second alarm requests and alarm writes per day.
- 8,000 non-alarm DO write cap plus 2,880 watchdog reserve: 54,080 planned DO writes/day.
- 5,760 foreground requests at one continuous 15-second page poll plus 1,440 watchdog requests: 50,400 planned DO requests/day.
- D1 billed writes remain capped at 4,800/day. The arena does not write every strategy observation to D1.

## Verification

```bash
npm run test:direct
npm test
npm run typecheck
npm run lint
git diff --check
```

Production releases use the GitHub-to-Cloudflare workflow and require advancing health checks with `market-regime-arena-v3`. Deployment never enables LIVE.
