# Status

- State: production-deployed
- Updated UTC: 2026-09-01T04:42:20Z
- Pull request: `#99` — `fix/resonance-feature-preservation`
- Verified starting HEAD: `0de959a15468d27db9b941ea4a7f1e7784e780f0`

## Completed and verified

- Restored the required fixed bottom navigation: `机会 / 雷达 / 订单 / 实盘 / 设置`.
- Preserved every learning view by placing the former standalone Learning content under `订单`; no capability was deleted to satisfy the five-tab contract.
- Kept the simulation-capital reset discoverable through `机会 → 资金设置 → 设置`, with exactly one destructive reset button.
- Preserved reset behavior: open simulated positions disable reset, and completed trades, per-trade reviews, learning results, and historical samples remain intact.
- Added an expandable pre-trade signal card powered only by existing HTE31 dashboard data. It now exposes direction, trigger state, complete required/optional gate results, entry zone and price, stop, TP1, TP2, risk/reward and holding limit, support, counter-evidence/missing conditions, and invalidation rules.
- Added capability-preservation assertions for the exact five-tab contract and full pre-trade evidence/risk surface.
- Completed the compatibility audit against `docs/RESONANCE_MUST_KEEP_FEATURES.md`:
  - simulation, trade review, Gate live, account, Web Push, audit, runtime diagnostics, Auto Live, reconciliation, credential deletion, and Emergency Stop remain reachable;
  - no duplicate reset action, destructive operation, live state source, live authority, risk path, credential path, or market-data producer was added;
  - no new polling, foreground Gate request, API route, D1/schema change, strategy decision change, scanner cadence change, position-protection change, or live risk change was introduced;
  - the new signal surface reads the existing observer-only dashboard payload and degrades to explicit empty-plan copy when no plan exists;
  - mobile cards use bounded grids, `min-width: 0`, and wrapping rules; the fixed nav remains safe-area aware.

## Validation evidence

- Focused capability/UI/reset regression tests: 24 passed, 0 failed.
- `npm run test:signals`: 189 passed, 0 failed.
- `npm test`: production build passed; 102 passed, 0 failed.
- `npm run lint`: passed with 0 errors and 0 warnings.
- `./node_modules/.bin/tsc --noEmit --incremental false`: passed.
- `./node_modules/.bin/wrangler deploy --dry-run --config dist/server/wrangler.json`: passed; the production Worker bundle and bindings assembled successfully.
- `git diff --check`: passed.
- The complete local validation set above passed again after updating GOAL, STATUS, and DECISIONS.
- GitHub Actions `Sentinel V2 CI` run `33467169944` (run 344), job `99729324911`, passed on implementation commit `b5b1afbdd874051b720a0b313a1e977b40471948`; checkout, install, strategy/risk/migration tests, production build/UI safety tests, and Wrangler production dry-run all succeeded.
- PR #99 was squash-merged to `main` as `0cef71de1eeff41d4cbb64f5951e0c0f188ce824`.
- Merged-main GitHub Actions `Sentinel V2 CI` run `33467619313` (run 346), job `99730648020`, passed.
- Cloudflare Workers Build `ff6a6eed-eb29-4807-9410-f04c4bf00b7b` passed and promoted Version `07eeee00-8226-4616-afdb-1124a7211dd9` to production.
- Production root `https://market-sentinel-free.alicia5574188.workers.dev/` loaded the owner login surface successfully after deployment.
- By design, a new Worker version disables new Gate entries while preserving existing-position protection and reconciliation; this deployment did not bypass that safety lock or silently re-enable live financial exposure.

## 2026-09-01 production `/api/hte31` 503 resilience hotfix

- A production iPhone report showed the core `/api/hte31` observer request returning HTTP 503 while the last successful market snapshot remained on screen.
- Audit confirmed `/api/hte31` is a high-frequency read-only observer, but it performed `ensureUserAccount()` through `requireApiAccount()` before its scanner/dashboard partial-degradation boundary. A transient `user_accounts` persistence failure could therefore take down the whole dashboard request even though account persistence is not required to read the snapshot.
- PR #100 introduces `requireApiViewer()` for this read-only hot path. It still authenticates the trusted request identity and derives owner/member role, but does not make `user_accounts` D1 persistence a prerequisite for the dashboard.
- Durable account checks remain unchanged for account details, settings mutations, push subscriptions, Gate credentials, live control, reconciliation, emergency actions, and other account-scoped operations.
- No polling cadence, Gate foreground request, D1 schema/history, strategy rule, scanner authority, position protection, live risk, credential path, or mutation behavior changed.
- PR #100 GitHub Actions `Sentinel V2 CI` run `33470798900` (run 348), job `99739988992`, passed on implementation commit `109d82092ef3357466cdc0b5d5130a4aab5b2e51`; strategy/risk/migration tests, production build/UI safety tests, and Wrangler production dry-run all succeeded.

## Remaining action

- No implementation or deployment work remains.
- The production owner can re-enable Auto Live from the verified live-control surface when intentionally ready to accept new Gate exposure.

## Blockers

- None.

## Exact final validation commands

- `npm run test:signals`
- `npm test`
- `npm run lint`
- `./node_modules/.bin/tsc --noEmit --incremental false`
- `./node_modules/.bin/wrangler deploy --dry-run --config dist/server/wrangler.json`
- `git diff --check`
