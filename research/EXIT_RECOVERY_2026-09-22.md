# Exit recovery and scoped rebuild — 2026-09-22

The user requests rollback of the failing exit upgrade, a simpler replacement,
and direct release through the existing verified main pipeline. No reset or LIVE
switch operation is authorized or performed.

Observed production `6f6cfa6` returned forward storage error
`未知Multi-Turn利润保护版本，保留原持仓`, null startedAt and zero projected orders.
This is unavailable state, not an empty account. PR376 changed the protection
constant v3→v4 but normalizeForward rejected full v3 records before the compatible
checkpoint reader could run. PR377 only addressed page caching and LIVE mounting.

Rollback base is PR375/0b3db46. Locally reversed PR376 first, retaining PR377 page
fixes, then rebuilt this narrowly scoped replacement. A bare production rollback
is unsafe because some durable records may already contain v4. Release once with
a common v3/v4 reader in both the full account and protection overlay paths.
Unknown versions still fail visibly. Preserve account IDs, amounts, history,
original stops, monotonic floors, member isolation and manual LIVE intent.

Exit design:
- Keep the stable v3 profit-retention curve and single owning-frame signal; remove
  v2 hold-value additions to the retention score. Arm after max(cost+0.1%,
  min(0.45R,2.5%)). Existing v4 floors cannot decrease.
- Hard stop and owning-cycle confirmed turn retain priority. A reached profit
  floor exits at a fresh executable quote, with real modeled costs and overshoot.
- Early invalidation needs a post-entry completed owning frame, at least one
  owning bar, opposite raw direction, weak confidence, high turn risk and a loss
  beyond modeled cost. No pre-entry frame can justify early invalidation.
- Stalled exits require at least two owning bars, weak direction, insufficient
  progress relative to entry expectation, return no better than modeled cost,
  and insufficient remaining space relative to pullback risk. Strong trends keep
  their original extension. No quota or forced trade to fill empty slots.
- An armed floor advances a legacy DEFERRED migration atomically to CURRENT;
  otherwise restart correctly rejects the contradictory record.

Acceptance: full v3/v4 × compact/legacy reads, overlay and repeat restart,
unknown-version rejection, profit-floor persistence and deferred migration,
fresh quote / owning timeframe / strong trend counterexamples, real React page
rendering at login/recovery/restored states, direct/member/LIVE/architecture
tests, build/type/lint/dry-run and production advancing-state receipt.
Functional correctness is not proof of improved future profit.
