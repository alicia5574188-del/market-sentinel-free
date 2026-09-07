# Project instructions

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
