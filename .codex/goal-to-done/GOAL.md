当前最高优先修正：V13只使用最相似的5段互不重叠历史走势，并在顶部直接画出这5段的真实OHLC K线和实际后一小时；不再把归一化收盘路径冒充K线。将当前历史路径PAPER风险提高到单笔1%/组合3%，不再预先按六币均分；相关敞口仍折半。扣费后目标/完整风险门槛由1.2降至0.8以提高频率，保留新鲜报价、入场区、成本覆盖、2%保护、亏损暂停和实盘关闭。完成PR #158、CI真实12小时回放、部署、PAPER切换和线上页面/开单链验证。

最新用户修正：V9以历史相似总体方向直接开仓，取消额外回踩信号；重放期中逆向波动，比较立即入场和冻结等待价格，风险不加大，最长一小时。详见docs/ANALOG_PATH.md。此项替代本轮尚未推送的五分钟回踩方案。

当前最高优先目标：V9历史辅助五分钟入场、最长一小时持仓，保留明确历史方向门控，取消固定三仓/同风险簇全拒绝，按本金和组合风险分配。顶部展开预测图，修复429/数据延迟，沿原GitHub/Cloudflare上线并给用户实际规则。详见docs/ANALOG_PATH.md。此目标取代下方旧V8一分钟/15分钟方案。

当前补充目标：为已上线V8短线模拟重做中文页面，优先权益/决定/持仓保护，折叠统计和历史辅助；沿原授权CI部署，不改交易后台或额度。

当前目标：按用户已授权方案发布 V8 顺势回踩短线模拟策略，复用原 GitHub/Cloudflare 路径；验证全天资源预算、故障恢复和版本切换。历史相似度降为辅助。不得宣称绝对不中断或未验证盈利。

# Current UI objective

Remove the obsolete multi-strategy heading; inspect and repair Brain, Orders and Management display issues, preserve capabilities, then release through existing authorized CI/Cloudflare path.

# Goal

## Current goal — long-term historical archive and fixed small universe

- Continuously retrieve earlier available K-lines at a controlled pace, retain them across upgrades, reuse them locally for historical forecasting, and limit scanning to six stable coins. Expose real progress, enforce request/write/storage budgets and preserve current account/risk/CI/Cloudflare paths. Do not wait for all history to finish before valid predictions can trade.

## Current bounded correction — distinguish data from insufficient matches

- Explain the observed zero-entry state from actual production data, repair incomplete historical caching, and simplify empty statistics and12h summaries. Preserve evidence and risk gates; reuse authorized CI/deploy without a new paper epoch.

## Current implementation — historical analog prediction

- User replaces the three-strategy proposal with one immediately usable historical K-line analog strategy: shape, amplitude, volatility, slope, time/day/weekend and recorded events. Use two hours of closed 5m candles, fourteen days of same-symbol history and a one-hour forecast as the initial bounded specification.
- Reuse existing PAPER/account/protection/D1/CI/Cloudflare infrastructure and prior release authorization. Remove the artificial three-symbol admission wait. Preserve fee-aware accounting and major PAPER archive; new unvalidated analog decisions remain in simulation.
- Deliver running code with honest historical outcome distributions, date evidence, sparse-data reasons and frequency/latency limitations; do not guarantee trades or profits. This supersedes the three-strategy design draft.

## Current goal — redesign before another trading rewrite

- Owner asks to rethink the entire product after repeated low-frequency and loss complaints. Deliver a concrete Chinese design first; this task does not activate new trading rules.
- Follow `docs/RESONANCE_REDESIGN.md`: shared replay/online rules, three explicitly unvalidated strategy candidates, measured frequency/net results, simple Chinese UI, preserved history and safety.
- Owner corrected the delivery scope: reuse existing authenticated GitHub/CI/Cloudflare deployment, target a compact three-strategy Chinese PAPER first release within a one-hour engineering budget, and separate extended replay/soak work. Keep necessary engineering, protection and release gates; no unconditional deployment-time or profit guarantee.

## Current bounded correction — explain zero primary observations

