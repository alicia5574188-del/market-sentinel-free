# Strategy Brain Lifecycle and Family Consolidation Plan

Status: **implemented, deployed, and production-verified in PR #109**
Prepared: **2026-09-03 UTC**

## Objective

Make the existing unified paper brain understand, compare, review, consolidate, and manage every strategy over its full lifecycle. Paper learning and the future Gate path must keep the same strategy lineage. Real funding remains an owner decision after sustained positive simulated growth.

This is an in-place improvement of the existing capital-backed simulation account. It must not create shadow trades or a second simulation layer.

## Current verified baseline to preserve

- Thirteen strategy variants already compete in one paper account and the brain's exact selected candidate is the only executable candidate for a symbol/cycle.
- Paper/live capacity is at most five positions, at most three per direction, one per symbol, and at most 20% total planned stop risk.
- Paper sizing targets 8% isolated margin, permits a liquidation-safe fallback up to 35%, and caps adaptive leverage at 50x.
- Post-exit observation, Entry Quality, counterfactual paths, per-cell loss gates, and strategy routing already exist.
- Planned recurring D1 writes are 27,360 rows/day. The hard planning ceiling is 60,000, leaving at least 40,000 below the 100,000 daily allowance.
- Current production protects HT4 with a source fingerprint. The owner has superseded that policy for the next implementation: HT4 must receive no priority, freeze, exemption, or special tuning protection. Its prior profitable period remains historical evidence only.

## Canonical strategy families

The first implementation should organize the thirteen current IDs into nine canonical families while retaining every old ID as a historical alias.

| Family | Canonical name | Current variants | Initial relationship |
| --- | --- | --- | --- |
| SF01 | `TREND_BREAKOUT` | HT1, HT1-R | base / accepted-breakout-retest |
| SF02 | `TREND_PULLBACK` | HT2, HT2-R | base / adaptive-depth recovery |
| SF03 | `FAILED_BREAKOUT` | HT3, HT3-R | base / force-aware failed auction |
| SF04 | `EXHAUSTION_REVERSAL` | HT4 | single variant; evaluated normally |
| SF05 | `HIGHER_TIMEFRAME_SWING` | HT5, HT5-R | base / regime-context variant |
| SF06 | `RANGE_ROTATION` | HT6 | single variant |
| SF07 | `COMPRESSION_EXPANSION` | HT7 | single variant |
| SF08 | `RELATIVE_STRENGTH` | HT8 | single variant |
| SF09 | `MOMENTUM_CONTINUATION` | HT9 | single variant |

Canonical display format:

`SF01 TREND_BREAKOUT / ACCEPTED_RETEST`

Required metadata:

- `familyId`, `familyName`, `variantId`, and legacy `traderId`/`strategyId` aliases.
- market-regime, timeframe, allowed-side, entry-style, and authority tags.
- dynamic health state kept outside the permanent name.
- historical facts such as HT4's prior profitable period stored as evidence, never as a permanent score bonus.

## Similarity and consolidation policy

Do not merge merely because two strategies use similar indicators or names.

1. Group the four explicit base/challenger pairs above immediately at the catalog and brain-management level.
2. Compare identical market snapshots for readiness, side, entry timing, entry zone, structural stop, targets, holding limit, and blocking checks.
3. Compare independent eligible episodes rather than counting repeated one-minute scans as independent evidence.
4. Retire a duplicate variant only when it adds no distinct market-regime coverage and its entries/risk plan substantially duplicate the family peer across adequate evidence.
5. If evidence is insufficient, keep both variants under one family. The family can produce only one executable candidate for a symbol/cycle.
6. Never delete or rewrite old trades, learning, evaluations, reviews, or live lineage. Resolve old IDs through catalog aliases.

The implementation must produce an auditable result for each current variant: `KEEP_VARIANT`, `MERGE_ALIAS`, `RETEST`, or `RETIRE_AFTER_EVIDENCE`, with the reasons and evidence count.

## Strategy health model

Apply the same model to every family and variant, including HT4:

- `LEARNING`: insufficient independent closed-order evidence.
- `ACTIVE`: suitable regime, valid opportunities, and no proven negative evidence.
- `UNDERPERFORMING`: recent eligible sample is negative but diagnosis is incomplete.
- `DEGRADED`: previously useful evidence has materially weakened in comparable regimes.
- `STARVED`: suitable regimes occurred repeatedly but the strategy produced no usable entries.
- `REGIME_WAIT`: the strategy is unused because its required market environment did not occur; this is not a fault.
- `RETEST`: one controlled paper revalidation is allowed after a pause or correction.
- `PAUSED`: proven-negative or invalid behavior cannot open until the revalidation rule is met.

Health must be derived from existing evaluations, closed paper orders, Entry Quality, post-exit evidence, and regime attribution. Do not add per-scan health writes. If a transition needs persistence, write only on state change.

## Closed-order final verdict

Reuse the existing post-exit observer and counterfactual windows. After the observation horizon completes, assign one explainable final verdict:

- `VALID_TRADE`: reasonable trade, including a normal loss within the setup.
- `NO_TRADE`: the setup lacked an edge and should have been skipped.
- `DIRECTION_WRONG`: the opposite thesis was consistently superior after costs.
- `ENTRY_EARLY` or `ENTRY_LATE`.
- `EXIT_EARLY` or `EXIT_LATE`.
- `RISK_PLAN_MISMATCH`: structural stop/target/timeout did not match the setup.
- `INSUFFICIENT_EVIDENCE`: do not learn from an incomplete path.

