# Strategy Center and Historical Memory Upgrade Plan

Status: **prepared only — no runtime or production behavior changed**
Prepared: **2026-09-03 UTC**

## Objective

Move the full strategy-family cards out of the bottom of Radar into a dedicated Strategy Center, remove upgrade-history and redundant explanatory copy from the operator UI, and make historical-market memory reliable, honest, and useful without lowering its evidence standard.

## Product rules

- The operator UI shows current truth, current decisions, current risk, and current actions only. It must not display release notes, migration explanations, or descriptions of how an upgrade was implemented.
- Every surface that names a strategy must use one canonical formatter. Do not independently assemble old codes, English names, setup names, or raw regime enums in individual components.
- Safety instructions, blocking reasons, strategy-health reasons, and current decision evidence remain available, but must be concise and actionable.
- Keep exactly five bottom tabs: `机会 / 雷达 / 订单 / 实盘 / 设置`.
- Strategy Center is a dedicated in-app subpage, not a sixth bottom tab.
- Real funding remains the owner's decision. This upgrade cannot move funds, infer approval, or change Gate execution authority.

## Strategy Center

### Navigation

- Add a visible `策略中心` entry near the top of Radar.
- Opening it replaces the current tab body with a dedicated page and a clear back action.
- Entering and leaving the page starts at the top; it must not inherit another page's scroll position.
- Radar and Orders retain only compact current summaries/links. Remove duplicated full strategy-card lists from both pages.

### Content

- Show all nine canonical families and all thirteen historical variants.
- Keep current family state, sample count, expectancy, profit factor, recent decay, last-use reason, and next action.
- Variant names remain available inside the family card but are compact or expandable.
- Use one current display format everywhere, for example `SF05 大周期波段 / 基础 [HT5] · 极端杠杆/清算`.
- Remove the long paragraph explaining that thirteen IDs were grouped into nine families and that live inherits the selected variant; those facts belong in documentation, not the daily operator surface.
- Do not add another API, poller, strategy authority, or data source. Reuse the existing HTE31 dashboard payload.

## Historical-memory diagnosis

Current code requests 720 one-hour, 1,200 four-hour, and 1,800 daily candles. The analog calculator needs only 44, 46, and 74 valid candles respectively before it can generate candidates. With enough valid candles, the current algorithm should not remain at zero because it selects the nearest independent historical episodes.

Therefore, simultaneous long-term `0/8` on all three horizons is treated as a data-validity or stale-empty-read-model problem, not as a genuine absence of historical analogs and not as something that should require days of new runtime accumulation.

## Historical-memory implementation

### Data contract

Extend each horizon with explicit source state:

- `READY`: at least eight independent episodes; eligible for brain judgment and UI detail.
- `WARMING`: valid history exists but fewer than eight independent episodes; excluded from judgment.
- `UNAVAILABLE`: history was empty, malformed, too short, or the upstream request failed.
- `STALE`: the current refresh failed but a bounded last-known-good result is retained.

Expose received candle count, required candle count, sample count, observed time, last successful time, and a short machine-readable failure reason. Do not turn missing data into `NEUTRAL 0%` or `0/8`.

### Fetch and resilience

- Validate each interval immediately after parsing instead of silently accepting an empty array.
- Isolate the three historical intervals so one failure does not erase the others or fail the core market scan.
- Retain a bounded per-symbol last-known-good memory result in the existing Market Scanner Durable Object state.
- Reuse that result only when labeled stale and within its time limit; stale memory cannot gain new-entry authority.
- Do not bump the Durable Object generation and do not reset scheduler/read-model state.
- Do not write historical memory every scan to D1. Reuse the existing scanner state write, so planned D1 recurring writes remain 27,360/day.

### Brain and UI behavior

- Keep the independent-sample minimum at eight; do not lower the threshold merely to make the feature appear active sooner.
- `READY` memory may contribute to the existing market brain.
- `WARMING`, `UNAVAILABLE`, and expired `STALE` memory contribute zero decision weight.
- Hide the three detailed cards until at least one horizon is `READY`.
- While no horizon is ready, show only one compact line such as `历史记忆准备中` or `历史数据暂不可用`; never show three permanent `0/8` cards.
- When a horizon becomes ready, reveal its current bias, confidence, independent sample count, and median forward move automatically.

## UI copy audit

Classify visible copy before removal:

