# RBE continuation — 2026-09-21

## Final result — REJECTED, no production release

Evaluated code6cb74d4de5d188e01aa4865ed8bb482e297b7bde. Functional verification35584112638 passed all required tests/build/lint/type/dry-run gates; deployment was skipped. Historical workflow35584112663 completed its computation and correctly failed economic acceptance. The earlier stack-limit error in bulk array accumulation was repaired; this is not an execution hang.

The learned experiment used577,972 labelled states and evaluated3,328 paired trades across June–August. One of three months improved. Brier0.2290 improves over training-prevalence0.2433, but ROC-AUC0.5280 does not meet the0.55 discrimination gate. Candidate equal-notional net remains negative; baseline-winning runner return retained only3.20%, far below85%. Reducing profit-to-loss reversals493→39 therefore does not establish a usable exit policy: it mostly exited before the large winners developed. Mean lead time is not a success measure when false early exits dominate. These are surrogate research returns, not actual account performance.

This fixed architecture is rejected on the inspected dataset. No parameter sweep, weakened gate, production wiring, account reset or LIVE mutation follows. Do not rerun this experiment as an unfinished task. Exact code, dataset hash, both models' diagnostic outcomes and limitations are retained in research-results/rbe-continuation-2026-09-21.json and the run's rbe-exit-audit artifact. A future genuinely different mechanism would require its own independent evidence; current user goal of a proven better exit remains unmet.

## Current learned experiment

The repaired heuristic's completed run35583191263 still fails: runner retention72.21%, giveback recovery56.25%, common top-runner gate false. Full release verification35583191274 succeeded. This result is retained without threshold sweeps.

The missing learned core is now implemented as a separate research experiment: a regularized four-outcome competing-risk fit (extension first, slow reversal first, first-five-minute shock reversal, unresolved) plus a continuation-value regression and three fixed fitted-policy iterations. Models fit only matured earlier episodes, with an additional two-day purge. Train on earlier months and evaluate June, July and August with expanding training; each evaluation trade keeps its entry-month model. Inputs include six-timeframe propagation, continuation/turn changes, structural/sequence evidence and holding state. Policy requires reversal probability above extension probability and negative continuation value beyond0.10ATR. No parameter search or profit-based stop changes.

Per-trade training weights limit long-trade sample dominance. Ambiguous future barrier order is excluded from training/scoring but NEVER from exit decisions. Outcomes cannot enter their earlier training cutoff. Report Brier versus training prevalence, ROC-AUC, precision/recall, lead time and paired baseline-cohort capture/net/runner retention. This is approximate fitted policy iteration, not proof of globally optimal stopping. Ten focused tests pass. One new historical run is required; results are automatically retained even if the gate rejects the experiment.

## Objective and scope

Continue PR #356 from e92b490 without repeating completed health/UI work or deploying an unqualified exit. The user requests the shortest necessary execution. Entry strategy, production code, original stops, sizing, accounts and owner LIVE control remain outside this research patch.

## Verified breakpoint

Research run 35581892348 completed, rather than hanging: its economic gate failed. The prior reconstructed 5,166-pair sample retained only 68.15% of baseline runner return despite fewer profit-to-loss reversals. Release verification 35581892347 failed one existing predictor assertion (773/774 direct tests passed).

## Concrete corrections

- Remove the unconditional open-profit cushion veto that contradicted the existing strong pre-turn exit test. Healthy continuation and renewal protections remain.
- The research executor previously installed dynamic protective stops on DEFENSIVE warnings even when shouldExit was false. It now executes only PRE_TURN_EXIT with shouldExit=true; original stops remain frozen.
- Signal at completed candle close, execute at the next observed candle open. Never include post-open extremes in a closed position's MFE. Gap stops use the adverse open, not the unreachable stop price.
- Censor trades across missing bars/end of data. Compare the top-runner gate on one common baseline cohort; preserve the report even when acceptance fails.

## Original heuristic limitations and release authority

The original predictor remains a hand-weighted heuristic; its three chronological sections are descriptive, not walk-forward training. The separate learned experiment above now supplies causal training. Reconstructed frames still omit production calibration and use surrogate entry/stop rules; sums of equal-notional return rates are not account returns. Repeated inspection of March–August also means this is not untouched holdout evidence. Therefore this PR cannot authorize production even if a diagnostic gate passes. Exact-source replay and genuinely independent evidence remain prerequisites. Do not relax economic gates or tune failed thresholds on the same inspected sample to manufacture a pass.

## Validation and next action

Ten focused predictor/execution/learning tests pass locally. Syntax and whitespace checks pass. Run one exact-head historical workflow and the existing mandatory release verification; record its actual outcome here. Do not rerun a completed result without a new concrete defect.
