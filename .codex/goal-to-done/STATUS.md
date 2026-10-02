Status: done — PAPER execution aligned to LIVE steps, 2026-10-03 Asia/Shanghai.

Production: 95f06425257013bf26492baf7c5e39e4f43bf839; exact tested tree
8fd98eae8f821cb1ca4355ecadb37b75fdc9ba93. PR613/614/615 merged through original
reviewed-main workflow; all PR/main verification and deployment jobs succeeded.

Shared committed intents dispatch owner/member LIVE immediately. PAPER shares
native admission checks, persists preparation/submission, then matches later
observed Gate depth. Pending/partial exits retain exposure. Fees/cash settle once;
partial restoration/dedup, failed commit fencing and trend handoff are covered.
Latency uses immutable first native-position confirmation; mutable mark time is
excluded. Saved erroneous pending timing recovered without account reset,
rewriting filled money/history or changing LIVE mode.

Verified:401 direct tests plus4 compatibility tests;37 focused PAPER/Worker,
208 native parity; original full CI (research/member/equity/feed, build, types,
lint, architecture/migration, dry-run). SQLite storage and compiled-member smoke
passed. Lint has only existing warnings. No new data request/timer/cap allowance,
no private production test trade or native switch action.

Two public receipts: lastSuccessAt1790964286924 ->1790964312827;
persistedAt1790964242304 ->1790964309502. Exact deployed SHA; authorityReady true,
stale false, runtime/storage errors null. Account1790951453949 retained,
closed46/open9 at both receipts, pending0. The two anomalous pending IDs are gone.
LIVE requestedEnabled=false/operational=false throughout. Execution cutover
1790962903574 preserved. Model prices, funding/liquidation and native wallet
PnL are not claimed identical; historical curves remain unchanged.

No remaining task blocker. Scope:research/PAPER_EXECUTION_STEPS.md.
