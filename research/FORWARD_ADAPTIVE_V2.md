# Forward Adaptive v2 — architecture lock (2026-09-20)

## Why this release exists

The current Forward system proved it can discover profitable market-response relationships, but the live path exposed a structural asymmetry: broad-market danger detection became faster than opportunity generation. A 5-minute turn warning could cut or block one direction immediately while the opposite direction still waited on the slower rule-refit path. Under smaller transition/drawdown budgets, risk was also divided across all ready candidates before any order was attempted; every candidate could become a fragment and all of them could be rejected.

This release keeps the same Forward idea. It does not replace it with fixed trend, mean-reversion, breakout, time-of-day, or loss-reversal strategies.

## Architecture

1. **Slow causal learner remains authoritative.** Existing 15/60/180-minute completed response measurements, modeled costs, chronological evidence, execution calibration and generated stops/exits remain.
2. **Rapid 15-minute migration lane.** A candidate may be added only from already-matured observations after three non-overlapping 15-minute groups agree strongly enough after modeled cost and uncertainty. It is explicitly uncertain, capped below full confidence, and cannot invent a trade without the same current condition matching.
3. **Every new matured response can refit.** The old 15-minute wall-clock refit remains a fallback, but new matured data can update rules on each 5-minute cycle. No new API call or history backfill is added.
4. **Warnings become continuous allocation, not silence.** Pullback/reversal/market-turn information changes candidate priority and risk weight. It never directly creates a LONG/SHORT order. Market-derived warnings no longer hard-zero an otherwise learned candidate; stale data, invalid quotes, contract metadata, cost, account risk and stop protection remain hard safety gates.
5. **Sequential best-first allocator.** Do not divide the available risk by every ready symbol before attempting the first order. Sort learned candidates, allocate to the best executable candidate under the unchanged single-trade/portfolio caps, then recompute remaining headroom for the next candidate. This prevents “all fragments, zero fills.”
6. **Drawdown changes size, not permission to learn.** State/turn caps can migrate existing portfolio risk, while drawdown scales *new* allocation continuously and never becomes a loss-triggered trading pause.
7. **No account reset or LIVE authority change.** Existing PAPER history, positions, samples, rules, startedAt and realized losses remain. Owner/member LIVE remains manual and mirrors only persisted current Forward source orders under the existing parity contract.

## Hard invariants

- No fixed directional strategy or forced reversal.
- No “must trade N orders/day” quota.
- No loss-streak disable, shadow promotion, daily stop, or automatic account reset.
- No widened original stop.
- No stale quote may open/close a trade.
- Single-trade structural risk remains <=1.5%; total/side/net portfolio limits remain authoritative.
- Explicit fee/slippage/funding assumptions remain in every candidate.
- Top30 five-minute learning and bounded realtime quote slots remain; no extra Gate request cadence.
- LIVE switch, credentials, copy identity, leverage/source geometry and member isolation are unchanged.
- The release may improve adaptation/participation without proving future profitability.

## Acceptance scenarios

The release must demonstrate in deterministic tests:

- normal trend paths preserve learned trading;
- a pullback reduces rather than zeroes the threatened direction;
- independently learned opposite candidates get priority during reversal risk;
- a strong recent conditional response can produce a rapid 15-minute migration candidate even when older evidence points the other way;
- the rapid lane rejects inconsistent or cost-negative recent groups;
- drawdown lowers new allocation but does not make allocation scale zero;
- multiple ready candidates under a smaller regime budget no longer all fail solely because headroom was pre-divided;
- stale quotes/data and account-risk constraints still fail closed;
- existing positions/history and LIVE parity remain continuous.

## Future-change rule

Do not respond to one losing trade or one user hypothesis by adding another hard veto. A future strategy change must first identify which layer is wrong (measurement, evidence, adaptation, allocation, execution, protection, data, or LIVE copy), reproduce it with a counterexample, and compare the proposed behavior against this architecture. “Fewer trades” is not itself an improvement criterion.
