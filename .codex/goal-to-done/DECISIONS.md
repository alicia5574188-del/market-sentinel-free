# Decisions

## 2026-09-05 — Correct entry invariants without another strategy rewrite

- Choice: Only completed five-minute candles may confirm entries. Resonance must recover nearby structure with market support; stops remain outside their actual swing and are rejected, never clamped inward, when price-distance risk exceeds 5% (also checked at the final quote). Reuse the existing regime classifier and rank qualified setups without a named-strategy bonus.
- Reason: Same-input probes reproduced weak bounce admission, missing market-fit checks and a 3% stop inside structure. Scanner source also passes unfinished chart candles. Hardcoded regime labels and exhaustion's fixed score bonus distorted isolation and selection; this does not establish the unique cause of an unseen production order.
- Scope: Preserve HT3-R/HT4 core patterns, quality/macro/portfolio/learning thresholds, risk sizing, live authority and D1 cadence. Use the existing major PAPER release cutover for V5; no production reset occurs during local implementation.
- UI: Centralize Chinese presentation only; retain stored English IDs and history, remove daily raw diagnostic clutter, keep complete evidence in Management and preserve all Must-Keep capabilities.
- Verification lesson: Run `npm run test:direct` in CI as well as signal/build/UI gates. Test clean exhaustion separately from overlapping reversal patterns, so removing a hidden ranking bonus cannot be mistaken for loss of the core exhaustion trigger. Use the canonical version in runtime and release proofs.

## 2026-09-05 — Separate useful operator status from raw diagnostics and restored-rule claims

- Choice: Remove the raw candidate hero from the daily Brain page; show plain operating status and keep complete evidence collapsed under Management. Preserve contribution, orders, twelve-hour review, account and live safety capabilities.
- Reason: The user explicitly rejects scores, English location codes, probabilities and empty levels as daily-use content. Candidate readiness must not be presented as a completed entry.
- Evidence: Local UI capability and state tests cover the new compact summary. Historical same-input probes show V4 differs from retained HT3-R/HT4/HT5-R through outer gates, omitted HT5-R market checks and clamped stops; copying core thresholds is not behavioral parity or verified profitability.
- Boundary: UI only is implemented locally; strategy findings are diagnosis, not a silent live-policy change. A fast follow-up must start from these exact probes rather than rediscovering the repository or guessing the screenshot's order ID.

## 2026-09-04 — Treat setup activity as a funnel, not a winner-only partition

- Choice: On every deep scan, count all three setup evaluations independently, then separate setup trigger, shared hard-gate qualification, primary selection, entry blocking, and actual opening. A fixed 12-hour result is complete only when measured Scanner coverage spans the full window; incomplete startup windows remain explicitly in progress.
- Reason: The first production window showed `7 + 79 + 47 = 133` because only the selected setup received an evaluation, even though all three ran every time. The new runtime started about 57 minutes before a UTC boundary and incorrectly promoted that partial coverage as a completed 12-hour review.
- Evidence: `lib/direct-market-activity.ts` owns zero-D1 funnel counters and coverage qualification; `DirectMarketCandidate.setupEvaluations` preserves all three deterministic results from the existing brain pass; focused tests prove equal evaluation counts and reject partial completion.
- Revisit when: A longer activity history is required. Any durable expansion must retain the no-recurring-D1-write boundary and must not change setup thresholds merely to improve displayed frequency.

## 2026-09-04 — Restore the original core as multi-timeframe comprehensive resonance

- Choice: Retire Dennis breakout from new-order authority and replace it with `MULTI_TIMEFRAME_RESONANCE`: aligned 15m/1h/4h direction, completed 5m confirmation/resume, spot/volume support, and anti-chase protection. Keep failed breakout and exhaustion reversal as the two mutually exclusive reversal stories.
- Reason: The user's first profitable concept was multi-timeframe resonance with dynamic protection, not Dennis. Requiring a literal range breakout produced too few samples; the restored setup can participate during orderly continuation without discarding hard safety.
- Evidence: `lib/direct-market-brain.ts` emits exactly the three setup IDs and focused deterministic tests cover each selection plus liquidity/volume rejection.
- Revisit when: Current-version independent closed orders and complete 12-hour paths provide enough comparable evidence; do not optimize win rate from isolated trades.

