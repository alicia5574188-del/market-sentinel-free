# Project instructions

Read `.codex/goal-to-done/GOAL.md`, `STATUS.md`, and `DECISIONS.md` before changes.

- This repository contains one authority: `MarketStream` and the pure modules it calls.
- Keep the public product PAPER-only. Never add a Gate order mutation, fund transfer, Auto Live switch, or live-entry endpoint without a new explicit owner authorization and separate release.
- Preserve the existing AES-GCM/HKDF format and the production `live_exchange_credentials.id=1` row. Never log or return key material.
- Futures data only. Spot order books, historical analogs, RSI/MACD-style lagging signals, and legacy strategy fallbacks are retired.
- Keep total structural stop risk at or below 5% of current PAPER equity. Include fee and stress-slippage estimates and recalculate on actual fill.
- Stale, failed, or sequence-fault data may cancel prepared plans, but may not open or close a position from an old price.
- Every alarm must remain idempotent and re-arm before optional checkpoint work. Do not add per-snapshot D1 writes.
- Keep planned daily DO requests and writes below 55,000 and planned D1 billed writes below 5,000. Update tests and README if cadence or persistence changes.
- Use `apply_patch` for edits. Run all README verification commands and `git diff --check` before commit. Do not deploy from a coding branch.
