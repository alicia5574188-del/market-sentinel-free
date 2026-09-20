# Audited repair release gate — 2026-09-20 continuation

Baseline: production `401768ccd5ea75da6bf55b2855433aba2df5d1a5`. The user authorizes completing known fixes and deploying only a demonstrably improved version. The intermediate HOLD is superseded where its concrete counterexamples are fixed below. This document is not a deployment receipt; exact-head verification and the normal main release remain required.

## Concrete acceptance

- Same-input old/new comparison retains all14 normal opportunity/accounting paths and corrects all7 named exit/forecast/LIVE-risk/health defects.
- Actual Worker persists critical peaks without consuming the last rows needed by subsequent financial exits. Protection has a durable8,640/day lane; financial capacity stays8,000. Counter and checkpoint commit together, survive full-account generations/restarts and UTC rollover, and refuse backward clocks/corrupt records. Exhausted/corrupt protection-only metadata does not block an otherwise-funded full exit.
- Account equity highs and maximum drawdown, including HORIZON-only positions, survive restart without rounding/throttling away extrema. Fresh individual exits remain possible when another position valuation is stale; incomplete portfolio valuation cannot authorize extra liquidations from stale marks.
- Full-account storage and archives remain atomic and field-equivalent, with legacy-read compatibility. Six retained-field/padded stress states reduce full-commit rows by2 each. Real local SQLite/workerd tests cover typed-array head storage and atomic failure. The emulator does not enforce the production128KiB limit; no false capacity certificate.
- No-fill turnover coalesces only nonfinancial cursor progress. New fills, dedup buckets and pagination enter/finish commit immediately. Actual Worker24h no-fill test saves288 summaries versus old1,440, without changing1,440 reads; restart dedup preserves totals.
- Counted financial writers reserve synchronously before storage awaits, release on failure and account once on success, including primary/member checkpoints and auxiliary readers. Pending reservations survive UTC midnight. This fixes in-process overbooking, not every external billing discrepancy across arbitrary crashes.
- Full direct tests, member/LIVE isolation, architecture/build, typecheck, lint, diff check, Wrangler dry-run and independent review pass on the exact candidate. Only documented storage/helper baselines and primary methods `advanceForwardNow` and `saveCheckpoint` change; eight other frozen bodies remain intact.

## Explicit resource tradeoff

The old55,000 owner-only planning target omitted newer work. Primary reserved rows are63,032:43,200 alarm +8,000 financial +8,640 protection +2,880 watchdog +312 hourly. Two members add33,280 and directory usage adds2,880, totaling99,192. This allocation fits the100,000/day Free SQLite row limit but is NOT whole-account capacity certification. Manual controls, retries, other directory records/Workers, UI request traffic and billable duration are additional concerns. Primary plus two-member alarm loops alone consume60,480 daily calls/writes;55,000 cannot represent that entire account at unchanged cadence. Do not retain the obsolete55,000 claim.

No plan upgrade, credential extraction, member-capacity expansion or alarm-frequency change is performed. Independent protection adds no new alarms or cross-DO requests. Financial exits retain their original budget/reserves; compact storage lowers actual row cost. High financial-event density can still exhaust the original financial budget; unbounded workloads are not certified. See the resource inventory and [official pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

## Deployment and recovery

Use the existing verified PR/main/GitHub Actions path, never a coding-branch deploy. Confirm exact deployed buildSha, same forward startedAt, advancing cycle/persistence, no storage error, current PAPER mirror source, guest denial and unchanged pre-release owner intent. No private Gate call, real test order, account reset, key creation or owner/member switch change.

Compact is a reader-compatibility change: old401768c refuses it safely. Never perform a bare platform rollback to that reader. Rollback must retain the new compatible reader while reverting unrelated logic, or first use the new reader to restore the whole account including protection overlay and atomically rewrite legacy format. Tests verify both directions and unchanged archives. Never erase overlay/history to make rollback appear successful.

Missing continuous executable quote tape and complete post-baseline order evidence prevent historical same-path PnL attribution or future-return guarantees. This is disclosed, not replaced by fabricated data or used to leave known fixable software defects unresolved. Demonstrated improvement means fewer erroneous decisions, durable protection, honest health and lossless resource savings, not superiority in every future market outcome.
