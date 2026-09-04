# Market Sentinel — Current System State

> **2026-09-04 strategy-activity correction — release candidate.**
>
> The three core setups still use exactly the deployed v3 decision and risk rules. Activity now reports a truthful funnel for every setup on every deep scan: evaluated, setup-triggered, hard-gate-qualified, selected, entry-blocked, and opened. Scanner coverage is measured inside the existing Durable Object save; an incomplete startup window cannot be promoted or displayed as a completed 12-hour review. Legacy malformed activity is discarded on the first new scan. No D1 write, strategy threshold, position lifecycle, paper/live lineage, Gate control, or funding authority changes.

> **2026-09-04 core-three resonance upgrade — production deployed.**
>
> `direct-market-brain-v3-resonance-three` keeps one Direct Market Brain and exactly three new-order setups: volume-force failed breakout, exhaustion reversal, and multi-timeframe comprehensive resonance. Dennis breakout remains historical only. The first two setups receive small evidence-floor relaxations while preserving completed-candle, liquidity, funding, macro, volatility, edge, portfolio, and fresh-entry checks; resonance requires aligned 15m/1h/4h direction, a completed 5m resume, adequate volume/spot flow, and anti-chase protection. The dashboard is now `大脑 / 订单 / 管理`: it ranks setup contribution, shows deterministic 12-hour operating reviews, keeps complete order review, and preserves Gate controls, Emergency Stop, paper reset, account, push, audit, and diagnostics. Scanner activity is accumulated inside the existing Durable Object runtime save and adds no recurring D1 write. PR `#129` deployed commit `0736a225`; workflow `33865500814` applied migration `0021`, deployed Worker `a998bdd9-1833-4535-9efd-22d4e82defc4`, passed asset/health checks, and proved the cutover completed with zero legacy open paper positions. Gate/live remained untouched.

> **2026-09-04 automatic-cutover correction — production deployed.**
>
> Current production uses `direct-market-brain-v2-core-three` as the sole new-order authority with three setups. Major versions are now a paper-only boundary: entry blocks first, pre-cutover/old-version paper positions close at fresh quotes as `version_reset`, history and 12-hour observations remain, and a clean epoch starts. Final D1 proof showed zero legacy open positions; Gate/live is outside this authority. See `docs/QUANT_UPGRADE_PATH.md`; this note supersedes conflicting historical Strategy 2.0 text below.

> **2026-09-04 return-to-purpose patch — production deployed.**
>
> The Direct Market Brain remains the sole authority for new orders, but its entry surface is deliberately reduced to three useful setups: volume-force failed breakout, exhaustion reversal, and the original low-frequency Dennis trend breakout. Each setup has explicit completed-candle, volume/force, location and anti-chase conditions, then passes the existing shared liquidity, funding, macro, volatility, structural-edge, portfolio and live-parity gates. The UI now shows the selected setup and score and presents only these three setups in its compact trading summary. Existing positions, risk plans, review/observation history, historical strategy IDs, five operator tabs, owner controls, live safety and D1 boundaries are preserved. No funds, credentials, live switches, existing orders, schema or recurring write path are changed.