- Audit the screenshot's 94 evaluations / one qualified failed-breakout signal / zero primary observations against current production selection and activity counters.
- Correct the misleading primary-candidate label: it counts triggered priority observations even while they remain unqualified. Preserve existing historical counts; do not fabricate a new strict funnel from incomplete history.
- Retain the latest qualified same-symbol comparison in the existing Scanner activity snapshot and show a losing strategy's actual preferred competitor going forward. Explicitly acknowledge that old counters did not retain that event.
- Do not alter strategy triggers, ranking, risk, paper/live positions, epoch, scan cadence or D1 writes. Use the existing authorized CI/deploy path after regression verification.

## Current optimization — remove fixed scan and paper position-count restrictions

- User requests removal of the 15-symbol / 6-deep restriction and three-position bottleneck. Evaluate the full existing configured universe (default 30, settings ceiling 50); use existing Scanner snapshots to select the least recently evaluated symbol, without more per-slice market requests or recurring D1 writes.
- Remove fixed total/same-direction PAPER counts; preserve 15% aggregate planned stop risk, 3.5% accepted per-trade risk, single-symbol ownership, correlation, margin, learning and data safeguards. Typically four normal-risk positions fit; do not represent this as unlimited financial exposure or a full-market real-time scan.
- Reserve D1 writes for prospective holdings and the day's peak reconstructed from existing immutable snapshots. Prepare major paper release V6 / additive 0024 cutover, keep Gate/live authority unchanged, verify before release. No further three-strategy formula change.

## Completed release — V5 production verified

- User authorized immediate GitHub/CI/Cloudflare production release on 2026-09-05 after the local V5 verification. Publish only the already verified scope, using one feature PR and green CI before merge.
- Verify the immutable V5 client asset, bounded production scheduler health, and completed PAPER cutover with zero legacy open paper positions. No fund movement, live reset or additional strategy tuning is authorized.
- Completed through PR `#136`, production commit `8badc27b`, successful workflow `33942706243`; migration `0023` completed with V5 active, no pending target and zero legacy open paper positions.

## Current authorized optimization — entry integrity and Chinese operator UI

- Keep the prepared compact daily UI and translate visible positions, states, metrics, chart labels and operator controls into Chinese without changing stored IDs, symbols or credentials.
- Correct the demonstrated HT5-R-derived resonance admission gaps: reuse scanner-owned market breadth/benchmark and the existing asset regime classifier; reject strongly opposing tactical trends and require completed-candle recovery of nearby price structure.
- Keep stops beyond actual swing invalidation; reject plans outside the historical 5% structural-distance ceiling instead of clamping stops to 3%. Keep sizing, total-risk and live safety authorities unchanged.
- Attribute all three setups to the actual existing regime classification instead of hardcoded regimes so loss isolation does not merge different environments. Retain the historical reversal pattern conditions and existing data/macro safety boundaries.
- Declare a new major paper release through the established additive cutover mechanism; do not modify or fund real positions. Run focused tests then one complete local verification pass.

## Current bounded task — compact decision display and strategy identity audit

- Remove the raw score/probability/location/empty-level hero from the daily Brain page. Keep a plain-language operating summary and move the existing complete diagnostic card to collapsed Management diagnostics.
- Compare the three V4 setups against retained historical sources and reproduce relevant admission differences on identical inputs. Distinguish code evidence from unverified production-order attribution.
- Do not tune strategies, modify positions, reset capital, add polling, or deploy in this task. Preserve the existing order review and owner/live safety capabilities.
- Verify the UI change locally, record exact evidence and access blockers, and leave a bounded next action rather than starting another system rewrite.

## Completed objective — V4 restored three-strategy core

