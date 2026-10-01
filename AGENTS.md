# Owner correction: PAPER fees match current LIVE rate — 2026-10-02

Owner requests matching simulated fee calculation to LIVE. Screenshot totals
imply current taker reference0.05%, versus PAPER0.07%. Change only prospective
passive inverse PAPER fills: own fill notional ×0.0005, once per OPEN/REDUCE/CLOSE.
Keep frozen source decision/accounting0.0007, nominal quantity, prices, lifecycle,
history, already-booked fees/curves, LIVE5× and manual sessions untouched. Stamp
new fills with their fee policy/rate, accept old7bp receipts without rewriting,
and report each ledger's own fees consistently in balances/views/review exports.
This is the owner's current reference rate, not an unqueried VIP/discount feed.
No new Gate read, timer, storage row, test trade/reset or LIVE control. Full
reviewed-main release and advancing production/account continuity required.

# Owner correction: half LIVE leverage / doubled margin — 2026-10-02

The owner explicitly requests halving leverage and doubling isolated margin to
reduce premature liquidation. Apply to inverse LIVE copies only: preserve the
same proportional target notional/quantized contracts, frozen source/PAPER,
decisions and lifecycle. New copies use half source leverage; migrate existing
program-owned inverse holdings with native confirmation and sufficient available
margin, no close/reopen or cross-margin switch. Prior same-leverage wording is
superseded for inverse execution only. Idempotent absolute leverage target from
original source receipt, bounded retry and one adjustment per existing complete
sync; no new alarm/data cadence or automatic LIVE control. Source exits retain
priority. Tests, reviewed-main release and advancing-state receipts required.

# Owner correction: overview-only PAPER/LIVE curves — 2026-10-02

The owner now wants both curves on overview only; remove PAPER's curve from the
simulated page. Add the same chart controls/cache for Gate-native account equity,
isolated by owner/member and the existing manual activation enabledAt. OFF keeps
the last saved session for viewing; the next OFF-to-ON hides old points immediately
and starts a new native baseline, without resetting the account, trades, source,
PAPER history or execution fence. Repeated ON and process/browser restart retain
the session. Save at most one fresh native mark per five minutes through existing
checkpoint transactions, charged to optional write capacity; no new Gate read,
alarm or trade. Keep rows outside bounded hot checkpoints and protect private
owner/member GETs. Existing reviewed-main release/continuity gates still apply.

# Owner correction: keep original PAPER curve visible during LIVE — 2026-10-02

The owner requests keeping the original simulated equity curve visible when
LIVE is enabled. Render the original PAPER curve as a clearly separate reference
on overview and the LIVE-mirrored simulated page. Preserve the existing account
identity, archive/cache scope and history; never splice Gate marks into PAPER.
LIVE ON headline equity, floating, order rows and settlements remain Gate facts.
This is presentation only: no strategy, trade, stop, sizing, owner/member switch,
account reset, archive write or new polling/alarm cadence. Verify scoped rendering
and the existing reviewed-main release; no private verification order.

# Owner correction: execution participation / LIVE authority — 2026-10-01

Owner explicitly abandons favorable-entry waiting and winner-filter research.
Use the same fresh Gate response for inverse execution sizing/dispatch, execute
market IOC promptly, minimize and record source/fill gaps instead of vetoing
adverse prices. LIVE ON overview and simulated account must reflect actual Gate
equity, native floating, confirmed fills and native settlements. Keep the frozen
shadow/source ledgers independent as signal/research authority, never pretend
uncopied PAPER profits are LIVE results. Size NEW inverse copies from CURRENT
LIVE capital, preserve real-account risk/margin/minimum-lot gates, unique sends,
unknown reconciliation, partial-fill honesty, existing positions/history and
manual owner/member sessions. No old-source replay, test order, switch action or
new data/alarm cadence. This supersedes favorable IOC and fixed-scale divergence
veto for inverse additions. Reviewed main deployment and advancing receipt.

# Owner correction: optimize LIVE exits too — 2026-10-01

