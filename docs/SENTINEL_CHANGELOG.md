# Sentinel Production Change Ledger

This is the durable production-history ledger for Market Sentinel. It exists so future development does not depend on chat history, memory, or screenshots.

Rules:

- Record **material production changes only**: strategy behavior, Regime logic, learning, risk, execution, order lifecycle, data architecture, stability, migrations, deployment/safety boundaries, or major observability that affects how the system is understood.
- Include what changed, what deliberately did **not** change, verification, and the production commit/version when known.
- Never rewrite old entries to make the history look cleaner. Append corrections as new entries.
- `docs/CURRENT_SYSTEM_STATE.md` describes the current truth; this file explains how that truth evolved.

---

## 2026-09-04 — Direct Market Brain reduced to three core setups

### Changed

- Versioned the sole new-order authority as `direct-market-brain-v2-core-three` and limited candidate admission to volume-force failed breakout, exhaustion reversal, and Dennis trend breakout.
- Added explicit setup identity/score to the immutable decision path and setup-specific completed-candle, volume/force, exhaustion, trend-alignment and anti-chase evidence.
- Compressed the daily product copy to show the three retained setups while keeping the existing operator navigation and controls.

### Deliberately unchanged

- Existing orders and their immutable stop/target lifecycle, 12-hour observation, historical lineage, portfolio and D1 limits, credentials, owner-only live controls, emergency stop, funding boundary, and five Must-Keep tabs.
- No migration, destructive reset, forced close, fund movement, live activation, or recurring write was added.

### Verification

- Local direct-brain/architecture tests passed 21/21; production build/UI/safety tests passed 111/111; TypeScript and production build passed. PR, CI, merge and production proof are recorded when completed.

## 2026-09-03 — Strategy-family lifecycle brain and post-exit verdicts

- Pull request: `#109`
- Feature commit: `e31d7521374bab75894f2da67904de51d2a78653`
- Production merge commit: `a92a516dd12f960a961814343dc88c9fa33632cf`
- Dashboard API identity: `resonance-v5-strategy-lifecycle`

### Changed

- Organized all thirteen legacy strategy IDs into nine canonical families while retaining every strategy ID, historical trade, learning record, review, open-position lifecycle, and Gate lineage.
- Limited each family to one executable variant per symbol/cycle and kept suppressed family alternatives visible for independent attribution and learning.
- Added equal lifecycle health for every strategy, including HT4: learning, active, underperforming, degraded, starved, regime-wait, retest, and paused. Prior profitability is historical evidence only and creates no permanent protection or boost.
- Added recent-versus-baseline decay evidence to routing and a final verdict after the existing 12-hour post-exit observation, including profit path, whether the trade should have existed, and the next remediation action.
- Added owner-visible family/variant health and exact family/variant labels to paper review and Gate live lineage.

### Deliberately unchanged

- One capital-backed paper account, exact paper-to-live strategy lineage, five-position/three-direction/20%-risk limits, 8% target margin, 35% safe fallback, and adaptive leverage capped at 50x.
- Existing positions, stop/TP protection, credentials, Auto Live, reconciliation, Emergency Stop, and exchange hard-safety checks.
- No second simulator, schema migration, Durable Object generation reset, fund transfer, inferred funding approval, or new recurring D1 write. Planned recurring writes remain 27,360/day.

### Verification

- Local strategy/risk suite passed 217/217; production build/UI/Must-Keep suite passed 109/109; ESLint, TypeScript, and diff checks passed.
- PR CI run `33716373058` / job `100526308099` and merged-main CI run `33716448405` / job `100526529930` passed, including Wrangler production dry-run.
- Production served immutable asset `assets/page-BF9gQ5KC.js` containing `9 个策略家族由大脑择优` and `SF09`.
- Two `/__health` probes returned HTTP 200 and `ok: true`; Position Monitor and Market Scanner success timestamps advanced, both remained live, all scheduler errors were null, and the scanner circuit remained closed.

## 2026-09-02 — D1 daily-write budget and lossless position checkpoints

- Pull request: `#108`

### Changed

