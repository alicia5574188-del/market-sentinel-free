# Status

- State: local-verified-awaiting-pr
- Updated UTC: 2026-09-01T08:33:42Z
- Base production implementation: `0cef71de1eeff41d4cbb64f5951e0c0f188ce824`
- Working branch: `codex/pr99-complete-must-keep` (a new remote feature branch will be created from current `main`)

## Completed locally

- Added `lib/resonance-entry-quality.ts`, a deterministic observer that records:
  - Entry Efficiency over the initial path;
  - MAE before the first +0.5R;
  - time to +0.5R and +1R;
  - delayed-entry counterfactuals for 1/2/3 completed 5m candles;
  - direction-wrong, entry-too-early, entry-too-late, normal-noise, stop-too-tight, or insufficient-data classification.
- Added additive D1 migration `0015_resonance_entry_quality.sql`; new and subsequently observed HTE31 trade charts persist the report in `entry_quality_json`.
- Exposed Entry Quality in the chart API, expandable order review, and owner diagnostics.
- Connected Entry Quality to cognitive review. `require_retest` now requires at least 3 assessed trades in the same setup and asset regime, with at least 2 and at least 60% classified as entry-too-early.
- Scoped the retest rule to that exact setup/regime cell. The existing cognitive marker keeps adapted orders paper-only and Gate live rejects them.
- Exposed the real historical-analog evidence floor in the payload and UI:
  - below 8 independent samples: `样本不足 · n/8` and `暂不参与判断`;
  - at/above 8: symbol + horizon, bias/confidence, effective independent samples, and median forward move.
- Reduced recurring `/api/hte31` pressure by caching auxiliary diagnostics for 60 seconds with a five-minute stale fallback and changing the single main poll from 15s to 30s.
- A transient refresh failure now preserves the last trustworthy dashboard and uses an amber “refresh delayed” notice instead of a raw red `/api/hte31 请求失败 (503)` banner; Scanner and Position Monitor remain independent.

## Explicitly unchanged

- No stop distance, TP protection rule, paper risk amount, adaptive leverage rule, Gate live sizing, live credential/control path, broad setup threshold, scanner authority, or position-management authority changed.
- No new polling, foreground Gate producer, destructive action, live authority, schema rewrite, or historical deletion was introduced.
- Historical trades and learning remain intact; the migration is additive.

## Validation evidence

- Focused Entry Quality and market-memory tests: 9 passed, 0 failed.
- Focused UI/migration/learning/Must-Keep tests: 36 passed, 0 failed.
- `npm run test:signals`: 194 passed, 0 failed.
- `npm test`: production build passed; 104 passed, 0 failed.
- `npm run lint`: passed with 0 errors and 0 warnings.
- `./node_modules/.bin/tsc --noEmit --incremental false`: passed.
- `git diff --check`: passed.

## Remaining action

- Run the full validation set once more after documentation reconciliation.
- Run Wrangler production dry-run.
- Create a feature branch/PR from current remote `main`, wait for green CI, merge, verify merged-main CI and Cloudflare migration/deployment, then verify production UI/API behavior.

## Blockers

- None.

## Exact final validation commands

- `npm run test:signals`
- `npm test`
- `npm run lint`
- `./node_modules/.bin/tsc --noEmit --incremental false`
- `./node_modules/.bin/wrangler deploy --dry-run --config dist/server/wrangler.json`
- `git diff --check`
