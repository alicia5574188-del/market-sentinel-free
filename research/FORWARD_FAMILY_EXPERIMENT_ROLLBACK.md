# Forward Family Experiment rollback contract — 2026-09-25

## Clean strategy baseline

- Branch: `baseline/forward-v2-20260925-pre-entry-guard`
- Commit: `b4375bb71f073e05c581c5d73beaa28c4e3eed1b`
- Meaning: Forward Relation 2.0 portfolio/reset baseline before the failed rule-id Entry Guard experiment.

## Validated data layer kept independently

The strategy rebuild carries forward only the already production-validated public market data topology:

- Bybit primary analysis feed
- OKX primary analysis feed
- KuCoin Futures primary analysis feed
- Bitget and Binance as WAF-backed-off fallbacks
- Gate remains execution/account truth
- production release requires at least three fresh public sources

Data-source changes are infrastructure and are not part of the strategy experiment verdict.

## Strategy experiment scope

New strategy behavior lives in `lib/forward-family-experiment.ts`.

It may only control:

1. causal relation family identity (threshold variants of one idea are one family);
2. reserve experiment minimum economic value;
3. one live reserve experiment per family;
4. family-level risk concentration;
5. family failure evidence and recovery.

It must not redesign:

- 15/60/180 minute relation learning;
- directional relation synthesis;
- structural stop geometry;
- MFE/profit giveback protection;
- portfolio total/same-side/margin budgets;
- 30-market scan and realtime data architecture;
- Gate execution or LIVE mirroring.

## Failure semantics

A family failure is recorded after:

- RELATION_DEGRADED;
- NO_POSITIVE_FEEDBACK;
- STRUCTURE_STOP when the trade never reached first positive feedback.

A neighboring threshold/rule ID in the same family cannot bypass that failure. Re-entry requires genuinely newer mature evidence plus lifecycle/path recovery.

## Rollback rule

If real observation underperforms the clean baseline on net PnL, fee efficiency, repeated-family churn, participation quality, or no-feedback losses:

1. do not add compensating strategy patches to the failed branch;
2. start the next strategy attempt from `b4375bb71f073e05c581c5d73beaa28c4e3eed1b`;
3. re-apply only the validated KuCoin multi-source infrastructure;
4. preserve the failed experiment branch and snapshot for comparison.

## Release gate

Do not merge unless all existing Forward/LIVE/build/type/lint/architecture tests pass and regressions prove:

- threshold variants map to one family;
- one reserve experiment per family;
- unrelated families remain tradable;
- weak reserve value is rejected before order creation;
- family failure blocks sibling rule IDs;
- new recovered mature evidence can release a family;
- no-feedback STRUCTURE_STOP counts as family failure;
- PAPER reset preserves family experiment state;
- production still has at least three fresh public market sources.
