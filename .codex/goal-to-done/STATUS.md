# Status

## Primary-observation diagnosis — verified locally, release pending

- Screenshot: failed breakout94 evaluations /1 triggered /1 qualified /0 selected; exhaustion94/18/2/18. Current main`62f863d0` selection sorts qualification first, then trigger, then evidence score; no named exhaustion bonus. Thus a qualified failed-breakout setup can lose only at same-symbol comparison to another qualified setup. The screenshot's exact winner/symbol/score was not retained by the old cumulative counters and is not reconstructed or invented.
- `selectedSignals` counts selected AND triggered even while qualification fails. It is a priority observation count, not strict post-qualification admission. Rename operator text to 优先观察（含待确认） and 通过条件; preserve original counters and historical window.
- Retain the latest qualified comparison (symbol/time/winner/score/selected) per setup inside the existing DO activity save, record same-symbol selection loss as a distinct reason, and display it when available. Old missing event details are labeled honestly. A strategy with raw signals and zero closed samples now says 观察 rather than 暂无机会.
- Strategy triggers, evidence ranking, execution/risk policy, positions, epoch, D1 and scanner cadence are unchanged. This does not prove restored frequency:94 evaluations with only1 raw trigger remains a genuine low-trigger observation requiring actual pattern evidence before tuning.
- Local direct36+architecture7 and production build/UI115 passed; TypeScript and ESLint passed. Existing authorized PR/CI/deployment path next. No production code changed yet.


## Reliability follow-up — production verified

- PR #138 merged as `62f863d020b4198744e1ef62907dd627bda96bb7`; PR verify `33944950244`, production verify/deploy/operations `33945003862` all passed. Worker `ba4caf2b-d4ea-493c-8567-cd6b538c5923`, client `assets/page-Di6F9607.js`. CI: direct34 + architecture7 + signals231 + UI115, zero failures.
- At `2026-09-05T04:38:53.967Z`, Cloudflare account-wide D1 analytics reported UTC-day reads68,452/writes753; rounded-out recent24h reads1,129,862/writes4,298 (about22.6%/4.3% of the5,000,000/100,000 free daily limits). These are observed analytics, not the30,000 app planning estimate. Analytics can lag and the rolling interval is rounded outward to hourly boundaries.
- Read-only progress probe passed: scanner lastSuccessAt advanced1788583072555→1788583129223; position nextRunAt1788583097868→1788583144709, lastSuccessAt also advanced1788583035970→1788583098060. Both managers live, no runtime error/circuit. Existing every-minute scheduler recovery preserved; new operations audit runs after deploy and every six hours.
- V6 paper cutover still completed, active version`direct-market-brain-v6-open-coverage`, target null, legacy holdings0. Reliability patch did not create a new epoch or mutate trading policies.
- Missing-page fix and same-version/same-epoch display fallback are deployed. Full old regression gates retained. No active code/testing/release task remains. Bounded observations do not prove a full future day of uptime or that every possible old failure cannot recur; scheduled checks expose health/capacity failures in Actions.
- Owner-authenticated visual browser replay was not performed; do not claim it. Production proof is in successful workflow and PR #138 comment. Do not redeploy only to record this proof.


## V6 production verified; reliability follow-up active

- PR #137 merged as `440d59801137ed8dedcfe5f508c7c2dc6dcd0d40`. Production workflow `33944293649` passed. Worker `3e8c67c0-17d1-4792-b86b-9bc22d22cdb7`; client `assets/page-BOG8g7a_.js`.
- Migration0024 complete: active `direct-market-brain-v6-open-coverage`, target null, legacy open PAPER positions zero. Configured-universe coverage and removal of fixed position count caps are deployed; total planned risk, D1 admission, correlation and live boundaries remain.
- Latest owner asks for actual D1 daily capacity, 24-hour continuity, missing-page-data fixes, and preservation of past regressions. Found concrete client defect: partial successful API responses replace good sections with null; server isolate cache cannot cover a cold isolate.
- Follow-up adds display-only same-version/same-epoch source fallback, stale labels, request deadlines, and bounded read-only CI checks of scheduler timestamp advancement and account-wide D1 read/write analytics. Reuses existing CI credentials; no runtime token, new D1 counter ledger, trading change, or new epoch.
- PR #138 passed full verify (`33944950244`) and merged as `62f863d020b4198744e1ef62907dd627bda96bb7`; production deployment and actual operations audit are pending.
- Do not call the 30,000 row planning estimate actual usage. Actual analytics and new production proof are still pending. A bounded advancing check cannot prove a full future day of uptime.

## Current V6 task — configured scan coverage and risk-based paper capacity

