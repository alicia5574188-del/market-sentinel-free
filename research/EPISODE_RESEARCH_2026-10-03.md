# Causal research first; adaptive execution design

## Release scope

`causal-episode-research-v1` is an independent observational layer. It does not authorize orders, change sizes, stops, exits, money, LIVE intent or account history. The next controller below is a design, not this release's execution behavior. An objective of positive long-term net returns with smaller losses in persistent trends is not an established result or a guarantee.

The prior inverse approach and the continuation approach expose complementary failures. Fading a move which continues to gain acceptance can repeatedly lose in a persistent trend. Conversely, treating fast entry protection as a holding anchor can close a viable continuation during an ordinary pullback. A static initial stop can also allow a meaningful winner to become a loser when no consistent protection evidence is applied. Relative ranking is context: it cannot negate an actual price failure in the held direction.

## Implemented evidence contract

The layer uses existing completed official minute/five-minute candles, current own bid/ask, symbol coverage and the existing market authority. It requests no extra feeds or timers. Invalid/future candles are excluded; gaps truncate coverage. Repeated timestamps cannot create new market transitions. Fresh coverage is required; missing coverage is reported rather than turned into directional agreement. Price summaries over15/30/45/60minutes describe one price evidence family, not four independent votes.

For each current episode, the record freezes its reference and initial proof. The holding anchor may advance only after a completed five-minute counter-move pivot and renewed directional progress, with the current price still beyond that anchor. Later one-minute entry stops do not silently replace it. This is a research anchor; it does not change the execution stop.

| Research state | Completed evidence | Required next evidence |
| --- | --- | --- |
| Unconfirmed | No usable direction proof, insufficient coverage, or no post-proof observation | Retained departure or genuine failed departure |
| Rotation | Both departures failed around an accepted balanced reference | A new edge attempt and its response |
| Advancing | Direction proof and retained own holding anchor | Next counter-move and renewed progress |
| Pullback | Directional retreat inside the anchor | Recovery or actual anchor loss |
| Support broken | Completed close beyond the anchor and tolerance | Reclaim or further non-recovery |
| Recovery failed | Consecutive completed closes beyond the anchor without improving recovery | Old continuation invalid; new direction must earn its own proof |
| Recovery building | Reclaim after damage, without retained renewed progress | Two retained completed closes and renewed directional progress |

The two-close non-recovery rule is an observable failure proxy; it does not claim to identify every intrabar recovery attempt. The research tolerance is based on existing ATR or recent range plus observed spread. Those definitions, and profit thresholds below, are initial explicit hypotheses requiring future observation, not optimized return claims.

Continuation and return hypotheses coexist. A failed continuation can create a return candidate without proving an opposite trend. A failed departure needs a fresh existing rejection. A return target is available only when the frozen reference is balanced and its center lies ahead of that return direction; absent that target, coverage remains incomplete. Candidates never equal execution eligibility.

## Holding research and execution disagreement

Each observed order separately records its original structural support, independent holding anchor, actual execution stop, completed-price premise, paid/estimated cost-aware net P&L, recorded peak and giveback. Existing recorded trade peaks may be adopted, but observation start and entry coverage are explicit; past transition times or executable fills are not invented. Closed orders stop observing at their actual close.

The initial protection hypothesis requires a meaningful recorded net peak (at least1.1times original structural price risk and four0.1%notional cost units), at least35%giveback and completed counter-pressure or anchor damage. It proposes evaluation rather than changing protection. Minor profit noise or holding age alone cannot trigger this proposal. Failed recovery proposes exit evaluation; an isolated break or incomplete recovery proposes review. Stale coverage proposes observation.

These thresholds are deliberately visible and testable. Research must expose false protection alerts during healthy trends, missed deterioration, and recovery confirmations that arrive too late. A proposed exit cannot be treated as a filled exit or a counterfactual profit. The export contains both the research record and the actual order/settlement state.

Planned notional, original actual notional and fill ratio are recorded together. The current simulation may see only the first BBO level and cancel the unfilled IOC remainder. Small fills must not be interpreted as deliberate risk sizing, and a shallow quote cannot establish full native exchange liquidity. This release diagnoses that disagreement; it does not change fills or upsize orders.

## Next adaptive execution controller — design only