## 2026-09-04 — Summarize strategy contribution without a new D1 write stream

- Choice: Count evaluation, qualified-signal, opening, and leading-blocker activity in the Scanner Durable Object's existing runtime save; combine it with current-version D1 trade results at read time. Use fixed 12-hour buckets and retain the latest completed bucket.
- Reason: The owner needs to see who is contributing or dragging and what happens next, while D1's billed-row budget prohibits a per-scan statistics ledger.
- Evidence: `recordTwelveHourActivity`, `buildDirectSetupPerformance`, and `/api/hte31` produce the review. The scanner still performs one runtime save per completed cycle and no new recurring D1 write path exists.
- Revisit when: Durable Object retention proves insufficient for longer historical reporting; any durable expansion must re-budget indexed D1 writes first.

## 2026-09-04 — Replace abstract navigation while preserving operator capabilities

- Choice: Retire the user-facing Opportunity and Radar pages; reimplement their useful decision evidence as one collapsed section under `大脑`, keep full review under `订单`, and combine live/settings into `管理`. Account, push, and audit remain in the independent on-demand drawer.
- Reason: The owner explicitly does not use Radar/Opportunity concepts and wants the daily page to answer only brain decision, contribution/drag, orders, and the 12-hour summary.
- Evidence: The three-tab UI preserves the single paper reset, Gate credentials, Auto Live, reconciliation, Emergency Stop, runtime diagnostics, account, push, audit, and complete order-review paths; focused Must-Keep tests pass.
- Revisit when: A missing operator task cannot be reached safely from the three destinations; do not restore duplicate pages merely for old test contracts.

## 2026-09-04 — Make major strategy releases an automatic paper boundary

- Choice: Every Direct Market Brain major version declares one release manifest and additive cutover migration. The entry boundary and Trade Manager compare the declared version with D1 state; a mismatch blocks new paper entries, archives all open paper positions at fresh quotes as `version_reset`, then records the new active version while creating a clean epoch.
- Reason: A major strategy change makes old and new simulated results incomparable. Waiting for old positions to expire delays the new sample, while deleting or silently mixing them destroys attribution.
- Evidence: The existing forced-reset lifecycle already preserves immutable trade lineage and creates all seven post-exit observations. The new version state makes that safe path repeatable and CI-enforced instead of a one-off migration comment.
- Boundary: This mechanism is paper-only. Gate/live positions, orders, credentials, leverage, controls, funding, and Emergency Stop are untouched.
- Revisit when: A future release is explicitly classified as minor and proven not to change entry, exit, sizing, portfolio, learning, or decision semantics.

Record only consequential decisions using this format:

## 2026-09-03 — Restart the adaptive round without deleting evidence

- Choice: Use a one-time migration reset that blocks new entries, archives all pre-upgrade paper positions at fresh Gate quotes, preserves their 12-hour observation chain, and starts a new capital epoch after the last archive. Ordinary owner resets remain non-forcing.
- Reason: Pre-upgrade positions cannot inherit the new five-minute policy, while hard-deleting them would destroy audit and counterfactual evidence.
- Evidence: The reset mode is explicit and one-time; the normal reset route always restores `natural`, and all close/observation writes reuse the existing position lifecycle.
- Revisit when: A future version boundary requires a user-visible choice between natural completion and explicit migration archive.

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

## 2026-09-02 — Protect the D1 daily write allowance without slowing safety checks