- **Keep-current:** live market judgment, entry blockers, health state, risk values, trade verdict, scheduler error, credential/safety instructions.
- **Shorten:** strategy-health reason/action, router reason, reset explanation.
- **Remove:** upgrade narrative, old/new version comparison, architecture explanation, repeated paper/live-parity explanation, duplicated family inventory prose.
- **Documentation only:** migrations, legacy compatibility, implementation history, D1 calculations, and release evidence.

## Cross-surface naming audit

Apply the canonical family/variant label and translated regime label to every current surface, not only Strategy Center:

- open and closed paper-order cards;
- compact current-position previews;
- Radar signal/plan cards and router selection;
- trade chart and post-exit review;
- strategy-health, paused-cell, and learning summaries;
- Gate live active orders and lineage details;
- owner diagnostics, audit/push text, and any API field rendered directly by the UI.

Historical database IDs remain unchanged for lineage. Raw values such as `higher_timeframe_swing`, `HT5 Swing`, or `leverage_liquidation` must not leak into the current operator display when a canonical Chinese label exists.

## Exact implementation map

- `app/page.tsx`: Strategy Center subpage, links, scroll reset, remove duplicate family lists, compact memory states, copy cleanup, and canonical names on every paper/order/radar/learning surface.
- `lib/hte31-strategy-catalog.ts`: one canonical current-display formatter shared by family, variant, and legacy-ID resolution.
- `lib/strategy-2-intelligence.ts` or the current regime-label owner: reuse one translated asset-regime formatter instead of showing raw enum values.
- `lib/resonance-market.ts`: explicit memory source states and data-quality metadata.
- `lib/gate-history.ts`: parsed-row/count validation and stable failure classification.
- `lib/hte31-scanner.ts`: interval isolation, last-good memory input/output, and no-failure core scan behavior.
- `worker/hte31-workers.ts`: optional backward-compatible per-symbol memory cache in existing runtime storage; no generation reset.
- `app/api/hte31/route.ts`: return the existing read model with the extended memory contract; no new endpoint or polling.
- `tests/resonance-market.test.ts`: valid history produces samples; insufficient/malformed history is not represented as genuine zero evidence.
- `tests/human-trader-ui.test.mjs`, `tests/mobile-navigation.test.mjs`, `tests/resonance-feature-preservation.test.mjs`: dedicated page, five-tab preservation, no duplicate card lists, honest hidden/preparing state, and Must-Keep reachability.
- Add one focused scanner-memory resilience test for partial failure and last-known-good fallback.

## Acceptance checks

- Radar no longer contains the full nine-family card list or upgrade explanation.
- Strategy Center is reachable near the top of Radar, opens at the top, and contains every family/variant.
- Orders does not duplicate the full strategy cards; its learning summary links to Strategy Center.
- Open/closed paper orders, current positions, Radar, review, learning, and Gate live all show the same canonical family/variant identity.
- No raw strategy ID, obsolete English display name, or raw regime enum appears on a current operator card when a canonical label exists.
- No release-history or implementation-explanation copy remains in the daily UI.
- Sufficient valid history cannot display `0/8`.
- Missing/short/malformed history is labeled unavailable, not neutral or sample-zero.
- One interval failure does not erase valid memory from the other intervals or stop the scanner.
- A bounded last-known-good memory remains explicitly stale and cannot authorize new risk.
- Eight independent samples are still required before historical memory influences the brain.
- No new foreground producer, polling loop, D1 recurring write, migration, live authority, risk change, fund action, or Durable Object generation reset is introduced.
- Full strategy/risk, UI/Must-Keep, lint, TypeScript, build, Wrangler dry-run, PR CI, merged-main CI, immutable asset, and two advancing health probes pass.

## One-pass execution order after allowance reset

1. Start from current `main` and create the implementation branch.
2. Add failing memory-state/resilience, Strategy Center, and cross-surface canonical-label tests.
3. Implement the historical-memory contract, isolated fetches, and last-good fallback.
4. Implement Strategy Center and remove redundant UI copy/duplicate lists.
5. Run focused tests, then every full local gate.
6. Review D1 budget and confirm the Durable Object generation is unchanged.
7. Push, open PR, wait for green CI, merge, verify main CI and production.
8. Record production evidence in the durable handoff/status/changelog.

## Estimated model and usage

- Recommended reasoning level: **极高**.
- `最高` is unnecessary because the architecture and exact files are already mapped.
- Expected implementation and local verification: about 30–45 minutes.
- Expected end-to-end time including remote CI and production probes: about 45–70 minutes.
- A freshly reset five-hour allowance should be sufficient. Reserve at least half of the allowance before starting; remote CI waiting itself uses little model capacity.
