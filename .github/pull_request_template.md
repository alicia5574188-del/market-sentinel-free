## Change summary

<!-- What problem is being solved? What user-visible or production behavior changes? -->

## Source-of-truth check

- [ ] I read the current `main` implementation for the affected subsystem.
- [ ] I read `docs/CURRENT_SYSTEM_STATE.md`.
- [ ] I inspected recent merged PRs/commits that last changed this subsystem.
- [ ] I am not relying on chat history or memory as the production source of truth.

## Authority / safety boundary

- [ ] I identified whether this change touches Strategy, Regime, Learning, Risk, Execution Engine, Order Lifecycle, Gate mutations, or UI-only observability.
- [ ] I documented any change to trading/risk authority below.
- [ ] Stale/invalid data cannot create new-risk permission.
- [ ] Learning/research diagnostics cannot silently gain execution authority.
- [ ] Existing order lifecycle / retry / reconciliation safety is preserved.

Authority changes, if any:

<!-- Explicitly write "None" if there are none. -->

## Regression verification

- [ ] Strategy / risk / migration tests pass.
- [ ] Production build / UI safety tests pass.
- [ ] New behavior has targeted regression coverage where practical.
- [ ] Failure/degraded paths were considered, not only the happy path.

## Durable handoff

- [ ] `docs/CURRENT_SYSTEM_STATE.md` is updated if current architecture, behavior, authority, known constraints, or operating recommendation changed.
- [ ] `docs/SENTINEL_CHANGELOG.md` has an appended entry for material production changes.
- [ ] Deliberately unchanged safety boundaries are stated in the PR description.

## Deployment verification

After merge:

- [ ] Verify merged `main` CI.
- [ ] Verify Cloudflare production deployment/result.
- [ ] Record production commit/version in the durable docs when material behavior changed.
