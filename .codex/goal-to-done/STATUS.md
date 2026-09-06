# Status

Rebuild is implemented locally on rebuild/three-state-core and is not deployed. The active design uses one SQLite MarketStream Durable Object, 2-second Gate futures REST books for a dynamic four-contract universe, bounded ancillary futures data, compact multi-scale structure, estimated liquidation cohorts, and a minimal read-only PAPER UI.

MarketStream storage is the PAPER authority. D1 is an idempotent versioned mirror with an outbox. The release workflow uses an immutable trusted read-only Gate preflight, complete 15-column credential fingerprinting, v6 create-only deployment and health/restart checks, v7 legacy Durable Object retirement, then the explicit D1 purge. Direct behavior tests, migration tests, clean build, typecheck, lint, and artifact scans pass locally; no production action was taken.
