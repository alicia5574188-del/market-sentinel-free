# RBE continuation — 2026-09-21

## Objective and scope

Continue PR #356 from e92b490 without repeating completed health/UI work or deploying an unqualified exit. The user requests the shortest necessary execution. Entry strategy, production code, original stops, sizing, accounts and owner LIVE control remain outside this research patch.

## Verified breakpoint

Research run 35581892348 completed, rather than hanging: its economic gate failed. The prior reconstructed 5,166-pair sample retained only 68.15% of baseline runner return despite fewer profit-to-loss reversals. Release verification 35581892347 failed one existing predictor assertion (773/774 direct tests passed).

## Concrete corrections

- Remove the unconditional open-profit cushion veto that contradicted the existing strong pre-turn exit test. Healthy continuation and renewal protections remain.
- The research executor previously installed dynamic protective stops on DEFENSIVE warnings even when shouldExit was false. It now executes only PRE_TURN_EXIT with shouldExit=true; original stops remain frozen.
- Signal at completed candle close, execute at the next observed candle open. Never include post-open extremes in a closed position's MFE. Gap stops use the adverse open, not the unreachable stop price.
- Censor trades across missing bars/end of data. Compare the top-runner gate on one common baseline cohort; preserve the report even when acceptance fails.

## Limitations and release authority

The existing predictor is a hand-weighted heuristic, not the promised trained Extension First/Reversal First model. Its three chronological sections are descriptive, not walk-forward training. Its reconstructed frames omit production calibration and use surrogate entry/stop rules; sums of equal-notional return rates are not account returns. Repeated inspection of March–August also means this is not untouched holdout evidence. Therefore this PR cannot authorize production even if its diagnostic economic gate passes. The missing learned competing-risk/value model and exact-source replay must be completed before considering deployment. Do not relax economic gates or tune failed thresholds on the same inspected sample to manufacture a pass.

## Validation and next action

Seven focused predictor/execution tests pass locally. Syntax and whitespace checks pass. Run one exact-head historical workflow and the existing mandatory release verification; record its actual outcome here. Do not rerun a completed result without a new concrete defect.