Owner explicitly asks to optimize exits because actual PAPER profits exceed
LIVE. Prioritize committed inverse source CLOSE/REDUCE when Gate exposure is
confirmed, without waiting for balance/all-order reads. Keep complete snapshot
authority for additions. Use existing fresh BBO for a bounded reduce-only IOC;
after a known terminal close result, confirm actual residual and complete it
immediately by reduce-only market. Never wait for PAPER exit price or add an
independent inverse stop/target/timer. Durable identities survive unknown sends;
no blind retries. Preserve frozen source/PAPER, manual sessions/switches and
history. Event-driven residual reads/journals only; no extra market/alarm cadence.
Include owner/member isolation, settlement honesty and existing resource gates.
Reviewed-main deployment and advancing public receipt; no real test trades.

# Owner correction: compact LIVE cards and favorable entry prices — 2026-10-01

Owner requests continuing the interrupted LIVE display / unfavorable-copy fix.
NEW inverse LIVE entries may wait for an executable price at least one Gate tick
better than the strict same-price shadow/inverse entry. Use a decimal-exact,
exchange-enforced IOC limit; no unbounded market fallback, extra alarm, repeated
post-submission identity or refill after partial execution. Reserve size/margin
at the worst permitted limit. Preserve unknown-outcome reconciliation and source
close, existing holdings, frozen shadow/PAPER accounting, manual sessions, current
switches and resources. Show six primary order fields and fold full attribution.
No test trades or switch changes; reviewed-main release and advancing receipt.

# Owner correction: inverse LIVE follows shadow events only — 2026-10-01

The owner explicitly shelved the proposed dangerous-entry redesign and asked to
remove the current inverse LIVE protection prices. This supersedes the adverse
native guard instruction below. Do not alter the frozen shadow or either PAPER
ledger. Inverse LIVE must have no independent stop, target, timer, protection
failure exit or source-horizon exit. Follow committed source OPEN/REDUCE/CLOSE,
with the opposite shadow side and proportional capital/requested leverage.
Cancel only tracked inverse native guards (including replacements/late responses),
confirm their absence and retain identity on failures; never force a market exit
because cancellation failed. Preserve legacy noninverse native protection,
manual switches, new-only activation, exactly-once reservations, actual margin,
exchange constraints and account history. Admission risk is an allocation charge,
not a claimed loss bound. No real-money verification trade or automatic LIVE ON.

# Owner-authorized inverse LIVE bridge — 2026-10-01

The owner's latest request completes the previously requested LIVE follow of
the current inverse PAPER account, including shared fresh BBO and committed
open/reduce/close events. This supersedes the older PAPER-only publication
exclusion below, not either PAPER decision/accounting policy. Preserve manual
owner/member intent, new-only activation, proportional capital, leverage,
exactly-once reservations and existing actual-account risk caps. The source's
moving stop is a source reference, never an inverse loss-side native stop.
Use the saved original source risk width for the adverse native LIVE guard;
native protection, fills and API faults can diverge from PAPER and are recorded.
Do not enable LIVE, reset accounts or make real exchange verification orders.
Read research/INVERSE_LIVE_BRIDGE_2026-10-01.md. Run the full reviewed-main
release and read-only advancing production receipt.

# Frozen shadow / passive inverse PAPER trial — 2026-10-01

The owner explicitly approved freezing the complete pre-integration `2b4fd60f77c9b78526bd5087940945fe7e86fab8` decision policy as a shadow and passively reversing its NEW PAPER lifecycle. Read `research/SHADOW_INVERSE_2026-10-01.md`. This supersedes new-entry research integration for this trial. The source, including its endogenous wallet/history/risk, decides everything; inverse results cannot feed back. Same contracts, opposite direction, same open/reduce/close event. No independent inverse stop, target, filter, resizing or winner selection. Source winners become inverse losers too. Current holdings drain under their existing policy; no historical PnL inversion, account reset or replay.

