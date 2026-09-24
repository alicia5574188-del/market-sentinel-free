# Forward Relation 2.0 — architecture lock (2026-09-24)

## Goal

Restore the successful causal Forward market-response idea without restoring its slow regime-change failure mode. The strategy must keep participating when learned relationships remain healthy, but it must withdraw authority from stale relationships quickly when their *ongoing real response path* stops behaving like profitable history. A failed LONG relationship never implies SHORT; the opposite side must earn its own mature evidence.

## Authority model

1. **Mature response learning is directional authority.** Conditions are recorded from completed 5m market data. Outcomes mature independently at 15, 60 and 180 minutes. Rules are generated only from completed outcomes that remain positive after modeled costs and uncertainty.
2. **Dual memory.** The bounded long-memory window decides whether a relationship exists. The most recent independent groups decide whether it should currently receive normal, reduced or probe risk.
3. **In-progress response checkpoints are defensive only.** 5/10/15/30/60/180-minute checkpoints compare live responses with the historical profitable path. They may demote an existing relation before its final horizon matures. They never create an opposite direction.
4. **Lifecycle hysteresis.** Relations move through ACTIVE, PRESSURED, DEGRADED and RECOVERING. A degraded relation needs fresh mature confirmation before it returns to ACTIVE.
5. **Rapid opposite migration is probe-only.** Three recent independent 15m groups can create a RECENT relation so released risk is not left idle, but RECENT relations stay reserve-sized and cannot rotate a full healthy book. Full rotation authority requires slower BASE evidence.
6. **Environment similarity is a soft authority weight.** Breadth, dispersion and volatility expansion are recorded with each sample. A current environment that diverges sharply from profitable history can pressure/degrade a relation; it does not manufacture a trade or hard-stop the whole system.
7. **Observed cohort applicability.** A relationship may trade only symbols that have actually contributed mature evidence to that relationship. No unseen symbol inherits a pooled edge automatically.
8. **Region and 1m logic are execution overlays only.** Breakout/retest/fakeout/range structure can improve ranking and execution only when a learned same-side relation already exists. Structure cannot invent direction.
9. **Post-entry management remains current-generation.** Structural stop, no-positive-feedback exit, relation-degradation exit, independent opposite relation, MFE profit retention and stronger-opportunity rotation remain available. Profitable positions tighten protection when their relation weakens; weak no-feedback positions exit earlier.
10. **Risk keeps working.** Total planned risk remains <=10%, same-direction risk <=6.5% and margin <=75%. ACTIVE relations compete normally. PRESSURED/DEGRADED and RECENT relations retain bounded nonzero probe risk rather than causing a global trading pause.

## Causal cold start

No historical outcomes are backfilled as fake live learning. The 15m rapid lane can only appear after real completed recent groups exist. 60m and 180m relationships mature later. The UI must show mature-sample and lifecycle counts so zero opportunities during cold start are distinguishable from data failure.

## Continuity invariants

- Preserve PAPER startedAt, balance, realized losses, history and existing positions across strategy upgrade.
- Do not reset or clear the account during deployment.
- Preserve current Bybit/OKX/Binance public analysis hub and Gate execution/account truth.
- Preserve 30-market scan and 11 realtime slots.
- Preserve owner-controlled LIVE and exact persisted PAPER-event mirroring.
- No forced reversal, loss-streak pause, daily trade quota, shadow promotion or strategy-generated real-money test.
- Do not widen existing stops.

## Acceptance scenarios

- Healthy causal relations still produce multiple candidates and fill available risk.
- A live response path can pressure/degrade the old side before its full 15/60/180m label matures.
- Old-side degradation alone produces no opposite candidate.
- Three mature recent opposite groups can create a probe relation, but that rapid relation cannot immediately rotate a full healthy book.
- A slower mature opposite relationship can later receive normal authority.
- Environment drift reduces relation authority without creating direction.
- Region/1m structures cannot trade without same-side learned relation support.
- Strategy migration preserves account identity/history.
- LIVE consumes the exact persisted PAPER trade event and never rebuilds a decision.
- Multi-source analysis and Gate execution paths remain unchanged.
