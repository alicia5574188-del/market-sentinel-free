# Status

## D1 daily-write budget — PR #108

- Active paper positions remain evaluated every 15 seconds; unchanged holding telemetry now persists every 60 seconds.
- TP1 protection, stop, TP2, timeout, close, learning, and recovery writes remain immediate.
- Regression-tested recurring budget at the configured maximum: 27,360 rows/day, leaving 72,640 rows beneath the 100,000 free daily allowance.
- Future upgrades must keep planned recurring writes at or below 60,000 rows/day and update the budget test when adding any D1 write path.
- Local verification: strategy/risk 208/208; production/UI/Must-Keep 109/109; ESLint, TypeScript, build, and `git diff --check` passed.

- State: production-deployed
- Updated UTC: 2026-09-02T10:51:00Z
- Branch: `feat/resonance-unified-paper-live-parity`
- Pull request: `#105` — `feat/resonance-unified-paper-live-parity`
- Feature commit: `fa4f38220be829d4bd67f1962f19020aed73d268`
- Production merge commit: `1c42379177d32d824b9907f4d04558e502607277`
- Runtime identity: `resonance-v4-unified-paper-live-parity`
- Production URL: `https://market-sentinel-free.alicia5574188.workers.dev`

## Completed and deployed

- Unified HT1–HT5, HT1-R/HT2-R/HT3-R/HT5-R, and HT6–HT9 into one thirteen-strategy paper execution pool while preserving HT4's exact source fingerprint.
- Removed all current-cycle shadow trade creation/advancement. Strategy evidence and router ranking now come from actual closed paper orders.
- Made the strategy brain's selected candidate the only executable paper candidate and preserved the same strategy/learning lineage for Gate live.
- Increased paper/live capacity to five positions, at most three per direction, with a 20%-equity total planned paper stop-risk envelope.
- Changed paper margin to an 8% target with a 35% liquidation-safe fallback and retained adaptive leverage up to 50x.
- Preserved Entry Quality, historical-sample eligibility, last-trustworthy-snapshot degradation, five-tab UI, owner controls, Gate safety, paper history, and all open-position lifecycles.
- Required no new migration; no historical trade, learning, shadow row, account, credential, live-order, or simulation-epoch data was deleted.

## Explicitly unchanged

- HT4 entry logic, existing positions, stop/TP lifecycle, paper account history, credentials, owner controls, reconciliation, safety locks, and Emergency Stop.
- No automatic fund transfer or live activation. The owner will fund only after actual positive simulated growth.
- No auto-switch, automatic hedge, or silent fallback to a lower-ranked strategy when the brain's selection fails final execution checks.

## Verification evidence

- Local: strategy/risk/migration suite 206/206; production build/UI/Must-Keep suite 107/107; TypeScript, ESLint, Wrangler production dry-run, and `git diff --check` passed.
- Final PR CI: Sentinel V2 CI run `33620998469` / job `100217743306` passed.
- Merged-main CI: run `33621133143` / job `100218154250` passed.
- Production served immutable client asset `assets/page-CLUWv592.js` containing `统一模拟策略池`, `十三种打法由大脑择优`, and `模拟/实盘同链`.
- Two `/__health` probes returned HTTP 200 with `ok: true`; Position Monitor and Market Scanner success timestamps both advanced, both remained `live`, `lastError` and `schedulerError` were null, and the scanner circuit remained closed.

## Next action

- Collect actual capital-backed paper-order evidence from all thirteen strategies. Do not fund Gate or infer owner approval; the owner decides after actual positive simulated growth.
- Use `docs/QUANT_SYSTEM_MASTER_HANDOFF.md` as the first entry point for every future quantitative-system task.

## Blockers

- None.