- Replace the September 4 simplified same-name setup rules with traceable adaptations of the original HT3-R failed-auction, HT4 anti-crowding exhaustion, and original Resonance direction plus HT5-R higher-timeframe entry behavior.
- Keep one Direct Market Brain and exactly three new-order setups. Evaluate all three on every deep scan, separate raw trigger from setup qualification, remove performance-paused cells before ranking, and never create a second router or simulator.
- Restore setup-specific market fit, confirmation, targets, and holding horizons so trend exhaustion cannot repeatedly fade a still-expanding move and the two starved setups can trigger at their original decision stages.
- Add immediate per-setup/direction/regime performance protection using independent events, while retaining account-wide risk and complete 12-hour learning as separate boundaries.
- Expose actual average win/loss R and realized payoff in the compact contribution cards; preserve the three-tab operator surface and every existing owner/live safety capability.
- Treat V4 as a major paper release: block new entries, archive all V3 paper positions at fresh quotes with full review lineage, start a clean 1,000U epoch, and leave Gate/live positions, funds, credentials, and owner authority untouched.
- Add behavioral identity tests and a source fingerprint so a future release cannot call a rewritten setup “restored” without changing its declared version. Complete through focused/full verification, one PR, green CI, deployment, cutover proof, and production health checks.

## Completed patch objective — truthful per-setup activity

- Count every one of the three core setups on every deep scan instead of attributing the scan only to the selected setup.
- Separate setup trigger, full hard-gate qualification, primary selection, entry blocking, and actual opening so signal frequency is comparable and understandable.
- Never label a partial startup window as a completed 12-hour review; expose measured scanner coverage and publish a completed summary only after a continuously covered full window.
- Change no setup threshold, paper/live position, risk rule, D1 write cadence, or Gate authority; release through focused/full tests, one PR, green CI, and production verification.

## Completed objective — core-three resonance dashboard

- Replace the Dennis breakout setup for new orders with the original multi-timeframe comprehensive resonance idea: completed 5-minute confirmation, 15m/1h/4h alignment, spot/volume confirmation, structural targets, and anti-chase protection.
- Keep volume-force failed breakout and exhaustion reversal, and make the three setup stories mutually exclusive under the existing Direct Market Brain authority and hard risk/live-parity boundaries.
- Restore current-version per-setup performance truth: activity, qualified signals, orders, wins/losses, win rate, net PnL, average R, profit factor, drawdown, losing streak, and contribution state.
- Produce deterministic 12-hour operating reviews from the existing Scanner Durable Object state plus current-version paper trades; add no LLM runtime, foreground exchange producer, or recurring D1 write path.
- Replace the abstract Opportunity/Radar surface with three operator destinations: Brain, Orders, and Management. Keep paper reset, complete trade review, Gate credentials/control/reconciliation/Emergency Stop, account, push, audit, and diagnostics reachable through their existing authority paths.
- Treat this as a major paper-only release: one additive migration requests the automatic fresh-quote archive of old paper positions and a clean epoch; Gate/live remains untouched.
- Complete through one branch, focused tests, one full verification suite, one PR, green CI, deployment, D1 cutover proof, and production health verification.

## Active patch objective — automatic major-version cutover

- Bind every Direct Market Brain major version to one explicit release manifest and additive migration.
- Before the new version can open paper orders, block entry, close every pre-release paper position at a fresh Gate quote with `version_reset`, retain its immutable lineage and complete 12-hour observation trail, then start a clean simulation epoch.
- Keep owner-requested resets natural, and never close, resize, fund, activate, or otherwise mutate Gate/live positions through this paper cutover.
- Make future upgrades small and predictable through one stable upgrade map, one CI guard, focused tests, and a single PR/deploy/production-verification loop.

## Active patch objective — return to three useful setups

- Keep the Direct Market Brain as the sole new-order authority, but admit candidates only through three explicit setups: `VOLUME_FORCE_FAILED_BREAKOUT`, `EXHAUSTION_REVERSAL`, and the original low-frequency `DENNIS_TREND_BREAKOUT` baseline.
- Require setup-specific completed-candle, price/volume force, location, liquidity, funding, macro, volatility, structural edge, and anti-chase evidence. A position slot remains a ceiling, never a quota.
- Make the selected setup and score visible in the existing compact daily UI; remove upgrade-centric copy without removing owner controls, diagnostics, review, reset, account, push, or live safety capabilities.
- Preserve current positions, immutable risk plans, paper/live decision lineage, 12-hour observations, historical strategy identities, D1 limits, and the no-fund/no-live-authority boundary.
- Finish inside one bounded release loop: focused tests, full tests, lint/type/build/dry-run, branch/PR, green CI, merge, and production health verification.

