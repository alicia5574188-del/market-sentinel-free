# All-Regime Compound V12 · 全境·复利引擎

Gate USDT perpetual PAPER authority for a single compounding 1,000 U account. LIVE remains owner-controlled, default OFF and fail-closed.

## Decision authority

V12 scans the thirty most liquid eligible **crypto** USDT perpetuals, builds only continuous completed 5-minute paths and separates state recognition, route formation and account admission. Unknown or stock/commodity-style contract types fail closed before ranking. Six mechanisms are researched, but only five have PAPER authority and only inside their frozen profitable state cells:

- `潮补`: broad-up compression while the contract remains at the low edge and lags the market tide.
- `静移`: neutral-market compression with a completed directional migration through the center.
- `潮接`: broad-up expansion at the high edge, or an orderly mixed-market trend at the high edge, after a completed pullback and resume.
- `冲衡`: balanced, broad-neutral center rotation after an isolated impulse is reclaimed.
- `脉折`: balanced broad-down center rotation after a local upward extreme fails.
- `势承`: retained as paired shadow research because its positive aggregate result is concentrated in too few time windows; it has no PAPER state authority.

Compression, expansion, orderly trend and balanced rotation each have at least one held-out-positive mechanism. Transition/noise has no stable after-cost edge in the frozen study, so its explicit strategy is capital preservation (`WAIT`) instead of forcing a trade. Every authorized event also runs exact normal and reverse shadows after full friction. Three normal wins retain/select normal; three normal losses select reverse only when those same three fully costed mirror trades all won. Mixed results retain the last authorized orientation.

The profit arm does not cap profit. It starts dynamic protection; structural invalidation, no-progress and maximum-hold exits remain active.

## Evidence contract

`npm run research:all-regime` consumes or builds the frozen CI dataset and performs next-bar, chronological replay with 0.14% round-trip friction and 0.025% entry slippage. The frozen thirty-day, twenty-crypto-market route study produced:

| Route | First half | Held-out half |
| --- | ---: | ---: |
| 潮补·压缩普涨低位 | 54 events, PF 1.75 | 31 events, PF 1.46 |
| 静移·压缩混合中位 | 53 events, PF 1.23 | 47 events, PF 1.51 |
| 冲衡·轮动混合中位 | 17 events, PF 1.99 | 29 events, PF 1.36 |
| 脉折·轮动普跌中位 | 20 events, PF 1.43 | 14 events, PF 2.08 |
| 潮接·扩张普涨/有序混合高位 | 87 events, PF 1.26 | 67 events, PF 1.85 |

With the same account constraints and non-overlapping lifecycles, the routed portfolio selected 194 first-half trades at PF 1.42 (1,000 → 1,251 U, 6.4% max drawdown) and 177 held-out trades at PF 1.46 (1,000 → 1,236 U, 11.9% max drawdown). The observed cadence is about twelve trades per day across twenty sampled markets; it is not a quota or forecast.

These are historical simulations, not a promise of daily profit. PAPER is the forward test.

## Account and execution

- One account with current-equity compounding. Position notional is set by structural risk and may use derivatives exposure up to the existing 4× account-wide ceiling; there is no separate 0.5× per-position ceiling or fixed position-count veto. A new PAPER route must still support at least 1× current-equity notional without exceeding structural-risk, directional-risk or margin limits; an exceptionally wide stop is rejected instead of being opened as a meaningless tiny position. Executable data capacity, 10% total risk, 6.5% same-direction risk and 30% total margin determine concurrency.
- Full modeled friction, fresh bid/ask, executable depth, Gate integer contracts and structural stops are mandatory. LIVE protective stops use Gate's current contract tick and round outward only, so price-grid normalization cannot close ahead of PAPER.
- Aggregate structural risk remains at most 10%; same-direction structural risk remains at most 6.5%.
- Stale or incomplete data cannot open or close on an old price.
- Same symbol has one active portfolio trade; same-side agreement merges and strong opposing routes wait.

## Operator page

The public page shows account equity, today's net result, current environment, owning strategy, PAPER positions and complete account trade records. Route status, direction and the final blocker come from backend admission state; the page never reconstructs authority from candles. Formed candidates that fail execution, strategy authority or account admission are retained in a bounded blocked-candidate audit; early route formation noise is not mislabeled as an order. The owner-only LIVE timeline remains visible after shutdown and records confirmed fills, exits, Gate rejection labels and safety actions.

Gate public reads use per-host endpoint backoff across the two official futures REST hosts: a timeout, 5xx or 429 on one host immediately fails over without putting the other host into backoff. Fresh executable books remain inside the two-second authority alarm, while the thirty-market radar, completed-candle refresh, universe refresh and research logging run as one non-overlapping background task and cannot hold the next protection/entry pass. Resident books are staggered; one scheduled subset miss stays in per-market feed diagnostics and cannot impersonate a whole-pool outage. Global recovery begins only after executable freshness actually expires, while a failed protected position or formed route freezes that exposure alone. Completed 5-minute paths update only after a new bar closes, then use four-row incremental reads and merge into the retained continuous 120-row path. A timeout or 429 keeps that path available; only repeated failure after the retained path exceeds eleven minutes blocks the affected market. Protected positions and formed routes retain fresh-book priority. Trading API credentials are never attached to these public reads.

## Verification and release

```bash
npm run test:all-regime
npm run test:direct
npm test
npm run typecheck
npm run lint
npm run build
npx wrangler deploy --dry-run --config dist/server/wrangler.json
```

Production releases only from GitHub `main`. The release gate requires `all-regime-compound-v2`, arena version 12, crypto-only causal replay, profitable discovery and held-out portfolios, four tradable phase authorities plus transition `WAIT`, backend route-check truth, thirty-market scanning and advancing authority health. LIVE defaults OFF for a new account, but deployment preserves the owner's saved requested state and starts non-operational until the first fresh Gate reconciliation; recoverable single-symbol rejection cannot rewrite that choice. Existing PAPER account equity, positions and history are preserved.
