# All-Regime Compound V12 · 全境·复利引擎

Gate USDT perpetual PAPER authority for a single compounding 1,000 U account. LIVE remains owner-controlled, default OFF and fail-closed.

## Decision authority

V12 scans the thirty most liquid eligible contracts, builds only continuous completed 5-minute paths and separates environment recognition, route formation and account admission. Six original mechanisms cover four environment classes:

- `势承·逆竭`: when broad-market direction is crowded, apparent single-symbol exhaustion that lacks broad confirmation continues with the crowd.
- `竭转·孤返`: when broad-market direction is neutral, a single-symbol path reverses only after progress collapses and a completed segment reclaims the opposite direction.
- `脉折·相位`: a 32-segment medium path measures the gap between total displacement and the latest six-segment contribution; neutral breadth permits the completed reversal while crowded breadth continues with the broad direction.
- `缓续·顺潮`: a less orderly 36-segment path fills slower opportunities only when synchronized broad-market direction confirms continuation; its neutral reversal branch is explicitly rejected.
- `衡返·双拒`: in a broad neutral market, a low-efficiency range must cross its center repeatedly, reject the same edge at least twice and reclaim it on a completed segment. Its latest chronological fold is negative, so it remains paired normal/reverse shadow research until current results select a polarity.
- Direct momentum chasing and direct compression breakout remain observation-only: their after-cost train/held-out evidence is negative.

Every executable event runs exact normal and reverse shadows after full friction. The four approved route families start in their validated direction. Three normal wins select normal; three normal losses select reverse only when those same three fully costed mirror trades all won. Mixed results retain the last authorized orientation. A disabled family can regain PAPER authority only through this current paired evidence.

The profit arm does not cap profit. It starts dynamic protection; structural invalidation, no-progress and maximum-hold exits remain active.

## Evidence contract

`node scripts/research-v11.mjs` consumes the frozen CI dataset and performs next-bar, chronological replay with 0.14% round-trip friction and 0.025% entry slippage. The frozen thirty-day, twenty-market route study produced:

| Route | First half | Held-out half |
| --- | ---: | ---: |
| 势承·逆竭 | 48 events, PF 1.80, +16.11% summed return | 50 events, PF 1.71, +23.98% |
| 衡返·双拒（影子） | 31 events, PF 1.16, +4.14% | 22 events, PF 1.42, +8.86%; latest fold PF 0.67, PAPER off |
| 竭转·孤返 | 103 events, PF 0.98, -0.81% | 86 events, PF 1.39, +15.85% |
| 脉折·相位 | 126 events, PF 1.60 | 147 events, PF 1.18; three folds PF 1.61/1.15/1.37 |
| 缓续·顺潮 | 47 events, PF 1.62 | 60 events, PF 1.66; three folds PF 2.01/1.45/1.68 |

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

Production releases only from GitHub `main`. The release gate requires `all-regime-compound-v2`, arena version 12, six route mechanisms, backend route-check truth, thirty-market scanning and advancing authority health. LIVE defaults OFF for a new account, but a deployment preserves the owner's saved requested state and starts non-operational until the first fresh Gate reconciliation; recoverable single-symbol rejection cannot rewrite that choice. The V11→V12 migration preserves the current account, positions and trade history while adding the two new strategy states.
