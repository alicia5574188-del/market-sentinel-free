# Market Regime Strategy Arena

A Gate USDT perpetual market-regime and strategy-rotation system. One `MarketStream` Durable Object is the authority for market observations, one 1,000 U simulated account, and optional owner-controlled LIVE mirroring.

## Data architecture

- Every 10 seconds, the existing bulk futures-ticker request scans all eligible USDT perpetuals. It now maintains compact streaming profiles for trend, range, compression and expansion while continuing to detect anomalies.
- The bulk scan is lightweight: price, turnover, funding and open interest update EWMAs, trend efficiency, volatility ratio and an approximate 30-minute range. A profile needs 18 observations and three confirmations before a regime change is accepted.
- Up to three priority symbols receive the existing two-second order book and rotating completed 1m/15m/1h data, locally aggregated 4h structure, signed trades, open interest, funding and liquidation observations.
- Deep slots are diversified across trend, rotation and event groups. Anomaly is one candidate channel, not a universal prerequisite. Shadow trades no longer reserve a scarce deep-data slot because the bulk ticker can settle them.
- No market request, alarm cadence, per-snapshot D1 write or request budget was added.

## Strategy arena V2

The catalog contains 48 bounded strategy cells: 12 interpretable playbooks × two entry styles (`CONFIRM`/`RETEST`) × two exit profiles (`FAST`/`STRUCTURE`).

- Trend: steady continuation, shallow pullback and deep reclaim.
- Range: edge reversal, sweep reclaim and failed break.
- Compression: breakout, breakout retest and failed breakout.
- Event: anomaly follow, anomaly pullback and anomaly fade.

Every cell starts in `SHADOW` with an isolated ledger. A first net-profitable shadow result moves only future signals into `TRIAL`. Two consecutive simulated losses move a trial or verified cell back to shadow. `VERIFIED` requires at least 12 distinct events across four symbols, positive stage net return and profit factor of at least 1.1.

Each result freezes its market regime, candidate channel, entry and exit variant, modeled full cost, price structure, trend and volatility measurements, open-interest change, funding, turnover, flow, confirmation and fakeout readings. MFE and MAE are recorded for later diagnosis.

Only one simulated account is user-facing and financially authoritative:

- Internal isolated ledgers evaluate and rotate the strategy cells; they are research records, not account orders.
- The 1,000 U account selects at most one promoted cell for the same symbol/event, holds at most three positions, sizes each at 30% of current account equity, deducts modeled full costs, and exposes its actual USDT equity and PnL.

Neither ledger is a profitability promise. Promotion is an online filter; only sufficiently long, out-of-sample records can establish whether a cell has useful expectation.

## Cutover and execution boundary

- `SYSTEM_VERSION=market-regime-arena-v2` discards incompatible V1 PAPER arena/checkpoint statistics at cutover. Historical V1 records are not mixed with the new experiment.
- Gate credentials and LIVE reconciliation state are preserved. Runtime decisions remain null and the retired PAPER executor receives `allowOpen: false`.
- LIVE starts off after deployment and can be enabled only by the authenticated owner. It mirrors only new 1,000 U account orders opened after the switch was enabled; it never backfills an already-open simulated position.
- Direction, stop, target and exit come from the same simulated-account order. LIVE scales the account's 30% allocation to real Gate equity and can skip only for exchange lot size, available margin, total-risk, correlated-direction-risk or reconciliation safety.
- Owner authentication, encrypted credentials, read-only Gate account visibility, reduce-only protection and system-tag-only cleanup remain available.
- No new D1 migration is needed: V2 research state remains in the bounded Durable Object checkpoint.

## Bounded operation

- Isolated open trades are capped at 240; each of shadow, trial/verified and portfolio histories is capped at 240; transitions at 200; signal deduplication keys at 2,000.
- 43,200 two-second alarm requests and alarm writes per day.
- 8,000 non-alarm DO write cap plus 2,880 watchdog reserve: 54,080 planned DO writes/day.
- 5,760 foreground requests at one continuous 15-second page poll plus 1,440 watchdog requests: 50,400 planned DO requests/day.
- D1 billed writes remain capped at 4,800/day. The V2 arena itself does not write strategy observations to D1.

## Verification

```bash
npm run test:direct
npm test
npm run typecheck
npm run lint
git diff --check
```

Production releases use the GitHub-to-Cloudflare workflow and require advancing health checks with `market-regime-arena-v2`. Deployment never enables LIVE.