- Choice: Continue evaluating active paper positions every 15 seconds, but persist unchanged holding telemetry once per 60 seconds. Stop, target, timeout, TP1-protection, close, learning, and recovery events remain immediate. Treat 60,000 planned recurring rows/day as the ceiling beneath Cloudflare D1's 100,000 free daily allowance.
- Reason: Five simultaneous paper positions can otherwise create 28,800 unchanged holding-row updates per day and push the account past Cloudflare's warning threshold. The user requires the free daily allowance to remain sufficient after every future upgrade.
- Evidence: The bounded thirteen-strategy/five-position schedule produces 18,720 evaluation rows, 1,440 diagnostic rows, and 7,200 position checkpoints per day, totaling 27,360 recurring rows and leaving 72,640 rows for lifecycle events and operational variance.
- Revisit when: Position capacity, scanner cadence, strategy count, persistence cadence, D1 plan, or any other recurring write path changes.

## 2026-09-03 — Treat HT4 as ordinary evidence and manage strategies by family lifecycle

- Choice: In the next strategy-brain implementation, remove HT4's freeze and special treatment. Preserve its prior profitable period only as historical evidence. Apply the same recent/lifetime/regime evidence, health states, diagnosis, retest, pause, and consolidation rules to all thirteen current strategy IDs. Group the explicit base/challenger pairs into canonical families without deleting legacy lineage.
- Reason: A strategy that made money previously is not guaranteed to retain its edge. Permanent protection would prevent the brain from detecting decay and would conflict with the owner's requirement that every strategy be understood, reviewed, and corrected or reduced when necessary.
- Evidence: Current code already exposes four base/challenger relationships through `baselineId`, and already stores actual paper results, Entry Quality, counterfactual paths, performance cells, and per-strategy evaluations. HT4's source fingerprint is a previous policy guard, not evidence of future profitability.
- Revisit when: Independent comparable-regime paper evidence supports a different family structure or the owner explicitly changes the equal-treatment rule.

## 2026-09-03 — Consolidate candidates without deleting strategy history

- Choice: Treat the thirteen stored strategy IDs as nine canonical families and thirteen variants. During one symbol/cycle, only the highest-ranked ready variant in a family can remain an executable candidate; the other variant remains visible as a family alternative and keeps its independent history.
- Reason: HT1/HT1-R, HT2/HT2-R, HT3/HT3-R, and HT5/HT5-R express overlapping stories. Allowing both to open from the same family/cycle would duplicate exposure, while deleting an ID would destroy attribution and Gate lineage.
- Evidence: `lib/hte31-strategy-catalog.ts` defines the family map and `lib/hte31-strategy-router.ts` performs deterministic family deduplication before conflict/cooperation routing.
- Revisit when: Comparable-regime closed-order evidence proves two variants are behaviorally independent or one is safely retireable.

## 2026-09-03 — Separate one-order diagnosis from repeated strategy changes

- Choice: Complete the existing 0/30/60/120/240/720-minute observation before issuing a final order verdict. A single order may state a profit path or no-trade conclusion, but strategy rules change only after repeated evidence in the same setup/environment.
- Reason: The owner requires every order to answer how it could have made money or whether it should not have existed, without turning one hindsight result into uncontrolled overfitting.
- Evidence: `lib/hte31-trade-verdict.ts` is observer-only; `lib/resonance-review.ts` consumes its result while retaining repeated-pattern thresholds for actual cognitive directives.
- Revisit when: More granular market replay supports a stronger causal test than the current 5-minute candle path.

## 2026-09-03 — Derive lifecycle health without new recurring D1 writes

- Choice: Compute strategy/family health from existing closed trades and 24-hour trigger buckets. Use recent eight versus older baseline evidence for degradation, and distinguish no suitable regime from active triggers repeatedly blocked by conditions.
- Reason: The brain must understand both losing and unused strategies, while the free D1 allowance must remain sufficient every day.
- Evidence: The upgrade adds no insert/update schedule or schema migration. The existing regression budget remains 27,360 planned recurring writes/day.
- Revisit when: Strategy count, position capacity, scanner cadence, checkpoint cadence, or any new recurring persistence changes.

## 2026-09-03 — Keep daily UI current and move strategy detail to a subpage