The report must answer both questions requested by the owner: what would have made the trade profitable, and whether the trade should not have existed. A single order may explain a hypothesis but must not rewrite strategy behavior by itself.

## Brain actions

1. Select the best family from current market structure and eligible evidence.
2. Select at most one variant inside that family for the symbol/cycle.
3. Use historical performance only after the existing minimum sample gate; recent and comparable-regime evidence must be visible separately from lifetime evidence.
4. For repeated losses, diagnose entry, direction, exit, risk plan, and regime fit before reducing usage.
5. For starvation, distinguish missing market regime from impossible/over-strict entry conditions before changing thresholds.
6. For degradation, reduce weight or pause the affected family/regime/direction cell and allow a traceable paper retest. Do not permanently protect a formerly profitable strategy.
7. Preserve no automatic hedge, close-and-reverse, lower-ranked substitution, fund transfer, or inferred owner approval.

## Implementation map

- Extend `lib/hte31-strategy-catalog.ts` with canonical family/variant metadata and legacy aliases.
- Add pure family-similarity and strategy-health modules; keep decision logic deterministic and directly unit-testable.
- Extend `lib/hte31-strategy-router.ts` to rank families first and emit at most one variant per family/symbol/cycle.
- Extend `lib/hte31-counterfactual.ts`, Entry Quality integration, and `lib/hte31-optimization-core.ts` with the final verdict and remediation reason.
- Remove the HT4 freeze policy and replace `tests/hte31-ht4-baseline.test.mjs` with equal-treatment, lineage-preservation, and open-position-lifecycle regression tests.
- Reuse current text IDs in D1. Avoid a schema migration unless implementation proves an additive field is necessary.
- Add owner-visible family, variant, health, last-use reason, degradation reason, and next action using the existing dashboard/read-model path; add no new polling.

## D1 budget guardrail

- No new per-minute or per-15-second health/history row.
- Family health is calculated from current rows; optional transition records are event-only.
- Every new write path must update the tested budget.
- Merge is blocked unless planned recurring writes remain at or below 60,000/day. The current reference is 27,360/day.

## Verification and release order

1. Start from the latest `origin/main`; inspect clean status and production health.
2. Create a new implementation branch; do not build on this preparation branch.
3. Add catalog/family tests before changing routing behavior.
4. Implement family selection, health, and final-verdict modules in small recoverable commits.
5. Run focused strategy, counterfactual, performance-gate, sizing, live-parity, D1-budget, and lineage tests.
6. Run `npm run test:signals`, `npm test`, `npm run lint`, TypeScript with no emit, Wrangler production dry-run, and `git diff --check`.
7. Confirm no migration deletes/renames history, no second simulation exists, and no live funding/action is introduced.
8. Open a PR, require green CI, merge, verify merged-main CI, then verify immutable production assets and two advancing `/__health` probes.
9. Deploy only when all checks pass. An interrupted or failed implementation remains off production.

## Acceptance checks

- All thirteen legacy IDs resolve to a canonical family and stable variant.
- Brain output contains no duplicate executable candidates from the same family for one symbol/cycle.
- Every strategy, including HT4, follows the same health and evidence rules.
- HT4's prior profitability is retained as history but creates no permanent boost or protection.
- A losing, starved, and degraded strategy each receive a distinct diagnosis and next action.
- Every completed post-exit observation has a final verdict or explicit insufficient-evidence result.
- Paper and Gate retain the selected family/variant lineage; no fund movement or live activation occurs.
- Five-position, directional, risk, leverage, margin, and existing-position protections remain unchanged.
- Planned recurring D1 writes stay at or below 60,000/day.
- Full local tests, PR CI, merged-main CI, and production health verification pass.

## Time and usage boundary

The implementation scope is intentionally limited to family metadata, deterministic analysis/decision modules, existing read-model UI fields, tests, and documentation. It excludes a redesign, a second simulator, destructive migration, new market-data producer, or broad strategy rewrite. Expected implementation is 45–60 minutes; full local/remote verification is expected to bring the end-to-end run to roughly 60–90 minutes. Use the `极高` reasoning level after the five-hour allowance resets; `最高` is not required.

## Production checkpoint — 2026-09-03

- Implementation shipped through PR #109; feature commit `e31d7521374bab75894f2da67904de51d2a78653`, production merge `a92a516dd12f960a961814343dc88c9fa33632cf`.
- All thirteen legacy IDs map to the nine planned families; family-level candidate deduplication, recent-decay ranking, health states, final trade verdicts, UI, and exact live-lineage labels are implemented.
- No migration, second simulator, fund action, live activation, risk-limit change, or new recurring D1 write was introduced.
- Local verification passed: 217 strategy/risk tests, 109 production/UI/Must-Keep tests, ESLint, TypeScript, and diff checks.
- PR CI run `33716373058` and merged-main CI run `33716448405` passed, including Wrangler production dry-run.
- Production served immutable asset `assets/page-BF9gQ5KC.js`; two advancing health probes confirmed both schedulers live with null errors and a closed scanner circuit.