This release is a PAPER-only experiment, not authorization to place inverse exchange orders. Exclude inverse rows from owner/member LIVE source publication and label that limitation; existing LIVE intent/legacy protections remain unchanged. Do not send the source's profit-side stop as an inverse hard stop. Each ledger pays its own actual modeled fees once, and spread is attribution only. Manual account reset is an explicitly marked administrative close of both ledgers, not a fabricated market event. Frozen source hashes, paired-money/restoration tests, the existing resource gates, normal reviewed main release and read-only production continuity receipt are required. Never claim the historical source will keep losing or the inverse will keep profiting.

# Unified research plan — 2026-10-01

The owner approved graded research/execution integration while preserving the winner discovery mainline and requested version-accurate review snapshots. Read `research/UNIFIED_PLAN_2026-10-01.md`. This supersedes research-only authority for the scoped new tagged plan adapter, not for shadow geometry. Keep untagged plans/legacy holdings, money, source identity, accounts, LIVE intent, risk ceilings, data budgets and clocks intact. A market warning alone must not close or tighten a healthy runner. Same-source price scores cannot pose as independent confirmations. Tests demonstrate mechanism/compatibility, not profitability; main-only verified deployment and advancing-state receipt remain mandatory.

# Shadow Market Geometry / Profit Conversion research — 2026-09-27

The owner explicitly wants to preserve the currently promising Market Intelligence account while researching whether choppy/rotational conditions, late chase entries and profit giveback are still under-modeled. Read `research/SHADOW_GEOMETRY_PROFIT_CONVERSION_2026-09-27.md`. This work is research-only: it may observe existing Market Intelligence state, completed 5m candles, ENTRY_RESPONSE receipts and trade MFE/MAE, but it may not feed back into symbol selection, entry, exit, stops, sizing, risk, PAPER state, LIVE parity or member copying. Do not reset the account. New research writes must stay optional/background, add no market-data requests or alarm cadence, and yield before financial authority. Any later strategy change requires separate evidence and explicit owner approval.

# Resource sufficiency is a permanent quality invariant — 2026-09-27

The owner requires every future change to preserve full trading/data quality **and** keep the deployed Workers Paid resource model comfortably inside the already-paid monthly allowances. This supersedes older instructions that treated the legacy 8,000/day non-alarm counter as a financial admission limit. Never solve a resource problem by scanning fewer markets, reducing the 2s execution observation quality, suppressing valid trades, dropping evidence/history, weakening LIVE protection, or disabling research/data sources. Prefer lossless compaction, deduplication, event-driven persistence, immutable-write reuse and explicit priority lanes.

Financial authority (PAPER open/close/account generations), owner LIVE intent, source-close durability and forced LIVE journals are critical writes: they may fail only on a real storage/platform error, never because optional analytics/cache work reached a self-imposed counter. Optional/background writes retain a generous runaway guard and yield first. Keep critical-protection persistence independent. The current paid-plan storage contract models the owner plus the two admitted member execution seats over a 31-day month and must remain below 50% of Cloudflare's included SQLite Durable Object row writes, leaving >35M rows/month headroom at the current topology. CI must fail if that contract is violated. Requests, duration, D1 and other metered dimensions remain separate resource gates and must be reviewed whenever cadence/topology changes. Do not claim a capacity guarantee for dimensions that were not checked.

# LIVE edge and broad-shock continuity — 2026-09-23

The latest owner request authorizes the scoped repair in
research/LIVE_AND_SHOCK_CONTINUITY_2026-09-23.md. Fix Cloudflare-incompatible
private Gate redirect handling without weakening dual-route reads or replaying
writes. Preserve AnchorFlow + RegionLaunch and improve only scan continuity,
core/liquid allocation, completed-5m strong continuation and extreme synchronized
REJECTION conflict handling. Keep the account/history/open positions, risk,
cost, freshness, credentials and manual LIVE intent unchanged. No reset or real
order. Reviewed-main deployment and public continuity receipt are mandatory.

# Private LIVE read and dispatch repair — 2026-09-23

