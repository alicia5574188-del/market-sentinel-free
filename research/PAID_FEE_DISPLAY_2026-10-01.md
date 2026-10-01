# Paid-fee presentation contract — 2026-10-01

The owner requested both the original-strategy shadow and inverse PAPER amounts and fees on each order, without charging estimated future closing fees in the displayed net.

## Display basis
`shadowInverse.paidCost` is a read-only `paid-fee-view-v1` projection. Each leg's net is actual realized gross plus remaining marked gross minus that leg's booked trading fees and booked funding allowance. Before any exit, only the opening trading fee has been booked. A partial exit adds only the fee for the quantity actually filled; a completed order includes all its actual closing fills. Funding allowance is shown separately and is not exchange-reported funding.

OPEN/REDUCE/CLOSE receipts retain their original values. Bid/ask-derived gross differences are displayed as quote gross gaps, not extra fee debits. Missing source marks remain unknown; stale own saved prices are identified. Closed source amounts can be reconstructed from paired receipts without loading or inventing the source's old market history. Aggregate realized totals come from the durable accumulator, not a truncated recent-order list.

Overview `已扣手续费` continues to read the original cumulative PAPER `fees` accumulator only. It does not add source fees or future exit estimates. Existing source/inverse historical curves and legacy summary fields retain their original conservative valuation, including projected closing fees, and are explicitly labeled as such. They must not be silently relabeled as paid-only history. No historical or account-equity values are rewritten, and no fees are refunded/redebited by this change.

## Isolation and access
The original decision policy remains fixed at `2b4fd60f77c9b78526bd5087940945fe7e86fab8`. No entry, exit, position size, fee rate, lifecycle, source wallet feedback, LIVE intent, account epoch, reset action, storage schema, data request or schedule is changed. Only one summary import/property is added to the passive ledger; a git-blob hash test enforces all other ledger code is unchanged.

Authenticated account views and snapshots receive the per-order projection. Unauthenticated public health receives aggregate paid-cost reconciliation only; `paidCost.rows` is omitted. The temporary exact-file privacy edit workflow is removed from the final tree.

## Validation and scope
Pure amount tests cover source long/short, spread/no spread, opening/partial/full settlement, unknown/stale/future/crossed quotes, archived aggregate totals, non-mutation and byte-identical execution accounting. Actual React render tests cover both order legs and overview paid-only fees. Original strategy/money/LIVE/equity tests remain in the normal release gates. Source head `b72dffef69555d44f75f8a237e3f7062610eb1f2` passed normal full PR verification in run `36820217682`; the final head including public-health privacy must pass those gates again before release.

This is presentation and audit work, not a new strategy or a profitability result. Displayed open-order net still includes floating price PnL and is not entirely realized profit.
