# Goal

## Objective

放大 HTE 3.1 模拟仓位并持续优化低频亏损策略：1000U 本金单笔风险30–50U、TP2净利润50–200U、杠杆透明；保持实盘开启授权但不自动修改真实风险，使用订单样本淘汰负期望组合。

## Deliverables

- A deterministic HTE 3.1 paper position-sizing module that enlarges notional first, selects up to 50x adaptive paper leverage, and adjusts TP2 R for fees before rejecting a valid entry signal.
- HTE 3.1 integration that records actual planned risk after caps and does not reduce current entry frequency merely to hide small-profit trades.
- Order cards that expose leverage for open and closed orders, original stop, margin, notional, planned risk, TP2 expected net profit, fees, and realized R.
- Post-exit classification fixes so near-TP2 time exits and temporary stop recoveries are not mislabeled.
- Performance gates grouped by trader, direction, asset regime, and exit reason so persistently negative combinations stop opening while the rest of the strategy continues.
- Tests, documentation, PR/CI evidence, and a verified production deployment.

## Acceptance checks

- At 1,000U normal paper equity, a new order plans 30–50U stop loss, normally about 40U.
- Its full-position TP2 projects 50–200U net after the configured round-trip cost.
- Existing READY signals are resized and, when necessary, receive a fee-aware TP2 adjustment before economic rejection is considered.
- Paper leverage is visible, adaptive, at most 50x, and the estimated liquidation point remains beyond the structural stop plus a safety buffer.
- Closed-order cards retain the original stop and leverage rather than showing only the final breakeven stop.
- Negative-expectancy trader/regime/direction cells are evidence-gated and paused without globally reducing healthy signal frequency.
- Focused tests, full tests, lint, TypeScript, build, CI, and production health checks pass.

## Constraints and non-goals

- Starting paper capital remains 1,000U; historical orders remain unchanged.
- The user explicitly authorized Gate live to remain enabled and states the futures account will remain unfunded for now.
- Do not silently change real Gate leverage/risk sizing in this paper-sizing change. Future funding would make enabled live trading financially active, so any real sizing change must remain separately traceable and verified.
- Do not reduce entry frequency merely to improve the displayed average profit.
- Do not claim guaranteed realized profit; entry economics can be enforced, while timeout, breakeven, fees, and slippage can still alter actual results.

## Current completion objective — PR #99 Must-Keep UI

Restore the complete operator-facing contract on PR #99 without changing trading authority or risk behavior:

- Keep exactly five fixed bottom tabs: `机会 / 雷达 / 订单 / 实盘 / 设置`.
- Keep the simulation-capital reset discoverable from funds and executable only once from Settings, with open-position blocking and history/learning preservation unchanged.
- Expose the full pre-trade plan from the existing HTE31 dashboard payload: direction, trigger state and gates, entry zone/price, stop, TP1, TP2, support, counter-evidence, and invalidation rules.
- Preserve account, Web Push, audit, Gate credential/control/reconciliation/emergency, review, and scanner diagnostic capabilities.
- Add no polling, foreground Gate producer, destructive-action duplicate, live authority, risk path, schema change, or strategy-rule change.
- Require focused UI tests, strategy/risk tests, production build/UI tests, lint, TypeScript, Wrangler dry-run, compatibility audit, and a green PR #99 remote CI run.

## Current completion objective — Entry Quality learning

Teach Resonance to diagnose entry timing before changing stop or risk policy:

- Show historical analogs as evidence with an explicit independent-sample threshold; fewer than 8 samples must say `样本不足 · n/8` and `暂不参与判断`, never `分歧 0%`.
- Record per-trade Entry Efficiency, adverse excursion before the first +0.5R, time to +0.5R/+1R, and delayed-entry counterfactuals for 1/2/3 completed 5m candles.
- Classify entry outcomes as direction wrong, entry too early, entry too late, normal noise, or stop too tight; insufficient paths remain unclassified.
- Feed the result into the existing cognitive review, but require repeated evidence in the same setup and asset regime before changing entry confirmation.
- Keep all learned entry-confirmation changes paper-only and traceable through the existing cognitive marker; do not change stop distance, paper/live risk, Gate rules, or broad setup thresholds.
- Reduce `/api/hte31` foreground pressure and preserve the last trustworthy snapshot during a transient refresh failure.

## Current completion objective — Strategy research throughput and routing

Increase forward strategy evidence without disturbing HT4's currently positive baseline:

- Freeze HT4 Exhaustion decision behavior with an explicit regression fingerprint; this change may observe it but must not tune, reprioritize, or rewrite its entry rules.
- Keep the existing five execution playbooks as the control lane while adding HTE31-native research challengers for revised HT1/HT2/HT3/HT5 logic and the missing range-rotation, compression-expansion, relative-strength, and shallow-pullback momentum-continuation stories.
- Record concurrent, independent research positions by setup, symbol, direction, and market regime without consuming the two control-account slots or its capital; multiple strategies may study the same move without doubling an executable position.
- Add an explainable shadow router that can report one strategy, same-side cooperation, opposite-side conflict, thesis invalidation, and a replacement candidate. It must remain research-only until forward evidence satisfies explicit sample, expectancy, profit-factor, and drawdown gates.
- Reduce new paper-position margin occupation by selecting higher safe isolated leverage while preserving the same structural stop, planned 3–5% account risk, notional, fees, and liquidation buffer.
- Do not auto-promote challengers, auto-switch Gate positions, change live sizing, or let research candidates block/preempt HT4 or any existing position lifecycle.

## Current completion objective — Unified paper brain and live parity (supersedes the research-only objective)

- Put all thirteen HT1–HT9 strategy definitions into one capital-backed simulation pool; do not create new shadow trades or any second simulation layer.
- Let one strategy brain select the executable candidate from current structure plus actual closed paper-order evidence. HT4's source remains frozen, but it has no permanent priority.
- Preserve the selected strategy, learned entry rules, stop, targets, leverage, and decision lineage for direct Gate live parity. Real balance, fees, slippage, contract limits, and hard safety remain exchange facts.
- Increase learning throughput to at most five open paper/live positions, at most three in one direction, with total planned paper stop risk no greater than 20% of equity and one open position per symbol.
- Target 8% isolated margin per paper trade; allow a liquidation-safe narrow-stop fallback up to 35%. Adaptive leverage remains capped at 50x by liquidity, volatility, quality, and stop-before-liquidation safety.
- Real funds remain entirely the user's decision. The user will not fund Gate until the simulation shows actual positive growth; the system must never move funds or decide that approval for the user.

## Current completion objective — D1 daily write budget

- Keep the 15-second active-position safety observation cadence and 60-second market-scanner cycle unchanged.
- Persist stop, TP1 protection, TP2, timeout, close, and learning events immediately.
- Replace unchanged 15-second holding-row writes with durable 60-second checkpoints.
- Keep planned recurring D1 writes at or below 60,000 rows/day under the configured thirteen-strategy/five-position maximum, leaving at least 40,000 rows below the 100,000 free daily limit for event-driven writes and variance.
- Make the D1 write budget a required review and regression-test item for every future upgrade.