- User asked to remove the fixed 15/6 scan restriction and three-position bottleneck. Local implementation scans the existing configured universe (default 30; existing settings maximum 50), selects the least recently evaluated symbol from existing Scanner snapshots, and removes the top-15 pruning of the read model. One deep target per phased job and existing request/write cadence remain unchanged; this is not simultaneous whole-market deep scanning.
- Fixed PAPER total and same-direction counts are removed. Aggregate planned stop risk remains 15%, normal accepted trade risk remains 3.5%, and single-symbol, correlation, margin, learning, fresh-quote and live boundaries remain. Usually four normal-risk trades fit; this does not grant unlimited exposure or demonstrate restored historical trade frequency.
- D1 capacity uses prospective holdings and the day's peak from immutable decision snapshots of today's entries/exits; closing positions cannot reset the estimate downward. The read reuses the bounded daily admission query, creates no new D1 write stream, and retains 22,000 entry admission / 30,000 app hard budgets. The six-position planning assumption is a budget calculation, not a replacement six-position trading cap.
- V6 / additive migration `0024` prepares the established major PAPER cutover. No three-strategy pattern or Gate/live policy is changed. Current remote main rechecked at V5 `8badc27b`; release will use the user's existing GitHub/CI/Cloudflare authorization after verification.
- Local verification passed 34 Direct + 7 architecture, 225 signal/risk/migration and 115 build/UI/safety checks, plus TypeScript, ESLint and diff checks. Feature commit `b4970e03796e3ef5bf243fa83b5a549f1190deb2` in PR `#137`; PR CI `33944213722` passed including Wrangler dry-run, then merged as `440d59801137ed8dedcfe5f508c7c2dc6dcd0d40`. Production deployment is in progress; V6 is not yet production-verified.

## Completed release — V5 production deployed and verified

- User instruction: publish now, quickly. Current remote `main` rechecked at `b97baf1f65339dd03221f5207b98347df67d8fe6`; its source tree matches the local tested base. Reuse the prepared 39 Direct/architecture + 224 signal + 115 build/UI/safety checks and existing CI gates.
- Release branch: `fix/v5-entry-integrity-chinese-ui`. Publish the existing patch only; merge after green CI and verify production health plus PAPER cutover. No new live/funding authority and no new strategy edits.
- Published feature commit `94279a44f53c1e96db56d2d2ec024fdc0e521aab`, PR `#136`; PR CI run `33942658322` passed including Wrangler dry-run. Merged as `8badc27bfd678f9317bbbb1301bdda30fed834c7`; production workflow `33942706243` completed successfully at 2026-09-05T03:47:06Z.
- Worker `fefcf159-98eb-4e9e-b922-b8be62877ca5` deployed; immutable client `assets/page-eomFNgKd.js` and bounded scheduler health passed the existing CI production probes. Deploy job `101243138701` provides the exact logs.
- Migration `0023_direct_market_v5_entry_integrity_cutover.sql` applied. Production D1 returned `status=completed`, `active_brain_version=direct-market-brain-v5-entry-integrity`, `target_brain_version=null`, `legacy_open_positions=0`. Old paper archive and clean epoch are verified; the paper cutover does not mutate Gate/live positions or funds.
- Production evidence is recorded on PR `#136` and in the successful workflow. No further runtime change or deployment is needed for this task. The implementation record below is historical pre-release evidence; its local-only wording no longer describes current production.

## Pre-release implementation — V5 entry integrity and Chinese UI locally verified

- User authorized the bounded optimization after the diagnostic/UI task below. Local version is `direct-market-brain-v5-entry-integrity`; it has NOT been pushed, deployed, or applied to production data. Last known deployed main remains V4 `b97baf1f` / workflow `33938908870`.
- Entry now filters unfinished/non-finite five-minute candles before setup evaluation, structural stops and correlation. Synthetic regressions prove an unfinished candle cannot authorize a trade or change its stop/targets.
- Resonance rejects a strong opposing tactical trend, requires a completed close beyond the previous two-bar structure, and restores benchmark/breadth plus actual classified-regime admission using existing scanner context. It still has no universal volume-spike requirement; no new market producer was added.
- Every setup uses its actual classified environment rather than hardcoded transition/liquidation labels. Removed exhaustion's unconditional 15-point selection bonus; overlapping qualified setups now rank by their evidence score. The HT3-R/HT4 core patterns and existing data/macro/portfolio/learning safety thresholds are unchanged.
- Structural invalidation stays outside the actual swing with its existing ATR padding. Removed the shared 3% clamp; invalid or over-5% structural plans are rejected, not moved inward. The final fresh-quote boundary rechecks the 5% price-distance limit without changing the stored stop or account risk sizing.
- Daily UI keeps the compact operating summary, contribution, orders and twelve-hour review. Locations, labels, chart markers, diagnostic states and known technical wording are translated through one small display-only module; stored IDs, ticker symbols, owner input, auth and live controls remain intact. Complete diagnostics remain collapsed under Management.
- Release manifest/migration `0023` prepares the existing fresh-quote forced PAPER archive and clean epoch. No old migration or historical order was edited, no live reset is added, and no cutover has run. Worker/UI/API/probes use the canonical release constant to avoid stale verification markers.
- Verification: `npm run test:direct` 33 core + 6 architecture passed; `npm run test:signals` 224 passed; `npm test` production build + 115 UI/safety/migration tests passed; ESLint, TypeScript and `git diff --check` passed. CI now includes `test:direct`, which the default verify job previously omitted.
- Limits: No exact production-order replay, visual browser proof, remote CI or production proof in this task. Production query access remains blocked by the previously cancelled network approval and absent configured owner-query credentials; do not bypass it or ask the user to supply an order ID. Synthetic defects are proven, but are not a unique attribution of the screenshot's loss, demonstrated profitability or restored historical frequency.
- Next: after release authorization, use the existing single PR/green CI/merge/deploy route and verify immutable assets, health and D1 cutover (V5 active, no pending target, zero legacy open PAPER positions). Do not restart strategy research or rebuild the repository.
- Updated UTC: 2026-09-05.