The latest owner request authorizes fixing repeated private Gate account timeouts
and PAPER-to-LIVE scheduling latency. Read research/LIVE_SYNC_LATENCY_2026-09-23.md.
Use two official Gate futures GET routes with complete-body deadlines and abort
losers; never hedge mutations or accept another exchange's private account data.
Committed source lifecycle events wake a serialized background reconciler without
holding the critical book/PAPER alarm. This explicitly permits only the alarm,
advanceForwardNow and syncLiveOnce method baseline updates plus reviewed private
adapter fingerprint after semantic tests. Preserve strategy/storage/auth hashes,
owner/member intent, unknown-order reconciliation, fresh data/risk gates, account
and history. No real-money test. Existing reviewed-main release and public
advancing-state/continuity receipt remain mandatory.

# Forward Adaptive v2 architecture lock — 2026-09-20

The user explicitly authorizes a one-time architecture-level upgrade of the current Forward self-learning route, not a replacement with fixed strategies. Read `research/FORWARD_ADAPTIVE_V2.md` first. Preserve the existing PAPER account, samples, history, open positions, source identity, owner/member LIVE intent, credentials, Gate copy contract, Top30 five-minute learning feed and bounded realtime quote pool. No account reset or real-money verification trade.

The release goal is to correct the structural asymmetry where market protection reacts faster than opportunity generation. Add a bounded rapid 15-minute lane using only matured causal response measurements; refit when new outcomes mature; convert market warnings/drawdown into continuous priority and allocation weights instead of new-entry silence; and allocate risk best-first instead of pre-dividing headroom across every candidate. Market state may never manufacture a trade or force reversal. Safety gates for fresh quotes/data, valid contract metadata, modeled costs, account/side/total risk, margin and original stops remain hard.

A future loss or user hypothesis must not add another hard veto by default. Reproduce the failure at the correct layer and compare against the architecture invariants first. “Fewer trades” is not itself an improvement. This strategy release may improve adaptation and participation but must not be described as proof of future profitability.

# Complete audited repair — 2026-09-20 continuation

The user asks us to finish known fixes end-to-end and permits deployment once demonstrably better. `research/AUDITED_REPAIR_RELEASE_GATE.md` is the current gate. The earlier HOLD below records the rejected intermediate design. Keep the financial lane at8,000; independent durable protection has at most8,640 writes/day and cannot consume exit capacity. Compact full storage and no-amount-change turnover coalescing must remain lossless. Counted financial writers require synchronous reservations through commit/failure, including members. This narrowly authorizes the `saveCheckpoint` frozen body update as well as `advanceForwardNow` and affected pure storage/helper baselines, after semantic tests. Eight other frozen primary bodies, owner intent, credentials, account identities and membership capacity stay unchanged.

Correct the obsolete owner-only55,000 write target explicitly: reserved rows are63,032 primary and99,192 with two members/directory usage. This is not a global capacity guarantee: retries, manual controls, other readers and account-wide duration/requests remain separate limitations. No billing plan, alarm/data cadence or trading switch change. No bare rollback to401768c after compact writes: keep the compatible reader or first atomically rewrite fully restored state including protection overlay to the old format. Main-only verified deployment and advancing-state receipt remain mandatory. Correctness/resource improvements are not future-profit proof.

# Audited repair candidate — 2026-09-20 (historical intermediate HOLD)

User requires demonstrable improvement before deployment. Read `research/AUDITED_REPAIR_RELEASE_GATE.md` first. Candidate repairs deterministic exit/forecast/LIVE-risk/health defects, but the compact peak checkpoint has a reproduced write-budget versus exit-commit regression. Do not merge/deploy until resolved; passing functional tests do not prove net-profit superiority. This task authorizes only the corresponding forward/store and `advanceForwardNow` frozen-hash updates; keep all other frozen primary methods, credentials, owner intent, ledgers and membership capacity unchanged. No real-money production test.

# Equity history cache — 2026-09-19

User requests retaining history across tab changes and reducing repeated reads. Implement only authenticated browser-scoped projection caching and bounded exclusive new-archive reads; keep all strategies/cadence/financial state/owner and member execution untouched. Read research/EQUITY_CACHE_INCREMENTAL.md. Cached curves are not trading authority or proof of better returns. Preserve frozen tests and reviewed-main deployment/continuity checks.

# Read-only equity chart and manual reference — 2026-09-18

