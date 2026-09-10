# Generated State-Route Controller V6

A Gate USDT perpetual market-state system. One `MarketStream` Durable Object is authoritative for market observations, the 1,000 U simulated futures account, and optional owner-controlled LIVE mirroring.

## V6 authority

- The first pass ranks eligible Gate USDT perpetuals by 24-hour turnover and keeps a thirty-contract liquid universe. It does not decide trades.
- Completed 5-minute OHLCV is the stable strategy source. One symbol is refreshed every ten seconds, so the full universe is covered in about five minutes without requiring tick history, trades or open interest.
- Each completed-candle state can generate several independent long/short paths. One coin may research several mechanisms and one mechanism may serve several coins.
- Six generated mechanisms replace the old 12-playbook/48-variant execution catalog: low-efficiency boundary return, volatility transition, failed boundary acceptance, path recovery, directional persistence and valid boundary acceptance.
- For each current path, chronological walk-forward compares 10/20/30/45/60-minute horizons. Selection uses old samples and requires recent independent confirmation; it never uses future candles.
- PAPER authority belongs only to the current state-path recommendation. The old three/six promotion and mirrored reverse rules are archive-only and cannot open orders.
- PAPER requires at least eight similar paths, positive conservative return after full cost, profit factor at least 1.05, sufficient target reachability and no single winner dominating the result.
- The 10% daily return figure is an aspirational ranking objective, not a quota or guarantee. No trade is forced when current evidence is negative.

## Execution and risk

- Every effective shadow requires fresh bid/ask, complete Gate contract metadata, integer contracts, enough two-sided depth and turnover, a stop outside ordinary minute noise and a target that covers fees, spread and conservative slippage.
- Approved PAPER orders are exact clones of their effective shadows: direction, entry, frozen stop, frozen target and selected holding horizon remain identical.
- Same-candle stop/target ambiguity is settled stop-first. Stale prices cannot open or close a simulated or LIVE position.
- Planned risk per order is 10–20 U. Dynamic position count remains bounded by 10% total stop risk, 6.5% same-direction risk, 30% margin, 4× total notional and ten-symbol real-time management capacity.
- Funding is included when applicable. LIVE remains OFF unless the authenticated owner explicitly enables it, and deployment never enables LIVE.

## Data continuity

- The ten-second liquidity scan and the completed-candle strategy refresh are independent. A failed optional bulk scan preserves the last display snapshot but cannot authorize a new order after it becomes stale.
- Position books and LIVE reconciliation run before optional market work. Held symbols retain real-time priority.
- Strategy analysis uses only completed five-minute candles plus a fresh final bid/ask validation, avoiding dependence on unavailable high-frequency archives.
- A bounded D1 runtime sample is saved every five minutes and retained for fourteen days for review. There are no per-snapshot D1 writes.

## Account cycles and cutover

- V6 archives the preceding PAPER cycle and starts the new generated-route cycle at 1,000 U. If an old PAPER position exists, cutover waits for a fresh executable quote, settles it, archives the cycle and then resets.
- Old orders and cycle summaries stay in historical archive but do not affect current equity, statistics or authorization.
- Effective shadows continue independently of whether a route currently qualifies for PAPER.
- Owner reset follows the same rule: close at fresh executable prices, archive the current cycle, start at 1,000 U and preserve research shadows. It is rejected while LIVE is enabled or a system LIVE order/position exists.

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

Production releases use the GitHub-to-Cloudflare workflow and require advancing health checks with `generated-state-routes-v6`, completed-candle policy version 2, 30-market scanning, the six generated mechanisms, unchanged account/risk limits and LIVE explicitly OFF.
