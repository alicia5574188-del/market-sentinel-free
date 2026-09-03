# Strategy Center and Historical Memory Upgrade Plan

Status: **implemented and locally verified — awaiting PR, CI, and production verification**
Prepared: **2026-09-03 UTC**

Implementation evidence:

- Dedicated on-demand Strategy Center, canonical cross-surface naming, compact current-only UI, and isolated scroll reset are implemented.
- Historical sources now validate payloads, isolate interval failures, expose `READY/WARMING/UNAVAILABLE/STALE`, retain bounded per-symbol last-good memory, and give non-ready/stale data zero decision weight.
- `/api/hte31` uses concurrent deadline-bounded reads and partial HTTP 200 fallbacks; diagnostics are on demand; `/__health` no longer wakes schedulers.
- No migration, Durable Object generation change, periodic D1 write, trading-risk change, live-authority change, or fund action was added.
- Local gates passed: strategy/risk/migration 221/221, production build/UI 110/110, focused resilience/UI 26/26, ESLint, TypeScript, Wrangler dry-run, and diff check.

## Objective

Move the full strategy-family cards out of the bottom of Radar into a dedicated Strategy Center, remove upgrade-history and redundant explanatory copy from the operator UI, make historical-market memory reliable without lowering its evidence standard, and prevent transient backend latency from turning the main dashboard into a blank `503` state.

## Observed 503 evidence

- On 2026-09-03, the phone received `/api/hte31 请求失败 (503)` after hours of normal operation.
- A production `/__health` probe then timed out after 20 seconds with no response; a retry succeeded after about 15.2 seconds.
- The successful probe still reported Position Monitor and Market Scanner as `live`, both with advancing successful timestamps, null errors, and a closed scanner circuit.
- This pattern indicates transient request latency/backpressure rather than a stopped scheduler. The exact upstream span still requires Cloudflare request logs when available.
- `/api/hte31` currently waits without a deadline for three Durable Object calls, then runs the dashboard D1 reads and strategy diagnostics. An isolate-cache miss, a busy Durable Object, D1 latency, or overlap with a background scan can make the combined request exceed the edge/client deadline even though each subsystem later recovers.

## 503 resilience implementation

- Keep the high-frequency main dashboard payload lightweight. Do not load full strategy-family diagnostics every 30 seconds when Strategy Center is closed.
- Move full strategy-health/family diagnostics behind the on-demand Strategy Center read path, with a bounded server cache and no new foreground Gate producer.
- Give Durable Object status/read-model calls explicit short deadlines. A slow auxiliary status must produce a partial HTTP 200 response with the last trustworthy read model, not hold the entire request until an edge 503.
- Run independent dashboard/diagnostic reads concurrently where safe and keep failures source-scoped.
- Preserve the last trustworthy dashboard snapshot across an iOS/PWA process reload with its timestamp and an explicit stale label. It remains display-only and cannot authorize trading or mutations.
- Keep the main UI populated during a transient refresh failure; show one compact delayed-refresh banner instead of replacing current values with zeros or `--`.
- Make `/__health` a fast read-only status probe; it must not block on live reconciliation or scheduler wake/ensure work.
- Keep mutations non-retrying and outside every cache/fallback path.

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
- `app/page.tsx` and the existing stability client: persist only the last trustworthy read-only snapshot with a timestamp, restore it as explicitly stale after a cold PWA reload, and never cache/retry mutations.
- `lib/hte31-strategy-catalog.ts`: one canonical current-display formatter shared by family, variant, and legacy-ID resolution.
- `lib/strategy-2-intelligence.ts` or the current regime-label owner: reuse one translated asset-regime formatter instead of showing raw enum values.
- `lib/resonance-market.ts`: explicit memory source states and data-quality metadata.
- `lib/gate-history.ts`: parsed-row/count validation and stable failure classification.
- `lib/hte31-scanner.ts`: interval isolation, last-good memory input/output, and no-failure core scan behavior.
- `worker/hte31-workers.ts`: optional backward-compatible per-symbol memory cache in existing runtime storage; no generation reset.
- `app/api/hte31/route.ts`: return the existing read model with the extended memory contract; no new endpoint or polling.
- `app/api/hte31/route.ts`: add bounded Durable Object deadlines, partial-response behavior, and remove full Strategy Center diagnostics from the high-frequency critical path.
- `worker/index.ts`: keep `/__health` read-only and latency-bounded instead of awaiting scheduler/live ensure work.
- `tests/resonance-market.test.ts`: valid history produces samples; insufficient/malformed history is not represented as genuine zero evidence.
- `tests/human-trader-ui.test.mjs`, `tests/mobile-navigation.test.mjs`, `tests/resonance-feature-preservation.test.mjs`: dedicated page, five-tab preservation, no duplicate card lists, honest hidden/preparing state, and Must-Keep reachability.
- Add one focused scanner-memory resilience test for partial failure and last-known-good fallback.
- Add focused route tests with deliberately hanging Durable Object/D1 stubs to prove that the main read returns bounded partial HTTP 200 instead of 503.

## Acceptance checks

- Radar no longer contains the full nine-family card list or upgrade explanation.
- Strategy Center is reachable near the top of Radar, opens at the top, and contains every family/variant.
- Orders does not duplicate the full strategy cards; its learning summary links to Strategy Center.
- Open/closed paper orders, current positions, Radar, review, learning, and Gate live all show the same canonical family/variant identity.
- No raw strategy ID, obsolete English display name, or raw regime enum appears on a current operator card when a canonical label exists.
- No release-history or implementation-explanation copy remains in the daily UI.
- A transient slow Durable Object, diagnostics read, or D1 source cannot erase the current dashboard or force the main read to wait until an edge 503.
- A cold iOS/PWA reload can show a timestamped last trustworthy snapshot while reconnecting; stale data never gains execution authority.
- `/__health` returns quickly without waiting for live reconciliation or scheduler-start work.
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
3. Split the high-frequency dashboard from on-demand diagnostics and add bounded partial-response/last-good behavior.
4. Implement the historical-memory contract, isolated fetches, and last-good fallback.
5. Implement Strategy Center and remove redundant UI copy/duplicate lists.
6. Run focused tests, then every full local gate.
7. Review D1 budget and confirm the Durable Object generation is unchanged.
8. Push, open PR, wait for green CI, merge, verify main CI and production under repeated overlapping reads.
9. Record production evidence in the durable handoff/status/changelog.

## Estimated model and usage

- Recommended reasoning level: **极高**.
- `最高` is unnecessary because the architecture and exact files are already mapped.
- Expected implementation and local verification: about 45–65 minutes.
- Expected end-to-end time including remote CI and production probes: about 60–90 minutes.
- A freshly reset five-hour allowance should be sufficient. Reserve at least half of the allowance before starting; remote CI waiting itself uses little model capacity.
