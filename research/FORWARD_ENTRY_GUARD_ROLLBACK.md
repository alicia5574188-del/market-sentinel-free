# Forward Entry Guard rollback contract — 2026-09-25

## Frozen baseline

- Branch: `baseline/forward-v2-20260925-pre-entry-guard`
- Commit: `b4375bb71f073e05c581c5d73beaa28c4e3eed1b`
- Meaning: production Forward Relation 2.0 immediately before relation re-entry / feedback-guard work.

If the new entry-guard version performs worse in real observation, start the next attempt from this baseline commit. Do not continue stacking patches on the failed strategy branch.

## Scope of this experiment

Strategy behavior may change only in:

1. relation re-entry after a real `RELATION_DEGRADED` or `NO_POSITIVE_FEEDBACK` failure;
2. evidence-aware no-positive-feedback exit timing.

The experiment must not change:

- Forward 15/60/180m sample learning;
- relation synthesis/directional authority;
- structural stop geometry;
- profit giveback / MFE protection;
- portfolio sizing and risk budgets;
- 30-market data architecture;
- Gate execution/account truth;
- LIVE mirroring;
- manual PAPER reset financial semantics.

## Module boundary

New behavior lives in `lib/forward-entry-guard.ts`.

`lib/forward-relations.ts` only owns four integration points:

- persist/normalize guard state;
- check guard before opening;
- record failed relation evidence after exit;
- ask the guard whether a no-feedback position should exit.

This keeps rollback mechanical: remove the module/integration and return to the frozen baseline instead of layering compensating conditions.

## Release criteria

Do not merge unless all existing Forward/LIVE/build/type/architecture tests pass and the following regressions pass:

- a failed relation is blocked across symbols;
- an unrelated relation remains tradable;
- a timestamp-only weak refresh cannot unlock the relation;
- genuinely recovered/new evidence can unlock it;
- 15m and 60m no-feedback exits require both elapsed evidence time and weak path state;
- a trade that already achieved positive feedback is not early-exited;
- PAPER reset preserves relation guards.

Real observation after deploy must be compared against the frozen baseline on net PnL, fee/turnover efficiency, participation, repeated-rule churn and no-feedback losses.
