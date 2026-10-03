# Unified market branch authority

Algorithm marker: `market-regime-authority-v1`. Existing account/envelope/storage
versions remain readable; active version is in `directStrategy.marketAuthority`
and every new trade's `unified.marketRoute`. This release replaces autonomous
per-coin branch choice for correlated followers. It does not reset a wallet,
rewrite losses, enable LIVE or create another strategy account.

## Causal decision cycle

1. Freeze a completed 5m reference before the recent departure. A candidate ID,
   refreshed scan or new quote cannot move this reference. Width/ATR are OHLCV
   proxies, not observed orders or a claim to know traders' intent.
2. A trend earns authority through three completed closes outside the reference
   with retained advance under counterpressure, or departure/counter/restart.
   Use existing official venue 1m bars where available, against the same frozen
   reference; otherwise use completed 5m bars. No synthetic quote candles certify
   structure. A quote tick cannot multiply completed-bar evidence.
3. Aggregate followers by correlation group, giving each group equal weight.
   Require fresh multi-venue coverage of at least 60% of the frozen electorate
   and at least three symbols. Normal quorum is two groups and 65% directional
   support. A genuinely synchronous single common factor is explicitly one group:
   at least six covered symbols and 80% agreement are required. Do not describe
   that case as multiple independent confirmations. Freeze the electorate during
   a trend, rather than letting scan rotation declare a different market. Retain
   up to eight market representatives, prioritizing anchor/group coverage. Keep
   those observers in existing scan/BBO/minute allocation ahead of ordinary new
   discovery, with holdings and armed execution first. This prevents a frozen
   electorate being silently evicted by radar rotation. The same 30 scan/BBO and
   11 minute capacities apply; held coin memory wins the 30-episode bound.
4. `UP` permits follower LONG continuation only; `DOWN` permits SHORT continuation
   only. `RANGE` permits failed-departure returns only. `HANDOFF` permits neither.
   Follower amplitude/score differences select location and size, never a branch.
5. Detachment requires own accepted trend plus residual beyond noise, normalized
   residual >=1.5, persistence >=.75, correlation <.55 and three distinct completed
   5m observations. A DIVERGENT label, a single spike or leverage-sized move is not
   permission. Lost independence returns the coin to common market authority.

These thresholds are declared starting controls, not fitted profitability claims.
The system cannot know a real trend at its first tick. Minute confirmation is
available only for the existing bounded official-minute coverage; this release
does not pretend all listed coins have continuous minute structure.

## End of a leg and next-leg admission

Loss of retained progress or 40% warning groups pauses new follower entries and
reviews existing protection. Warning does not immediately sell a healthy runner
or open an opposite position. Existing accepted support can tighten only after a
completed counter move and renewed advance; financial protection never loosens.

Two completed closes beyond accepted support, with recovery still failing, revoke
that coin's trend. Common support <40% together with >=60% broken/opposite group
evidence revokes the market trend into HANDOFF. Unconfirmed followers and failures
of the other direction do not count as broken accepted supports. Retain recorded
support failure while a new reference forms; resetting geometry cannot erase the
failure that invalidated the preceding leg. A confirmed opposite/range vote
cannot directly flip an accepted trend. The next cycle must separately establish
the next direction or a two-sided failed-departure range. Missing coverage keeps
the last phase as stale and suspends entries; it cannot create opposite authority.

Range authority requires a previously balanced reference and failed departures on
both sides, followed by renewed acceptance inside it. New return events need an
actual failed edge attempt with follow-through back toward the center, or an
in-range impulse/counter/restart failure and a break of the counter base. Stop is
beyond that failed extreme. Target is the accepted center. A slower impulse or an
unconfirmed trend alone does not qualify. Range positions never promote to trend
under an incompatible common market label.

## One actual execution direction

Both branches pass through the existing entry response and location validation
using the actual order side. Freeze proof identity and actual stop before arming;
require fresh executable Gate BBO and sufficient current net space/risk after
cost. Recheck market epoch/permission immediately before admitting an intent.
An old frozen validation cannot survive a market switch into a contrary entry.

Trend entry space is a finite volatility leg estimate unless an actual reference
target exists; the estimate is labelled, never claimed to be future liquidity or
a mandatory profit exit. Do not chase beyond .75 reference ATR from proof price.
Return exit is its own structural stop, center target or revoked market permission.
Trend exit is its own structural stop, failed acceptance or revoked common trend.
No calendar exit or account-dollar loss threshold substitutes for structural facts.
Existing winner protection/partial-realization remains, assessed on actual side.

At cutover preserve filled IDs, quantities, fees, balances and history. Never
manufacture new entry anchors for legacy holdings. Cancel unfilled legacy intents;
filled legacy positions keep their original obligations until those complete or
confirmed common authority invalidates the old branch. Source closure is committed
through the existing PAPER/LIVE flow. New opposing follower intents wait for old
PAPER branch closure confirmation; native account reconciliation/admission and
new-only owner/member activation remain separate exchange execution constraints.
PAPER book-model matching and native fills are not promised equal.

Marked v1 returns have an actual adverse-side structure stop, so their execution
receipt uses the existing regular native protection path. Legacy inverse/return
receipts remain event-only, with no reflected guard reintroduced. Receipt version
disambiguates these obligations across owner/member restart. New trend admission
checks the labelled finite route estimate even though its holding plan deliberately
has no mandatory profit target; PAPER uses that same LIVE admission builder.
Native guard creation/update stays per admitted order/confirmed structure change
inside the existing serialized executor and resource limits, never a new timer.

## Persistence, evidence and release

At most 30 coin episodes, 30 electorate members and eight phase events. Store the
controller through the existing coalesced protection checkpoint; commit a market
epoch transition with financial authority. No new market request, alarm, D1 tick
log, KV key family, seat, scan capacity or timer is introduced. Account reset can
retain causal market learning; it cannot reset a traded same-side event identity.

Research snapshots expose current controller, preceding transitions, every coin's
reference/acceptance/failure/relation and each trade's route. Estimated target basis,
data recovery and pending closure remain explicit. Older narrative/geometry fields
are diagnostic context; this version alone authorizes active strategy branches.

Synthetic functional checks cover early official minutes, both trend directions,
common-factor counting, range admission, actual return stops/targets, independence,
handoff, stale data, repeated timestamps, epoch fencing, incompatible pending
exposure, metadata bounds, checkpoint corruption and account continuity. Original
execution, member, native parity, resource, build and storage checks remain required.
No historical market replay or profitability backtest is added. Publish only via
the existing reviewed PR/main workflow, then confirm deployed SHA, advancing cycle,
unchanged account generation/LIVE intent and healthy storage. Future market results
determine profitability; functional checks do not certify positive returns.
