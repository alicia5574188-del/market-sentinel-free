## 2026-09-06 — V12 多数途中方向模拟版已上线

PR #156 / main `03e5c7b` / workflow `33981949818` 的验证、0030增量迁移、Worker部署和operations全部通过。页面状态修正保留：六币完整扫描时显示运行中；局部429/超时时只提示局部行情延迟，不误报全系统异常。

方向由至少5段独立历史片段的途中首段简单多数决定，不再被历史期望、命中率或净亏占比二次否决。目标取多数投票片段一小时内最大有利运动中位数的75%，且扣费后目标至少为完整风险1.2倍；2%保护距离、报价/入场区/失效位、流动性、0.25%单笔/0.75%组合风险和亏损暂停保留。PR真实12小时回放11个信号、9个完成单、合计+0.963R，仅为PAPER证据，不保证未来盈利。新版本实盘关闭，历史、归档、凭据和LIVE记录保留。

## 2026-09-05 — V8 短线交易台页面改版

权益/已实现结果与当前决定在前，当前持仓显示保护价和最迟退出；统计与历史辅助折叠。订单默认紧凑，原经济计划和复盘按需展开。管理页保留扫描、持仓、资金保护、模拟重置及全部实盘/账户/通知能力。暖黑、米白、橙色主题与中文PWA信息统一。

分类：原控制/数据读取保持；首页和订单呈现重新实现；旧三策略比较、重复指标退役；运行资源仅说明实际既有预算/审计，无实时额度则明确未知。不增加轮询、Gate请求或D1写入；交易策略、版本、epoch与旧历史不变。部署证据以STATUS及PR为准。

## 2026-09-05 V8 一分钟回踩发布进行中
- 已实现固定六币一分钟缓存/十五分钟方向、缩量回踩恢复入场、含费0.25%单笔/0.75%组合、三连亏30分钟暂停、日亏1.5%持久保护、最多15分钟全平。
- 历史相似模型仅后台辅助，长期归档保持；旧模拟仓位沿0026强制报价归档，不触碰实盘。
- 短线复核共享缓存；重启/429退避、分钟故障回放、保护优先、信号去重和日初余额缓存已实现。详情 docs/MINUTE_PULLBACK.md。
- 本地115页面/安全、231信号/风险、52策略+7架构已通过；最终针对性验证与PR/生产核对进行中。24小时仿真已完成，真实24小时在线观察尚未完成。

## 2026-09-05 — Compact single-strategy UI and management display correction

- Remove multi-strategy comparison heading; show 策略表现 and preserve statistics/history. Distinguish the 12-hour common blocker from the current prediction; remove duplicated drawdown and history paragraphs.
- Adapt existing controls, do not restore old feature implementations: account/push/audit stay outside the page failure domain in an ordinary top toolbar; no floating content obstruction. Drawer uses border-box sizing. Existing emergency, credentials, reset and trading boundaries remain reachable.
- Management shows runtime/settings first. Long phase/rule text wraps and the six-coin list occupies a full row. Single strategy spans desktop width; phone headings and summary times wrap. All displayed runtime/order/audit times use Beijing time.
- A failed live-status read retains the last success with timestamp/error, rather than falsely showing unconfigured/empty. Initial reads show unknown/loading; stale or missing live state disables the normal toggle/reconcile buttons, while emergency remains reachable. No automatic mutation retry or new polling.
- Strategy, history archive, scheduler, risk, positions, D1 and credentials are unchanged. UI/risk/architecture gates required; release verification pending.

> 2026-09-05 persistent history prepared: fixed six coins; stable per-symbol daily archive and throttled72h backfill, no14-day retention cutoff. Older history rotates through bounded local matching. No new epoch/threshold/live change. STATUS records release proof.

> Production verification: PR #142 / main b6075da3 / run33961439540 all passed. Browser confirms compact sparse-analog UI; no threshold/epoch change or frequency claim. See STATUS and PR comment.

> 2026-09-05 follow-up: production AKE has4031 history bars but1/8 matches; it is not a12h storage wait. Compact empty-state UI and bounded cache gap repair are prepared; see STATUS for release proof. No threshold/epoch/risk change.