- Kept active paper-position evaluation at 15 seconds but changed unchanged holding telemetry persistence to a 60-second durable checkpoint.
- Added a regression-tested daily budget: 18,720 strategy-evaluation rows + 1,440 diagnostic rows + 7,200 maximum-position checkpoint rows = 27,360 planned recurring writes/day.
- Made 60,000 planned recurring rows/day the maximum for future upgrades, leaving at least 40,000 rows beneath Cloudflare D1's 100,000 free allowance for lifecycle events and variance.

### Deliberately unchanged

- Stop, TP1 protection, TP2, timeout, close, post-exit learning, outage replay, scanner cadence, order capacity, strategies, leverage, margin, paper/live parity, and Gate safety behavior are unchanged.

### Verification

- Focused D1 budget/position tests passed. Full strategy/risk suite passed 208/208; production build/UI/Must-Keep suite passed 109/109; ESLint and TypeScript passed.

## 2026-09-02 — Unified paper strategy brain and direct live parity

- Pull request: `#105`
- Feature commit: `fa4f38220be829d4bd67f1962f19020aed73d268`
- Production merge commit: `1c42379177d32d824b9907f4d04558e502607277`
- Runtime: `resonance-v4-unified-paper-live-parity`

### Changed

- Unified all thirteen HTE31 strategies into one capital-backed paper execution pool and made the brain's exact selection the only executable candidate.
- Removed current-cycle shadow trade creation/advancement; actual closed paper orders now drive router performance evidence.
- Extended Gate live eligibility to the same thirteen-strategy catalog and preserved learned entry checks, stop, targets, leverage, and decision lineage from paper to live.
- Increased paper/live capacity to five positions and three per direction; paper total planned stop risk is capped at 20% of equity.
- Changed isolated paper margin from a 15% target/45% fallback to an 8% target/35% liquidation-safe fallback; leverage remains capped at 50x and by market/safety conditions.

### Deliberately unchanged

- HT4's decision source fingerprint, existing position lifecycle, owner controls, credentials, reconciliation, emergency stop, and no-fund fail-closed behavior remain intact.
- No automatic fund transfer, live activation, hedge, close-and-reverse, or lower-ranked strategy substitution was added.

### Verification

- Local strategy/risk/migration suite: 206 passed. Production build/UI/Must-Keep suite: 107 passed. TypeScript, ESLint, Wrangler production dry-run, and `git diff --check` passed.
- Final PR CI run `33620998469` / job `100217743306` passed.
- Merged-main CI run `33621133143` / job `100218154250` passed.
- Production served immutable asset `assets/page-CLUWv592.js` with the unified strategy brain surface. Two `/__health` probes returned HTTP 200 and `ok: true`; Position Monitor and Market Scanner both remained live and advanced their success timestamps, no scheduler error was present, and the scanner circuit stayed closed.

## 2026-09-02 — Isolated strategy challengers and research router

- Production PR: `#103`
- Feature commit: `013908658e26c783742e50f21efde3d6307ad1e3`
- Production merge commit: `599dd815e202e8910b773a4481f45083c35972bc`
- PR CI run/job: `33612891752` / `100191962600`
- Merged-main CI run/job: `33612981374` / `100192245504`

### Changed

- Preserved the five existing control playbooks and froze the HT4 Exhaustion decision block with an exact regression fingerprint.
- Added eight HTE31-native research strategies: accepted breakout, adaptive pullback, force-aware failed auction, higher-timeframe swing context, range rotation, compression expansion, relative strength, and shallow-pause momentum continuation.
- Reworked HT3's research hypothesis to require breakout volume/range, reclaim depth, reverse-force votes, microstructure evidence, and explicit strong-trend opposition handling instead of treating every return to the prior range as a false breakout.
- Added a 64-position concurrent shadow ledger with strategy/symbol/direction/regime identity, sequential 5m stop/target/timeout observation, conservative same-bar ordering, costs, MFE/MAE, and non-overlapping evidence counts.
- Added an explainable research router for `SINGLE`, `COOPERATE`, `CONFLICT`, and `SWITCH_WATCH` states. Same-side strategies retain separate attribution without multiplying executable risk; opposite hypotheses are never averaged into an order.
- Changed paper sizing to target 15% isolated-margin occupation by selecting higher safe leverage while preserving structural stop, notional, fee-inclusive 3–5% equity risk, and liquidation safety. A narrow-stop fallback is hard-capped at 45% collateral.
- Added radar UI for the eight challengers, concurrent research counts, forward performance, and current router reasoning.

