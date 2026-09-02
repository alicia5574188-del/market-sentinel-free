# Status

- State: production-deployed
- Updated UTC: 2026-09-02T09:18:00Z
- Pull request: `#103` — `feat/resonance-strategy-research-v2`
- Feature commit: `013908658e26c783742e50f21efde3d6307ad1e3`
- Production merge commit: `599dd815e202e8910b773a4481f45083c35972bc`
- Runtime identity: `resonance-v3-strategy-research`
- Production URL: `https://market-sentinel-free.alicia5574188.workers.dev`

## Completed and deployed

- Preserved HT1–HT5 as the five paper control/execution strategies and froze HT4 Exhaustion with an exact source regression fingerprint.
- Added eight HTE31-native challengers in a research-only lane: revised HT1/HT2/HT3/HT5 plus HT6 range rotation, HT7 compression expansion, HT8 relative strength, and HT9 momentum continuation.
- Added up to 64 concurrent no-capital shadow observations and an explainable research router for single-strategy, same-side cooperation, opposite-side conflict, and switch-watch hypotheses.
- Changed new paper sizing to target 15% isolated margin with a 45% narrow-stop hard fallback while preserving structural stop, notional, fee-inclusive 3–5% equity risk, and liquidation buffer.
- Preserved Entry Quality, historical-sample eligibility, last-trustworthy-snapshot degradation, five-tab UI, owner controls, Gate safety, paper history, and all open-position lifecycles.
- Applied additive migration `0016_hte31_concurrent_strategy_research.sql`; no historical trade, learning, account, credential, live-order, or simulation-epoch data was deleted.

## Explicitly unchanged

- HT4 entry logic and priority, two paper control position slots, existing positions, stop/TP lifecycle, and paper account history.
- Gate live sizing, three-strategy live allowlist, credentials, Auto Live intent, reconciliation, safety locks, and Emergency Stop.
- Research strategies cannot spend capital, create a Gate order, pre-empt HT4, auto-promote, auto-switch, hedge, or multiply executable exposure.

## Verification evidence

- Local: strategy/risk/migration suite 204/204; production build/UI/Must-Keep suite 107/107; ESLint, TypeScript, Wrangler dry-run, and `git diff --check` passed.
- PR CI: Sentinel V2 CI run `33612891752` / job `100191962600` passed.
- Merged-main CI: run `33612981374` / job `100192245504` passed.
- Production served immutable client asset `assets/page-BQKWUfKi.js` with the new `选择、并用与纠错` surface.
- Production `/__health` returned HTTP 200 with `ok: true`; Position Monitor and Market Scanner were both `live`, both success timestamps advanced between probes, no scheduler error was present, and the scanner circuit was closed.
- The current access surface did not expose Cloudflare's internal Build ID or Version ID, so deployment was verified from the immutable production asset plus live scheduler health rather than inventing those identifiers.

## Next action

- Collect non-overlapping forward research evidence. Do not tune HT4 or promote any challenger until the explicit router gates and a separate manual audit are satisfied.
- Use `docs/QUANT_SYSTEM_MASTER_HANDOFF.md` as the first entry point for every future quantitative-system task.

## Blockers

- None.