- Choice: Show only current operational truth, decisions, risk, and actions in the daily UI. Move the full family/variant cards into a dedicated Strategy Center reached from Radar, while preserving exactly five bottom tabs.
- Reason: Upgrade narratives and duplicated strategy lists make the phone interface harder to inspect and do not help daily operation.
- Evidence: The current Radar and Orders surfaces both render the full family-card list, and Radar includes implementation-history prose beneath the strategy heading.
- Evidence: Paper `TradeCard` still assembles `trader.code`, the old English trader name, setup text, and raw `assetRegime`, while live/chart paths already expose canonical labels; one shared formatter is required to prevent partial upgrades.
- Revisit when: The owner explicitly changes the five-tab information architecture.

## 2026-09-03 — Fix historical-memory validity without lowering evidence quality

- Choice: Keep the eight-independent-episode gate, add explicit ready/warming/unavailable/stale states, validate each historical interval, isolate partial failures, and retain only a bounded labeled last-known-good result in scanner state. Hide detailed cards until useful.
- Reason: With enough valid candles the current nearest-episode algorithm should not remain at zero; three persistent `0/8` results indicate missing/short/stale input, not a need to wait for new live accumulation.
- Evidence: The scanner requests 720/1,200/1,800 candles while the three calculators require only 44/46/74 valid rows to produce candidates. The current empty result carries no source-health reason.
- Revisit when: Comparable production probes show whether the upstream history depth or analog definition needs a separate research change.

## 2026-09-03 — Bound the main dashboard instead of treating transient 503 as a scheduler failure

- Choice: Remove on-demand strategy diagnostics from the 30-second main critical path, add deadlines and source-isolated partial responses around Durable Object/D1 reads, persist a timestamped read-only last-good snapshot across PWA reloads, and make health checks read-only.
- Reason: A single slow dependency currently delays the combined `/api/hte31` request until the client or edge can return 503, after which a cold page has no in-memory snapshot and replaces valid state with blanks.
- Evidence: A production health request timed out after 20 seconds, followed by a successful 15.2-second probe with both schedulers live, advancing, error-free, and the scanner circuit closed.
- Revisit when: Cloudflare request traces identify a narrower upstream bottleneck or production latency probes remain bounded after the split.

## 2026-09-03 — Replace named-strategy entry authority with direct market judgment

- Choice: New orders will come only from a deterministic `direct_market_brain` that evaluates current market location, direction, structural targets, invalidation, costs, and portfolio risk. HT1–HT9, families, and variants remain historical lineage but cannot vote, emit new candidates, provide fallbacks, or gate a new order.
- Reason: Recent losses showed that strategy naming and lifecycle labels were not correcting the actual location and entry problem. The owner wants the system to answer whether this location is tradable, which direction is most probable, and where the move should terminate.
- Evidence: The current scanner still reaches three legacy evaluator groups and a family router, while incomplete post-exit reviews can influence later execution. The frozen plan records the exact cutover and compatibility boundary.
- Revisit when: Only if the owner explicitly restores a named-strategy authority after comparable forward evidence; historical IDs alone are not sufficient.

## 2026-09-03 — Select at most three positions from a dynamic five-coin universe

- Choice: Rank five eligible Gate USDT perpetuals by confirmed 24-hour quote volume, compare them in one bounded batch, and open at most the available slots under a three-position global limit. Never force all three slots; use one position per symbol, normally at most two in one direction, and treat correlated exposure as one risk cluster.
- Reason: Five liquid candidates keep continuous scanning focused while three positions provide learning throughput without disguising correlated bets as independent diversification.
- Evidence: The current five-position budget and rotating single-symbol scan do not perform same-batch cross-sectional selection. The new plan defines membership stability, failure isolation, correlation gates, and safe handling of pre-existing positions above three.
- Revisit when: Completed direct-brain orders across several regimes demonstrate that five candidates or three positions materially constrain positive expectancy without breaching the D1/risk budget.

## 2026-09-03 — Require complete 12-hour evidence before learning

- Choice: Observe every close at `0/30/60/120/240/480/720` minutes using real post-exit 5-minute candles. Only a valid 720-minute path with required coverage and timing can change a brain version; incomplete paths stay pending/stale/unavailable and carry zero learning weight.
- Reason: A useful review must distinguish a bad trade from wrong direction, poor location, early/late entry, protection, target, or holding-time error without using hindsight or an unfinished future path.
- Evidence: The deployed observer omits 480 minutes and current review can consume trades before their 12-hour observation completes.
- Revisit when: A longer horizon is justified by measured holding-time distribution; never lower the completeness requirement merely to accumulate samples faster.