## Active patch objective — clean adaptive-brain restart

- Stop new paper entries during the release, archive every pre-upgrade open paper position at a fresh exchange quote, retain its immutable lineage and seven-node 12-hour observation trail, then create a new simulation epoch at the configured starting capital.
- Keep the ordinary owner reset non-forcing, leave Gate/live funds and execution untouched, add no recurring D1 writes, and verify the production schedulers and fresh current-round account after deployment.

## Active objective — adaptive direct-market decision and position brain

- Keep the Direct Market Brain as the only new-order authority, but replace mechanical fixed-entry/hold behavior with a replayable decision loop that judges current location, direction, target path, invalidation, and whether to wait.
- Build cross-market selection from one time-consistent top-fifteen snapshot, deep-rank the strongest independent opportunities, and allow at most three open positions without forcing slot usage; normally no more than two positions may share one direction.
- Revalidate every candidate against a fresh quote immediately before paper entry. Cancel stale, out-of-zone, invalidated, or no-longer-economic entries rather than using an old candidate price.
- Reassess every open paper position on completed five-minute evidence. Preserve the original immutable thesis while emitting explainable `HOLD`, `PROTECT`, `EXIT`, or post-exit `REASSESS` decisions. Never reverse merely because a position is losing; close first and require a new independently qualified decision after cooldown.
- Make TP1 protection fee-aware, and let structure/volatility govern protection, target continuation, and timeout decisions without loosening the original hard stop.
- Separate immediate closed-trade protection from the complete 12-hour learning path. Immediate losses may tighten admission or pause new entries; only valid complete post-exit evidence may produce a one-variable, versioned, rollback-safe decision revision.
- Preserve 3.5% planned risk for every accepted non-paused simulation trade, the 15% portfolio cap, owner-only funding/live authority, exact paper-to-live lineage, all historical records, and the pending-reset lifecycle.
- Add no periodic D1 writes. Keep scanner and reassessment state in Durable Object memory/storage, retain the existing index-adjusted budget gates, and verify the production health/read paths after release.
- Release once through branch, PR, green CI, merge, deployment, and advancing production scheduler checks. Existing open positions keep their immutable original stop/target plan; adaptive management applies only when enough fresh evidence is available and may only reduce risk through protection or an explained early exit.

## Active patch objective — current round, safe reset, normal simulation sizing

- Scope current account statistics and Direct Market Brain risk evidence to the active simulation epoch and current brain version; keep older closed orders in a collapsed read-only archive.
- Accept an owner reset while positions are open, block replacement entries, let every position follow its existing stop/target/timeout lifecycle, then create the new 1,000U epoch automatically and resume scanning.
- Keep simulation risk at the normal 3.5% per trade from the first active sample instead of shrinking it by learning stage. Preserve the hard PAUSED stop and all portfolio, liquidity, volatility, quality, liquidation-distance, 5% per-trade, 15% total-risk, and three-position caps.
- Add no periodic D1 writes. Preserve every historical trade, chart, 12-hour observation, learning row, credential, live order, and owner-only live/funding control.
- Release through PR/CI and verify the production asset, reset state, scheduler health, and bounded `/api/hte31` behavior.

## Active prepared objective — Direct Market Brain (supersedes named-strategy authority)

