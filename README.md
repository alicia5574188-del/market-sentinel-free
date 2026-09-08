# Market Anomaly Radar

A Gate USDT perpetual paired-reaction and win/loss-attribution research system. One `MarketStream` Durable Object remains the sole authority for market state and protection of any pre-existing PAPER/LIVE positions.

## Market-data architecture

- Every 10 seconds one bulk Gate futures-ticker request scans every eligible USDT perpetual. The local radar compares each contract with its own short-window movement baseline, rejects contracts below the liquidity floor, and publishes at most twelve ranked anomalies.
- Open exposure and the strongest candidates have priority. At most three symbols receive two-second order-book monitoring. Candidate detail is fetched from completed 1m candles plus rotating signed trades, OI statistics, and liquidations; the system never opens one full feed per contract.
- An anomaly is only a sample selector, never an entry direction. After two radar confirmations, the system freezes the event reference and opens a three-minute paired observation: pullback-then-continuation, deep-retrace reversal, or explicit no-trade when neither condition completes.
- Continuation requires a 20%-70% retrace followed by two advancing, impulse-aligned flow observations. Reversal requires at least a 70% retrace followed by two declining, opposite-flow observations. Each triggered branch freezes its own shadow entry, noise-bounded stop, and target.
- Triggered shadow branches are followed for up to twenty minutes, use the same ten-minute no-progress exit, and deduct 0.18% modeled round-trip friction. The paired lab is bounded and checkpointed without per-snapshot D1 writes.
- A separate outcome researcher starts only with newly created routes that contain a complete pre-outcome feature snapshot. It contrasts winners and losers by branch, event type, impulse size/strength, relative movement, volume, OI change, spread, aligned book depth, trigger retrace/flow/speed and stop width. The first 100 complete routes are discovery samples; later routes are held out as confirmation samples so exploratory conditions cannot grade themselves.
- Outcome-path measures such as maximum favorable/adverse movement and holding time remain diagnostic fields, not admissible entry filters. Aggregates, feature buckets, complete-condition segments, deduplication ids and recent samples are bounded in the existing checkpoint; the researcher makes no exchange request and no D1 write.
- The public ticker scan finds where activity occurs. OI, taker flow, liquidations, and order-book imbalance classify whether the move resembles new money, squeeze/liquidation, or an unsupported price shock. Missing optional evidence lowers confidence instead of putting the entire service into recovery.
- Contract metadata refreshes every ten minutes. A 30-second compact checkpoint and one-minute Cron watchdog recover eviction or missed alarms. No market snapshot is written to D1.

## Execution lock and retained risk controls

- The paired-reaction lab has no PAPER or LIVE order authority. Runtime decisions are explicitly null, PAPER opening is disabled, the LIVE enable endpoint rejects activation, and every process restart restores LIVE to off.
- Existing PAPER/LIVE positions, if any, keep their original stop and exit management. Gate account visibility, reconciliation, reduce-only protection, owner authentication, and system-tag cleanup remain available.
- Per-entry planned loss is confidence-scaled from 0.5% to 1% of applicable equity. Planned notional remains capped at 4× equity, aggregate structural risk at 10%, same-direction correlated risk at 6.5%, and aggregate margin at 30%.
- Every entry must independently provide at least 1.2:1 net reward/risk after modeled 0.18% round-trip friction and at least 0.2% of equity in net target value. Wider/noisier stops reduce notional instead of increasing dollar loss.
- Historical PAPER performance remains visible, but the research version measures branch trigger rate, after-cost win rate, average net return, and frozen winner/loser feature differences instead of targeting order count.
- Stops remain immediate. Optional soft exits need completed-minute evidence and cannot fire from a few two-second ticks. Dynamic protection still waits for both 1.5R and 70% target progress, so an ordinary pullback is not turned into a premature micro-profit exit.

## Retained operations

- AES-GCM/HKDF credential format, fixed owner authentication, signed same-origin HttpOnly session, LIVE default-off boundary, and the prohibition on fund transfers.
- Exact string Gate order IDs, ambiguous-order reconciliation, system-tag-only cleanup, actual Gate lot/margin revalidation, and per-symbol feed recovery.
- PAPER reset to 1,000 U, separate completed-history clearing, bankruptcy rollover/reporting, idempotent D1 outbox, complete cursor-paginated PAPER history, and full cycle-order disclosure rebuilt from durable per-order diagnostics at bankruptcy archival.
- The operator page has no market or history charts. History loads only when the review tab is opened, then refreshes only the newest page; each order keeps prices, gross result, modeled cost, net result, realized R, original stop, target, duration, and exit reason without making another Gate candle request.
- Public research page and owner-only LIVE account/position controls. Old completed trades remain available, the old single-direction rejection audit is archived, and paired experiments plus win/loss attribution have separate review pages.

## Planned Free-tier budget

- 43,200 two-second alarm requests and alarm writes per day.
- 8,000 non-alarm DO write cap plus 2,880 watchdog reserve: 54,080 planned DO writes/day.
- 5,760 foreground requests at one continuously open 15-second page poll plus 1,440 watchdog requests: 50,400 planned DO requests/day.
- D1 billed writes are capped at 4,800/day; removing chart mirrors and chart review events leaves only position/account audit persistence, so normal event trading is expected to be materially lower.
- One bulk Gate ticker scan every 10 seconds adds 8,640 public requests/day. Two-second detail remains capped to the three realtime symbols and preserves the existing per-alarm subrequest/concurrency redlines.

## Verification

```bash
npm run test:direct
npm test
npm run typecheck
npm run lint
git diff --check
```

Production releases use the existing GitHub-to-Cloudflare workflow. The encrypted Gate credential row is preserved, and every deployment must pass advancing runtime-health checks while LIVE remains forced off for this research version.