## 2026-09-03 — Keep learning single-account, versioned, and D1-bounded

- Choice: Apply one-variable, evidence-linked revisions directly to the sole paper account, with parent versions and rollback; do not create shadow trades or a second simulation. Stop thirteen recurring strategy-evaluation writes and enforce planned total writes at or below 33,120/day, a 55,000-row protective threshold, and the 60,000 project ceiling.
- Reason: The owner requires one simulation-to-live decision chain and Cloudflare Free's 100,000 daily write allowance must remain sufficient after every upgrade.
- Evidence: Removing 18,720 daily legacy evaluation rows reduces planned recurring writes from 27,360 to about 5,760 even with three continuous position checkpoints.
- Revisit when: Any scan cadence, position capacity, observation schedule, schema write, or D1 plan changes.

## 2026-09-03 — Expand the candidate universe without multiplying correlated risk

- Choice: Supersede the prepared five-coin universe with the fifteen eligible Gate USDT perpetuals having the highest confirmed 24-hour quote volume. Light-scan all fifteen every rolling cycle, deep-scan six drawn from multiple correlation clusters, then select at most three positions by marginal portfolio expectancy rather than raw single-coin score.
- Reason: The five largest crypto contracts can all express the same BTC-driven move. A broader liquid universe improves the chance of finding independent opportunity, but fully refetching every timeframe for fifteen coins each minute would recreate latency and rate-limit failures.
- Evidence: Shared ticker reads, incremental candle caches, three-minute full light-scan coverage, six bounded deep scans, and three-request concurrency preserve breadth without adding D1 writes or foreground data production.
- Revisit when: Production request telemetry proves a different deep-scan width or refresh window is safer while maintaining full fifteen-coin coverage.

## 2026-09-03 — Replace raw loss streaks with independent-event protection and earned risk

- Choice: Supersede the provisional 2/4/6-order stop-loss rules. Group same-batch, same-direction, correlated and overlapping orders as one independent performance event; apply realized-PnL/drawdown protection immediately, but permit model changes only after valid 12-hour reviews. Start the new authority in `CALIBRATING`, progress through `VALIDATING`, and grant normal risk only after sufficient independent forward evidence.
- Reason: Three correlated positions can lose in one market shock and should not be treated as three independent proofs, while waiting 12 hours before reducing exposure is unsafe. The new authority has no comparable live sample and should not start at full risk merely because the retired strategies did.
- Evidence: The implementation contract now defines sample coverage, risk stages, rolling expectancy/PF/drawdown guards, low-risk recovery probes, and one-variable version promotion/rollback.
- Revisit when: Enough direct-brain independent events exist to recalibrate thresholds without mixing old-strategy results or overlapping market shocks.

## 2026-09-03 — Budget D1 by billed table and index rows, not logical records

- Choice: Supersede the 27,360 logical-row estimate. The direct brain writes no scanner/evaluation/diagnostic rows to D1, limits its own index-adjusted usage to 30,000 rows/UTC day, stops new-order admission at 22,000 including committed future lifecycle rows, reserves 100 billed rows per accepted trade, and requires account-wide production metrics below 65,000.
- Reason: Cloudflare bills written table rows and written index entries. The old evaluation table has a text primary key and three explicit indexes, so 18,720 evaluation records can conservatively cost 93,600 billed rows before diagnostics and position checkpoints.
- Evidence: `lib/direct-market-d1-budget.ts` calculates a 105,120 legacy upper bound and a 30,000 direct-brain hard budget; `tests/direct-market-d1-budget.test.ts` passes all three guard checks. Official D1 metrics expose `rowsWritten` per query and account-wide through GraphQL.
- Revisit when: Production D1 query metadata proves a safe lower cost, or any schema index, write path, position cadence, observation horizon, or daily order capacity changes.

