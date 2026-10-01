# Current inverse PAPER → manually enabled LIVE

Verified production base: f7e7c432. The visible account contained inverse rows,
but `forwardMirrorSources` excluded them. A second gap was the candle/background
lane not waking LIVE after a committed lifecycle event. Public production reads
showed owner requested/operational OFF and zero actual open holdings.

Only current inverse PAPER rows publish NEW intents once the trial exists.
Legacy already-bound holdings retain their original source lookup/close journal.
Changing source policy adds a durable exclusion fence for existing rows without
changing the owner's switch, original enable time, account or quantities.
Each source identity remains a single durable reservation; unknown submissions
are reconciled, never replayed. One serialized executor receives committed
open/reduce/close events from either lane. Quote-only marks cause no extra private
reads. A fresh resident Gate BBO is shared; stale data uses the existing bounded
refresh. Exchange latency and slippage prevent a promise of exact seconds/fills.

Inverse PAPER remains a strict same-source-price ledger with unchanged frozen
shadow decisions. Gate executes the inverse direction using actual bid/ask.
Source moving stops/targets are reference labels, never valid inverse protection
instructions. The LIVE adverse native guard uses the original source stop width
stored at entry. Actual-equity 10% portfolio/6.5% directional caps, margin,
minimum quantity, drift and leverage checks remain mandatory. An exchange native
guard can end LIVE earlier than PAPER; this is visible deviation and the same
parent never reopens. Normal reductions/final close follow committed PAPER events,
including reductions of a losing inverse. No secondary inverse signal/timer,
profit management, source wallet feedback or source policy tuning is added.

Member projection includes only source ID/price/time marks needed to value the
strict inverse account, not a second source decision engine or wallet.
Resource topology, public feed cadence, 30-market pool and namespace are unchanged.
No real Gate verification order or owner/member switch operation is allowed.

Acceptance covers both directions, moving source reference prices, missing
original risk geometry, activation/source-policy migration, partial reductions,
close while leverage is awaited, shared fresh quote, ambiguous submit/restart,
source wake coalescing and commit failure. Existing release gates remain required.

Local candidate acceptance: 308 direct, 160 LIVE/Gate (11 new inverse tests),
49 member, 65 equity, 78 Forward and 43 architecture/migration tests; full npm
test, typecheck, build, native feed/storage workerd and deployment dry-run passed.
Lint has zero errors and the 15 existing warnings. Review/publication follows.
