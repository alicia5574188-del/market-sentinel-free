# Status

## Automatic major-version cutover — production deployed

- Branch: `feat/automatic-strategy-cutover`, based on deployed `main` `aa4e461`.
- Added a single release contract for `direct-market-brain-v2-core-three`. Migration `0020` immediately blocks new paper entries and marks all currently open paper positions for fresh-quote `version_reset` archival.
- Both the entry boundary and Trade Manager enforce the release version. After the last paper close, the reset finalizer records the active brain version, creates a clean simulation epoch, and resumes entry; temporary quote failure remains safely pending for retry.
- Normal owner resets remain natural. Historical trades, immutable decision lineage, seven post-exit checkpoints through 12 hours, credentials, Gate/live orders, live controls, funding authority, and recurring D1 cadence are unchanged.
- Local verification passed: strategy/risk/migration 224/224, production/UI/safety 112/112, focused Direct Brain 21/21, reset/migration 19/19, production build, ESLint, TypeScript, and `git diff --check`. Local Wrangler dry-run was blocked by environment network approval; remote CI remains the release gate.
- Release: feature PR `#124`; production proof refinements `#125`–`#127`; current main `6c6b18c`.
- Final workflow run `33858569353` passed verify and deploy, including Wrangler dry-run, migration check, immutable asset, three bounded health probes, and the new D1 cutover gate.
- Production D1 proof: `status=completed`, `active_brain_version=direct-market-brain-v2-core-three`, `target_brain_version=null`, and `legacy_open_positions=0`. Two current-version positions opened only after the clean epoch resumed and are not legacy residue.
- Production Worker version: `bade6b32-a680-463c-b637-fadf44110ddd`.
- Updated UTC: 2026-09-04.

## Core-three return-to-purpose patch — production deployed

- Branch: `refactor/back-to-core-three-setups`, based on current `main` `d0451b98ce41e873d0a3d853b931da373f38f504`.
- Direct Market Brain v2 now evaluates only three explicit entry stories: volume-force failed breakout, exhaustion reversal, and the original Dennis trend breakout baseline. Setup-specific evidence is replayable and stored in every candidate/decision snapshot.
- Existing safety remains final: completed candles, data quality, liquidity, volume, funding, macro, ATR, structural edge, anti-chase, portfolio limits, one lifecycle per symbol, immutable stop/targets, and exact paper-to-live lineage.
- The daily UI exposes the chosen setup and score and compresses the settings summary to the three retained setups. Five operator tabs and every Must-Keep safety/owner capability remain reachable.
- No migration, recurring D1 write, forced close, fund action, credential/control change, live activation, or historical deletion was added.
- Production main is `aa4e461`; final GitHub Actions run `33854604328` passed verification and Cloudflare deployment. Production Worker version is `027625ca-41a6-4442-b50b-665a803ee83c`.
- Updated UTC: 2026-09-04.

## Clean adaptive-brain restart — locally verified

- Added additive migration `0019_adaptive_brain_fresh_start.sql`: it blocks new paper entries and requests a one-time forced archive reset without deleting any order or learning record.
- The Trade Manager skips old-policy review during this reset, obtains fresh Gate quotes, closes each old paper position as `version_reset`, creates all seven post-exit checkpoints through 12 hours, and finalizes a new simulation epoch only after every old position is archived.
- Normal future owner resets remain natural-exit resets. Gate/live controls, credentials, orders, funds, risk sizing, strategy decisions, scheduler generation, and recurring D1 writes are unchanged.
- Local verification passed: 224/224 strategy/risk/migration tests, 111/111 production/UI/safety tests, 18/18 focused reset/migration tests, TypeScript, ESLint with warnings only, production build, and `git diff --check`.
- Next: release through PR/green CI/merge, then verify production health, zero old open paper positions, restored starting capital, and resumed adaptive scanning.
- Updated UTC: 2026-09-03.

## Adaptive direct-market decision and position brain — locally verified

