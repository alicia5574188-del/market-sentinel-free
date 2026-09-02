# Decisions

Record only consequential decisions using this format:

## YYYY-MM-DD — Decision

- Choice:
- Reason:
- Evidence:
- Revisit when:

## 2026-08-30 — Enlarge paper positions before rejecting signals

- Choice: Size HTE 3.1 paper orders around 4% equity risk, constrain actual planned loss to 3–5%, and target fee-adjusted TP2 net profit of 5–20%. Preserve READY-entry frequency by enlarging simulated notional and adjusting TP2 R before rejecting a setup.
- Reason: The previous 1%/3x/25%-margin combination produced sub-dollar gains; the user explicitly rejected solving this by filtering more entries from an already low-frequency system.
- Evidence: `lib/hte31-repository.ts` currently caps base risk near 10U, leverage at 3x, and margin at 25% equity. The user specified 30–50U acceptable loss and 50–200U profit for 1,000U paper capital.
- Revisit when: New paper samples show whether the adjusted setup remains positive after fees and time exits.

## 2026-08-30 — Cap adaptive paper leverage at 50x

- Choice: Permit HTE 3.1 simulated sizing to use up to 50x for tight-stop, liquid markets, subject to a liquidation-buffer check and full UI disclosure.
- Reason: Tight structural stops require larger notional to put 30–50U at risk; leverage should express stop-defined risk rather than conceal it.
- Evidence: Current HTE leverage is only 1–3x and is omitted from closed-order summaries.
- Revisit when: Paper slippage modeling or contract-specific Gate limits are added.

## 2026-08-30 — Keep live enabled per explicit authorization, isolate paper sizing

- Choice: Preserve the current Gate live-enabled intent; do not automatically apply the new paper leverage/risk formula to real orders in this change.
- Reason: The user explicitly authorized live to remain on and states the futures account is unfunded, while real sizing changes still require independent verification.
- Evidence: User instruction on 2026-08-30; project live controls are owner-controlled and fail-closed.
- Revisit when: The user funds the futures account or explicitly requests real sizing parity.

## 2026-08-30 — Expand analysis, not execution latency

- Choice: Keep 5m tactical execution for HT1-HT3, expose 15m/1h/4h separately, and add HT4 Exhaustion plus HT5 Higher-Timeframe Swing as independent paper traders.
- Reason: Recent trades often had short-term favorable excursion while the larger subsequent move ran the other way; averaging timeframes into one scalar hid that conflict.
- Evidence: Four new paper trades all showed initial profit; two reached TP1, while two later hit valid structural stops and continued adverse.
- Revisit when: Counterfactual and post-exit samples are large enough to compare original direction, direct opposite, and confirmed reversal paths by trader/regime.

## 2026-08-30 — Fix measurement before tuning setup thresholds

- Choice: Make paper 1R include round-trip fees, classify TP1-protected breakevens as scratches rather than failure losses, and prevent a newly moved TP1 stop from using pre-trigger intrabar history.
- Reason: Otherwise loss R is overstated, protected trades contaminate loss streaks, and impossible same-candle ordering can create false breakeven exits.
- Evidence: BTC planned -39.10U realized -48.64U and HYPE planned -39.87U realized -45.29U were explained by fees outside the old risk budget.
- Revisit when: Real exchange slippage modeling or finer event/tick data is introduced.

## 2026-09-01 — Preserve capabilities and repair stale UI smoke contracts

- Choice: Keep the PR #99 operator capabilities and update three stale smoke assertions to validate behavior: preserved reset history, absence of document/window touch traps, and one trading page tree plus the isolated operator drawer.
- Reason: The failed assertions encoded obsolete copy and DOM shape, and one over-broad rule treated the Emergency Stop button's local gesture suppression as a page-wide scroll trap.
- Evidence: GitHub Actions run `33460289588` failed only tests 35, 68, and 96; the production build, 189 strategy/risk tests, 100 UI safety tests, Wrangler dry-run, ESLint, and TypeScript all pass after the compatibility repair.
- Revisit when: The reset behavior, mobile navigation model, or root operator-control mounting architecture changes.

## 2026-09-01 — Restore the five-tab contract without deleting learning

- Choice: Use exactly `机会 / 雷达 / 订单 / 实盘 / 设置` in the fixed bottom navigation and place the former standalone Learning sections under `订单`.
- Reason: The original product contract requires those five discoverable destinations, while learning and per-trade review remain Must-Keep capabilities and should not be discarded merely to meet the navigation count.
- Evidence: The production page previously exposed `首页 / 市场 / 交易 / 学习 / 实盘` and hid Settings behind a header button; focused and full UI tests now enforce the restored fixed tab set while continuing to assert every learning surface.
- Revisit when: User research supports a different information architecture and the fixed five-tab contract is explicitly changed.

