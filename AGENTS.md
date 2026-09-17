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