| Decision | Return branch | Continuation branch |
| --- | --- | --- |
| Eligible premise | Actual failed departure, or failed continuation plus new reverse response | Accepted departure with retained own anchor and renewed progress |
| Location | Bounded distance from the failed extreme/own protection | Bounded retest near own support; avoid chasing an expanded frontier |
| Required room | Real accepted center/obstacle ahead; room exceeds executable costs | Own structural risk and realistic room; volatility estimates remain labeled estimates |
| Strong common trend | Do not fade merely because price is extended; require own contrary failure proof | Follow accepted common direction or a genuinely supported independent exception |
| Holding | Preserve return premise while price advances toward the accepted target | Preserve independent holding premise through normal pullbacks |
| Deterioration | Failed return response or anchor invalidation | Anchor invalidation, failed recovery, or earned-profit deterioration |

The controller should be one price-evidence state machine with two branches, not a global switch that mechanically reverses every old instruction. No-trend does not automatically mean range. Sustained accepted movement makes blind counter-trend exposure ineligible; an own-symbol exception requires actual contrary response and coverage. Group breadth is weighted so several correlated symbols do not masquerade as independent confirmation. Portfolio/group risk limits remain a separate constraint, and adding contrary positions or increasing size is not a recovery mechanism.

Entry protection must establish a bounded initial loss, while holding protection uses completed counter-moves and restart structure. The controller must observe the transition from entry response to established holding, rather than continually importing a short entry window as the holding premise. Losing positions do not receive a widening stop to preserve a thesis. Relative ranks cannot overrule own anchor failure.

A meaningful winner should receive a causal protection decision when its progress deteriorates. That decision needs executable price boundaries and retained structural evidence; fixed holding minutes or peak-percentage giveback alone must not close every healthy trend. Research and execution must record the same reason chain, including why protection was retained, raised or invalidated.

An existing holding does not mechanically flip when market phase changes. Establish its premise failure, request its real reduction/close, wait for actual completion, then evaluate a new side using its own proof and current costs. Pending submission, partial fill and settlement remain distinct. A new direction cannot inherit the old side's authorization.

Before evaluating the redesigned controller's performance, resolve the simulation's depth limitation using actually observed multi-level liquidity and the same native order quantity/price boundary. If that coverage is absent, expose uncertainty; do not fabricate deeper volume or assume an optimistic full fill. Respect native minimum quantity rather than imposing an arbitrary nominal position floor. Changes to this execution path belong to the next phase.

## Persistence and limits

The optional record is bounded to48KiB,30symbols,10active/8recent closed orders, four changes per current episode and24compact cross-episode transitions. Omission counters disclose truncation. It is a rolling diagnostic record, not an unlimited historical archive. Exports taken during operation preserve the observations available at that time; older discarded details cannot later be reconstructed as known facts.

The layer reuses existing financial/protection checkpoint keys and clocks. A research-only change does not request a protection write. The optional overlay is omitted when combined checkpoint JSON would exceed112KiB; the existing financial fields remain intact. This reserves host-serialization headroom and does not guarantee every preexisting financial payload is itself within the host limit. Optional errors yield to the financial lane; corrupt optional restoration is discarded without rejecting valid account restoration. Account reset separates order observations by generation while leaving the ongoing market episode distinct. Resetting an account does not reset the market itself.

## Acceptance before execution adoption

Deterministic fixtures verify long/short symmetry, completed-price timing, coverage gaps, stale inputs, no duplicate transitions, recovery confirmation, pre-entry/pre-proof isolation, paired hypotheses, correlated-group weighting, cost-aware giveback, partial fills, close-time freezing, reset isolation, restoration, byte bounds and financial invariance. They test behavior, not historical profitability.

Production acceptance requires the exact reviewed-main build, healthy advancing data and research timestamps, bounded rows/bytes, existing account generation and LIVE intent preserved, and no storage/runtime error. Research timestamps indicate current observation; first-observed and source times distinguish it from historical knowledge.

Future causal snapshots must assess how often failed-trend proposals precede sustained losses, whether healthy pullbacks are wrongly flagged, whether meaningful winners receive timely protection evidence, and whether candidate return trades have a real target after costs. Use actual filled-order net settlement for outcomes. Do not infer profitable counterfactual trades from a research label. Only after these discrepancies and the execution-depth issue are resolved should the new controller take authority.
