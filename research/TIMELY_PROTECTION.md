# Timely protection: bounded source-timing change

## Authority and scope

The user reports a large intraday giveback and asks to improve timely profit-taking/defense without destroying active trading, and asks whether abrupt reversals and rapid oscillation are supported. This release does NOT claim the historical afternoon would have been saved. The supplied snapshot contains80recent closed details and11open sources, not a complete executable quote sequence or a complete231-trade path. First-crossing time, historical optimal exits and a counterfactual portfolio cannot be recovered from favorable/adverse extrema alone.

The current source uses executable quote exits with an approximately10second minimum advance cadence; five-minute completed-bar features and15minute refitting are separate. A3hour learned response does not require waiting3hours to honor the existing hard stop. However, the original source deliberately embargoed giveback exits until5minutes and opposite-confirmation exits until15minutes, even after their other conditions were satisfied. These are reproducible deterministic timing limitations, not a claim that every losing trade was a software fault.

## Implemented

- New source orders have exitControl.policy=timely-protection-v1. Keep the frozen arm, giveback, hard stop, source duration and exit-mode selection. A REACTION_DECAY order which has actually armed AND given back its frozen width may exit on the first eligible source evaluation, without a further5minute wait. Arming alone never takes profit. HORIZON-only orders are not converted into trails.
- Opposite evidence still requires two distinct completed-bar confirmations of an active applicable rule at the same horizon. The extra15minute position-age condition is removed only for new orders. A single tick/bar, timeout, losing trade or dormant rule does not generate a reverse entry. Existing same-symbol/same-bar dedup stays intact.
- Hard stop and deadline priority remains. All model fills occur at the observed fresh executable quote plus existing modeled slippage/fees; gaps may still lose more than planned. Missing/old/future quotes never receive invented fills.
- Attach bounded exit audit to new closed orders: observed arm time and quote time, current decision/quote time, observed sampling gap and maximum gap/age, exit boundary, actual model execution, overshoot and loss above planned risk. These are OBSERVATIONS, not claimed market-first-crossings, latency attribution, or live-exchange PnL. No per-tick path storage or extra network calls. Intermediate maxima may still rely on the existing checkpoint cadence; do not promise a complete tick archive.
- Install a separate exitPolicyUpgrade marker without modifying participation-execution-v1.2 or its evidence compatibility. Preserve rule/measurement/feedback state; do not zero lastFitAt, refit for installation or rewarm. Legacy already-open orders remain unmarked with original timing and snapshots. New behavior applies to subsequent entries, not reconstructed past peaks. Record old-positionIDs and actual baseline separately from the original account.
- Full source bindings and persisted closures already propagate to both primary and members. Integration tests drive an actual early source closure through each actual executor with FakeGate; no private production calls. Exchange-hosted original hard stop remains. No new native trailing-stop amendment, no claim that local quote logic protects through arbitrary network outages.

## Deliberately NOT implemented

No new PnL/drawdown switch, forced liquidation at an observed peak, family kill list, confidence veto, automatic loss reversal, reduced scan frequency, volatility-wide freeze or minimum-lot enlargement. Existing same-direction concentration and repeated weak hypotheses remain research concerns, not solved by relabeling this narrow timing repair. A broad risk allocator would change exposure/frequency and needs its own causal evidence, not parameters chosen to fit one afternoon.

## Tradeoffs and validation

Synthetic tests include an early spike/reversal where prompt protection closes, a continuing trend which remains invested, oscillations below the original arm and inside giveback which do not exit, opposite-evidence two-bar confirmation and duplicate callbacks, long/short symmetry, real-price gap losses, stale/future rejection, legacy timing, idempotent non-reset migration and atomic round-trip. They ALSO include a rebound-after-exit where the legacy holder earns more: no universal PnL dominance or smooth-drawdown claim.

521direct tests (99forward including21new timing tests, plus new actual-primary/member parity cases),18architecture/migration tests and build/type/lint/dry-run are required. The source generator, evidence module, fee/quantity/risk algorithms and all10critical primary execution bodies remain unchanged. The forward source hash baseline is explicitly advanced by this authorized timing change and its helper added, not removed as a safety check. Exact local/remote file checksums and final ordinary PRCI precede main. Actual public production receipt must verify build/exit-policy activation, source cadence/storage, retained start and primary/member owner settings; it is not a real-money fill test or profitability certification.

## Regime-change boundary

The system reacts to observed prices and matured evidence, not news prediction. Hard-stop checks and armed giveback can act sooner than model refitting, but are not guaranteed subsecond or exact-price fills. Two-bar confirmation avoids some one-bar noise at the cost of delayed reversal recognition. Rapid repeated swings can still hit both directions or erode returns with costs. Neither this patch nor the supplied sample establishes robust profitability in abrupt reversals, high-volatility chop or every market regime.

Official execution contract checked2026-09-18: https://www.gate.com/docs/developers/apiv4/en/futures/ (price-triggered orders, reduce_only, IOC and trigger-price types). Documentation specifies API semantics, not protection of any particular app or guaranteed fill prices.
