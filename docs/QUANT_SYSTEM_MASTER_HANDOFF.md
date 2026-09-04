# Market Sentinel / Resonance — Quant System Master Handoff

> **2026-09-04 activity correction prepared:** branch `fix/true-strategy-activity` fixes the v3 dashboard's winner-only setup attribution and partial-window completion. All three setups now receive one evaluation per deep scan, with trigger/qualification/selection/block/open counters kept separate, and a 12-hour review completes only with full measured Scanner coverage. The change reuses the existing Durable Object save and changes no setup, risk, D1, position, live, or funding authority. Treat this paragraph as release-candidate truth until CI and production API proof are recorded.

> **2026-09-04 current production:** PR `#129` deployed `direct-market-brain-v3-resonance-three`, replaced Dennis with multi-timeframe comprehensive resonance, restored per-setup contribution statistics and deterministic 12-hour operating review, and reduced the operator surface to `大脑 / 订单 / 管理`. It reuses the existing Scanner Durable Object save, adds no recurring D1 write, preserves every Must-Keep capability, and uses additive cutover migration `0021`. Workflow `33865500814` passed full verification, migration, deployment, immutable-asset and health checks; production D1 proved `status=completed`, no pending target, and zero legacy open paper positions. Worker version: `a998bdd9-1833-4535-9efd-22d4e82defc4`.

> **2026-09-04 current correction:** production `main` `6c6b18c` keeps Direct Market Brain as the only new-order authority with three setups and makes every major brain version automatically block new paper entries, archive pre-cutover/old-version paper positions at fresh quotes, and start a clean epoch; Gate/live remains untouched. Final workflow `33858569353` proved `legacy_open_positions=0` and active version `direct-market-brain-v2-core-three`. Use `docs/QUANT_UPGRADE_PATH.md` for the bounded upgrade route.

Last reconciled: **2026-09-04 — current main `0736a225` includes PR #129; resonance-three production proof complete**
Purpose: **the complete continuation entry after deleting all prior chats**

## 0. Start every new task here

Use this exact starter prompt in a new Project chat:

> Continue the Market Sentinel quantitative system. First read `docs/QUANT_SYSTEM_MASTER_HANDOFF.md`, `AGENTS.md`, `.codex/goal-to-done/GOAL.md`, `STATUS.md`, `DECISIONS.md`, `docs/CURRENT_SYSTEM_STATE.md`, `docs/SENTINEL_CHANGELOG.md`, `docs/RESONANCE_MUST_KEEP_FEATURES.md`, `docs/DIRECT_MARKET_BRAIN_UPGRADE_PLAN.md`, and `docs/DIRECT_MARKET_BRAIN_EXECUTION_PACK.md` completely. Then inspect current GitHub `main`, recent merged PRs, CI, and production health. Repository and verified production state override chat memory. Implement the prepared Direct Market Brain as the only new-order authority: dynamically light-scan the fifteen highest-volume eligible Gate USDT perpetuals, deep-scan six across correlation clusters, select at most three qualified portfolio-safe positions, complete a real 12-hour post-exit observation before learning, preserve old strategy data only as history, maintain exact paper-to-live decision lineage, preserve every Must-Keep feature, and work through a branch/PR/green-CI/production-verification loop. Enforce the index-adjusted D1 30,000 app budget, 22,000 new-order admission line, and 65,000 account safety line. Never move funds or infer funding approval.

Do not reconstruct the system from a chat summary. The authoritative order is:

1. Current GitHub `main` and its tests.
2. Verified production state.
3. This handoff and the current-state/changelog documents.
4. Old chats, screenshots, migration packs, and historical branches.

If any lower source conflicts with a higher source, the higher source wins.

## 1. Project identity and current production

| Item | Current truth |
| --- | --- |
| Repository | `alicia5574188-del/market-sentinel-free` |
| Production Worker | `https://market-sentinel-free.alicia5574188.workers.dev` |
| Production strategy identity | Market Sentinel HTE 3.1 Clean / Resonance V5 strategy-family lifecycle |
| Durable Object generation | `resonance-v4-unified-paper-live-parity` (intentionally unchanged) |
| Dashboard API identity | `resonance-v5-strategy-lifecycle` |
| Latest deployed feature PR | `#109` |
| Feature commit | `e31d7521374bab75894f2da67904de51d2a78653` |
| Production merge commit | `a92a516dd12f960a961814343dc88c9fa33632cf` |
| Final PR CI | Run `33716373058`, job `100526308099`, passed |
| Merged-main CI | Run `33716448405`, job `100526529930`, passed |
| Production proof | Asset `assets/page-BF9gQ5KC.js` served nine-family lifecycle UI; two healthy advancing scheduler probes |