User authorizes observed-equity-reference-v1 only. Read research/EQUITY_CURVE_REFERENCE.md. Project actual saved archive marks from initial capital, never fabricate a historical flat balance or replace raw values by smooth interpolation. Default week/mobile history navigation. Manual LIVE timing sentence is descriptive, conditional and sample-aware, not a new strategy or automatic switch. Whole-account PAPER recoveries include old holdings unavailable to new-only LIVE. Keep all source/execution/cadence/account/member/owner authority unchanged; bounded authenticated reads, no trading writes or extra alarms. Preserve frozen tests and ordinary reviewed-main deployment/advancing-state receipt.

# Targeted protection timing — 2026-09-18

The user authorizes a small change for timely profit protection and faster defense after confirmed opposite evidence, while preserving participation and stable operation. Read `research/TIMELY_PROTECTION.md`. New source orders carry `timely-protection-v1`: remove ONLY the extra five-minute giveback and fifteen-minute confirmed-relation age embargoes. Original arm/width/stop/deadline, candidate discovery and scan/refit cadence remain unchanged. Existing unmarked positions retain their original rules and timing; no retrofit of historical peaks. No equity-peak stop, daily pause, loss-triggered reversal, minimum-lot enlargement, weak-rule veto or membership/owner-control change. New ordered exits carry observed timing/overshoot audit, not invented first-crossing times. Source loss history and current primary/member LIVE parity remain intact. This explicit authorization updates only the forward-engine baseline and its new pure helper; ten original primary execution method hashes stay unchanged. No claim of lower future drawdown or profit is established by synthetic tests. Deploy only verified reviewed main and obtain a public advancing-state receipt.

# Compact records and read-only settlements — 2026-09-18

User explicitly requests deployment of UI copy cleanup, member terminology, separate PAPER positions/recent10/archive50 views and actual LIVE closed-position PnL. Presentation retention must not delete the strategy/financial/source/dedup ledgers. Gate historical PnL is attributed only with matching contract, side, original reservation/position cycle, size and price; ambiguous/missing data stays pending. A lazy owner/member-authenticated history reader uses at most one optional GET page/minute and a separate account-scoped cache, never changes trading or LIVE intent. Original critical trading method hashes remain intact. This is not a strategy change. Existing main release verification and post-deploy continuity checks still required.

# Isolated member login keys — 2026-09-18

The primary owner authorizes personal member login keys only and explicitly prioritizes the stable running system. Read `MEMBER_ACCESS_CONTRACT.md`. Do not change PAPER decisions, signal frequency, sizing, primary LIVE execution logic, owner intent/activation or history. Only the primary owner issues distinct permanent keys; new keys never revoke existing memberships, including unused keys. MemberDirectory and MemberExecutor are additive isolated namespaces; zero members must add no alarm or primary trading work. Members consume the same source and control only their own encrypted API/LIVE, default OFF. Master sees only program-attributable turnover summaries. Initial admission is20issued accounts/2active member execution seats, primary excluded, explicitly disclosed and not silently expanded. Guests now require login for program API data; health remains operational metadata. Every release runs member isolation, original parity and frozen-primary-body tests. No real-user key, member, login, Gate order or switch is created for production verification.

# Current copy coverage and turnover request — 2026-09-18

Repair confirmed post-enable execution gaps and add owner-visible Gate confirmed-fill turnover. Read `research/LIVE_COPY_COVERAGE_TURNOVER.md`. Do not change PAPER decisions, sizing/leverage, activation fence, existing holdings or owner mode. Preserve all money/history; serialization may change only losslessly with legacy-read tests. Gate Unicode signing and UTC resource day must match official contracts. Trade analytics is independent, bounded and cannot impair protection.

# Latest owner request — NEW orders, decimal lots, real PnL / 2026-09-18