> **2026-09-03 Direct Market Brain — implementation prepared, not deployed.**
>
> The frozen next contract is `docs/DIRECT_MARKET_BRAIN_UPGRADE_PLAN.md`, with the one-pass build map in `docs/DIRECT_MARKET_BRAIN_EXECUTION_PACK.md`, prepared from current `origin/main` `6416699` (PR #111). After implementation, one deterministic direct market brain will replace named strategies as the authority for **new orders**: light-scan the fifteen highest-volume eligible Gate USDT perpetuals, deep-scan six across correlation clusters, select at most three qualified portfolio-safe positions, and learn only after each close has a complete real 12-hour observation. Correlated overlapping orders count as one independent performance event, immediate drawdown protection is separate from delayed model learning, and the new brain earns higher risk through calibration. Old strategy IDs/history remain intact but cannot vote, emit candidates, or provide fallbacks. The D1 audit found that the old 27,360 logical-row estimate omitted index writes and can conservatively exceed 100,000; the prepared replacement uses zero scanner writes, a 30,000 index-adjusted app hard budget, a 22,000 new-order admission line, and a 65,000 account safety line. Simulation remains the only learning/selection environment; live may only inherit an actual simulated decision snapshot. The new budget module/test are dormant and preparation changed no production position, data, risk rule, Gate control, funds, or Durable Object generation.

> **2026-09-03 strategy-family lifecycle brain — deployed and production-verified in PR #109.**
>
> The thirteen legacy strategy IDs now map to nine canonical families in production. Same-family variants keep their IDs/history but only the highest-ranked variant remains executable for a symbol/cycle. Every strategy, including HT4, uses the same health, recent-decay, retest, and pause rules; HT4's former freeze is removed and its prior profit is historical evidence only. Completed 12-hour post-exit paths receive a final verdict stating the observed profit path or that the trade should have been skipped. Paper/live lineage remains exact. No schema, recurring D1 write, risk limit, owner control, fund action, or Durable Object generation changed.

> **2026-09-02 D1 daily-write budget correction.**
>
> The active-position safety loop still evaluates every 15 seconds, while unchanged holding telemetry is durably checkpointed once per 60 seconds. TP1 protection, stop, TP2, timeout, close, learning, and recovery events remain immediate. PR #108 reported 27,360 logical rows/day under thirteen one-minute evaluations and five continuously open positions. The later Direct Market Brain audit found that this omitted billed primary/secondary index writes and can conservatively exceed 100,000; the newer index-adjusted budget supersedes the old headroom claim.

> **2026-09-02 unified-paper/live-parity correction (supersedes all conflicting research-lane, shadow-position, paper-only learning, live allowlist, two-slot, and margin descriptions below).**
>
> All thirteen HTE31 strategies now share one capital-backed simulation account. One strategy brain ranks the current stories and chooses the exact executable candidate; actual closed paper orders, not auxiliary shadow trades, drive strategy evidence. The system no longer creates or advances a second simulation layer. Historical shadow rows remain read-only for audit compatibility.
>
> Gate live directly inherits the chosen paper trade's strategy, learned entry checks, stop, targets, and leverage for every ID in the same thirteen-strategy catalog. Real balance, fees, slippage, contract limits, reconciliation, owner controls, and hard safety are still live-account facts. The system never moves funds or decides funding approval: the owner will fund only after actual positive simulated growth.
>
> Paper/live concurrency is five positions with at most three in one direction. Paper total planned stop risk is capped at 20% of equity and one symbol still has at most one open position. New paper sizing targets 8% isolated margin, allows a liquidation-safe fallback up to 35%, and caps adaptive leverage at 50x plus liquidity/volatility/quality/liquidation constraints. PR #109 later removed HT4's source freeze and placed it under the same lifecycle rules as every other strategy.

> **2026-09-02 strategy-research correction (supersedes conflicting strategy-count and paper-margin descriptions below).**
>
> Resonance keeps HT1–HT5 as the only control/execution lane and freezes HT4 Exhaustion's decision block with a regression fingerprint. Eight HTE31-native challengers run in a separate research lane: revised HT1/HT2/HT3/HT5 plus HT6 range rotation, HT7 compression expansion, HT8 relative strength, and HT9 shallow-pause momentum continuation. They may create up to 64 concurrent shadow observations without consuming control-account capital or either control position slot, and they cannot enter Gate live.
>
> The research router can describe a single story, same-side cooperation, opposite-side conflict, or a possible thesis switch. It keeps each strategy's attribution separate, ignores performance weighting below 8 valid samples, and requires at least 30 non-overlapping forward samples plus PF ≥ 1.30, expectancy ≥ +0.15R, and maximum drawdown ≤ 6R before even requesting manual promotion review. It never auto-promotes, auto-reverses, or changes an existing position.
>
> New paper orders now target at most 15% of equity as isolated margin by selecting higher safe leverage, while preserving the market-defined stop, notional, fee-inclusive 3–5% account risk, and liquidation buffer. Exceptionally narrow stops may use a bounded 45% collateral fallback after reaching the safe leverage cap. This does not change Gate live sizing.

> **2026-09-01 Resonance Entry Quality correction (supersedes older learning/UI descriptions below).**
>
> Resonance evaluates five paper playbooks (HT1–HT5). Its new Entry Quality observer records Entry Efficiency, MAE before first +0.5R, time to +0.5R/+1R, and 5/10/15-minute delayed-entry counterfactuals. It distinguishes direction error, early entry, late entry, normal noise, and tight stop. Entry confirmation can change only for a setup + asset-regime cell with at least 3 assessed samples and repeated evidence; every such adaptation remains paper-only and is rejected by the Gate live boundary.
>
> Historical analog cards now expose the real minimum of 8 independent episodes. Below that floor they are explicitly excluded from judgment. `/api/hte31` auxiliary diagnostics are cached for 60 seconds, the main phone refresh runs every 30 seconds, and a transient failure retains an explicitly labeled last trustworthy snapshot.

> **2026-08-30 HTE 3.1 correction (supersedes conflicting strategy and paper-risk statements below).**
>
> Production is **Market Sentinel HTE 3.1 Clean**. New simulated entries come from three independent Human Trader setups: Dennis trend breakout, Raschke trend pullback, and Turtle Soup failed breakout.
>
> For new HTE 3.1 paper orders, target structural-stop risk is about 4% of equity with an admitted range of 3%–5%; fee-adjusted TP2 net profit targets 5%–20% of equity. Adaptive isolated paper leverage may reach 50x subject to liquidity, volatility, data-quality and liquidation-buffer caps. The sizing layer enlarges notional and may raise TP2 R before rejecting an otherwise valid READY signal. Trader/regime/direction cells with repeated negative expectancy are paused independently instead of reducing the entire strategy's frequency.
>
> These paper rules do not silently alter separate Gate live order sizing. Gate live remains owner-controlled and fail-closed; the owner explicitly authorized its enabled state to remain unchanged on 2026-08-30.

> **Single source of truth for continuation work.**
>
> Chat history is discussion context only. Before any future code change, read the current `main` branch, recent merged PRs/commits, CI status, and this file. Never reconstruct production behavior from memory or a missing chat message.

Last reconciled: **2026-09-03 04:53 UTC — PR #109 deployed and verified**
Repository: `alicia5574188-del/market-sentinel-free`  
Production strategy identity: **Market Sentinel HTE 3.1 Clean**

For the actual current HEAD/deployment, always inspect GitHub and Cloudflare rather than copying a historical commit/version ID from this document.

## 1. Development continuity rule

Every future change must follow this order:

1. Read current `main`; do not start from remembered code or chat summaries.
2. Read this file and `docs/SENTINEL_CHANGELOG.md`.
3. Inspect recent merged PRs/commits that touch the target subsystem.
4. Identify current authority boundaries before editing Strategy / Regime / Risk / Execution / Order Lifecycle / Learning.
5. Work on a branch and PR for material changes.
6. Run both CI gates: strategy/risk/migration tests and production build/UI safety tests.
7. Merge only when green.
8. Verify the merged `main` CI and Cloudflare production deployment.
9. Update this file and the changelog whenever production behavior, safety boundaries, data flow, or observability materially changes.

If chat history and repository state disagree, **repository state wins**.

## 2. Current architecture and authority

Production decision flow:

`Gate market data → background MarketScanner → Market/Regime context → 12 Playbook Strategy 2.0 pool → learning/risk filters → portfolio risk → Execution Engine / Order Lifecycle → simulated or live safety gates`

Production UI read flow:

`background MarketScanner → Durable Object read model → /api/scanner + /api/market → iPhone/web UI`

Key authority rules:

- **Sentinel Strategy 2.0** is the only active strategy identity.
- P1–P12 are evaluated as a parallel Playbook pool; learning coverage and use diagnostics are separate from whether a Playbook is evaluated.
- Regime intelligence exposes current regime, candidate regime, migration probability, stability and transition risk.
- The Intelligence layer is explanatory/shadow-only and cannot raise live risk, override hard safety, or auto-promote a model.
- Portfolio risk, Execution Engine, Order Lifecycle, Live Master Switch and Gate hard-safety checks remain final execution authorities.
- Learning cannot bypass hard risk limits.
- Legacy V1/V3 learning/trade memory is not a valid Strategy 2.0 learning source.
- In Cloudflare production, foreground market/scanner APIs are **consumers**, not public-market-data producers. They must not recreate Gate deep analysis when the background read model is unavailable.

## 3. Current loss containment state

A defensive execution governor is part of Strategy 2.0.

Reason: the accumulated `contract_v2` sample showed materially weak aggregate performance, so the system must not continue generating low-quality execution merely to gather samples.

Current behavior:

- The governor evaluates completed Strategy 2.0 results and recent performance.
- When aggregate/recent performance is weak, state becomes `DEFENSIVE`.
- Exploration-mode candidates do **not** create new simulated orders.
- Candidates whose intended V2 risk multiplier is below ~full base risk are fail-closed from order creation until fractional risk sizing is consumed end-to-end by the execution path.
- In defensive mode, only `high_conviction` candidates with sufficient samples and positive learned expectancy may create new simulated orders.
- Existing open positions continue their normal lifecycle; the governor does not force-close them.
- No leverage increase or hard-risk relaxation was introduced.

Important unresolved engineering boundary:

> Strategy 2.0 computes fractional risk multipliers, but the legacy contract-preview sizing path has not yet been fully redesigned to consume those multipliers end-to-end. Current production protects against this mismatch by blocking partial-risk intents from silently executing at full base risk.

Do not remove this containment until sizing is explicitly traced and tested from Strategy intent → risk budget → contract size → execution.

## 4. Current data-degradation / Worker-pressure architecture

The recurrent non-JSON 503 / black-screen issue is treated as a **producer/consumer architecture problem**, not merely a retry problem.

### Production read-model boundary

- The background `MarketScanner` is the producer of public Gate market analysis.
- After each successful/degraded background scan, the MarketScanner Durable Object persists a current foreground read model and per-symbol deep packets.
- In Cloudflare production, `/api/scanner` reads that model instead of calling `fetchGateUniverse()` / global-risk upstreams again.
- In Cloudflare production, `/api/market` reads the stored per-symbol/background model instead of calling `analyzeGateSymbol()` again.
- Missing or old deep evidence is returned as explicitly degraded data. The UI may show a coarse universe ticker while waiting for background deep coverage, but it must not fabricate a current decision.
- A background snapshot failure is **not** allowed to trigger a foreground Gate recomputation. This prevents the UI from becoming a second market-data producer exactly when the backend is already under pressure.
- Direct Gate market analysis remains available for non-Cloudflare/local paths and explicit/manual scan workflows, not normal production phone polling.

### Upstream fan-out boundary

- `analyzeGateSymbol()` no longer fires its entire public Gate source set simultaneously; endpoint fan-out is bounded to **4** concurrent requests.
- Position quote candle reads use the same bounded fan-out helper.
- Background deep-symbol concurrency remains separately bounded, so symbol concurrency and per-symbol endpoint concurrency cannot multiply without limit.

### Client/PWA boundary

- A parser-time `/sentinel-runtime-guard.js` is loaded before React client pollers so foreground request admission starts before hydration.
- Foreground same-origin GET reads are coalesced and globally spaced.
- `/api/market` and `/api/scanner` are now treated as lightweight snapshot reads; they do not queue behind Strategy/D1 research work as if they were Gate-computation requests.
- A 429/5xx opens a circuit breaker instead of being immediately replayed by the early guard.
- Dynamic root HTML is never reused as an old-version fallback.
- PWA shell **v7** uses a dedicated recovery shell and places a **5-second upper bound on top-level navigation fetches**. A stalled Worker navigation should hand off to recovery instead of leaving an indefinite dark blank screen.
- Recovery retries remain backed off rather than continuously reloading the Worker.
- Fatal asset/chunk failures and a visible blank mounted shell also hand off to recovery when JavaScript is alive.

### Remaining observability reads

- `/api/v2` remains a read-only D1/intelligence dashboard path with partial-source isolation and bounded interactive history. It no longer competes with a foreground `/api/market` Gate analysis lease in the production path.
- Research diagnostics remain infrequent and read-only.

Data-safety rule: stale/degraded data may be shown only when explicitly labeled; cached data must never be presented as current real-time market/execution truth.

Execution-safety rule: these controls apply to read-only UI/observability paths. They do not retry, delay, or acquire authority over Gate mutations, Execution Engine actions, Order Lifecycle, or the live coordinator.

## 5. Current Regime / market-intelligence state

The Regime layer no longer treats a single hard label as sufficient UI truth.

Current observability includes:

- current Regime
- candidate Regime
- migration/transition estimate
- stability
- transition risk and velocity
- leading transition components

The candidate state should not disappear merely because an old hard threshold was not crossed. Stability must represent environmental persistence/transition pressure, not merely classifier separation.

Do not infer a Regime bug solely from seeing the same label repeatedly; diagnose probability distribution, candidate strength, transition momentum, data freshness and state persistence first.

## 6. Current Strategy 2.0 learning / observability

Existing learning concepts include:

- `Global Regime × Asset Regime × Playbook × Direction` cells
- Bayesian/low-sample conservatism
- positive / negative / degrading cells
- forward sample tracking
- Playbook coverage
- persistent WATCH/REJECT counterfactual archive statistics
- Playbook usage diagnostics that identify missing learning coverage rather than assuming a strategy is not running

### Learning Arena

The repository contains a **read-only Strategy 2.0 Learning Arena**. It adds rolling-edge and diagnostic observability such as:

- all / last 20 / last 50 / last 100 result rollups
- forward vs pre-forward evidence
- rolling expectancy/profit-factor trend
- exit-pattern distribution changes
- Playbook performance
- Regime × Playbook × direction heatmap

It is explicitly research/observability-only. It does **not** acquire trading, sizing, risk, promotion or execution authority.

Do not interpret period shifts as proven learning alpha unless a frozen baseline/challenger comparison exists.

## 7. UI responsibilities

Current product structure remains centered on:

- **机会**: decision board — Regime, candidate migration, Playbook pool, TRADE/WATCH/REJECT and decision diagnostics.
- **雷达**: market intelligence — leading transition/risk signals.
- **订单**: portfolio/thesis/execution/learning observability.

UI metrics must describe real underlying semantics. Avoid vanity labels that imply a capability the engine does not actually possess.

## 8. Safety invariants that must survive every change

Do not merge a change that unintentionally weakens any of these:

- stale/invalid market data cannot become a new-risk permission
- learning cannot increase risk beyond hard policy
- no uncontrolled self-modification of production strategy
- no automatic challenger promotion without explicit governance
- no accidental restoration of legacy learning memory
- no duplicate order creation caused by retries/restarts
- protective exits remain reduce-only where applicable
- existing order lifecycle/reconciliation safety remains intact
- a UI/diagnostics failure must not create trading authority
- a research metric must not be presented as a live decision authority
- a recovery/load-shed path must not replay a mutation
- a production foreground market read must not silently reacquire public Gate computation authority

## 9. Current operating recommendation

The system is in a **containment + observation** phase, not an aggressive parameter-tuning phase.

Primary questions for new forward data:

- Does defensive gating materially reduce the rate of new losing trades?
- Do recent/forward expectancy and profit factor improve?
- Which Playbooks/Regimes retain positive edge after the newer Regime engine and loss governor?
- Do non-JSON 503/black-screen events disappear after the producer/consumer split, bounded Gate fan-out and timed navigation recovery?
- Does the missing Playbook learning coverage represent legitimate rarity or unreachable conditions?

Do not loosen a strategy merely to increase trade count or force 12/12 learning coverage.

## 10. Handoff checklist for the next developer/AI

Before saying “I will change X”, answer from the repository:

- What is the current `main` SHA?
- What was the last production deployment result?
- Which recent PR/commit last changed X?
- Which tests cover X?
- What execution/risk authority does X currently have?
- What invariant could this change break?
- Does `CURRENT_SYSTEM_STATE.md` need to be updated after the change?

For another 503/black-screen report, determine first whether the failing foreground endpoint was supposed to be a **snapshot consumer**. If `/api/market` or `/api/scanner` is observed issuing Gate public-market fan-out in Cloudflare production, treat that as a regression. Also capture CF Ray IDs when available.

If any answer is unknown, inspect first. Do not guess.
