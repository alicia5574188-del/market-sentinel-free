Status: final latency correction — PAPER execution steps, 2026-10-03 Asia/Shanghai.

Implemented shared committed source intents and separate PAPER preparation,
submission, observed-depth matching, cash/fees, partial settlement and restart
dedup. Preserves account/history/strategy, owner/member activation and LIVE mode.
Original source/shared-realization provenance remains byte-identical.

Verified 398 direct tests, 34 focused model/Worker tests, original npm test,
forward/research suites, typecheck/lint and SQLite storage smoke. Compiled member
smoke passed after fresh rebuild (earlier stale-build local session timeout).
PR613 merged and original main CI/deploy succeeded:
d263c8d2c3122cf7e369a572d44b8657fc527b09 (tested tree44e46e68226f2a13d7355353adecf283054caf34).
Public production activated live-steps-paper-v1, account1790951453949 unchanged,
closed42, open8, authorityReady true, stale false, errors null, LIVE OFF.
Final inspection found delayed trend-close must release the original consumed
candidate for its continuation handoff. Added a regression and narrow fix;
new order plans immediately say EXECUTING. Original fresh trend/risk gates stay.
PR614 merged and deployed a55a4e0f738233ce95aa8702f49eb02542dac824.
Final health exposed two pending entries with2028444ms confirmation delay:
receipt.exchangeEntryAt is mutable with native mark refresh, not first fill.
Correct sampling to immutable position.entryAt, version the latency basis and
recover active old pending/filled-order latency without rewriting paid money.
Tests reproduce refreshed old timestamps and saved pending recovery.
Next: publish the latency correction through reviewed-main CI/deploy; require
advancing healthy receipts and verify the anomalous pending delays disappear.
Base: b5f591011ca380a61a80621b60311916819245cf. No private order or reset.
Scope/evidence: research/PAPER_EXECUTION_STEPS.md and tests/paper-execution.test.ts.
No claim of identical native prices, funding/liquidation or historical equity.