> **2026-09-06 V13 prepared and PR-verified, not deployed yet.** PR #158 head `d090ce5`, workflow `33984216762` passed. Exactly five closest independent analog episodes now own vote/target/replay and expose raw 24+12 OHLC candlesticks in the top UI. Current analog PAPER risk is 1% per trade / 3% portfolio without six-symbol pre-allocation; correlated exposure halves. Executable reward/full-risk boundary is 0.8R, while the 2% stop cap and all data/quote/liquidity/account/D1/LIVE boundaries remain. Bounded 12h replay: 42 signals, 21 closed, 7 wins, +2.891R, 2 open. This is limited evidence, not a profit promise. Production remains V12 until merge/deploy proof.

# Market Sentinel / Resonance — Quant System Master Handoff

> **2026-09-05 V7 production verified.** PR #141 / main `16834018` / workflow `33952777266` verify+deploy+operations passed. Worker `2dd398ad-49e0-47a8-9b31-2c25838ddf45`, page `DQDbO0mL`. PAPER active V7, target null, no legacy holdings. Scanner and position scheduling advanced. Account rounded-out24h D1:1,038,542reads/4,159writes at07:34:45Z. Analog frequency/profit remains unproven; normal production history hydrates per symbol. STATUS and PR comment contain proof; do not redeploy solely to record it.

> **2026-09-05 V7 historical analog prepared, not yet deployed.** The user replaced the three-strategy draft with one historical-pattern predictor. Closed 2h input / up-to-14d history / 1h outcome; calendar and recorded event context, disjoint purged samples, bounded DO cache, immediate single-signal PAPER admission, Chinese overlay/date evidence. V7/0025 retains fresh-quote old PAPER archive; no live authorization. See `docs/HISTORICAL_FORECAST.md` and current STATUS for exact rules, validation and release evidence.

> **2026-09-05 observation correction deployed.** PR #139 / main`c4b1b0bf` / successful workflow`33946738899`; Worker`89a885a5-0c35-4a29-9dfd-3f34a35a9c90`, page`2Cs6-feN`. Priority-observation labels and latest qualified comparison evidence are deployed; historical counts/epoch and trading rules preserved. Old screenshot competitor is unknown; restored trigger frequency is not claimed. STATUS contains proof.

> **2026-09-05 priority-observation correction prepared.** The old 主候选 counter includes triggered WAIT observations. Label it 优先观察（含待确认）, preserve cumulative history, and retain latest qualified same-symbol comparison in the existing DO snapshot. Qualified losers now have a concrete competitor reason going forward; old missing details stay explicitly unknown. No strategy/risk/epoch/cadence/D1-write change and no claim of restored frequency. STATUS records verification and pending release.

> **2026-09-05 reliability production verified.** PR #138 / main`62f863d0` / run`33945003862`: verify, deploy, operations all passed. Worker`ba4caf2b-d4ea-493c-8567-cd6b538c5923`; page`Di6F9607`. Account D1 at04:38:53Z: UTCday68,452reads/753writes; rounded-out recent24h1,129,862reads/4,298writes. Scanner and position scheduling advanced without runtime errors; six-hour audit is configured. Partial page fallback deployed; old gates all retained. This completes the follow-up described below; STATUS has detailed proof.

> **2026-09-05 V6 verified production and reliability follow-up.** PR #137 / main `440d5980` / successful production run `33944293649`; Worker `3e8c67c0-17d1-4792-b86b-9bc22d22cdb7`. V6 paper cutover completed, target null, zero legacy holding positions. This supersedes older local/preparation status below. Follow-up fixes partial-success page null overwrites and adds read-only post-deploy/six-hour account D1 read/write plus advancing scheduler checks. Existing CI credential only; no runtime token or recurring D1 ledger. Budget estimates are not actual usage; new audit measurement pending. Idle manager heartbeat is five minutes: verify alarm advancement without increasing persistence frequency.

> **2026-09-05 V6 prepared:** User requested removal of fixed 15/6 scan and three-position restrictions. The configured universe now rotates by oldest per-symbol evaluation, PAPER capacity follows the existing 15% total risk/margin/correlation safeguards, and the D1 estimate follows prospective/day-peak holdings. V6/0024 is a new PAPER version boundary; three strategy formulas and Gate/live policy are unchanged. Default configured coverage is 30 (existing settings maximum 50), not unrestricted simultaneous whole-market analysis. See current STATUS before claiming deployment.

