# PAPER execution aligned to LIVE steps

Scope: replace new dual-thesis PAPER instantaneous signal fills with a durable
execution transport. No signal rule, account generation, native switch, private
credential, timer, market request, archive sampling or capacity changes.

The financial state retains pending instructions under their original source
identity. Unfilled entry reservations consume capacity but have zero funded
exposure or paid fees. The existing owner/member LIVE source API projects the
committed instruction immediately. PAPER preparation uses the very same
buildProportionalMirror account/risk/lot/margin/leverage and final-price checks.
Submission is persisted independently from a later fresh executable-book
confirmation. Fees and cash change once, only for observed matched quantity.

Entry IOC discards the unmatched remainder after a partial fill. Closing or
reducing retains actual residual exposure until later liquidity can settle it.
Fragments from one execution order coalesce into a weighted price, bounded to
two reductions plus one closing order. Gate sequence, or a bounded book
fingerprint for feeds without sequence, prevents reusing unchanged displayed
depth across heartbeats and restarts. Full close supersedes a pending reduction;
already realized money remains under the same parent. Durable commit failure
cannot publish an instruction, move cash, or dispatch native execution.

Confirmed RETURN_TREND_CONFIRMED settlement releases the original consumed
candidate for the same continuation handoff as immediate settlement did.
It never releases before cash settlement or directly creates a new trade:
fresh per-symbol trend, space, metadata and portfolio checks still apply.

Native entry is never gated on PAPER fill. A source projection freezes signal
time, requested size and allocation risk; PAPER confirmation cannot change
native copy sizing or backfill pre-enable signals. Pending close is an explicit
source close instruction, not a fabricated PAPER settlement. Existing closure
journal/member lookup protects it after hot-history rotation. Cancelled unfilled
entries are bounded to32 hot records, separate from paid trade history.

Resource bounds: reuse the existing2s decision clock,10s protection lane,
financial reservation/cap, financial/archive keys and urgent book pool<=30.
No independent order polling, unbounded fragment log, extra market requests or
larger row allowance. Every stage/partial settlement uses the existing financial
budget; optional research yields under the same policy. Error text changes in
numbers alone cannot create a financial write every tick. Existing financial
event saturation limits still apply; no unbounded-throughput claim.

Old money, fees, entry points and curves remain exact. Existing filled positions
acquire execution metadata only when a subsequent close/reduction is requested.
Review traces start at actual model entry confirmation; pending entries cannot
produce PnL evidence. Frozen baseline source/shared realization code stays
byte-identical; the new transport has a separate financial restoration validator.

Limits: public-book matching is a model, not Gate execution evidence. Observed
latencies use bounded historical receipt medians; without receipts the explicit
fallback uses the execution clock. Native funding, isolated liquidation,
exchange outages/rejection probabilities, queue priority and private wallet
differences are not replicated. No equality of native prices/equity/profitability
is certified. No production private orders or manual mode changes are tests.

Validation: test:paper-execution; real Worker sub10s protection and committed
close dispatch/failure tests; original direct/forward/live/member/equity/frozen
provenance suites; typecheck/lint/build/dry run; storage/member workerd smoke;
reviewed main CI and advancing public production health/account continuity.
