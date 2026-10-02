Status: in progress — PAPER execution steps, 2026-10-03 Asia/Shanghai.

Implemented shared committed source intents and separate PAPER preparation,
submission, observed-depth matching, cash/fees, partial settlement and restart
dedup. Preserves account/history/strategy, owner/member activation and LIVE mode.
Original source/shared-realization provenance remains byte-identical.

Verified 398 direct tests, 34 focused model/Worker tests, original npm test,
forward/research suites, typecheck/lint and SQLite storage smoke. Compiled member
smoke passed after fresh rebuild (earlier stale-build local session timeout).
Final unchanged-logic build/dry-run are running. No new market timer/request/cap;
same financial reservations, bounded depth/partial events and history remain.
Next: create reviewed branch/PR, require CI, merge original main, verify exact
deployment SHA and advancing public healthy account state.
Base: b5f591011ca380a61a80621b60311916819245cf. No private order or reset.
Scope/evidence: research/PAPER_EXECUTION_STEPS.md and tests/paper-execution.test.ts.
No claim of identical native prices, funding/liquidation or historical equity.
