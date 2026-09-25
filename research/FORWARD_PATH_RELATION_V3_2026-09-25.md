# Forward Path Relation 3.0 — 2026-09-25

## Scope

This release replaces the Forward Relation 2.0 strategy authority rather than layering another strategy on top.

Kept unchanged:
- multi-source public market-data architecture;
- Gate as executable/account truth;
- total, same-side, family, probe and margin risk caps;
- account identity, financial history and manual reset semantics;
- LIVE owner control, member isolation, credential handling and Gate reconciliation.

Replaced:
- 15/60/180 independent response learner;
- fixed R-based profit-retention logic for new positions;
- the separate sampleMemory score adjustment.

## Root-path samples

A completed 5m market frame can start one root observation. The same root progressively records:
5/10/15/20/30/45/60 minute checkpoints.

A checkpoint is not another sample. The root receives one identity and is enriched over time. Directional validation uses non-overlapping time groups so correlated symbols and overlapping roots do not get treated as fully independent votes.

Retention is bounded for storage:
- newest observations retain the highest density;
- older observations are thinned by symbol/time bucket;
- the learner keeps a bounded recent 24h path memory (maximum 2,200 retained root records).

Old Forward Relation measurements are migrated into the new sample representation where their mature checkpoints are available. Strategy migration must not reset PAPER financial state.

## One evidence source for entry and exit

A qualified relation learns:
- direction;
- best hold among 15/30/45/60m;
- expected checkpoint path;
- normal adverse excursion;
- positive-feedback deadline;
- target/favorable excursion;
- profit-protection activation;
- learned profit-retention fraction;
- maximum useful hold.

Every new PAPER trade freezes that exit profile as sample-exit-plan-v1.

The holding manager compares the observed trade path to the frozen profile. It may close for no positive feedback, sample-path divergence, exhausted remaining edge, learned maximum hold, relation degradation, a qualified opposite opportunity, or the hard structure stop.

The hard structure stop and account risk budgets remain safety boundaries and cannot be widened by learned samples.

Pre-v3 open positions keep their frozen legacy lifecycle until drained. The release does not reinterpret already mirrored positions.

## Family identity

Threshold changes, RECENT/BASE scope changes and learned hold-horizon changes cannot create a new family identity. Family identity is direction + condition feature/operator shape.

This prevents a failed causal idea from re-entering by changing 15m to 30/45/60m or by moving between RECENT and BASE.

## LIVE and member LIVE contract

PAPER remains the only strategy decision authority.

LIVE and member LIVE:
- copy the persisted PAPER trade;
- preserve source identity, size ratio, leverage and stop structure;
- record the frozen sample exit plan in the mirror receipt;
- use the sample plan maximum hold only for source freshness/deadline;
- never recompute direction, entry or exit independently;
- close only when the persisted PAPER source lifecycle closes, subject to existing Gate reconciliation and safety handling.

No real-money test order is authorized by this release.

## Release gate

Before merge:
- Forward tests;
- family experiment tests;
- LIVE parity and Gate tests;
- member tests;
- equity tests;
- architecture/migration tests;
- typecheck, lint and production build;
- release health strings must all identify forward-path-relation-v3.

Rollback base is main commit 48fe0c59390b2f383e7108f0c4819377166428e1.