- Replace HT1–HT9/family/variant selection for **new orders** with one deterministic, replayable brain that directly judges location, direction, structural targets, invalidation, expected value, and whether to wait.
- Build each rolling decision batch from the fifteen eligible Gate USDT perpetuals with the highest confirmed 24-hour USDT quote volume. Light-scan all fifteen, deep-scan six across multiple correlation clusters, and select at most three qualified portfolio-safe opportunities; never fill slots merely to stay invested.
- Keep at most three total positions, one per symbol and normally no more than two in the same direction. Existing positions above the new limit are never force-closed; block new entries until the count returns to three or fewer.
- Preserve every old strategy ID, trade, review, learning row, and live lineage as read-only history, but do not let old strategies vote, provide fallbacks, emit candidates, or control new-order eligibility.
- Give every closed order a real `0/30/60/120/240/480/720`-minute post-exit observation. Only a complete, valid 12-hour path may change a versioned brain rule; one revision changes one explainable variable and remains rollback-safe.
- Keep simulation as the only learning and selection environment. Gate live may only inherit an actual simulated order's immutable decision snapshot; never move funds, infer funding approval, or independently redesign the trade.
- Preserve five bottom tabs and all Must-Keep safety/owner capabilities while replacing strategy-centric daily UI with current fifteen-coin market judgment, brain decision, positions, orders, review, and live parity.
- Treat correlated, overlapping orders from one market move as one independent performance event. Separate immediate drawdown protection from 12-hour-complete model learning, and graduate the unproven brain through calibration, validation, and normal-risk stages.
- Stop all periodic scanner/evaluation/diagnostic D1 writes. Count table and index amplification, keep this application's index-adjusted hard budget at or below 30,000/day, stop new-order admission at 22,000 including committed lifecycle rows, and require account-wide production metrics below the 65,000 safety line under Cloudflare Free's 100,000/day allowance.
- Implement, test, migrate, release, verify, and retain rollback evidence using `docs/DIRECT_MARKET_BRAIN_UPGRADE_PLAN.md`.

Previous sections below remain production-history and compatibility requirements; they do not restore named strategies as the authority for new orders.

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

## Current completion objective — Strategy family and lifecycle brain

- Treat all thirteen strategies equally. HT4's prior profitable period remains historical evidence only; remove its freeze, permanent protection, and any special treatment in the next implementation.
- Organize the thirteen legacy strategy IDs into canonical families and variants, preserving all old IDs, trades, learning, reviews, and Gate lineage.
- Audit behavioral overlap before retiring a duplicate; a family may emit at most one executable candidate for a symbol/cycle.
- Give every strategy an explainable health state covering learning, active, underperforming, degraded, starved, regime-wait, retest, and paused behavior.
- Turn the existing post-exit observation and counterfactual evidence into a final verdict: valid trade, no-trade, wrong direction, entry timing, exit timing, risk-plan mismatch, or insufficient evidence.
- Diagnose repeated losses, long non-use, and historical-to-recent performance decay before changing entry rules or reducing strategy usage.
- Preserve the existing paper/live parity, five-position and 20% total-risk limits, adaptive leverage/margin safety, owner-only funding decision, and D1 recurring-write ceiling.
- Use `docs/STRATEGY_BRAIN_LIFECYCLE_PLAN.md` as the implementation and acceptance checklist.

## Prepared next objective — Strategy Center and historical memory

- Move the complete nine-family/thirteen-variant cards into a dedicated in-app Strategy Center without adding a sixth bottom tab.
- Use one canonical family/variant and translated-regime label across paper orders, current positions, Radar, review, learning, live orders, and owner diagnostics; preserve legacy IDs only as stored lineage.
- Remove upgrade-history, implementation, and duplicated explanatory copy from the daily operator UI; show only current truth, decisions, risk, and actions.
- Treat persistent three-horizon `0/8` as a data-validity fault, not as genuine evidence or runtime accumulation.
- Validate and isolate historical-candle sources, retain a bounded labeled last-known-good result, and keep the eight-independent-sample gate.
- Hide detailed historical-memory cards until useful; unavailable or warming data must contribute zero decision weight.
- Add no new polling, foreground market producer, D1 recurring write, migration, risk change, live authority, fund action, or Durable Object generation reset.
- Keep `/api/hte31` latency bounded and source-isolated so a slow Durable Object/D1/diagnostic read returns partial HTTP 200 with a timestamped last trustworthy snapshot instead of blanking the iOS/PWA UI with 503.
- Move full family diagnostics to the on-demand Strategy Center path and make `/__health` a fast read-only probe.
- Use `docs/STRATEGY_CENTER_HISTORY_MEMORY_PLAN.md` as the implementation and release checklist.