## Previous task — compact decision UI locally verified; strategy identity audited, not retuned

- Local-only UI change removes the daily Brain hero's raw confidence/probabilities, English location, empty price grid and technical blocker string. A compact operating summary distinguishes loading/degraded/reset/scanner-paused/risk-paused/candidate states without claiming a signal is a filled order. The existing complete evidence and execution reason are collapsed under Management; no new polling or execution path.
- Historical comparison: retained `hte31-research-strategies.ts` HT3-R and `hte31-advanced-traders.ts` HT4 contain largely the same core pattern thresholds as V4. They are not evidence that the owner's entire original profitable system was restored. V4 wraps them with stricter/different admission: data 0.68→0.72, macro ceiling 0.98→0.85, ATR 0.15–3.2%, confidence 70 and calculated edge 0.55R, plus the current portfolio/learning/per-setup guard path.
- Same-input synthetic probes based on the existing Direct Brain failed-breakout/exhaustion fixtures: both legacy evaluators are READY at dataQuality 0.70 or macroEventRisk 0.90, while V4 rejects the corresponding setup at the data/macro gate. Normal-input controls qualify in both. This establishes behavioral differences, not the production frequency attribution or a reason to disable safety gates blindly.
- Resonance uses HT5-R timing, not the complete first Resonance system. Its weak one-bar resume and one-sided 15m bound also exist in the retained HT5-R source; V4 additionally omits HT5-R benchmark/breadth and classified-regime admission. A identical synthetic packet with 15m=-0.9, 1h=0.8, 4h=0.75, benchmark=-2 and advancing breadth=0.2 leaves legacy HT5-R watching but V4 LONG.
- Structural-stop synthetic probe: entry 100.18, prior 14-bar low 96.60 gives the legacy structural plan stop 96.462657, but V4 admits LONG with stop 97.1746 (exactly 3% below entry and above the prior low). The legacy signal in that probe is watching for regime reasons; compare its generated plan, not a historical executed trade. Strategy/stop code was NOT modified.
- Verification: `npm test` passed production build and 113 UI/safety tests before the final extra summary-state test; final targeted UI/Must-Keep/architecture run passed 28/28 including that test. `npm run test:signals` passed 224/224; TypeScript, ESLint and `git diff --check` passed.
- No commit/push/CI/production deployment, strategy tuning, database write, reset, position change or Gate/funding action in this task. Last known deployed main remains `b97baf1f` (workflow `33938908870`), not these local UI edits.
- Production-order replay remains blocked by the prior network access approval cancellation and absent configured production-query credentials. Do not request an order ID from the user: use the existing owner-history list route to match the screenshot's times/strategy/prices once normal read access is available. Do not bypass owner authentication or extract CI secrets.
- Next bounded strategy change, after authorization: reproduce the bad-admission and clamped-stop cases in regressions; correct missing market-fit/structural invariants without blanket gate relaxation or another strategy rewrite. Preserve major-release paper archival and live boundaries if trading semantics change.
- Updated UTC: 2026-09-05.

## V4 restored core strategies — production deployed

