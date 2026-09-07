# Market Anomaly Radar

A Gate USDT perpetual event-scalping system. One `MarketStream` Durable Object is the sole authority for both PAPER and owner-controlled LIVE execution.

## Market-data architecture

- Every 10 seconds one bulk Gate futures-ticker request scans every eligible USDT perpetual. The local radar compares each contract with its own short-window movement baseline, rejects contracts below the liquidity floor, and publishes at most twelve ranked anomalies.
- Open exposure and the strongest candidates have priority. At most three symbols receive two-second order-book monitoring. Candidate detail is fetched from completed 1m candles plus rotating signed trades, OI statistics, and liquidations; the system never opens one full feed per contract.
- An anomaly needs a personal baseline, a relative/absolute price shock, at least two radar observations, fresh 1m evidence, four fresh book snapshots after a symbol joins the realtime pool, and no strong opposing flow. The resulting current-price IOC plan uses the actual event price, a noise-aware stop, and a short-term target that independently passes after-cost economics.
- The public ticker scan finds where activity occurs. OI, taker flow, liquidations, and order-book imbalance classify whether the move resembles new money, squeeze/liquidation, or an unsupported price shock. Missing optional evidence lowers confidence instead of putting the entire service into recovery.
- Contract metadata refreshes every ten minutes. A 30-second compact checkpoint and one-minute Cron watchdog recover eviction or missed alarms. No market snapshot is written to D1.

## Execution and risk

- PAPER and LIVE consume the same frozen plan, actual-fill sizing, fees, stress slippage, leverage selection, stop, and target. LIVE defaults off and deployment/login never enables it.
- Entry is a current-price IOC. No exchange-resident entry order waits for price. After a LIVE fill, a reduce-only exchange hard stop is required; failure to protect fails closed.
- Per-entry planned loss is confidence-scaled from 0.5% to 1% of applicable equity. Planned notional remains capped at 4× equity, aggregate structural risk at 10%, same-direction correlated risk at 6.5%, and aggregate margin at 30%.
- Every entry must independently provide at least 1.2:1 net reward/risk after modeled 0.18% round-trip friction and at least 0.2% of equity in net target value. Wider/noisier stops reduce notional instead of increasing dollar loss.
- There is no daily order-count ceiling and currently no daily loss shutoff. The operator UI shows a New-York-day goal of +150 U from a 1,000 U PAPER base, but the goal never relaxes entry quality or risk limits.
- Stops remain immediate. Optional soft exits need completed-minute evidence and cannot fire from a few two-second ticks. Dynamic protection still waits for both 1.5R and 70% target progress, so an ordinary pullback is not turned into a premature micro-profit exit.

## Retained operations

- AES-GCM/HKDF credential format, fixed owner authentication, signed same-origin HttpOnly session, LIVE default-off boundary, and the prohibition on fund transfers.
- Exact string Gate order IDs, ambiguous-order reconciliation, system-tag-only cleanup, actual Gate lot/margin revalidation, and per-symbol feed recovery.
- PAPER reset to 1,000 U, separate completed-history clearing, bankruptcy rollover/reporting, idempotent D1 outbox, complete cursor-paginated PAPER history, and full cycle-order disclosure rebuilt from durable per-order diagnostics at bankruptcy archival.
- History is the only chart surface. Each order loads cached, completed Gate 5m OHLC candles on demand, marks its exact buy (`B`) and sell (`S`) points, and continues the review window through twelve hours after exit. This review path does not add Durable Object alarms or D1 writes.
- Public PAPER page and owner-only LIVE account/position controls. Old completed trades remain available for review; the new strategy version starts separate runtime decisions.

## Planned Free-tier budget

- 43,200 two-second alarm requests and alarm writes per day.
- 8,000 non-alarm DO write cap plus 2,880 watchdog reserve: 54,080 planned DO writes/day.
- 5,760 foreground requests at one continuously open 15-second page poll plus 1,440 watchdog requests: 50,400 planned DO requests/day.
- D1 billed writes are capped at 4,800/day; normal event trading is expected to be materially lower.
- One bulk Gate ticker scan every 10 seconds adds 8,640 public requests/day. Two-second detail remains capped to the three realtime symbols and preserves the existing per-alarm subrequest/concurrency redlines.

## Verification

```bash
npm run test:direct
npm test
npm run typecheck
npm run lint
git diff --check
```

Production releases use the existing GitHub-to-Cloudflare workflow. The encrypted Gate credential row is preserved, and every deployment must pass advancing runtime-health checks while LIVE remains user-controlled.