- Branch: `feat/adaptive-position-brain`, based on production `main` `7a71f77fa29d3e442d2e8a38a28e1a3eca101d3c`.
- The rotating deep cohort now ranks up to three fresh candidates together and can execute the best earlier candidate, rather than only the symbol that happened to finish last. Every entry is revalidated against a fresh quote, its original zone, structural invalidation, and current reward/risk.
- Accepted new orders lock `adaptive-position-v2`. Completed five-minute evidence emits `HOLD`, fee-aware `PROTECT`, or explained early `EXIT`; old open positions without that immutable policy marker retain their original lifecycle.
- Immediate current-round losses now affect entry admission without waiting 12 hours. Only complete independent 12-hour events can block a repeated failure signature or raise the global edge floor; no incomplete future path changes the model.
- Capacity remains three positions and 15% planned stop risk, with no more than two in one direction. Active accepted simulation trades remain at 3.5% risk; PAUSED and all existing hard safety boundaries remain intact.
- No schema, migration, recurring D1 write, Durable Object generation reset, live activation, live sizing change, fund action, forced close, or historical deletion was added. The index-adjusted app plan remains 30,000 rows/day, with new-order admission at 22,000 and 70,000 rows of free-tier headroom.
- Local verification passed: 224/224 strategy/risk/migration tests, 110/110 production/UI/safety tests, 18/18 adaptive direct-brain tests, TypeScript, ESLint with warnings only, production build, Wrangler dry-run, and `git diff --check`.
- Next: one PR, green CI, merge, automatic Cloudflare deployment, then production asset/health/scheduler/API verification.
- Updated UTC: 2026-09-03.

## Current-round/reset/risk patch — implementation verification

- Branch: `fix/current-epoch-reset-risk`, based on production `main` `224654490779147ca4508c0f6fad532572c39e08`.
- Current Direct Market Brain/version/epoch orders now exclusively drive current stats and risk evidence; prior closed orders remain available under a collapsed history archive.
- Owner reset is now a durable pending request: new paper entries stop, existing positions retain natural lifecycle, and the single Trade Manager creates the new epoch after the final close. Migration `0018` queues the requested reset on release.
- Every non-paused simulation risk state now uses normal 3.5% risk; PAUSED and all structural portfolio/liquidity/volatility/data/liquidation safeguards remain unchanged.
- No live activation, fund transfer, forced close, historical deletion, or recurring D1 write was added.
- Local verification passed: 224/224 strategy/risk/migration tests, 110/110 production/UI/safety tests, focused reset/direct-brain/full-migration checks, TypeScript, ESLint (warnings only), production build, Wrangler dry-run, and `git diff --check`.
- Next: push the patch, merge after green CI, then confirm migration-driven reset state, immutable production asset, `/api/hte31`, and scheduler health.
- Updated UTC: 2026-09-03.

## Direct Market Brain — implementation verified, release in progress

- Branch `prep/direct-market-brain` now implements the single `direct_market_brain` new-entry authority over a dynamic top-fifteen Gate USDT-perpetual universe, a rotating six-symbol deep pool, cross-market ranking, correlation-cluster blocking, and a three-position maximum.
- Every accepted paper order locks its location, three paths, direction, entry zone, structural invalidation, targets, risk state, portfolio checks, universe, and brain version in one immutable decision snapshot. Gate live eligibility requires that exact simulated snapshot and remains owner-controlled; no funding or live activation was performed.
- Old thirteen-strategy IDs and records remain readable history but are absent from the scanner and new-entry path. The daily UI now shows the direct market decision and top-fifteen radar while retaining the five main tabs, order economics/review, owner controls, and independent scroll-to-top behavior.
- Every close creates real `0/30/60/120/240/480/720`-minute observations. Incomplete or unavailable Kline windows get bounded exponential retry, retain explicit quality state, and never update learning; only a READY 720-minute path updates direct-brain evidence.
- Scanner/evaluation/diagnostic D1 writes are zero. The index-adjusted app budget remains capped at 30,000 rows/day, new orders stop at the 22,000 admission line including lifecycle reserve, and the account-wide release threshold remains 65,000 of the 100,000 free allowance.
- Local gates passed: 224/224 strategy/risk/migration tests, 110/110 production/UI/safety tests, direct-brain focused tests, full migration replay, TypeScript, ESLint (warnings only), production build, and `git diff --check`.
- Updated UTC: 2026-09-03T18:58:34Z.
- Next action: commit, push, apply additive D1 migration, deploy, and verify production health/API/runtime identity.

## Direct Market Brain — upgrade preparation complete

