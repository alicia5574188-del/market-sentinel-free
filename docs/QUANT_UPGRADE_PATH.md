# Quant upgrade path

This is the short route for future strategy work. Current `main`, tests, and production health remain authoritative.

## Classify first

| Change | Release class | Position action |
| --- | --- | --- |
| Copy, labels, read-only diagnostics | Minor | Keep positions |
| Bug fix that cannot change a stored decision | Minor | Keep positions |
| Entry, exit, sizing, portfolio, learning, setup set, or brain-version change | Major | Force-archive all paper positions; new epoch |
| Gate/live risk or execution change | Separate live release | Never inherit paper authorization |

## Stable upgrade surface

Most strategy upgrades should touch only these owners:

| Concern | Owner |
| --- | --- |
| Release/version/cutover | `lib/direct-market-release.ts`, `lib/direct-market-types.ts`, one new additive migration |
| Market decision | `lib/direct-market-brain.ts` |
| Entry and immutable snapshot | `lib/direct-market-execution.ts` |
| Position decision | `lib/direct-market-position-brain.ts` |
| Background orchestration | `worker/hte31-workers.ts` |
| Daily UI | `app/page.tsx` only when operator-visible truth changes |

Do not create a second simulator, router, risk authority, market-data producer, or live execution path. Prefer replacing dead code over stacking another compatibility layer; preserve stored lineage and read-only history.

## Major release checklist

1. Change `DIRECT_MARKET_BRAIN_VERSION`.
2. Update `DIRECT_MARKET_RELEASE` with a new migration tag and `force_archive_paper`.
3. Add one non-destructive migration naming the new version. Never edit an applied migration.
4. Run focused decision/cutover tests while editing.
5. Run the full strategy, UI/safety, lint, type, build, migration, and Wrangler dry-run gates once.
6. Open one PR, merge only on green CI, then verify the immutable asset, D1 migration, both schedulers, bounded API, and new simulation epoch.

CI must fail when the brain version and declared cutover migration disagree.

## Time budget

- Diagnosis and scope: 10 minutes.
- Focused implementation: 25 minutes.
- Local gates and correction: 15 minutes.
- PR, CI, deploy, production proof: 10 minutes plus external queue time.

If the change cannot fit this surface, stop and document the architectural reason before expanding scope.

## Traps already paid for

- A deploy asset check must match current UI copy, not upgrade-history copy.
- A phased scanner may validly report `starting`; health checks must not call that failure when timestamps, errors, and circuit state are healthy.
- Use completed candles for decisions and fresh quotes for entries/exits.
- D1 bills index writes too. Keep scanner/diagnostics write-free and preserve lifecycle reserve.
- Current statistics require both the active epoch and current brain version; old rows remain archive evidence.
- A reset blocks replacement entries before any close and finalizes only after every paper position is closed.
- Forced paper closure must still create the full `0/30/60/120/240/480/720` observation trail.
- Paper release authority never grants Gate/live funding or mutation authority.
