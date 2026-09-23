# LIVE and shock continuity deployment receipt — 2026-09-23

## Release

- Pull request: #416 (`fix: LIVE continuity and broad-shock entries`)
- Reviewed main commit / deployed build: `0e44be8d3b8fd4d20151f635ce9ecd280b829111`
- Exact-head PR workflow: run `35923250211`, success
- Main release workflow: run `35923434141`, success
- Main gates passed: source verification, tests/build/lint/dry-run, migration idempotence, deploy, and advancing production health
- One-time cutover was skipped as expected; no migration replay or account reset occurred

## Production continuity

Read-only public samples after deployment showed:

- `ok=true`, `ready=true`, `runtime.state=LIVE`, `stale=false`, `lastError=null`
- Exact `buildSha=0e44be8d3b8fd4d20151f635ce9ecd280b829111`
- Forward `startedAt=1790157902785` and `initialEquity=1000` unchanged from the pre-release receipt
- Forward `balance=952.5270493596319`, `resolved=30`, `openCount=0`, `storage.error=null`
- `lastSuccessAt`, radar scan time, Gate stream message time, and accepted-book count advanced across samples
- Radar scanned 30 markets with 0 consecutive failures
- Realtime pool capacity remained 11 with 10 actionable and 1 warming market
- Gate market-data WebSocket remained connected with no transport error; feed-quality window had 0 failures
- Hourly path failures, degraded markets, blocking markets, candle errors, and runtime-log errors were all 0
- Owner LIVE intent remained `requestedEnabled=false`, `operational=false`

The observer used for the independent read added a repeatable ~10-second wait to the health route, static root, and a 404 alike. GitHub's deployment gate independently obtained multiple advancing health samples with an 8-second request timeout, so the observer-path delay is not attributed to the Durable Object or the market loop.

## Safety and scope

No private Gate verification request, real-money test order, credential change, LIVE switch mutation, account reset, history reset, or foundation-framework replacement was performed. The release changes only the reproduced redirect/data-continuity/selection/entry-veto paths described in `research/LIVE_AND_SHOCK_CONTINUITY_2026-09-23.md`.
