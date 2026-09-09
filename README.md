# Market Anomaly Strategy Arena

A Gate USDT perpetual strategy-rotation research system. One `MarketStream` Durable Object remains the authority for market observations and the protection of any pre-existing LIVE position. New LIVE entries are hard-locked off.

## Data architecture

- Every 10 seconds one bulk Gate futures-ticker request scans all eligible USDT perpetuals and publishes at most twelve ranked anomalies.
- At most three priority symbols receive two-second order books plus rotating completed 1m/15m/1h data, locally aggregated 4h structure, signed trades, open interest, funding, and liquidation observations.
- An anomaly selects a sample; it does not dictate a trade direction. Every strategy whose data requirements are satisfied evaluates the same frozen event independently.
- Missing critical book or completed-candle evidence blocks new observations. Optional OI, trade, or liquidation delay affects only strategies that require it.
- Arena state is stored in the existing 30-second Durable Object checkpoint. It adds no market request and no per-snapshot D1 write.

## Strategy arena

The initial catalog contains ten bounded and interpretable strategies across five families:

- Momentum: confirmed impulse follow and new-money continuation.
- Pullback: shallow and deep pullback continuation.
- Order flow: aligned-flow continuation and flow-divergence reversal.
- Structure: accepted-breakout continuation and failed-breakout reversal.
- Mean reversion: extreme-move exhaustion and squeeze/liquidation fade.

Every strategy starts in `SHADOW` with its own open trades and ledger. Results use observed future prices, a frozen entry/stop/target, a 45-minute maximum hold, and 0.18% modeled round-trip friction.

- Promotion requires a rolling six-result shadow window with at least four profitable results and positive total net return after cost. One lucky trade can never promote a strategy.
- A promoted strategy sends only future signals to its isolated 1,000 U `PAPER` ledger.
- Two consecutive PAPER losses immediately demote it to SHADOW. A non-positive rolling six-trade PAPER net result also demotes it.
- A demoted strategy must earn promotion again on new shadow results. Strategy transitions and bounded shadow/PAPER records are visible in the operator UI.
- Separate ledgers prevent multiple strategies reacting to the same event from masking one another through a shared account balance.

## Cutover and execution boundary

- Migration `0035_strategy_arena_fresh_start.sql` deletes the retired PAPER plans, positions, and events and resets retired PAPER equity. It never names or mutates `live_exchange_credentials`.
- The version cutover also discards retired PAPER checkpoint state and starts a fresh arena while preserving Gate credential data and LIVE reconciliation state.
- Runtime decisions remain null, the legacy PAPER executor receives `allowOpen: false`, and the LIVE enable endpoint rejects activation.
- Owner authentication, encrypted credentials, read-only Gate account visibility, reduce-only protection, and system-tag-only cleanup remain available.
- Existing internal portfolio limits remain defense-in-depth for legacy position protection, but the UI no longer presents a shared simulated P&L target or combination-risk budget because arena ledgers are isolated.

## Bounded operation

- Shadow and PAPER histories are each capped at 400 records; transitions at 200; signal deduplication keys at 1,000.
- 43,200 two-second alarm requests and alarm writes per day.
- 8,000 non-alarm DO write cap plus 2,880 watchdog reserve: 54,080 planned DO writes/day.
- 5,760 foreground requests at one continuous 15-second page poll plus 1,440 watchdog requests: 50,400 planned DO requests/day.
- D1 billed writes remain capped at 4,800/day. The arena itself does not write strategy observations to D1.

## Verification

```bash
npm run test:direct
npm test
npm run typecheck
npm run lint
git diff --check
```

Production releases use the GitHub-to-Cloudflare workflow and require advancing health checks with `strategy-arena-v1` while LIVE remains forced off.
