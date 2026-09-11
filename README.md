# Extreme Sequence Mirror V9 · 极序·镜转

A Gate USDT perpetual market-state system. One `MarketStream` Durable Object is authoritative for market observations, the 1,000 U simulated futures account, and optional owner-controlled LIVE mirroring.

## V9 authority

- The first pass ranks eligible Gate USDT perpetuals by 24-hour turnover and keeps a thirty-contract liquid universe. It does not decide trades.
- Completed 5-minute OHLCV is the stable strategy source. One symbol is refreshed every ten seconds, so the full universe is covered in about five minutes without requiring tick history, trades or open interest.
- `极序·镜转` is the only strategy with PAPER authority. It recognizes two completed-candle extremes: retained boundary displacement (`FISSION`, 裂变) and failed boundary sweep/reclaim (`SNAPBACK`, 回卷).
- Every valid event opens paired normal and reverse effective shadows with mirrored geometry and identical cost assumptions.
- Exactly the latest three independent, cost-after shadow outcomes set the next-event polarity. Three normal wins authorize `NORMAL` (顺极). Three normal losses authorize `REVERSE` (逆极) only when the matching three reverse shadows all won. Mixed or stale sequences authorize no PAPER order.
- Polarity affects only a new event; it never reverses an existing position. A symbol and branch cool down for thirty minutes after close.
- Current extreme candidates are ranked globally before admission. The account can hold at most three positions, with the existing risk, direction, margin and notional caps applied.
- The 10% daily return figure remains an aspirational objective, not a quota or guarantee. No trade is forced when the polarity is unresolved or market structure is ordinary.

## Exit and risk

- Every effective shadow requires fresh bid/ask, complete Gate contract metadata, integer contracts, enough two-sided depth and turnover, a stop outside ordinary five-minute noise, and an economic profit-arm distance after fees, spread and slippage.
- Reaching the profit arm does not close the position. It starts a moving protection that locks at least costs plus 0.35R and follows favorable movement, allowing an uncapped runner.
- The original structural stop remains hard protection until the arm is reached. Same-candle stop/arm ambiguity is settled protection-first; stale prices cannot open or close a simulated or LIVE position.
- Before profit activation, no-progress expiry can close a trade. The full four-to-six-hour edge-decay horizon remains a hard maximum.
- Planned risk per order is 10–20 U. The portfolio is bounded by 10% total stop risk, 6.5% same-direction risk, 30% margin, 4× total notional, three open positions and ten-symbol real-time management capacity.
- Funding is included when applicable. LIVE remains OFF unless the authenticated owner explicitly enables it, and deployment never enables LIVE.

## Data continuity

- The ten-second liquidity scan and the completed-candle strategy refresh are independent. A failed optional bulk scan preserves the last display snapshot but cannot authorize a new order after it becomes stale.
- Position books and LIVE reconciliation run before optional market work. Held symbols retain real-time priority.
- Strategy analysis uses only completed five-minute candles plus a fresh final bid/ask validation.
- A bounded D1 runtime sample is saved every five minutes and retained for fourteen days for review. There are no per-snapshot D1 writes.

## Account cycles and cutover

- V9 archives the preceding PAPER cycle and starts the `极序·镜转` cycle at 1,000 U. If an old PAPER position exists, cutover waits for a fresh executable quote, settles it, archives the cycle and then resets.
- Old orders and cycle summaries remain available as historical evidence but do not affect current equity, statistics or polarity authorization.
- Effective shadow pairs continue independently of whether a polarity currently qualifies for PAPER.
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

Production releases use the GitHub-to-Cloudflare workflow and require advancing health checks with `extreme-sequence-mirror-v1`, arena version 9, the single `极序·镜转` authority, 30-market scanning, unchanged account/risk limits and LIVE explicitly OFF.