> **2026-09-05 V5 production verified:** PR `#136` merged as `8badc27bfd678f9317bbbb1301bdda30fed834c7`; workflow `33942706243` passed verification, deployment, immutable asset, bounded health and PAPER cutover. Worker `fefcf159-98eb-4e9e-b922-b8be62877ca5`, client `assets/page-eomFNgKd.js`. Migration `0023` completed with V5 active, no pending target and zero legacy open paper positions. The following local-only notes are retained as pre-release history and are superseded by this proof; no Gate/live reset or funding occurred.

> **2026-09-05 local V5 correction (not deployed):** `direct-market-brain-v5-entry-integrity` now filters unfinished candles, requires resonance structural recovery and existing market-fit checks, preserves true swing stops instead of clamping them at 3%, uses real classified regimes, and removes exhaustion's fixed selection bonus. Compact operator UI and known labels/states are Chinese. Local gates passed 39 Direct/architecture, 224 signal and 115 build/UI/safety tests; Direct tests are now part of CI. Additive migration `0023` prepares the established PAPER-only fresh-quote archive; no production action has occurred. Read current `STATUS.md` for the bounded next release step.

> **2026-09-05 diagnostic evidence correction:** Older “restored original bloodlines” wording does not prove full behavioral parity or profitability. Retained HT3-R/HT4 core thresholds largely match V4, but outer admission differs; V5 repairs the specific reproduced defects above without blanket gate relaxation. The screenshot's actual order remains unreplayed because normal production read access is blocked. Do not claim frequency or the unique cause of that loss from synthetic tests.

> **2026-09-05 current production V4:** PR `#133` restored the actual HT3-R Failed Auction, HT4 Exhaustion/Anti-Crowd, and Resonance direction + HT5-R timing bloodlines under one Direct Market Brain. Setup-local loss protection pauses only a proven failing setup/direction/regime cell, while actual average winner/loser R and payoff are visible. Migration `0022` archived every V3 paper holding at fresh quotes and started a clean V4 epoch; Gate/live remained outside the cutover. Final workflow `33938628363` passed verification, deployment, immutable asset, bounded health and D1 cutover proof: active version V4, no pending target, zero legacy paper positions. Worker `f415e87f-5a59-4f46-accf-fa2eec51a392`.

> **2026-09-04 current production activity correction:** PR `#131` (`113bf39a`) fixes the v3 dashboard's winner-only setup attribution and partial-window completion. All three setups now receive one evaluation per deep scan, with trigger/qualification/selection/block/open counters kept separate, and a 12-hour review completes only with full measured Scanner coverage. Workflow `33894121421` passed all verification and deployment gates with no pending migration; the active brain remained v3 and legacy open positions remained zero. The change reuses the existing Durable Object save and changes no setup, risk, D1, position, live, or funding authority.

> **2026-09-04 current production:** PR `#129` deployed `direct-market-brain-v3-resonance-three`, replaced Dennis with multi-timeframe comprehensive resonance, restored per-setup contribution statistics and deterministic 12-hour operating review, and reduced the operator surface to `大脑 / 订单 / 管理`. It reuses the existing Scanner Durable Object save, adds no recurring D1 write, preserves every Must-Keep capability, and uses additive cutover migration `0021`. Workflow `33865500814` passed full verification, migration, deployment, immutable-asset and health checks; production D1 proved `status=completed`, no pending target, and zero legacy open paper positions. Worker version: `a998bdd9-1833-4535-9efd-22d4e82defc4`.

> **2026-09-04 current correction:** production `main` `6c6b18c` keeps Direct Market Brain as the only new-order authority with three setups and makes every major brain version automatically block new paper entries, archive pre-cutover/old-version paper positions at fresh quotes, and start a clean epoch; Gate/live remains untouched. Final workflow `33858569353` proved `legacy_open_positions=0` and active version `direct-market-brain-v2-core-three`. Use `docs/QUANT_UPGRADE_PATH.md` for the bounded upgrade route.

Last reconciled: **2026-09-05 — current main `ebc6284a` includes PR #134; V4 restored-core production proof complete**
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
