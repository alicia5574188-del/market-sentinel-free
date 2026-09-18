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
- Keep planned daily DO requests and writes below 55,000 and planned D1 billed writes below 5,000. Update tests and README if cadence or persistence changes.
- Use `apply_patch` for edits. Run all README verification commands and `git diff --check` before commit. Do not deploy from a coding branch.
