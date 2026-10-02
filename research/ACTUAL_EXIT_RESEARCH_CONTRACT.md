# Bounded actual-order exit evidence

`actual-exit-research-v1` observes actual `dual-thesis-v2` RETURN and
CONTINUATION trades after execution calculation. It cannot change a signal,
allocation, stop, exit, commit flag, manual control or market-data cadence.

Each trace is at most 4096 UTF-8 bytes and eight points. Timestamp anchors
reference the same point bodies. First observed floating loss strictly below
-10 USDT, observed extrema, recovery levels, evidence changes and terminal
outcomes are retained subject to that cap; dropped points are counted. Quotes
must be fresh. Late/migrated observations are identified rather than backfilled.
RETURN intelligence describes the observed push direction, explicitly distinct
from the actual trade direction. Already calculated local acceptance and flow
facts are reused without another research evaluation.

Hypothetical exit estimates use the actual direction's BBO, remaining exposure,
already realized proceeds/fees and one estimated taker exit fee. Terminal net
uses the actual PAPER settlement. These are not native LIVE fills. Winning
trades that previously crossed the loss threshold remain control cases. Extrema
are hindsight diagnostics, not executable exit recommendations; later market
paths and feedback from a changed exit policy are not simulated.

Ten active traces contribute at most 40 KiB. Eight recent closed traces are
retained in hot runtime; a newly closed burst survives its existing financial
archive commit (at most ten additional traces), then yields on later ticks.
Existing hot projection also limits retained closed traces to eight. No
unbounded queue, new storage key, timer, request or checkpoint cadence is added.
Member dispatch and ordinary owner page projections omit the optional research
and observation body. Only explicit research exports include the full traces.

Research yields before another compressed account chunk and the existing
120 KiB protection record, 640 KiB hot
account target, and 112 KiB financial archive packet limits. Optional research
alone does not create another archive shard. Omissions are explicit, financial
receipts and essential protection remain intact, and read-only exports hydrate
omitted cold evidence when available through the existing bounded pagination.
The existing single pending protection overlay keeps eligible observations;
unsaved intra-slot evidence can be lost on a crash. No old event history or
settlement is deleted or rewritten.