The older remote branch `feat/resonance-strategy-research` contains an earlier divergent experiment and is not production. PR #103 used `feat/resonance-strategy-research-v2`; current `main` is authoritative.

Current repository main is `64166992319e7036fbac7cbe07fd7140aa7c5441` (PR #111, resilient Strategy Center). The older PR #109 rows above remain the last independently recorded production commit/CI proof in this handoff; verify the current Worker version before claiming an exact production SHA.

At the final production probe:

- `ok: true`, mode `cloudflare-free`.
- Position Monitor state `live`; its successful timestamp advanced between probes; `lastError: null`.
- Market Scanner state `live`; its successful timestamp advanced between probes; `lastError: null`; `circuitOpen: false`.
- `schedulerError: null`.
- Immutable client asset `assets/page-BF9gQ5KC.js` contained `9 个策略家族由大脑择优` and `SF09`.
- Cloudflare internal Build ID and Version ID were not exposed by the available surface. They must be queried from Cloudflare in a future authenticated session if needed; never infer them.

## Prepared successor — Direct Market Brain

`docs/DIRECT_MARKET_BRAIN_UPGRADE_PLAN.md` is the frozen next implementation and release contract. It supersedes the strategy-family architecture **for new orders only** after a verified deployment:

- one deterministic, replayable brain judges current location, direction, structural target, invalidation, net expectancy, and `WAIT` directly;
- each rolling batch light-scans the fifteen eligible Gate USDT perpetuals with the highest confirmed 24-hour quote volume, deep-scans six across correlation clusters, and selects at most three qualified portfolio-safe positions; three is a ceiling, never a quota;
- one position per symbol, normally at most two in one direction, with correlation-aware portfolio risk; existing positions above three are protected rather than force-closed;
- HT1–HT9/family/variant fields remain immutable history for old orders but cannot vote, emit candidates, provide fallbacks, or control new-order eligibility;
- every close receives real `0/30/60/120/240/480/720`-minute observation, and only complete valid 12-hour evidence can modify a versioned rule;
- simulation remains the only learning/selection environment and Gate only inherits an actual simulated decision snapshot; no fund movement or owner-approval inference;
- correlated overlapping orders from one market move count as one independent performance event; immediate account protection is separate from 12-hour-complete model learning, and the new brain must earn higher risk through calibration and validation;
- the daily UI becomes fifteen-coin market judgment, decision, orders, review, and parity rather than a strategy catalog, while all five tabs and Must-Keep controls remain;
- the old 27,360 logical-row budget is invalid because it omitted index writes; its conservative billed-row upper bound is 105,120/day;
- all scanner/diagnostic D1 writes become zero, the app receives a 30,000 index-adjusted hard budget, new-order admission stops at 22,000 including committed lifecycle rows, and deployment must prove account-wide usage below 65,000/day.

Preparation branch: `prep/direct-market-brain`, based on current main. `lib/direct-market-d1-budget.ts` plus its passing unit test and `docs/DIRECT_MARKET_BRAIN_EXECUTION_PACK.md` are prebuilt but not connected to production. Runtime behavior remains unchanged until the full implementation, tests, CI, deploy, and production verification all pass.

## 2. The current authority model

There is one strategy lineage and two account contexts:

1. **Unified paper brain:** all thirteen strategies compete in one capital-backed simulation account. The brain selects the exact executable candidate; actual orders and closes feed learning.
2. **Gate live parity:** every catalog strategy may reach Gate only through an actual selected paper trade, reusing that trade's strategy, learned checks, stop, targets, and leverage. Real account/exchange facts and hard safety are reapplied without redesigning the strategy.

Historical shadow tables remain read-only compatibility data. Do not create or advance shadow trades and do not rebuild a second simulation layer.

The retired Strategy 2.0 / P1–P12 engine remains historical and isolated. Some older sections and files still describe it for audit compatibility. It is not the current production decision authority and must not be reconnected by copying historical code.

## 3. Strategy inventory

### Unified paper/live catalog — original strategies

| Code | Internal ID | Setup | Authority |
| --- | --- | --- | --- |
| HT1 | `dennis_trend` | Dennis trend breakout | Paper brain + live parity |
| HT2 | `raschke_pullback` | Raschke trend pullback | Paper brain + live parity |
| HT3 | `turtle_soup` | Turtle Soup false breakout | Paper brain + live parity |
| HT4 | `exhaustion_reversal` | Anti-crowding exhaustion reversal | Paper brain + live parity; ordinary lifecycle rules |
| HT5 | `higher_timeframe_swing` | Higher-timeframe structure | Paper brain + live parity |

HT4 production rule after PR #109:

- The old source fingerprint `05adae71b2c1169c441e409d831ceb5acbec1390f5b051a5cb18f7a7af8389a3` is historical evidence from the previous production policy, not an active protection.
- HT4 receives no priority, exemption, permanent score, or special tuning protection. Its prior profitable period is historical evidence only.
- Equal-treatment and router regression tests prevent HT4-specific ranking branches while existing HT4 positions keep their original lifecycle.

### Unified paper/live catalog — additional strategies

| Code | Internal ID | Setup story | Family |
| --- | --- | --- | --- |
| HT1-R | `dennis_trend_v2` | Accepted breakout and retest | Trend |
| HT2-R | `raschke_pullback_v2` | Adaptive deep/shallow pullback recovery | Trend |
| HT3-R | `turtle_soup_v2` | Force-aware failed auction | Reversal |
| HT5-R | `higher_timeframe_swing_v2` | Regime-aware swing context | Trend |
| HT6 | `range_rotation` | Range-edge rotation | Range |
| HT7 | `compression_expansion` | Compression followed by real expansion | Volatility |
| HT8 | `relative_strength` | Cross-sectional relative strength | Relative strength |
| HT9 | `momentum_continuation` | Impulse, shallow pause, renewed continuation | Trend |

HT3-R explicitly evaluates breakout volume/range, reclaim depth, reverse impulse and force ratio, spot/order-book/liquidation evidence, and higher-timeframe opposition. It must not label every return to a prior range as a false breakout.

Every signal carries `executionLane: "paper"`. The same catalog IDs are accepted by the live-parity boundary. The historical `research` names are descriptive only and grant no separate lane.

## 4. Capital-backed evidence and strategy router

All router performance evidence comes from actual closed HTE31 paper orders under the current policy. Historical shadow rows may be displayed for audit only and must not affect current selection.

Execution rules:

- The brain may rank all complete current setups, but opens only its exact selected candidate.
- If that candidate fails its final learned/performance/execution gate, the cycle opens nothing; it does not silently substitute a lower-ranked strategy.
- Same-side stories remain separately attributed while the router can report cooperation.
- Opposite stories remain separate. A conflict opens only when the leading side is ahead by the explicit score margin; otherwise it waits.
- Thesis invalidation never auto-closes and reverses. The current position exits by its own lifecycle, then a future cycle decides again.

Router modes:

- `WAIT`: no qualified current story.
- `SINGLE`: one leading story.
- `COOPERATE`: multiple same-side stories; still only one possible executable exposure in the control lane.
- `CONFLICT`: opposing stories; no averaging or automatic hedge.
- `SWITCH_WATCH`: current thesis may be invalidated and a replacement is being observed; no automatic close-and-reverse.

Evidence policy:

- Below 8 valid samples: performance contributes zero routing weight.
- At 30 actual closed orders, PF 1.30, expectancy +0.15R, and drawdown at most 6R, evidence is considered mature for ranking/reporting. These thresholds do not create a new execution lane or automatic fund approval.

## 5. Paper account, sizing, and lifecycle

The configured starting simulation capital is **1,000 USDT**. Resetting paper capital starts a new accounting epoch only; it preserves historical trades, per-trade review, and learned evidence, and is blocked while a paper position is open.

New paper sizing policy:

- Minimum fee-inclusive stop risk: 3% of equity.
- Normal target risk: 4% of equity.
- Maximum risk: 5% of equity.
- At 1,000 USDT, the intended band is 30–50 USDT and the normal target is about 40 USDT.
- Minimum economically acceptable TP2 net value: 50 USDT at the 1,000-USDT paper baseline.
- Market structure owns TP2. The system does not pull every target toward a fixed dollar number and does not cap strong runners at 200 USDT.
- Maximum market-defined reward/risk accepted by the sizing layer: 20R.
- Adaptive isolated paper leverage may reach 50x, subject to liquidity, volatility, data quality, and liquidation-buffer caps.
- Normal isolated-margin target: 8% of equity.
- Narrow-stop collateral fallback hard ceiling: 35% of equity after the safe leverage cap is reached.
- Higher leverage reduces locked margin; it must not increase the structural-stop loss budget.
- Fees are included inside planned 1R.

The paper account allows at most five open positions, at most three in the same direction, and no more than 20% of current equity in aggregate planned stop risk. A symbol still has at most one open position.

Lifecycle capabilities that must remain:

- Structural initial stop and TP1/TP2 plan.
- TP1 protection/breakeven behavior.
- Timeout and post-exit observation.
- Original stop and leverage retained after close.
- Planned loss, margin, notional, projected TP2 net, fees, realized R, MFE/MAE, and review visibility.
- Existing positions continue through deployments and are never rewritten by strategy research.

## 6. Entry Quality and learning already deployed

PR #101 added a deterministic Entry Quality report for each eligible HTE31 trade:

- Entry Efficiency.
- MAE before first +0.5R.
- Time to +0.5R and +1R.
- Counterfactual entries delayed by 1/2/3 completed 5-minute candles.
- Diagnosis: direction wrong, entry too early, entry too late, normal noise, stop too tight, or insufficient data.

`require_retest` can activate only within the exact setup + asset-regime cell after at least 3 assessed trades, at least 2 early-entry diagnoses, and at least 60% agreement. When the brain selects that learned version, its check remains in the direct paper-to-live lineage.

Historical analog memory requires 8 independent episodes. Below that floor the UI must say `样本不足 · n/8` and `暂不参与判断`; it must never display a fabricated `分歧 0%`.

The HTE31 foreground dashboard:

- Uses a read-only viewer boundary rather than durable account persistence for every refresh.
- Caches auxiliary diagnostics for 60 seconds with a five-minute stale fallback.
- Polls the main dashboard every 30 seconds.
- Preserves the last trustworthy snapshot and shows a refresh-delay notice on transient 503/non-JSON failure.

## 7. Gate live trading boundaries

Gate live accepts the same thirteen strategy IDs, but only through an actual unified-paper trade selected by the brain. The user explicitly retains funding authority and will not transfer funds until actual simulation growth is positive. Never move funds, infer approval, or replace the owner's decision.

Current HTE31 live parity and safety policy:

- Normal target stop risk: 4% of current Gate equity, never inflated above a smaller candidate's risk.
- Maximum risk policy value: 5%.
- Minimum TP2 net after fees and allowed slippage: 5% of current Gate equity.
- Maximum Gate margin allocation per position: 35% of current Gate equity, further limited by actual available isolated margin and a 10% buffer.
- Maximum open live positions for the HTE31 path: 5.
- A fourth same-direction live position is blocked once three same-side positions already exist.
- A live candidate expires after 120 seconds and cannot predate the current enable session.
- Entry drift beyond 0.3% or outside the expanded entry zone fails closed.
- Contract status, leverage limit, price tick, minimum/maximum contract size, taker fee, and market-order slippage are checked before submission.

Live performance gates:

- Two consecutive attributed live losses trigger a six-hour cooldown for new entries; existing positions remain protected.
- A 10% drawdown in Market Sentinel's own transfer-neutral live strategy equity curve blocks new entries.
- Three consecutive simulation losses pause live entry without stopping simulation learning.
- The last eight simulation results are used for expectancy/profit-factor checks; at least six samples are required for the low-win-rate gate.
- An unresolved recently closed Gate order with missing realized PnL fails closed until reconciliation.
- Daily realized-loss, directional exposure, deployment recovery, reconciliation, reduce-only protection, and Emergency Stop remain independent hard boundaries.

Do not change the selected paper strategy's learned rules, stop, targets, or leverage merely because live funding begins. Balance-based notional, fee/slippage, exchange contract limits, and hard safety remain live preflight facts.

## 8. Background runtime and data flow

Production decision/read flow:

`Gate public market data → HTE31 Market Scanner Durable Object → thirteen-strategy evaluation → unified brain selection → paper execution → actual-order learning/read model → /api/hte31 → owner UI`

Live flow:

`eligible fresh brain-selected paper lineage → live performance/portfolio/risk checks → Gate account/contract preflight → LiveTradingCoordinator → Gate order + protective orders → reconciliation/audit`

Runtime cadence:

- Market Scanner: 60-second cycle.
- Position Manager: 15 seconds while positions are active, 60 seconds while idle.
- Active heartbeat: 60 seconds; idle heartbeat: 5 minutes.
- Durable Object generation changes reset scheduler/checkpoint state only. D1 trades, learning, simulation epochs, live credentials, and live-order lineage remain untouched.

D1 daily-write budget:

- Cloudflare Free's 100,000 daily `rows_written` allowance is a hard operating constraint for this system and must be reviewed on every upgrade.
- Active paper positions are still inspected every 15 seconds. Unchanged holding telemetry is persisted once per 60 seconds; TP1 protection, stop, TP2, timeout, close, learning, and recovery events persist immediately.
- At thirteen one-minute strategy evaluations and five continuously open positions, planned recurring writes are 27,360 rows/day: 18,720 evaluation rows, 1,440 diagnostic rows, and 7,200 position checkpoints.
- Planned recurring writes must stay at or below 60,000 rows/day, preserving at least 40,000 rows below the free-plan limit for event-driven lifecycle writes and operational variance. Any future write path must update the regression-tested budget before merge.

The foreground page is a consumer, not a second Gate market-data producer. Do not restore heavy foreground Gate analysis or unbounded polling. Public Gate fan-out and symbol work remain bounded, and stale/degraded data must be labeled rather than fabricated.

## 9. Database and persistence

This change requires no destructive migration. Existing SQLite text columns already store all catalog IDs. Historical research/shadow tables remain intact and read-only; no historical table, Durable Object class, trade, learning row, epoch, credential, or live order is deleted or reset.

Preserve:

- HTE31 paper trades and simulation epochs.
- Entry Quality and counterfactual reports.
- Trigger buckets and historical shadow samples (read-only compatibility; never resume writes).
- Strategy memory and per-trade reviews.
- Account, owner access, Web Push, audit, settings, and scanner diagnostics.
- Gate credential record, live control intent, live orders, order lineage, and reconciliation audit.

Never run a destructive reset to “clean up” strategy data. Paper-capital reset is the only user-facing reset and creates a new accounting epoch while keeping learning/history.

## 10. Operator UI and Must-Keep contract

The mobile/PWA operator surface uses exactly five fixed bottom tabs:

1. `机会`
2. `雷达`
3. `订单`
4. `实盘`
5. `设置`

Must-Keep capabilities include:

- Account and owner access.
- Simulation funds, epoch, realized/unrealized equity, and the single safe reset action.
- Complete pre-trade plan: direction, state, gates, entry zone/price, stop, TP1, TP2, support, counter-evidence, missing conditions, and invalidation.
- All thirteen unified strategy cards and actual paper-order learning statistics.
- Router reasoning, selected-for-execution strategy, and explicit paper/live-parity authority.
- Orders, trade chart/review, Entry Quality, historical analog memory, and learning history.
- Inline Gate status and orders, credential verification/deletion, Auto Live control, reconciliation, risk visibility, and Emergency Stop.
- Web Push, audit, runtime health, and scanner diagnostics.
- Last-trustworthy-snapshot degradation and mobile-safe layout.

Before any UI, navigation, PWA, account, notification, order, live-control, or product-surface refactor, read `docs/RESONANCE_MUST_KEEP_FEATURES.md` and run its regression suite. Preserve capabilities and safety outcomes; do not duplicate destructive controls or create a second authority path.

## 11. Major production milestones already incorporated

| Milestone | Commit / PR | Result |
| --- | --- | --- |
| HTE31 enlarged paper economics and restored live controls | `d9e1dd2` / PR #68 | 1,000-USDT paper sizing, adaptive leverage, order transparency, independent performance cells |
| Restored complete operator/Must-Keep surface | `0cef71d` / PR #99 | Five tabs, full plans, settings/reset, account/live/audit/diagnostics preserved |
| Account-store fault isolation | `dff20cc` / PR #100 | `/api/hte31` viewer path no longer depends on account persistence |
| Entry Quality and honest memory | `6450fe0` / PR #101 | Entry timing diagnostics, delayed-entry counterfactuals, 8-sample eligibility, graceful refresh degradation |
| Isolated strategy research router | `599dd81` / PR #103 | HT4 freeze, eight challengers, 64 shadow observations, research router, lower paper margin |
| Unified paper brain and live parity | `1c42379` / PR #105 | One capital-backed thirteen-strategy pool, five-position limits, exact paper-to-live lineage |
| D1 daily-write guardrail | `ce60336` / PR #108 | 15-second safety checks with 60-second unchanged checkpoints; 27,360 planned recurring writes/day |
| Strategy-family lifecycle brain | `a92a516` / PR #109 | Nine canonical families, equal HT4 treatment, health/decay states, final post-exit verdicts |

All of these are cumulative. A future optimization must not remove an earlier milestone merely because the newest strategy work is the current focus.

## 12. Verification commands and release discipline

For every material change:

1. Start from current `main`.
2. Read this file and all project instructions.
3. Inspect current behavior and uncommitted work before editing.
4. Classify old feature references as keep-current, supplement/adapt, reimplement, or retire.
5. Use a branch and PR.
6. Run:
   - `npm run test:signals`
   - `npm test`
   - `npm run lint`
   - `./node_modules/.bin/tsc --noEmit --incremental false`
   - Wrangler production deploy dry-run
   - `git diff --check`
7. Merge only after PR CI is fully green.
8. Verify merged-main CI.
9. Verify immutable production assets plus `/__health`; confirm both schedulers advance and have no errors.
10. Update `.codex/goal-to-done/STATUS.md`, `DECISIONS.md` when consequential, this handoff, `CURRENT_SYSTEM_STATE.md`, and the changelog.

The final PR #109 evidence was:

- 217 strategy/risk/migration tests passed.
- Production build plus 109 UI/Must-Keep tests passed.
- ESLint passed.
- TypeScript passed.
- Wrangler production dry-run passed.
- PR CI run `33716373058` and merged-main CI run `33716448405` passed.
- Production immutable asset `assets/page-BF9gQ5KC.js` and two advancing scheduler probes passed.

## 13. Current operating objective

Strategy-family consolidation and lifecycle management are deployed. Follow `docs/STRATEGY_BRAIN_LIFECYCLE_PLAN.md` and collect real capital-backed paper evidence:

- Treat every strategy equally, including HT4, and retain prior profitability as history rather than permanent protection.
- Keep the thirteen legacy IDs under the nine canonical families; retire a variant only after behaviorally comparable evidence proves it redundant, while preserving all lineage.
- Review actual closed-order frequency, expectancy, profit factor, drawdown, stop/TP/timeout composition, direction concentration, five-slot utilization, and recent-vs-lifetime decay.
- Diagnose repeated losses, strategy/regime starvation, and degradation before changing entry rules or reducing usage.
- Use the deployed final trade verdict and remediation action after each complete post-exit observation.
- Keep same-side cooperation and opposite-side conflict explainable; do not auto-switch positions or substitute a lower-ranked strategy after selection.
- Treat positive simulated growth as evidence for the owner's later funding decision, never as automatic funding approval.

Non-goals:

- No auxiliary shadow-trade simulation.
- No automatic close-and-reverse or hedge.
- No fund transfer or owner-approval inference.
- No deletion of old trades, learning, shadow history, or simulation epochs.
- No per-scan strategy-health write or D1 recurring budget above 60,000 rows/day.

## 14. How to continue after deleting chats

The safest permanent setup is a ChatGPT Project named **Market Sentinel 量化系统**. Add this handoff as a Project source and start one dedicated ChatGPT Work/Codex chat named **量化程序优化升级**. Project files and instructions carry across related chats; each new task should still begin by reading current `main` and this handoff.

Deleting old chats does not delete GitHub history or this handoff. Do not delete the Project source or repository. If the chat and repository disagree, trust the repository and repeat production verification.