## 2026-09-01 — Adapt existing HTE31 plans into complete pre-trade cards

- Choice: Render full pre-trade evidence and risk detail from the existing dashboard `entryPlan`, `reasons`, and `blockers`, using native expandable cards and no new API or state producer.
- Reason: The backend already persisted the required trigger checks, levels, support, counter-evidence, and exit rules; the UI type and compact card were the only missing layer.
- Evidence: `getHte31Dashboard()` already returns parsed entry plans. The updated page displays direction, trigger/gates, entry zone, stop, TP1/TP2, evidence, missing conditions, and invalidation while the polling and exchange boundaries remain unchanged.
- Revisit when: The HTE31 entry-plan schema changes or operators require additional execution economics on pre-trade cards.

## 2026-09-01 — Learn entry timing with scoped, paper-only evidence

- Choice: Persist a deterministic Entry Quality report for every HTE31 trade chart: Entry Efficiency, MAE before +0.5R, time to +0.5R/+1R, late-1/2/3-bar counterfactuals, and one of five explainable diagnoses. `require_retest` may activate only after at least 3 assessed trades in the same setup and asset regime, with at least 2 and at least 60% classified as entry-too-early.
- Reason: The previous `MAE ≥ 0.75R && MFE ≥ 0.6R` heuristic could identify a possible entry issue but could not answer whether waiting 5–15 minutes would have improved the trade, and its recent-three-trade directive was not scoped to one playbook/environment.
- Evidence: `lib/resonance-entry-quality.ts` replays the stored candle path conservatively; `lib/resonance-review.ts` aggregates only matching setup/regime cells; `lib/resonance-trading.ts` applies the retest only to that cell and the existing cognitive marker keeps it out of Gate live.
- Revisit when: A forward baseline/challenger sample is large enough to compare original versus retest timing without changing stop or risk policy.

## 2026-09-01 — Keep the HTE31 observer independent of account persistence

- Choice: Authenticate the high-frequency `/api/hte31` read path with a trusted read-only viewer identity, while retaining durable `requireApiAccount()` checks for account-scoped and mutation APIs.
- Reason: The core dashboard does not need to read or update `user_accounts` on every refresh. Making that auxiliary lookup a prerequisite allows a transient account-store failure to surface as a full dashboard 503.
- Evidence: PR #100 added `requireApiViewer()` to the observer path and passed its production CI. This Entry Quality change preserves that boundary while adding local diagnostic caching and last-trustworthy-snapshot degradation.
- Revisit when: HTE31 snapshot responses need durable account identifiers or account-specific authorization beyond owner/member display role.

## 2026-09-01 — Present historical analog sample eligibility honestly

- Choice: Expose the 8-independent-episode minimum in the market-memory payload and UI. Below it, show sample progress and exclusion from judgment; at or above it, show bias, effective sample count, and median forward move.
- Reason: `NEUTRAL / confidence 0` below the evidence floor means “not eligible,” not a measured 0% disagreement.
- Evidence: `buildHistoricalAnalog()` already deduplicates overlapping windows and requires 8 independent matches; the UI now renders the same threshold rather than inventing a directional reading.
- Revisit when: The historical analog estimator or its evidence minimum changes.

## 2026-09-01 — Degrade HTE31 refreshes locally

- Choice: Cache auxiliary diagnostics for 60 seconds with a five-minute stale fallback, reduce the single main dashboard poll from 15 to 30 seconds, and retain the last trustworthy snapshot with an amber refresh-delay notice after a transient failure.
- Reason: A non-JSON edge 503 should not erase valid data or display a raw whole-page failure while the independent Scanner and Position Monitor continue running.
- Evidence: The reported iPhone screenshot retained the prior snapshot while `/api/hte31` returned 503; the new client state preserves that behavior explicitly and cuts foreground diagnostic reads.
- Revisit when: Production logs show the remaining request budget or a read-model split supports an even lighter health refresh.

## 2026-09-02 — Freeze HT4 and challenge the other strategy families separately

- Choice: Keep HT1–HT5 as the control lane, freeze HT4 Exhaustion's decision source with a regression fingerprint, and implement revised HT1/HT2/HT3/HT5 plus HT6–HT9 only as HTE31-native research challengers.
- Reason: HT4 currently carries the positive result, but a few wins are not enough to grant permanent priority. The weaker strategies need new applicability and entry hypotheses without risking the profitable baseline or reconnecting the retired Strategy 2 authority.
- Evidence: Research signals are filtered out before `tryOpenResonanceTrade()` selects a control candidate; the Gate live allowlist remains unchanged; tests verify HT4's exact source hash and reject any HT4 wrapper in the research module.
- Revisit when: A challenger has enough non-overlapping forward evidence for a separate promotion audit.

