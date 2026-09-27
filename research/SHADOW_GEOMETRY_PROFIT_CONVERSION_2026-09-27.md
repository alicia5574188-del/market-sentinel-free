# Shadow Quality V2 / Geometry retention amendment — 2026-09-27

This amendment keeps the original research-only boundary intact and fixes the first live research defect found from snapshot `market-intelligence-v1-snapshot-2026-09-27(5).json`.

## Geometry retention repair

The first implementation stored every high-frequency Market Intelligence update and capped the array at 96 rows. In production this meant 96 rows covered only a few minutes, so it could not support multi-hour regime analysis.

The corrected design stores at most one Market Geometry representative per **5-minute time bucket** and keeps 96 buckets, giving roughly **8 hours** of bounded research coverage. Existing high-frequency rows are losslessly normalized to one representative per 5-minute bucket on read. This lowers optional write volume; it does not add an alarm, quote request, data source, or financial write.

## Response Quality V2

The original PASS/CANCEL authority is unchanged. Shadow V2 computes a continuous, outcome-blind research score from only information available at entry:
- fraction of the allowed response window consumed;
- best favorable response;
- favorable response per second;
- adverse response during confirmation;
- support-family breadth;
- 30-minute side-relative entry location and pre-entry path efficiency.

It records `ROBUST / MIXED / FRAGILE` plus flags such as `OVER_15S_OBSERVED_RISK`, `WEAK_RESPONSE_SPEED`, `EXTENDED_LOCATION`, and `STRONG_EXTENSION_CONFIRMED`.

The 15-second observation from the current sample is **not** a production veto. It is retained as a shadow flag so later data can test whether it remains stable out of sample. Final PnL and post-entry outcome labels are not inputs to the response score.

## Profit Conversion V2

Shadow V2 separates peak gross excursion from peak net opportunity after modeled round-trip friction, then combines giveback with the already-existing Position Intelligence evidence state.

Profit proof tiers:
- NONE
- THIN
- MEANINGFUL
- EXPANSION

Shadow-only research signals:
- NO_PROOF
- LET_RUN
- WATCH
- PROTECT_CANDIDATE
- EXIT_CANDIDATE

Moderate profits do not escalate merely because price pulls back; they require converged deterioration evidence. Large EXPANSION profits deliberately receive wider giveback room so the study does not recreate a tight universal trailing stop, but destructive tail giveback can still be flagged before a full structural stop.

Each trade keeps a bounded milestone history only when response/profit research state changes. This allows later snapshots to ask whether a shadow protection candidate appeared materially before the real exit without creating per-tick writes.

## Authority boundary

Response Quality V2 and Profit Conversion V2 are not imported by `forward-relations.ts` and cannot open, close, size, score, rank or protect a real PAPER/LIVE/member position. A later authority change still requires separate evidence, explicit owner approval, and a new release scope.

# Shadow Market Geometry & Profit Conversion — 2026-09-27

## Owner intent

Preserve the currently profitable Market Intelligence account and its ability to hold rare large winners such as SUI. Do **not** react to the small 11-trade sample by tightening production entry/exit rules. Add an isolated research layer that can explain why some trades work, why some chase entries are late, and why some trades show meaningful floating profit before closing negative.

This is research-only. It has no authority over symbol selection, entry, exit, stops, sizing, leverage, risk, PAPER account state, LIVE parity or member copying.

## Questions to answer

1. Is the broad market trending coherently or rotating/chopping even when a short directional bias exists?
2. At entry, where is price relative to the preceding 30/60/120-minute range?
3. How much of the recent directional run has already happened before entry?
4. Was ENTRY_RESPONSE immediate and clean, or did it consume most of its confirmation window?
5. Did a trade merely show gross floating profit, or did it move far enough to cover modeled round-trip cost?
6. If cost-covering profit existed, how much was retained or given back before exit?
7. Can these measurements distinguish SUI-like durable winners from RARE/TAO/ADA/DASH-style profit giveback and BNB-like late responses without clipping strong trend tails?

## Shadow measurements

### Market Geometry

Persist bounded 5-minute snapshots of the existing Market Intelligence state:
- breadth3 / breadth12 / breadthSlope
- dispersion / synchrony
- residual balance / leader persistence
- venue pressure
- macro / major / short / short phase / transition
- leadership-rotation evidence

A descriptive label is stored for research only:
- TRENDING
- ROTATIONAL
- MIXED

The label has no trading authority.

### Entry Location

Using only completed 5-minute candles whose close time is at or before the real entry:
- 30 / 60 / 120 minute high-low range
- raw range position
- side-relative position (how far toward the trade-direction extreme)
- distance to the favorable recent extreme
- breakout beyond the prior range
- directional run already consumed before entry
- path efficiency

No future candle may enter entry geometry.

### Response Quality

Freeze the existing ENTRY_RESPONSE receipt and derive:
- elapsed time
- configured response window
- fraction of the response window consumed
- best/current advance
- max adverse response
- advance per second
- IMMEDIATE / DEVELOPING / LATE descriptive tempo

This does not alter PASS/CANCEL.

### Profit Conversion

For each current/recent Market Intelligence trade:
- peak favorable excursion and approximate peak bar
- maximum adverse excursion
- first 5-minute bar whose excursion covered modeled round-trip cost
- current signed return
- modeled current net return
- actual realized net return when closed
- giveback from peak
- retained-peak ratio
- realized/current net capture relative to peak net opportunity
- descriptive state:
  - NO_FAVORABLE
  - GROSS_ONLY
  - PROFIT_RETAINED
  - PROFIT_THINNED
  - PROFIT_LOST

The distinction between GROSS_ONLY and PROFIT_LOST is important: a small floating profit that never covered friction is not treated as equivalent to a large cost-covering profit that was later surrendered.

## Persistence and resources

Two separate optional Durable Object keys are used:
- market geometry
- trade shadow quality

They are updated only when a new Market Intelligence state snapshot appears, a trade appears/closes, or a new completed 5-minute bar changes the trade review. They use the optional/background write lane and yield before financial authority. No new market-data request or alarm is added.

## Release gate

Before deployment:
- unit test proves the shadow layer does not mutate ForwardState;
- architecture test proves it runs after authoritative PAPER advancement;
- architecture test proves production advanceForward has no shadow-research dependency;
- full LIVE parity/member isolation/build/typecheck/lint gates pass;
- account/history/open positions and manual LIVE intent remain unchanged.

Deployment of this shadow layer is **not** approval to change production trading rules. Any later decision-layer change needs separate evidence and owner approval.