Read the amended `LIVE_MIRROR_CONTRACT.md`. Do not backfill PAPER positions already open when LIVE is enabled. OFF-to-ON captures a durable source-account/time/ID fence; refresh, repeated ON and deployments preserve it. Previously bound real positions still receive protection and their original source close. Every private Gate size response must enable decimals; actual contract min/max controls downward exact sizing, never silent minimum-lot enlargement. Display native position unrealised_pnl and declared margin-based percentage, with stale/unknown semantics. Current owner intent may be ON: do not turn it OFF or invoke private Gate for tests. PAPER strategy/history remains unchanged. The following older backfill wording is superseded.

# Permanent current-PAPER LIVE parity — 2026-09-17

The owner explicitly requires EVERY future version to mirror its current visible PAPER orders to LIVE when, and only when, the owner enables. Read `LIVE_MIRROR_CONTRACT.md` first. Earlier PAPER-only-routing/canonical-LIVE restrictions below are superseded. The simulator still has no private keys; the owner-enabled adapter mirrors persisted source identities, full rules and lifecycle with frozen proportional capital/same requested leverage. Do not change strategy or reset accounts to add this bridge. Errors pause execution, never override the owner's switch. Unknown fills and exchange differences remain visible. `test:live-parity` and production current-source metadata are mandatory release gates. This session must leave actual LIVE intent unchanged and perform no private Gate trades.

# Current participation authority — 2026-09-17

The user authorizes restoring the active forward baseline's opportunity breadth with targeted execution/cost corrections. Current specification: `research/FORWARD_PARTICIPATION_REPAIR.md`. Reject no-trade-as-success. Keep PAPER-only authority, continuous accounts/losses, original position geometry, owner LIVE intent, native dark UI, existing Worker and deployment paths. Algorithm marker is participation-execution-v1.2; storage schema stays v1.0. Earlier v1.1 hard-unanimity gates below are superseded only as documented.

# Current correction authority — 2026-09-17

The user authorizes the targeted PAPER evidence/calibration repair in `research/FORWARD_EVIDENCE_REPAIR.md` and direct main deployment after verification. `lib/forward-evidence.ts` supplies bounded learning controls, not LIVE authority. Preserve the v1 storage prefix/schema and all financial records; version algorithm changes separately. Keep Worker, LIVE/auth/credentials and established deployment path unchanged. Read newest goal/status/decisions before historical instructions.

# Project instructions

Current authority addition (2026-09-16): `lib/forward-relations.ts` is the user-authorized real-feed PAPER-only generated-rule engine. Old frozen regime strategies have no new-entry authority. Their records, existing protective lifecycle and canonical LIVE source remain intact. Do not wire generated rules to LIVE. Preserve forward state and archives through deployments; never seed historical outcomes or reset on corruption. User requested direct main deployment after functional verification, not another profitability backtest. Read the newest sections before historical decisions.

Read `.codex/goal-to-done/GOAL.md`, `STATUS.md`, and `DECISIONS.md` before changes.

- This repository contains one authority: `MarketStream` and the pure modules it calls.
- The public surface is read-only. LIVE mutations require the fixed owner account, a signed same-origin session, and the user-controlled switch; deployment and login must never enable LIVE automatically. Fund transfers remain forbidden.
- Preserve the existing AES-GCM/HKDF format. The owner may save/replace `live_exchange_credentials.id=1`, or delete it only while LIVE is off and Gate has no positions or orders. Never log or return key material.
- Futures data only. Spot order books, historical analogs, RSI/MACD-style lagging signals, and legacy strategy fallbacks are retired.
- Keep total structural stop risk at or below 10% of the applicable PAPER or actual Gate equity, with same-direction BTC/ETH/SOL risk at or below 6.5%. Include fee and stress-slippage estimates and recalculate on actual fill.
- Stale, failed, or sequence-fault data may cancel prepared plans, but may not open or close a position from an old price.
- Every alarm must remain idempotent and re-arm before optional checkpoint work. Do not add per-snapshot D1 writes.
- Use the latest scoped resource model above; the original55,000 owner-only planning assumption is obsolete. Keep planned D1 billed writes below5,000. Update tests and README if cadence or persistence changes; local counters are not whole-account quotas.
- Use `apply_patch` for edits. Run all README verification commands and `git diff --check` before commit. Do not deploy from a coding branch.