### Deliberately unchanged

- HT4's entry behavior, the five-strategy control candidate pool, its two position slots, every open-position lifecycle, structural stops, Gate live sizing, Gate strategy allowlist, credentials, Auto Live, reconciliation, and Emergency Stop are unchanged.
- Research strategies cannot consume paper capital, pre-empt HT4, create a Gate order, auto-promote, auto-switch, hedge, or increase executable risk.
- The retired Strategy 2 engine remains isolated and is not reconnected as a production authority.

### Verification

- Strategy/risk/migration suite: 204 passed.
- Production build/UI/Must-Keep suite: 107 passed.
- TypeScript, ESLint, and Wrangler production dry-run passed.
- Production served immutable asset `assets/page-BQKWUfKi.js` containing the new strategy-routing surface. `/__health` returned HTTP 200 and `ok: true`; Position Monitor and Market Scanner were live, their successful timestamps advanced between probes, no scheduler error was present, and the scanner circuit remained closed.
- Cloudflare's internal Build ID and Version ID were not exposed by the current access surface; no identifier was inferred or invented.


---

## 2026-09-01 — Entry Quality learning and honest historical-memory UI

- Production implementation commit: `6450fe04f03f31fa836df22248c556c83ca95f9d`
- Cloudflare Build ID: `93c6c0bf-c551-4417-8de7-c6ec7411dc39`
- Cloudflare Version ID: `4a248442-61fb-44ab-ab26-f534730e6a80`

### Changed

- Added a deterministic, persisted HTE31 Entry Quality report with Entry Efficiency, MAE before first +0.5R, time to +0.5R/+1R, and delayed-entry counterfactuals for 1/2/3 completed 5m candles.
- Added explainable entry classification: direction wrong, entry too early, entry too late, normal noise, stop too tight, or insufficient data.
- Scoped `require_retest` to repeated evidence in the same setup and asset regime: at least 3 assessed trades, at least 2 matching early-entry diagnoses, and at least 60% agreement.
- Added the entry metrics and 5/10/15-minute comparisons to expandable order reviews and owner diagnostics.
- Changed historical-memory cards below 8 independent episodes from `分歧 0%` to `样本不足 · n/8` and `暂不参与判断`; eligible cards show the symbol/time horizon, effective independent samples, bias, and median forward move.
- Cached auxiliary HTE31 diagnostics for 60 seconds with a five-minute stale fallback, reduced the single main dashboard poll to 30 seconds, and retained the last trustworthy snapshot with a local refresh-delay notice on transient failure.
- Added additive migration `0015_resonance_entry_quality.sql` for persisted per-trade entry diagnostics.

### Deliberately unchanged

- No structural stop, paper risk amount, leverage policy, Gate live risk, broad setup threshold, scanner authority, position-protection rule, or real-order execution path changed.
- Entry Quality adaptations remain cognitive paper challengers and carry the existing marker that prevents Gate live execution.
- The UI adds no second poll, foreground Gate producer, duplicate destructive control, or second authority source.

### Verification

- Focused Entry Quality/market-memory tests: 9 passed.
- Focused UI, migration, learning, and Must-Keep tests: 36 passed.
- Strategy/risk/migration suite: 194 passed.
- Production build/UI safety suite: 104 passed.
- TypeScript and ESLint passed.
- PR #101 CI run 352 and merged-main CI run 353 passed, including Wrangler production dry-run.
- Cloudflare applied the additive migration and successfully promoted the recorded version; the production root returned HTTP 200 and unauthenticated `/api/hte31` returned the expected JSON HTTP 401 instead of 503/HTML failure.

---

## 2026-09-01 — Resonance operator surface and complete pre-trade plans deployed

- Production implementation commit: `0cef71de1eeff41d4cbb64f5951e0c0f188ce824`
- Cloudflare Build ID: `ff6a6eed-eb29-4807-9410-f04c4bf00b7b`
- Cloudflare Version ID: `07eeee00-8226-4616-afdb-1124a7211dd9`

### Changed