- Preparation branch: `prep/direct-market-brain`, based on current `origin/main` `64166992319e7036fbac7cbe07fd7140aa7c5441` (merged PR #111).
- Frozen implementation/release contract: `docs/DIRECT_MARKET_BRAIN_UPGRADE_PLAN.md`.
- New-order target authority is one deterministic direct market brain: dynamic fifteen-coin volume universe, all-candidate light scan, six-candidate cross-cluster deep scan, location/direction/target/invalidation judgment, and cross-coin portfolio selection.
- Capacity is fixed at no more than three total positions from the fifteen candidates, never forced full; one symbol/position, and any same-direction combination must pass correlation-cluster and portfolio stress checks.
- Raw 2/4/6-order loss streak rules are superseded: correlated overlapping orders count as one independent event, immediate account drawdown reduces exposure without rewriting the model, and 12-hour-complete evidence controls version changes. New authority starts at calibration risk and earns higher risk only from forward evidence.
- Every close must complete seven real post-exit checkpoints through 12 hours before it can affect versioned learning. Old thirteen-strategy records remain historical only and cannot control new entries.
- D1 audit found the old 27,360 estimate omitted index writes: the legacy path can conservatively reach 105,120 billed rows/day. The prepared replacement makes all fifteen-coin scanner/diagnostic writes zero, reserves at most 30,000 index-adjusted rows/day for this app, stops new-order admission at 22,000 including future obligations, and requires account-wide production metrics below 65,000.
- Prebuilt budget contract and passing test: `lib/direct-market-d1-budget.ts` and `tests/direct-market-d1-budget.test.ts` (3/3).
- One-pass implementation map, type contracts, exact file routing, staged tests and release checks: `docs/DIRECT_MARKET_BRAIN_EXECUTION_PACK.md`. Target formal model-active time is 75–105 minutes and total implementation-to-production time is 105–150 minutes, excluding external service delay.
- No runtime code, production behavior, current position, strategy/risk rule, Gate control, funds, database row, or Durable Object generation changed during preparation.
- Next action: after allowance reset, start from `docs/DIRECT_MARKET_BRAIN_EXECUTION_PACK.md` with `GPT-5.6 Sol 极高`, implement each prepared layer, run one final full suite, then CI/deploy/production/D1 verification.

## Strategy Center and historical memory — locally complete

- Started from current `origin/main` plus the reviewed preparation commits.
- Implemented the dedicated Strategy Center, canonical cross-surface labels, truthful historical-memory states, bounded dashboard/health reads, cold-reload last-good display, scroll isolation, and focused regressions.
- Local verification passed: strategy/risk/migration 221/221, production build/UI 110/110, focused resilience/UI 26/26, ESLint, TypeScript, Wrangler dry-run, and `git diff --check`.
- Local feature commit: `4b87beb` (`feat: add resilient strategy center`).
- Release is blocked before push: this environment rejected writing the commit to the configured GitHub remote without a separate explicit source-export approval, and Wrangler has no authenticated Cloudflare session. Production therefore remains unchanged.
- Current production is still running, but the old health path reproduced its intermittent latency: one 8-second timeout followed by HTTP 200 in 1.27 seconds; both schedulers were `live`, errors were null, and the scanner circuit was closed.
- No fund action, risk/live authority change, migration, D1 recurring write, or Durable Object generation reset is authorized.

## Preparation baseline

- Preparation branch: `prep/strategy-center-history-memory`.
- Scope, exact files, data states, UI rules, tests, D1 constraints, and one-pass release order are fixed in `docs/STRATEGY_CENTER_HISTORY_MEMORY_PLAN.md`.
- The same prepared upgrade now includes the reproduced transient-503 boundary: one 20-second health timeout followed by a healthy 15.2-second response while both schedulers remained live. Main reads will be split, deadline-bounded, and last-good capable.
- No runtime code, production behavior, D1 write path, strategy, risk, live control, or deployed asset changed during preparation.
- Next action after the five-hour allowance resets: implement from current `main` using `极高`, complete all local gates, then PR/CI/merge/production verification.

## Strategy brain lifecycle — production deployed

- Pull request: `#109` — `feat: add strategy family lifecycle brain`.
- Feature commit: `e31d7521374bab75894f2da67904de51d2a78653`.
- Production merge commit: `a92a516dd12f960a961814343dc88c9fa33632cf`.
- Runtime API identity: `resonance-v5-strategy-lifecycle`.
- Organized all thirteen legacy IDs into nine canonical strategy families with stable variant names/tags. Existing IDs, trades, learning, reviews, and Gate lineage remain unchanged.
- The router now emits at most one executable variant per family/symbol/cycle and preserves suppressed same-family alternatives for explanation and learning.
- Added equal health states for every strategy, including HT4: learning, active, underperforming, degraded, starved, regime-wait, retest, and paused. Recent decay now reduces router evidence score; no strategy has a freeze or permanent advantage.
- Added a final closed-order verdict after the existing 12-hour observer completes: valid trade, no-trade, wrong direction, early/late entry, early/late exit, risk-plan mismatch, or insufficient evidence. The verdict states the best observed profit path and whether the exact trade should have existed.
- Added nine-family health/action UI, exact family/variant labels on paper and live lineage, and retained all thirteen variants in the same capital-backed paper brain.
- No D1 schema/migration or recurring write was added. PR #109 historically reported 27,360 logical rows/day; the later Direct Market Brain audit found that figure omitted billed index writes and supersedes it for quota decisions.
- Local verification: strategy/risk 217/217; production build/UI/Must-Keep 109/109; ESLint, TypeScript, and `git diff --check` passed.
- PR CI run `33716373058` / job `100526308099` and merged-main CI run `33716448405` / job `100526529930` passed, including Wrangler production dry-run.
- Production served immutable asset `assets/page-BF9gQ5KC.js` with the nine-family lifecycle UI. Two advancing `/__health` probes returned `ok: true`; both schedulers stayed live, all errors were null, and the scanner circuit stayed closed.

## D1 daily-write budget — PR #108

- Active paper positions remain evaluated every 15 seconds; unchanged holding telemetry now persists every 60 seconds.
- TP1 protection, stop, TP2, timeout, close, learning, and recovery writes remain immediate.
- PR #108 regression-tested 27,360 logical rows/day at the configured maximum. The later index-aware audit supersedes its claimed headroom because D1 also bills written index entries.
- Future upgrades must keep planned recurring writes at or below 60,000 rows/day and update the budget test when adding any D1 write path.
- Local verification: strategy/risk 208/208; production/UI/Must-Keep 109/109; ESLint, TypeScript, build, and `git diff --check` passed.

- State: production-deployed
- Updated UTC: 2026-09-03T04:53:48Z
- Branch: `feat/strategy-brain-lifecycle`
- Pull request: `#109` — `feat: add strategy family lifecycle brain`
- Feature commit: `e31d7521374bab75894f2da67904de51d2a78653`
- Production merge commit: `a92a516dd12f960a961814343dc88c9fa33632cf`
- Runtime identity: `resonance-v5-strategy-lifecycle`
- Production URL: `https://market-sentinel-free.alicia5574188.workers.dev`

## Previous unified-paper foundation retained

- Unified HT1–HT5, HT1-R/HT2-R/HT3-R/HT5-R, and HT6–HT9 remain in one thirteen-strategy paper execution pool; HT4 now follows the same lifecycle rules as every other strategy.
- Removed all current-cycle shadow trade creation/advancement. Strategy evidence and router ranking now come from actual closed paper orders.
- Made the strategy brain's selected candidate the only executable paper candidate and preserved the same strategy/learning lineage for Gate live.
- Increased paper/live capacity to five positions, at most three per direction, with a 20%-equity total planned paper stop-risk envelope.
- Changed paper margin to an 8% target with a 35% liquidation-safe fallback and retained adaptive leverage up to 50x.
- Preserved Entry Quality, historical-sample eligibility, last-trustworthy-snapshot degradation, five-tab UI, owner controls, Gate safety, paper history, and all open-position lifecycles.
- Required no new migration; no historical trade, learning, shadow row, account, credential, live-order, or simulation-epoch data was deleted.

## Explicitly unchanged

- Existing positions, stop/TP lifecycle, paper account history, credentials, owner controls, reconciliation, safety locks, and Emergency Stop.
- No automatic fund transfer or live activation. The owner will fund only after actual positive simulated growth.
- No auto-switch, automatic hedge, or silent fallback to a lower-ranked strategy when the brain's selection fails final execution checks.

## Verification evidence

- Local: strategy/risk/migration suite 217/217; production build/UI/Must-Keep suite 109/109; TypeScript, ESLint, build, and `git diff --check` passed.
- Final PR CI: Sentinel V2 CI run `33716373058` / job `100526308099` passed.
- Merged-main CI: run `33716448405` / job `100526529930` passed.
- Production served immutable client asset `assets/page-BF9gQ5KC.js` containing `9 个策略家族由大脑择优` and `SF09`.
- Two `/__health` probes returned HTTP 200 with `ok: true`; Position Monitor and Market Scanner success timestamps both advanced, both remained `live`, `lastError` and `schedulerError` were null, and the scanner circuit remained closed.

## Next action

- Collect actual capital-backed paper-order evidence from all thirteen strategies. Do not fund Gate or infer owner approval; the owner decides after actual positive simulated growth.
- Use `docs/QUANT_SYSTEM_MASTER_HANDOFF.md` as the first entry point for every future quantitative-system task.

## Blockers

- None.
