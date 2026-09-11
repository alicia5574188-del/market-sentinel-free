# All-Regime Compound V10 · 全境·复利引擎

Gate USDT perpetual PAPER authority for a single compounding 1,000 U account. LIVE remains owner-controlled, default OFF and fail-closed.

## Decision authority

V10 scans the thirty most liquid eligible contracts, builds only continuous completed 5-minute paths and separates environment ownership from entry timing:

- `势承`: when broad-market direction is crowded, an apparent single-symbol exhaustion that lacks broad confirmation is treated as continuation, not a guessed top or bottom.
- `竭转`: when broad-market direction is neutral, a single-symbol path may reverse only after progress collapses and a completed segment reclaims the opposite direction.
- `衡返` and `压跃`: retain range and compression ownership plus paired research, but have no PAPER authority because the frozen thirty-day replay was not positive in both chronological halves.

Every executable event runs exact normal and reverse shadows after full friction. The two approved routes start in their validated direction. Three normal wins select normal; three normal losses may select reverse only when the same events won in reverse and the latest twelve reverse samples have positive mean with profit factor at least 2.5. Mixed results retain the last authorized orientation.

The profit arm does not cap profit. It starts dynamic protection; structural invalidation, no-progress and maximum-hold exits remain active.

## Evidence contract

`npm run research:all-regime` downloads completed Gate futures 5-minute candles and performs next-bar, chronological replay with 0.14% round-trip friction and 0.025% entry slippage. The frozen thirty-day, twenty-market acceptance run produced:

| Route | First half | Held-out half |
| --- | ---: | ---: |
| 势承 base events | PF 2.11, +23.20% summed event return | PF 1.19, +6.72% |
| 竭转 base events | PF 1.13, +11.53% summed event return | PF 1.04, +3.51% |
| Routed account at 0.5× per position | 207 trades, 1,000 → 1,045.16 U, 6.27% max drawdown | 214 trades, 1,000 → 1,046.72 U, 9.23% max drawdown |

These are historical simulations, not a promise of daily profit. PAPER is the forward test.

## Account and execution

- One account, current-equity compounding, at most three positions and at most 0.5× equity notional per position.
- Full modeled friction, fresh bid/ask, executable depth, Gate integer contracts and structural stops are mandatory.
- Aggregate structural risk remains at most 10%; same-direction structural risk remains at most 6.5%.
- Stale or incomplete data cannot open or close on an old price.
- Same symbol has one active portfolio trade; same-side agreement merges and strong opposing routes wait.

## Operator page

The public page shows account equity, today's net result, current environment, owning strategy, PAPER positions and complete account trade records. Shadow samples, raw diagnostics, internal route transitions and legacy research remain backend-only. Owner authentication reveals LIVE controls and credentials; public runtime never returns secrets.

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

Production releases only from GitHub `main`. The release gate requires `all-regime-compound-v1`, arena version 10, four environment owners, thirty-market scanning, advancing authority health and LIVE explicitly OFF.