## 2026-09-02 — Increase evidence throughput with independent shadow positions

- Choice: Allow up to 64 concurrent shadow observations keyed by strategy, symbol, direction, regime, and time bucket. Count only non-overlapping completed paths for routing evidence, and keep same-side cooperation or opposite-side conflict as separate attribution rather than extra executable exposure.
- Reason: Raising the two-slot control-account limit would make experimental strategies compete with HT4 and confound account PnL. A no-capital research ledger provides more strategy opportunities and cleaner comparisons without changing current execution.
- Evidence: Each READY strategy gets a cost-aware stop/TP/timeout path; same-candle ambiguity is stop-first; duplicate inserts do not consume capacity; router promotion remains gated at 30 samples, PF 1.30, +0.15R expectancy, and 6R drawdown.
- Revisit when: Forward data shows whether the 64-observation cap or per-symbol independence policy causes starvation or correlated overcounting.

## 2026-09-02 — Lower paper margin without increasing stop-defined risk

- Choice: Target 15% equity per new paper order as isolated margin by selecting the required safe leverage, while preserving the same structural stop, desired notional, 3–5% fee-inclusive account risk, and liquidation buffer. Permit a 45% hard collateral fallback only when a narrow stop reaches the leverage cap.
- Reason: Margin occupation and stop loss are different quantities. Higher leverage can free simulated collateral for observation without increasing the amount lost at the planned stop.
- Evidence: Position-sizing tests verify the unchanged risk band, unmodified market TP, adaptive leverage caps, and liquidation distance; the Gate live sizing path is separate and unchanged.
- Revisit when: Contract-specific leverage tiers, maintenance-margin brackets, or real slippage are modeled for paper execution.

## 2026-09-02 — Replace research isolation with one capital-backed simulation brain

- Choice: Put all thirteen HTE31 strategies into one paper execution pool. The strategy brain selects the single candidate for each symbol/cycle, and routing evidence comes from actual closed paper orders. Stop creating or advancing shadow trades.
- Reason: The user explicitly rejected “simulation inside simulation” and wants every strategy to learn from the same real simulated account.
- Evidence: The prior production path split five controls from eight no-capital shadow strategies; the new path gives every catalog strategy `paper` authority and persists the brain selection on each opened trade.
- Revisit when: Actual paper-order evidence shows a specific strategy or regime cell should be contained; containment must remain scoped and must not recreate an auxiliary simulation layer.

## 2026-09-02 — Make live inherit the exact learned paper lineage

- Choice: Gate live accepts every strategy in the unified thirteen-strategy catalog and directly reuses the selected paper trade's strategy, learned entry checks, stop, targets, and leverage. Real account balance, fees, slippage, contract constraints, and hard safety gates remain live facts.
- Reason: The user wants live to match the learned simulation exactly so strategy behavior is not redesigned after funding.
- Evidence: The live candidate boundary now validates against `HTE31_ALL_TRADER_IDS` and no longer rejects cognitive challengers or the former research IDs.
- Revisit when: Never merely because funding starts. Change only on an explicit strategy/risk optimization request with end-to-end parity tests.

## 2026-09-02 — Increase learning capacity without ceding funding control

- Choice: Allow up to five paper/live positions, at most three in one direction, and cap total planned paper stop risk at 20% of equity. Target 8% isolated paper margin with a liquidation-safe 35% fallback; leverage remains capped at 50x and by liquidity, volatility, quality, and liquidation distance.
- Reason: More concurrent capital-backed orders increase learning samples, while direction and total-risk envelopes prevent unlimited stacking.
- Evidence: Position-sizing, portfolio-risk, live-preflight, and router tests cover these limits.
- Revisit when: Actual simultaneous-position data shows correlation or margin contention not captured by direction and planned-stop risk.

## 2026-09-02 — Real funding remains the owner's approval

- Choice: Do not move funds or infer approval to trade live. The owner will transfer funds only after the unified simulation demonstrates actual positive growth.
- Reason: Funding and acceptance belong to the user, not the system.
- Evidence: Explicit user instruction on 2026-09-02; Gate remains fail-closed without available funds and retains owner-controlled live activation/emergency controls.
- Revisit when: Only after an explicit owner instruction.