- Restored the fixed `机会 / 雷达 / 订单 / 实盘 / 设置` bottom navigation while preserving the learning views under Orders.
- Kept simulation-capital reset discoverable from funds with one Settings execution point, open-position blocking, and historical trade/learning preservation.
- Added expandable pre-trade cards backed by the existing HTE31 dashboard payload: direction, trigger state and checks, entry zone/price, stop, TP1, TP2, risk/reward, support, counter-evidence, missing conditions, and invalidation rules.
- Restored or retained operator-critical account, Web Push, audit, scanner diagnostics, Gate credential deletion, reconciliation, risk visibility, strategy lineage, and mobile-safe Emergency Stop capabilities.

### Deliberately unchanged

- No strategy trigger, paper/live sizing rule, risk limit, D1 schema/history, scanner cadence, position-protection rule, Gate credential model, foreground market producer, or execution authority changed.
- No new periodic polling, duplicate destructive reset, duplicate live control, or second risk path was added.
- The deployment-version safety lock may disable new Gate entries; existing positions continue normal protection and reconciliation, and Auto Live is not silently re-enabled by deployment automation.

### Verification

- Focused capability/UI/reset regression tests: 24 passed.
- Strategy/risk/migration suite: 189 passed.
- Production build/UI safety suite: 102 passed.
- ESLint, TypeScript, Wrangler production dry-run, and compatibility audit passed.
- PR CI run 345 and merged-main CI run 346 passed.
- Cloudflare Workers Build succeeded and promoted the recorded version to production; the public production root served the owner login surface successfully.

## 2026-08-30 — HTE 3.1 paper economics and negative-cell containment

### Changed

- Replaced the HTE 3.1 10U / 3x / 25%-margin micro-position path with stop-defined 30–50U risk for the 1,000U paper account.
- Added adaptive isolated paper leverage up to 50x with liquidity, volatility, quality and liquidation-buffer limits.
- Added fee-aware TP2 adjustment targeting 50–200U net instead of accepting sub-dollar full-target outcomes.
- Preserved READY-signal frequency by resizing and adjusting TP2 before economic rejection.
- Added trader/regime/direction performance cells: three straight losses or four proven-negative samples pause only that cell, not the full strategy.
- Closed and open order cards show original stop, leverage, margin, notional, planned loss, TP2 projected net and realized R.
- Tightened post-exit learning so a temporary rebound followed by adverse continuation is not called a fake stop, and a TP1-achieving timeout is not described as wholly unfulfilled.

### Deliberately unchanged

- Gate live enablement and real-order sizing remain separate from the HTE 3.1 paper-sizing formula.
- Existing historical paper orders are not rewritten.
- Entry setup thresholds are unchanged; negative evidence gates only the specific proven-losing trader/regime/direction cell.

### Verification

- Pending focused, full-suite, CI and production deployment verification on the feature branch.

## 2026-08-28 — Foreground/background market producer split

PR: `#40 Move foreground market reads onto background snapshots`

### Problem

- The prior load-shed work reduced retry amplification but left the underlying duplication intact: the background scanner already computed public Gate market analysis while normal phone polling could independently recompute the same symbol through `/api/market`.
- `/api/scanner` also refetched Gate/global-risk data instead of consuming the background scanner's latest result.
- One deep selected-symbol request could fan out to 10+ public Gate endpoints at once; foreground and background producers could therefore overlap and recreate Worker pressure.
- A top-level navigation could still remain visually blank while a Worker navigation request hung, because the Service Worker had no explicit navigation deadline.

### Changed

- The MarketScanner Durable Object now persists a foreground read model after each background scan plus per-symbol deep packets.
- Cloudflare-production `/api/scanner` is a snapshot consumer; it does not refetch Gate/global-risk data when the background model is missing.
- Cloudflare-production `/api/market` is a snapshot consumer; it does not fall back to `analyzeGateSymbol()` when the background model is missing/stale.
- Missing/stale deep evidence is explicitly degraded; coarse universe data may remain visible, but no current decision is fabricated.
- `analyzeGateSymbol()` public upstream fan-out is bounded to 4 concurrent endpoints, and position quote candle fan-out uses the same bounded helper.
- `/api/market` and `/api/scanner` are treated as lightweight read-model calls by the pre-hydration guard instead of competing with Strategy/D1 research reads for the heavy slot.
- PWA shell advances to v7; top-level navigation has a 5-second network deadline before the dedicated recovery shell takes over.

