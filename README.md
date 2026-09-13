# All-Regime Compound V12 · 全境·复利引擎

Gate USDT perpetual PAPER authority for a single compounding 1,000 U account. LIVE remains owner-controlled, default OFF and fail-closed.

## Decision authority

V12 scans the thirty most liquid eligible **crypto** USDT perpetuals, builds continuous completed 5-minute paths and separates route formation, frozen market-environment authority and account admission. Unknown or stock/commodity-style contract types fail closed before ranking. Five V5 mechanisms have PAPER authority only in cross-market cells that stayed profitable in chronological train and held-out samples:

- `界返`: range-lower-band re-entry during a strong daily market with a four-hour pullback.
- `渠破`: 48-bar downside channel break in a neutral-to-weak daily market.
- `势回`: asset uptrend pullback recovery during a mild broad-market decline.
- `熊缩`: main-asset volatility squeeze release during a broad decline.
- `牛接`: main-asset volatility squeeze release during a strong daily market pullback.

Every mechanism uses completed-candle signals, current executable-price economics, a fixed stop and a fixed target. A formed signal is spaced by the same two/four-hour cooldown used in research. The account admits at most one open trade per mechanism and one per direction; every authorized event also runs exact normal and reverse shadows after full friction.

## Evidence contract

The final implementation was replayed directly from its trailing 360-candle runtime path on independent Binance 90-day and Gate 35-day crypto-only datasets. Under a 0.22% stress cost, 3% current-equity risk, one position per strategy and one per direction, the held-out results were:

| Dataset | Held-out trades | Profit factor | Net PnL from 1,000 U | Max drawdown |
| --- | ---: | ---: | ---: | ---: |
| Binance 90-day | 41 | 1.18 | +79.14 U | 9.34% |
| Gate 35-day | 18 | 1.66 | +122.83 U | 6.52% |

The corresponding full-period stress replays were PF 1.71 with 9.34% drawdown on Binance and PF 1.76 with 6.52% drawdown on Gate. Sparse periods remain valid waiting states rather than a trade quota.

These are historical simulations, not a promise of daily profit. PAPER is the forward test.

## Account and execution

- One account with current-equity compounding. Each accepted trade targets 3% of current equity at its stop, subject to the existing 4× notional ceiling, 10% total risk, 6.5% same-direction risk and 30% total margin. An exceptionally wide stop that cannot sustain at least 1× equity notional is rejected instead of becoming a meaningless tiny position.
- Full modeled friction, fresh bid/ask, executable depth, Gate integer contracts and structural stops are mandatory. Immediately after Gate confirms an entry submission, the same execution pass submits the existing native close-only/reduce-only price-order stop; reconciliation then owns and updates that order. LIVE protective stops use Gate's current contract tick and round outward only, so price-grid normalization cannot close ahead of PAPER.
- Aggregate structural risk remains at most 10%; same-direction structural risk remains at most 6.5%.
- Stale or incomplete data cannot open or close on an old price.
- Same symbol has one active portfolio trade; same-side agreement merges and strong opposing routes wait.

## Operator page

The public page shows account equity, today's net result, current environment, owning strategy, PAPER positions and complete account trade records. Route status, direction and the final blocker come from backend admission state; the page never reconstructs authority from candles. Formed candidates that fail execution, strategy authority or account admission are retained in a bounded blocked-candidate audit; early route formation noise is not mislabeled as an order. The owner-only LIVE timeline remains visible after shutdown and records confirmed fills, exits, Gate rejection labels and safety actions.

Gate public reads use per-host endpoint backoff across the two official futures REST hosts: a timeout, 5xx or 429 on one host immediately fails over without putting the other host into backoff. Fresh executable books remain inside the two-second authority alarm, while the thirty-market radar, completed-candle refresh, universe refresh and research logging run as one non-overlapping background task and cannot hold the next protection/entry pass. Resident books are staggered; one scheduled subset miss stays in per-market feed diagnostics and cannot impersonate a whole-pool outage. Global recovery begins only after executable freshness actually expires, while a failed protected position or formed route freezes that exposure alone. Completed 5-minute paths update only after a new bar closes, then use four-row incremental reads and merge into the retained continuous 360-row path. A timeout or 429 keeps that path available; only repeated failure after the retained path exceeds eleven minutes blocks the affected market. Protected positions and formed routes retain fresh-book priority. Trading API credentials are never attached to these public reads.

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

Production releases only from GitHub `main`. The release gate requires `all-regime-compound-v2`, arena version 12, V5 route authority, backend route-check truth, thirty-market scanning and advancing authority health. LIVE defaults OFF for a new account, but deployment preserves the owner's saved requested state and starts non-operational until the first fresh Gate reconciliation; recoverable single-symbol rejection cannot rewrite that choice. Existing PAPER account equity, positions and history are preserved.
