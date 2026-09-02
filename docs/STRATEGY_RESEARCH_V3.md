# Resonance Strategy Research V3

This document records the safety and learning contract for the strategy-expansion phase.

## Control lane: unchanged execution authority

The existing five HTE31 strategies remain the only strategies that can reach formal paper execution and any downstream live-eligibility path.

HT4 `trend_exhaustion_reversal` is the protected baseline. This phase does not change its setup thresholds, RR, maximum holding time, entry checks, ranking inputs, or live safety behavior. New strategies cannot consume an HT4 execution slot because they never enter the formal candidate list.

## Research lane: eight challengers

The research lane runs independently and has no paper/live/Gate authority:

- HT1-R — breakout acceptance: 1h direction + 15m structure acceptance + 5m execution.
- HT2-R — pullback resume: trend + intact pullback + restart; micro-flow only vetoes strong opposition.
- HT3-R — failed auction: breakout attempt + lack of outside acceptance + structural reclaim + sufficient reverse displacement.
- HT5-R — higher-timeframe swing: 4h/1h structure, 15m recovery, 5m execution only.
- HT6 — range rotation: edge rejection and return toward balance; no middle-of-range entries.
- HT7 — compression release: volatility compression followed by accepted expansion.
- HT8 — relative strength: cross-sectional leaders/laggards that resume in the relative-strength direction.
- HT9 — shallow pullback continuation: strong trends that pause shallowly and never offer a deep mean pullback.

Research signals are written to the diagnostic/shadow ledger only. Up to 64 concurrent research observations may exist. A symbol can be studied by multiple strategies at the same time, including conflicting directions, because these observations do not reserve capital or formal trade slots.

## Brain/router contract

The router is observe-only. It may rank evidence, but it may not:

- change formal execution priority;
- raise HT4 priority because of recent profit;
- replace HT4 or another formal strategy;
- auto-reverse a position;
- automatically promote a research strategy;
- mutate live/Gate execution state.

A research strategy is only marked evidence-qualified after at least 30 completed independent samples, Profit Factor >= 1.30, and expectancy >= +0.15R. Qualification is evidence for a later explicit promotion decision, not execution permission.

## Paper capital efficiency

Higher leverage is used only to reduce margin footprint. It does not increase the planned structural-stop risk budget.

- minimum / normal target / maximum stop-risk budget: 3% / 4% / 5% of current paper equity;
- preferred single-position margin footprint: <= 15% of equity;
- hard single-position margin footprint: <= 30% of equity;
- paper leverage ceiling: 75x only when liquidity, volatility, confidence/data quality, and liquidation-buffer checks allow it;
- formal concurrent paper positions: maximum 4;
- aggregate planned stop risk across open formal paper positions: maximum 16% of current equity.

Live/Gate leverage, deployment recovery locks, reconcile behavior, credential storage, current-position protection, emergency stop, and Auto Live are unchanged.

## Non-regression contract

This phase must preserve:

- simulation capital reset without deleting historical trades/reviews/learning;
- five fixed bottom navigation tabs;
- full pre-trade signal and post-trade review surfaces;
- account/logout and Web Push controls;
- Gate credential management, reconcile, Auto Live and emergency stop;
- no additional front-end Gate polling;
- no second execution authority;
- no live permission for research strategies.