### Deliberately unchanged

- No Strategy 2.0 trigger, Playbook threshold or Regime logic changed.
- No position sizing, leverage, risk budget or portfolio gate changed.
- No Execution Engine, Order Lifecycle, live coordinator or Gate private-mutation authority changed.
- Direct Gate analysis remains available only outside the normal Cloudflare-production foreground polling path and for explicit/manual scan workflows.

### Verification

- PR strategy/risk/migration suite passed before final documentation reconciliation.
- PR production build/UI safety suite passed before final documentation reconciliation.
- Merged `main` CI and Cloudflare production deployment must be verified after merge.

---

## 2026-08-28 — Root-load shedding for recurring 503 / iOS black screen

PR: `#39 Stop foreground retry storms before hydration`

### Problem

- `/api/market` and `/api/v2` were still able to fail together with Cloudflare non-JSON 503 responses.
- The existing React-mounted stability layer started after hydration and could therefore lose the race against independent startup pollers.
- Once Worker pressure produced a 503, the old safe-GET retry loop could immediately replay failed reads and amplify the same pressure it was trying to recover from.
- A repeated recovery/navigation loop could then contribute to iOS standalone black-screen behavior.

### Changed

- Added a parser-time/pre-hydration runtime guard that owns same-origin read admission before React pollers start.
- Heavy UI reads are serialized to one at a time, while a second slot remains available for lighter status reads.
- Added minimum foreground refresh spacing: selected market 30s, Strategy 2 dashboard 45s, research diagnostics 5m.
- Replaced immediate 429/5xx replay with a 15s circuit breaker, extended to 30s after repeated edge failures.
- Added server-side same-isolate admission for `/api/market` and `/api/v2`; a competing heavy read now returns explicit load-shed/degraded output instead of competing until Worker failure. `/api/market` prefers its explicitly labeled last-known-good snapshot when available.
- Reduced interactive-only Strategy 2 learning history to 400 rows and bounded recent opportunity/thesis payloads to 60/40. Background decision learning retains its deeper history.
- PWA shell advanced to v6 and now caches the early runtime guard.
- Recovery navigation now backs off 4s → 8s → 16s → 30s instead of rapidly retrying.
- Added asset-load and blank-shell recovery handoff for iOS PWA rendering failures.

### Deliberately unchanged

- No Strategy 2.0 trigger or Playbook threshold changed.
- No Regime logic changed.
- No position sizing, leverage or risk limit changed.
- No Execution Engine, Order Lifecycle, live coordinator or Gate mutation authority changed.
- API caches/fallbacks may be shown only when explicitly labeled degraded/stale; no stale value gains live decision authority.

### Verification

- Strategy/risk/migration suite must pass before merge.
- Production build/UI safety suite must pass before merge.
- Merged `main` CI and Cloudflare production deployment must be verified after merge.

---

## 2026-08-28 — Learning Arena added as read-only observability

Production merge commit: `6c3fe62c0fe9e4507c8d734212f6cd74c0e6fc23`  
Cloudflare Version ID: `76cc7a12-3881-4ac9-9e44-2b9e7c9f40af`

### Changed

- Added Strategy 2.0 Learning Arena.
- Added rolling all/20/50/100 result views, forward-vs-pre-forward evidence, rolling expectancy/profit-factor trend, exit-pattern diagnostics, Playbook diagnostics, and Regime × Playbook × side heatmap.
- Added a cached research-only API for the Arena.

### Deliberately unchanged

- No new trading authority.
- No risk increase.
- No strategy auto-promotion.
- No Execution Engine or Order Lifecycle authority transfer.

### Verification

- Strategy/risk suite passed.
- Production build/UI safety suite passed.
- Cloudflare production deployment succeeded.

---

## 2026-08-28 — Persistent-loss containment and data-degradation reduction

Production merge commit: `a1c7ef5baf59c4f612f5f4c35e3df9ab6cd976bf`  
Cloudflare Version ID: `9efe620a-c09e-4d56-98a7-334f64350447`

