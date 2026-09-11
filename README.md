# All-Regime Compound V11 · 全境·复利引擎

Gate USDT perpetual PAPER authority for a single compounding 1,000 U account. LIVE remains owner-controlled, default OFF and fail-closed.

## Decision authority

V11 scans the thirty most liquid eligible contracts, builds only continuous completed 5-minute paths and separates environment recognition, route formation and account admission:

- `势承·逆竭`: when broad-market direction is crowded, apparent single-symbol exhaustion that lacks broad confirmation continues with the crowd.
- `竭转·孤返`: when broad-market direction is neutral, a single-symbol path reverses only after progress collapses and a completed segment reclaims the opposite direction.
- `衡返·双拒`: in a broad neutral market, a low-efficiency range must cross its center repeatedly, reject the same edge at least twice and reclaim it on a completed segment. Its latest chronological fold is negative, so it remains paired normal/reverse shadow research until current results select a polarity.
- Direct momentum chasing and direct compression breakout remain observation-only: their after-cost train/held-out evidence is negative.

Every executable event runs exact normal and reverse shadows after full friction. The two currently approved exhaustion-derived branches start in their validated direction. Three normal wins select normal; three normal losses select reverse only when those same three fully costed mirror trades all won. Mixed results retain the last authorized orientation. A disabled family can regain PAPER authority only through this current paired evidence.

The profit arm does not cap profit. It starts dynamic protection; structural invalidation, no-progress and maximum-hold exits remain active.

## Evidence contract

`node scripts/research-v11.mjs` consumes the frozen CI dataset and performs next-bar, chronological replay with 0.14% round-trip friction and 0.025% entry slippage. The frozen thirty-day, twenty-market route study produced:

| Route | First half | Held-out half |
| --- | ---: | ---: |
| 势承·逆竭 | 48 events, PF 1.80, +16.11% summed return | 50 events, PF 1.71, +23.98% |
| 衡返·双拒（影子） | 31 events, PF 1.16, +4.14% | 22 events, PF 1.42, +8.86%; latest fold PF 0.67, PAPER off |
| 竭转·孤返 | 103 events, PF 0.98, -0.81% | 86 events, PF 1.39, +15.85% |

These are historical simulations, not a promise of daily profit. PAPER is the forward test.

## Account and execution

- One account, current-equity compounding, at most three positions and at most 0.5× equity notional per position.
- Full modeled friction, fresh bid/ask, executable depth, Gate integer contracts and structural stops are mandatory.
- Aggregate structural risk remains at most 10%; same-direction structural risk remains at most 6.5%.
- Stale or incomplete data cannot open or close on an old price.
- Same symbol has one active portfolio trade; same-side agreement merges and strong opposing routes wait.

## Operator page

The public page shows account equity, today's net result, current environment, owning strategy, PAPER positions and complete account trade records. Route status, direction and the final blocker come from backend admission state; the page never reconstructs authority from candles. The runtime card reports a rolling one-hour book success rate and separates recovered short faults from actual trading blockers.

Gate public reads use endpoint-wide rate-limit backoff plus the two official futures REST hosts. The thirty-market radar runs once per minute. Completed 5-minute paths update only after a new bar closes, then use four-row incremental reads and merge into the retained continuous 120-row path. A timeout or 429 keeps that path available; only repeated failure after the retained path exceeds eleven minutes blocks the affected market. Protected positions and formed routes retain fresh-book priority. Trading API credentials are never attached to these public reads.

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

Production releases only from GitHub `main`. The release gate requires `all-regime-compound-v2`, arena version 11, four environment owners, backend route-check truth, thirty-market scanning, advancing authority health and LIVE explicitly OFF.
