# Audited repair candidate — 2026-09-20

**NOT APPROVED FOR PRODUCTION. Do not merge or deploy this candidate.**

User requires the next deployment to be demonstrably better. The fixed comparison baseline is production `401768ccd5ea75da6bf55b2855433aba2df5d1a5`. Same-input functional superiority is established for named bugs, not net-profit superiority. The complete continuous executable quote tape and complete order ledger are unavailable. No historical path is synthesized from extrema, and no future return claim is made.

## Improvements implemented

- Exit planning deducts already-planned exits once; normal stops/deadlines have priority. Unknown/stale market state cannot authorize new portfolio cuts.
- Warning UNKNOWN is distinct from recovery, preserves prior directional entry budgets, and does not force a trade or exit. Consecutive confirmations require distinct, synchronized, complete five-minute bars. Continuing reversal is not recovery.
- Compact armed-trail/confirmation checkpoints preserve relevant observed position protection across restart. They do not alter balances, size, frozen geometry, learning or history.
- LIVE checks actual account total and directional structural risk even with source-authoritative sizing. Remaining quantities, pending exits and unresolved submissions retain risk; normal proportional quantity/leverage is preserved.
- Forward failure cannot be hidden by healthy transport. Discovery, fees, owner/member intent and authentication remain unchanged.
- `test:direct` includes all TypeScript test files, including formerly omitted market-state tests. Only the authorized forward/store hashes and `advanceForwardNow` hash are advanced after semantic tests; the other nine frozen primary method bodies remain unchanged.

## Blocking evidence, not merely an untested concern

`tests/forward-checkpoint.test.ts` reproduces in the actual Worker: at 7,933 non-alarm writes, a full three-key exit still fits the 8,000 cap with the unchanged 64-write reserve. A one-key peak checkpoint advances usage to 7,934; the subsequent giveback exit can no longer persist and the previous open holding is retained. This is fail-before-publish but still an unacceptable new liveness regression.

At ten-second callback cadence there are 8,640 callbacks/day. Even subtracting 288 five-minute full cycles leaves a worst-case 8,352 added peak writes, above the entire internal cap. Observed old daily usage was 7,773, leaving only 163 after the reserve. One-key compactness is not proof of acceptable daily load. No cap, alarm/data cadence or resource quota has been silently changed. Throttling away critical peaks cannot be called exact restart continuity.

Independent review also identified a remaining pre-existing coverage gap: account equity highs from HORIZON-only positions can affect drawdown-based budgets without triggering the armed-trail checkpoint. Current tests prove the named trail/confirmation restoration cases, not every account-risk decision across restart.

## Release decision

Hold this complete candidate as a draft. Required next work is a bounded persistence/resource design that cannot consume exit-commit capacity, an account-peak persistence decision with accurate semantics, full regression/independent review, and explicit separation of correctness improvement from unproven profitability. Do not weaken the tests, raise caps, delete archives, pause trading globally, or promise returns to manufacture approval.

No production merge, deployment, account reset, LIVE switch action, private Gate call, real trade, key creation or member-capacity change occurred during this implementation. The original service remains on the baseline.

See `UPGRADE_COMPARISON_2026-09-20.md`, its reproducible script/JSON and the current project STATUS for exact verified checks. A passing test that reproduces a release blocker is not a safe-release certificate.