- Release: PR `#133` merged as `525a02ff`; verification correction PR `#134` merged as `ebc6284a`; final production workflow `33938628363`.
- Restored traceable entry behavior instead of tuning the Sep-4 simplified substitutes: `HT3-R_FAILED_AUCTION`, `HT4_EXHAUSTION_ANTI_CROWD`, and `RESONANCE_V1_WITH_HT5-R_TIMING`.
- Raw activity is intentionally broader than qualified entry: failed-auction activity counts sweep/reclaim before its own volume/reversal gates, and resonance no longer inherits a universal volume-spike requirement. HT4 no longer treats a 24-hour move as exhaustion and requires mature ATR stretch, at least three crowding/divergence sources, failed continuation, and a completed 5m reversal.
- Added per setup/direction/regime loss isolation: three independent consecutive losses pause the exact cell immediately; a negative four-sample cell also pauses; other strategies continue; only one high-quality revalidation may enter after quarantine.
- Added actual average winner R, average loser R, and realized payoff ratio to each strategy card. The 12-hour summary no longer implies that immediate loss protection waits for the next report.
- Major paper cutover is declared by additive migration `0022_direct_market_v4_restored_core_cutover.sql`: old paper holdings must close at fresh quotes as `version_reset`, archive, and start a clean epoch. Gate/live tables and controls remain untouched.
- Verification passed: Direct/architecture 29/29, signal/risk/migration 224/224, production build/UI/safety 112/112, TypeScript, ESLint, build, migration replay, remote Wrangler dry-run, immutable asset, bounded production health, and paper cutover proof.
- Migration `0022` completed. Production D1 proved `status=completed`, `active_brain_version=direct-market-brain-v4-restored-core`, `target_brain_version=null`, and `legacy_open_positions=0`. Production Worker version: `f415e87f-5a59-4f46-accf-fa2eec51a392`.
- Release-path lesson retained: the first deployment succeeded but its post-deploy probe still hardcoded the retired V3 marker, so proof failed and skipped cutover verification. The probe now derives the expected version from the canonical source constant so future major versions do not repeat this false failure.
- Updated UTC: 2026-09-05.

## Truthful per-setup activity — production deployed

- Release: PR `#131`, production commit `113bf39a8515d4a1cae7d9135c91a4c75654107a`, workflow `33894121421`.
- Root cause confirmed: every scan evaluated all three setups, but the 12-hour recorder incremented only `candidate.setup`; the displayed `7 + 79 + 47 = 133` was a partition of primary selections, not three evaluation totals.
- A startup window with only about 57 minutes of coverage was also marked complete at the next fixed UTC boundary and displayed as a full 12-hour result.
- Implementation now carries all three setup evaluations, counts trigger/qualification/selection/entry-block/open separately, measures capped continuous runtime coverage, rejects legacy counters, and refuses to complete a partial window. No D1 write or strategy/risk/live rule changed.
- Verification passed: focused Direct/activity/architecture 26/26, strategy/risk/migration 224/224, production build/UI/Must-Keep 112/112, TypeScript, ESLint, `git diff --check`, remote Wrangler dry-run, immutable asset, bounded health, and paper-cutover proof.
- Production deployed with no pending migration. The active brain remained `direct-market-brain-v3-resonance-three`, legacy open positions remained zero, and the feature deployment Worker version was `8e978ade-5799-4625-95c6-5398081c5f22`.
- Updated UTC: 2026-09-04.

## Core-three resonance dashboard — production deployed

- Release: PR `#129`, production `main` `0736a2259103e4fdf602eedccb169a96d5e5a14a`, workflow `33865500814`.
- New authority version: `direct-market-brain-v3-resonance-three`. The three new-order setups are volume-force failed breakout, exhaustion reversal, and multi-timeframe comprehensive resonance; Dennis is historical only.
- Added current-version per-setup performance, Scanner-owned fixed 12-hour activity buckets, deterministic review/next action, and setup identity on paper order cards. No LLM runtime or recurring D1 write was added.
- Replaced the five abstract/operator tabs with `大脑 / 订单 / 管理`; detailed decision evidence is collapsed, and complete review, reset, Gate credentials/control/reconciliation/Emergency Stop, account, push, audit, and runtime diagnostics remain reachable.
- Major paper cutover is declared by additive migration `0021`; the existing fresh-quote `version_reset` lifecycle will archive old paper positions and start a clean epoch. Gate/live remains untouched.
- Verification: Direct/performance/architecture 23/23; focused UI/migration/Must-Keep 45/45; strategy/risk/migration 224/224; production build/UI/safety 112/112; ESLint, TypeScript, build, and `git diff --check` passed.
- Remote CI passed the full verify job, Wrangler dry-run, additive D1 migration, Worker deployment, immutable-asset check, bounded production health checks, and paper cutover proof.
- Migration `0021_direct_market_v3_resonance_cutover.sql` applied successfully. Production D1 returned `status=completed`, `active_brain_version=direct-market-brain-v3-resonance-three`, `target_brain_version=null`, and `legacy_open_positions=0`.
- Production Worker version: `a998bdd9-1833-4535-9efd-22d4e82defc4`.
- Updated UTC: 2026-09-04.

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
