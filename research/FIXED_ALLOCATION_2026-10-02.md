# Fixed1000 U allocation only

The owner explicitly cancelled all proposed admission pauses, automatic recovery,
60 U thresholds and emergency protection before publication. None were deployed.
This release changes allocation only; normal entries, source reductions/closes,
no-independent-inverse-stop policy and manual LIVE controls stay as deployed.

The shadow allocator receives1000 U through one optional input at its existing
new-entry call. The inverse PAPER continues copying original source quantities
and lifecycle. Actual source/inverse wallets, fees, realized/floating equity,
daily results and prior trades are retained, never replaced with1000. Existing
holdings are not resized. Changing equity alone no longer compounds/shrinks
future allocation, while stop distance/opportunity parameters and quantity
rounding still determine a particular order's size.

Native LIVE saves its real capital anchor once from the existing complete account
snapshot before staging a new copy, then uses anchor/1000. For example a280 U
anchor gives0.28 of source notional; profits, ordinary OFF/ON and restart never
raise the anchor. LIVE actual-equity risk/margin, available funds, exchange size
and other existing admission gates remain mandatory. Account identity mismatch
does not silently rebase. Owner/member checkpoints save their own small anchor.
No added Gate read, timer, periodic log, storage row or history reset.

The vendor manifest records exact reversible allocation-only edits; removing
these edits and reversing import paths must reconstruct the original2b4fd60f
source hash. Source build remains provenance; allocation policy is separately
identified as fixed-1000-v1 in summaries, review exports and copy receipts.

Acceptance covers source allocation at true wallets below/above1000, default
baseline behavior, LIVE anchor profits/losses/restart/OFF-ON/member isolation,
actual account limits, checkpoint failure before sending, no native guards or
new pause/exit authority, original histories and full reviewed-main release.