## 2026-09-03 — Prebuild one-pass execution to protect model allowance

- Choice: Use `docs/DIRECT_MARKET_BRAIN_EXECUTION_PACK.md` as the only formal-upgrade route, with fixed type contracts, exact files, six limited implementation stages, targeted tests per stage, one final full suite, and one CI/deploy verification loop.
- Reason: Re-analyzing architecture, repeatedly running the full suite, or rediscovering UI/migration boundaries would waste the five-hour model allowance without improving safety.
- Evidence: The prepared pack routes every module and acceptance gate, while the D1 constants/test are already implemented. Formal target is 75–105 minutes of model-active work and 105–150 minutes including normal local/remote verification.
- Revisit when: Current `main` changes the prepared interfaces before implementation or external CI/deployment latency exceeds the planned waiting window.

## 2026-09-03 — Retry incomplete post-exit evidence without learning from it

- Choice: A failed or incomplete post-exit Kline checkpoint remains quality-labeled `STALE` or `UNAVAILABLE` and receives up to four exponentially delayed attempts. It cannot update the brain; only a `READY` 720-minute path can do so.
- Reason: A one-time Gate or Worker fault must not permanently discard the user's required 12-hour observation, while unlimited rapid retries would waste D1 writes and scheduler capacity.
- Evidence: The observation schema now records retry count and next retry time; the scheduler reads only due retryable nodes, and the per-order 100-row lifecycle reserve covers the bounded retry writes.
- Revisit when: Production failure telemetry shows four attempts are insufficient or a cheaper durable market-data archive becomes available.

## 2026-09-03 — Isolate the current round and queue paper-capital reset safely

- Choice: Current statistics and immediate Direct Market Brain risk use only the active simulation epoch and exact brain version. Older closed orders remain a collapsed archive and keep their charts, lineage, and 12-hour observations. A reset request blocks new simulated entries, waits for all existing positions to exit under their unchanged plan, then creates the next epoch automatically.
- Reason: Old strategy losses must not make the replacement brain appear to be losing or control its current risk, while a continuously active scanner must not make capital reset impossible or force-close positions.
- Evidence: The dashboard now exposes separate current/archive lists, the reset state is durable, the scanner checks it before entry, and the single Trade Manager is the only reset finalizer.
- Revisit when: The owner requests an explicit forced-close workflow; it is intentionally not inferred from a capital reset.

## 2026-09-03 — Do not shrink active simulation sizing by learning stage

- Choice: Supersede earned-risk staging for sizing. `CALIBRATING`, `VALIDATING`, `NORMAL`, `CAUTION`, and `DEFENSIVE` all use the normal 3.5% simulation risk. `PAUSED` remains zero and all independent-event drawdown, portfolio, market-quality, liquidity, volatility, liquidation, and hard risk limits remain active.
- Reason: The owner wants losses to change the entry/exit decision through complete review rather than silently producing tiny positions and weak learning evidence.
- Evidence: Focused tests assert constant active-state sizing and the unchanged hard pause.
- Revisit when: Comparable forward evidence supports a different normal rate or the owner explicitly restores stage-based exposure reduction.

## 2026-09-03 — Rejudge positions on completed evidence instead of holding mechanically

- Choice: New direct-brain orders carry an immutable `adaptive-position-v2` marker. Once per completed five-minute bucket, the position brain may `HOLD`, improve the stop through fee-aware `PROTECT`, or `EXIT` after multi-bar structural invalidation/time decay. It may never loosen the original stop or reverse inside the same order.
- Reason: A valid entry can become invalid before its original stop, while reacting to incomplete candles would manufacture hindsight and churn. Closing first and requiring a fresh ranked setup keeps reversal evidence-based.
- Evidence: Deterministic tests cover early invalidation, fee-aware protection, incomplete-evidence holding, and unchanged D1 checkpoint cadence.
- Revisit when: Complete 12-hour observations show a repeated exit error attributable to the position rule, not a single trade.

## 2026-09-03 — Let losses change admission before changing the learned model

