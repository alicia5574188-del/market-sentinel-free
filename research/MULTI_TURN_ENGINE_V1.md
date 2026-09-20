# Multi-Turn Engine v1 — architecture lock

Date: 2026-09-21

## Purpose

This release replaces the Forward rule-generator as strategy authority. The core trading question becomes one causal state variable at six independent levels:

**Is the current direction still intact, or is this timeframe turning?**

Timeframes: **5m, 15m, 30m, 1h, 4h, 1d**.

The system must react quickly enough to turns without solving drawdown by becoming inactive. It must not use future data, repainting labels, forced reversals, loss-streak pauses, fixed internet strategies, or a trade-count quota.

## Evidence from the failed baseline

The latest Forward snapshot had already detected `REVERSAL_RISK` against LONG, with 15m/30m breadth at 20%, while the executable learned set was still `activeLong=4, activeShort=0`; equity was about 895.46U with about 20.45% max drawdown. The defect is therefore not lack of another entry filter. The old architecture can recognise danger before it can migrate directional authority.

## Strategy authority

`multi-turn-v1` is the only new-entry/strategy-exit authority.

The old Forward components may remain only for:
- verified market data plumbing;
- explicit fee/slippage/funding accounting;
- fresh quote/contract validation;
- durable PAPER ledger and immutable archive;
- LIVE copy, owner control and member isolation;
- research-only historical comparison.

Old condition→future-response rules, market-state hard cuts, fixed horizon exits and rapid-rule generation do not create new orders after cutover.

## Six independent levels

Each timeframe emits:
- current direction: LONG / SHORT / NEUTRAL;
- direction confidence;
- turn probability;
- phase: FLOW / WATCH / TURNING / CONFIRMED;
- turn evidence decomposition;
- volatility and structural stop distance;
- continuation score;
- last confirmed turn time;
- signal age and data readiness.

No timeframe can hard-veto another. A 5m turn is a 5m turn. It may increase the probability of a 15m turn, but it cannot directly close a 1h/4h/1d position.

## Turn detection

The primary detector is **sequential change pressure** (robust CUSUM/change-of-mean logic on completed bars). Auxiliary evidence:
1. market structure break against the incumbent direction;
2. short-vs-slow momentum disagreement and acceleration;
3. failed extension / rejection at a new extreme;
4. volatility expansion;
5. volume shock;
6. same-timeframe Top30 breadth contradiction;
7. lower-timeframe confirmed-turn propagation.

Evidence is fused into a continuous probability. Strong one-bar evidence can confirm a fast timeframe; slower levels require persistence unless evidence is extreme.

The design follows the useful part of online change-point research: optimise the false-alarm/detection-delay trade-off instead of waiting for a lagging indicator to cross. BOCPD/CUSUM/HMM ideas are used as state-estimation concepts, not as a promise that a named academic model is profitable in crypto.

## Causal calibration

Every emitted probability creates a delayed evaluation record. It is resolved only after its future window has actually elapsed. The realised opposite move becomes a label and updates:
- Brier score;
- mean predicted probability;
- realised turn frequency;
- a bounded online calibration bias.

No future label participates in the decision that created it.

## Entry

A timeframe can propose a trade when:
- its data are complete and contiguous;
- direction is non-neutral;
- turn probability is sufficiently low for that current direction, or it has just confirmed a new direction;
- continuation confidence clears the timeframe floor;
- expected movement after spread + modeled fee/slippage/funding remains positive;
- a fresh executable quote and contract metadata exist;
- portfolio/timeframe/directional risk headroom exists.

There is no daily order quota and no loss-streak disable.

## Exit

A position is bound to the timeframe that opened it.

Primary exits:
- that same timeframe confirms the opposite direction;
- that same timeframe reaches extreme turn probability with structural confirmation;
- hard structural stop.

A 5m warning does not close a 1h position. Fixed holding-time exits are removed as normal strategy logic. A very large maximum lifetime remains only as a stale-position safety boundary.

## Position/risk model

Portfolio planned-risk cap remains 10%. Directional correlated-risk cap remains 6.5%.

Global timeframe risk sleeves:
- 5m: 1.5%
- 15m: 2.0%
- 30m: 2.0%
- 1h: 2.0%
- 4h: 1.5%
- 1d: 1.0%

These are portfolio sleeve caps, not a required allocation.

A losing period may scale **size**, never disable turn search.

### Gate one-way position constraint

Gate is intentionally kept in single-position mode. Therefore v1 will not pretend it can hold opposite independent legs on the same contract.

All six levels are evaluated independently, but **only one executable PAPER/LIVE source trade may exist per symbol at a time**. If several levels want the same symbol, the strongest cost-adjusted continuation candidate owns that symbol. Other levels continue observing and may take over only after the current source exits. This preserves exact PAPER→LIVE parity and avoids hidden netting or synthetic per-leg PnL.

A future hedged/virtual-sleeve adapter must be a separate explicit execution-version change, never a silent strategy tweak.

## Data

- 5m is the causal base path for 5m/15m/30m/1h/4h aggregation.
- Retain up to 1000 completed 5m candles per Top30 market (about 3.5 days; enough for ~20 completed 4h bars).
- 1d uses a low-frequency native Gate daily path, refreshed independently and never required for lower-timeframe operation.
- Missing/gapped data make only that timeframe unavailable. No interpolation.
- Existing realtime quote capacity remains bounded; Top30 turn states help choose which symbols deserve realtime slots.

## Validation

Before cutover:
- deterministic trend continuation;
- sharp V reversal;
- slow rollover;
- fake one-bar turn;
- range/chop;
- volatility spike without direction change;
- lower-timeframe pullback inside intact higher timeframe;
- turn propagation 5m→15m→30m→1h;
- conflicting timeframes without hard veto;
- fee-heavy small moves;
- stale/gapped candles and stale quotes;
- one-symbol execution ownership;
- portfolio/timeframe/directional risk caps;
- restart persistence;
- LIVE source parity;
- exact account reset/cutover.

Metrics: detection delay, false-turn rate, missed-turn rate, post-turn adverse excursion, capture ratio, turnover/fees, net PnL, max drawdown, Brier score/calibration and regime-conditioned performance.

## Release/cutover

The old PAPER account is not mixed into Multi-Turn performance. After all release gates pass and before normal operation:
1. require LIVE owner switch OFF and no managed LIVE exposure;
2. close/archive any old PAPER source positions using fresh executable prices;
3. atomically persist the final old-account archive packet;
4. create a new 1000U Multi-Turn PAPER account with no old rules, samples, positions or PnL;
5. preserve credentials, owner/member settings, LIVE switch state and long-term UI history infrastructure;
6. deploy exact main SHA and require advancing production health.

At most one or two later strategy micro-adjustments are acceptable. A failed Multi-Turn concept is not to be kept alive by accumulating hard filters.