### Problem

- Strategy 2.0 had accumulated a materially weak completed sample and continued to generate losing simulated trades.
- `/api/market` and `/api/v2` could degrade together under Worker/Gate/D1 pressure.
- Client-side retries alone could not control server-side fan-out or repeated heavy learning reads.

### Changed

- Added a cached Strategy 2.0 execution governor using completed `contract_v2` results and recent performance.
- Added `DEFENSIVE` behavior when aggregate/recent performance is weak.
- Exploration intents are observation-only at the order-creation boundary.
- Partial-risk intents are fail-closed until V2 fractional risk multipliers are consumed end-to-end by contract sizing.
- Defensive execution only permits already-validated high-conviction cells with sufficient sample support and positive learned expectancy.
- Bounded deep-scan target concurrency to 2.
- Added partial-source isolation to `/api/v2` and cached/bounded heavy interactive learning/counterfactual reads.
- Added a short last-known-good fallback for `/api/market`, explicitly marked degraded/stale.

### Deliberately unchanged

- Existing positions continue normal lifecycle.
- No forced close was introduced.
- No leverage increase.
- No Gate mutation-path changes.
- No hard-risk relaxation.

### Verification

- Strategy/risk/migration tests passed.
- Production build/UI tests passed.
- Merged `main` CI passed.
- Cloudflare production deployment succeeded.

---

## 2026-08-28 — PWA/Worker black-screen recovery hardening

### Problem

- A previous 1102 recovery path could reuse dynamic root HTML across deployments and leave iOS with an old HTML/new asset mismatch, producing a black screen.
- Startup data modules could still create a burst of requests before the client stability layer fully controlled them.

### Changed

- Dynamic root HTML stopped being used as an unsafe stale fallback.
- Recovery now uses a dedicated reconnect shell instead of old application HTML.
- API startup concurrency/backoff was reduced and coordinated.
- Real-time API data remains network-authoritative; stale data is never silently presented as live truth.

### Deliberately unchanged

- Strategy logic and risk authority were not changed.

---

## 2026-08-28 — Playbook usage diagnostics

### Changed

- Added read-only Playbook usage/coverage diagnostics so `11/12` learning coverage can be traced to the exact missing Playbook and its evaluation/TRADE/WATCH/REJECT/completed-sample funnel.

### Deliberately unchanged

- No Playbook threshold was loosened to force 12/12 coverage.
- No execution/risk behavior changed.

---

## 2026-08-28 — Regime candidate/stability correction

### Problem

- Candidate Regime could disappear behind a hard score threshold.
- Stability could saturate too high because classifier separation was being treated as market stability.

### Changed

- Preserved a full Regime probability view and explicit runner-up candidate.
- Candidate state no longer depends on the old hard display threshold.
- Stability incorporates transition pressure/persistence rather than only classifier separation.
- Candidate momentum / early migration pressure contributes before a formal Regime switch.

### Deliberately unchanged

- Formal Regime switching remains guarded; candidate evidence does not force premature state flips.

---

## 2026-08-27/28 — Strategy 2.0 intelligence convergence

### Changed

- Kept a single **Sentinel Strategy 2.0** product/strategy identity.
- Added current→candidate Regime migration observability.
- Added dynamic Playbook expert-weight diagnostics.
- Added shadow win-probability / Net EV / decision-confidence / model-disagreement / OOD diagnostics.
- Added persistent WATCH/REJECT counterfactual archive statistics.
- Added portfolio Regime×direction concentration proxy.
- Unified Opportunity/Radar/Orders presentation around market intelligence, decisions, portfolio risk, thesis, execution and learning.

### Deliberately unchanged

- Intelligence is shadow/explanatory only.
- `liveDecisionAuthority=false`.
- Intelligence cannot increase risk, override hard safety, or auto-promote.
- Existing Strategy 2.0, portfolio risk, Execution Engine, Order Lifecycle, Live Master Switch and Gate safety chain remain authoritative.

---

## Historical migration policy

Sentinel V2/Strategy 2.0 learning must not reuse obsolete legacy transaction/learning samples as if they were current-strategy evidence. Necessary system configuration may be retained, but old-version learning memory is not a valid basis for current strategy adaptation.