- Choice: Current-epoch closed results immediately drive `NORMAL/CAUTION/DEFENSIVE/PAUSED` admission quality. A model rule changes only after complete 12-hour evidence: four independent weak events can quarantine the exact location/direction/regime signature, while eight weak independent events can raise the edge floor by one versioned variable.
- Reason: Waiting twelve hours to protect the account is too slow, but learning from unfinished future paths is unreliable. Admission protection and durable model learning therefore have separate evidence clocks.
- Evidence: The learning profile deduplicates independent event keys and snapshots its action, evidence count, reason, parent version, and revalidation status into every accepted order.
- Revisit when: Forward samples justify different minimum counts; do not lower them merely to make learning appear faster.

## 2026-09-03 — Compare fresh candidates as a cohort and cap directional concentration

- Choice: Preserve the top-fifteen light universe and six-symbol rotating deep pool, retain each fresh deep candidate with its candles in bounded Durable Object state, rank the cohort, and attempt the top three in order. Keep the global maximum at three positions and normally two per direction; never force a slot.
- Reason: Executing only the latest completed symbol could miss the strongest earlier candidate. Cohort execution makes cross-market selection real without adding a database write or a second simulator.
- Evidence: The worker fetches fresh quotes for the ranked finalists in one bounded call, then every candidate independently passes stale/zone/invalidation/economic, correlation, portfolio, risk, learning, and D1 gates.
- Revisit when: Production latency or forward evidence supports changing the six-symbol deep width; the fifteen-coin light universe and D1 zero-write boundary remain fixed unless explicitly redesigned.

## 2026-09-04 — Reduce new entries to three explicit setups

- Choice: Keep one Direct Market Brain and only admit volume-force failed breakouts, exhaustion reversals, or Dennis trend breakouts. Do not reconnect the retired multi-strategy router or create parallel simulators.
- Reason: The owner wants the system back to a small set of understandable, useful trading stories, with the original low-frequency profitable idea retained and code/product copy compressed.
- Evidence: Every candidate now stores one setup and score; deterministic tests cover selection plus low-liquidity/low-volume rejection, while the existing hard risk and exact live-parity gates remain in force.
- Revisit when: Complete independent 12-hour forward evidence from this exact brain version supports replacing—not stacking—one of the three setups.

## 2026-09-05 — Restore the original strategy bloodlines instead of tuning substitutes

- Choice: Replace the simplified Sep-4 formulas with direct, named adaptations of HT3-R Failed Auction, HT4 Exhaustion/Anti-Crowd, and the original Resonance direction layer combined with HT5-R timing. Keep one Direct Market Brain and three understandable setups.
- Reason: Production counters and outcomes showed that the replacement formulas did not behave like the strategies the owner had previously observed. In particular, a universal volume gate starved resonance, and a 24-hour move proxy allowed false exhaustion entries.
- Evidence: Behavioral tests now prove sweep/reclaim plus setup-local force for HT3-R, no exhaustion from 24-hour movement alone, and 4h/1h direction with mean-location/5m resume timing for resonance. Stable lineage constants make future accidental substitution fail architecture review.
- Revisit when: Comparable forward results from this exact V4 epoch show a specific rule—not a whole named strategy—is responsible for negative expectancy.

## 2026-09-05 — Separate immediate damage control from twelve-hour optimization

- Choice: Evaluate loss protection independently for each setup, direction, and asset regime. Three consecutive independent losses or a proven four-sample negative cell pauses only that cell immediately; after six or twelve hours it may take one high-confidence, high-edge revalidation order. Twelve-hour reports remain the optimization clock, not the stop-loss clock.
- Reason: Waiting for a report or twenty samples allowed a losing strategy variant to keep consuming capital, while global throttling would also suppress healthy strategies.
- Evidence: The execution boundary queries only current-version/current-epoch rows for the exact cell, deduplicates independent event keys, snapshots the guard reason, and tests pause, correlation deduplication, and revalidation.
- Revisit when: Forward evidence supports different thresholds; never pool correlated orders or unrelated strategies to manufacture the sample count.
