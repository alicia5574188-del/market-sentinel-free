# Forward participation and execution repair — 2026-09-17

The user accepts the first forward version as an ACTIVE research baseline and explicitly rejects improving apparent loss by eliminating trading. They authorize research, targeted optimization and deployment after verification. This does not authorize Gate orders, owner-switch actions, resetting the account, shadow strategies or arbitrary trade quotas. Monthly compounding to 2x remains unproven.

## Recorded evidence, not a new historical profit search

Public read-only workspace run35170504316 captured216 complete immutable packets and2215 unique matured market measurements. Archive SHA256:985c87d16b821c25194b313ea72e2922c5e8c24859932f0d734f8a59fa8fb0f2. At capture the unchanged account had61closed/0open,959.4353379255655USDT,0post-v1.1 entries. The user-supplied earlier snapshot had48closed/4open and943.9077694430488USDT. They are different timestamps, not competing account totals.

At49 recorded FIT times, reconstruct only measurements available by that time, using the same384-per-horizon rolling capacity. Apply generated rules to subsequent recorded feature anchors. Feedback uses the same ACTUALLY closed original PAPER orders available at each cutoff, not counterfactual future trades.1728 distinct recorded symbol/time anchors are available; these are sparse measurement anchors, not a full five-minute quote tape. No modeled fill or portfolio-profit claim is made.

| Generator | Unique matching symbol/time/direction hypotheses | Original528 hypotheses retained |
| --- | ---: | ---: |
| Active v1 baseline | 528 | 528 |
| Strict v1.1 | 25 | 10 |
| Participation repair | 547 | 526 |

The repair preserves99.62% of those baseline matches versus1.89% for strict v1.1. It also produces additional local hypotheses. These numbers measure candidate coverage, NOT orders, independent trials, daily frequency or profitability. The inspected history cannot be called blind evidence. No parameters were selected by maximizing account return.

An earlier ablation on three saved snapshots found that only removing leave-one-out rejection still leaves0 shared stumps under the bounded central lower bound, while the active raw estimator has2/4/1 shared stumps at60minutes. Quote retry alone cannot repair candidate starvation.

Eight of the original48closed trades had arm-minus-giveback geometry below the modeled explicit round-trip fees. This is a cost-geometry defect; it does not establish how much profit a different stop would have produced, because the complete quote path is not present.

## Implemented boundaries

- Restore the active causal raw positive-after-modeled-cost hypothesis estimator and bounded expression search. Confidence is separate: retain clipped/leave-one-symbol-out diagnostics, raw and calibrated estimates, warnings and0.5–1risk scaling. A pooled hypothesis is explicitly NOT a proven transferable edge. Only previously observed cohort symbols are eligible; local hypotheses remain local. Flat/below-cost raw observations still produce no hypotheses.
- Keep actual closed-PAPER forecast-error feedback, time grouping and decay. Negative calibrated estimates remain visible and affect confidence/risk instead of becoming another universal veto. Positive past PnL never boosts the original risk maximum. The calibration is not a proof of optimal exits.
- Preserve1.5%individual-at-entry,10%total,6.5%same-direction and4xgross maxima. Remove the extra3%same-horizon veto. Share risk, gross capacity and margin across simultaneous executable names. Leverage may differ to share margin but NEVER increases proposed notional or stop risk; exchange max leverage and stop-distance limit still apply. Keep meaningful integer lots and reject tiny residuals.
- Stage only current completed-bar signals missing a fresh sequence-valid quote. Retry on the existing10-second engine callback, ending at the NEXT five-minute bar boundary, not five minutes from retry. Revalidate active rule, signal, current executable quote, remaining raw opportunity and all capital checks. No retry fill is backdated. One same-symbol/bar entry; a close cannot immediately reopen in the same evaluation. New completed bars can provide new opportunities without a full-horizon lockout.
- Midpoint movement is used for entry opportunity depletion because the modeled base cost already includes entry slippage. Actual simulated entry still pays ask/bid, slippage and fees; no fee rate is reduced to beautify results.
- For NEW rule versions only, cap giveback to retain1.25times modeled cost at ideal activation. Existing cost-sufficient geometry is unchanged; old open positions retain their original protection and amounts. Gaps/stale intervals still exit only at real observable quotes and can lose.
- Record participation-execution-v1.2 separately from the unchanged forward-relations-v1.0 storage schema. Preserve prior upgrade marker, account identity, loss history and learning. Atomic persistence remains ahead of publishing a simulated fill. Waiting retries do not force extra writes; fills still do. No new network calls or D1 writes. Existing DO write-budget guard remains.
- Native dark UI shows raw versus bounded/calibrated estimates, uncertainty, matches, pending quote retries and actual new/retry entries. Matches are never advertised as trades.

## Expected benefit and possible regressions

The tested benefits are restored opportunity coverage, elimination of a deterministic stale-quote timing miss and correction of an internally cost-insufficient protection boundary. Restored participation can also restore losses. Outlier transfer, selection bias and small samples still affect pooled hypotheses, explicitly including ones with nonpositive bounded/calibrated estimates. The initial bounded risk scaling is an experiment, not an optimal fraction. Narrower cost-aware giveback can cut off a later winner. Quote retries can execute losing opportunities previously missed. Shared allocation can reduce exposure to the best candidate. More simulated fills can consume more write budget despite no per-retry writes. None of these fixes guarantees positive net expectancy or monthly doubling.

## Verification and reproducibility

`tests/forward-participation.test.ts` covers current-bar quote retries, expiry, retirement, changed features, no lookahead/backdating, no duplicate fills, unchanged waiting-write cadence, atomic recovery, meaningful multi-coin allocation under existing caps, no same-bar churn, non-reset v1.1 migration, upgrade-boundary retention, cost-aware exit geometry and explicit gap losses. Existing v1.1 policy-specific tests are updated to assert warnings/risk rather than obsolete unanimity vetoes; safety/accounting tests remain.

Local direct tests:354 total, including78 forward tests. Run build/architecture/type/lint/dry-run and actual production receipt before declaring release complete. Worker/LIVE/authentication/canonical/deployment files remain byte-identical, verified by the existing authority-hash test. No fake return target is a CI success criterion.

The research bundle contains the original read-only evidence, comparison source versions, coverage script and detailed per-cutoff results. Do not publish private credentials or account-auth responses. Production receipt must report exact build, continuous start/equity/history, LIVE intent, saved policy, advancing cycle and actual new entries separately from inherited positions; no requirement to force a trade for the receipt.