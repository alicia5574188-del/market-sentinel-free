# Owner activation, contract quantity and actual floating PnL — 2026-09-18

## Requested correction

The owner rejects backfilling PAPER positions already open on LIVE enable, reports missing live floating PnL, and reports mismatched orders caused by the integer one-contract assumption. This explicitly changes the old catch-up contract. Preserve owner-exclusive ON/OFF, already-owned real position protection, current PAPER strategy/identity/lifecycle, source leverage, proportional capital and all losses/history. No private Gate credentials, login, manual exchange order or owner-switch action is used in implementation tests.

## Evidence before changes

Main de3f0e5548f028781ee8d672aecf86fdbf60f67e. Public workspace run35285249569, artifact10523458573, SHA25682deadf9f2daf82b194e31b74fd6ecef422d44f95c4c6e1faea089636c845d2b. Capture2026-09-17 23:06UTC: owner requestedEnabled=true/operational=true, 11current PAPER sources, 9copied, SOL and ZEC reported below-one-contract. No private account values were requested. Public contract metadata includes989contracts,14decimal-enabled contracts. SOL allows0.1contract with multiplier1; ZEC has minimum1contract with multiplier0.01 and enable_decimal=false. This is a timestamped example, not hardcoded symbol logic. PAPER had165closed/11open, initial1000, originalstart1789556791436.

The previous adapter used Math.floor and a hardcoded minimum1, omitted quantity metadata, and private API requests lacked X-Gate-Size-Decimal. The UI estimated floating PnL from public bid/ask rather than forwarding actual position unrealised_pnl. Source eligibility allowed any still-open PAPER parent, irrespective of enable time.

## Implemented behavior

1. OFF-to-ON creates a durable activation containing timestamp, PAPER account identity and the IDs already present. Only later-born parents can create new live orders. Equal-timestamp and explicitly excluded IDs do not qualify. Repeated ON/restart does not reset the boundary; OFF-to-ON starts another boundary. Staged submissions capture the session and recheck it after network awaits, including OFF-then-ON races. Existing copied positions stay managed and follow their original source close, even when not eligible for NEW entry.
2. One-time migration of an already-enabled runtime records a deployment fence and excludes previously unbound sources without changing owner intent or closing actual holdings. The independent owner-intent key retains the session; old checkpoints cannot remove it. New session version is new-orders-decimal-pnl-v1, the source mapping version remains current-paper-live-parity-v1 and PAPER algorithm/storage are unchanged.
3. Public contract metadata flows into the LIVE adapter: enable_decimal/order_size_min/order_size_max/market_order_size_max. Exact BigInt decimal arithmetic computes downward quantities without epsilon round-up. The published minimum is used as a CONSERVATIVE quantity quantum; the API does not expose a separately verified quantity-step field in this capture. Contradictory/unknown/missing specs fail explicitly. Maximum-size violations do not silently split or shrink. No automatic one-lot enlargement or source leverage change.
4. All private Gate requests opt into decimal size responses. Decimal signed request strings, actual partial/zero fills, exchangeSize, protection, subsequent snapshot, restart and source closure remain consistent. Real0.1positions are never treated as zero. PAPER quantities remain untouched.
5. Actual Gate unrealised_pnl, mark_price, positive reported margin/initial_margin basis and checkedAt travel with each live position. Cards show amount, timestamp and explicitly calculated PnL/margin percentage. Stale actual values retain their timestamp; missing values do not become zero or a public-price estimate. Actual zero is displayed as zero. This does not claim final after-fee realized profit or exact Gate UI ROI convention.
6. Coverage distinguishes all current PAPER sources, post-enable eligible, excluded pre-enable, carried real copies, pending, true-minimum blocked and actual partial deviations. Owner-authenticated minimum diagnostics include target/min quantity, minimum notional/margin and the live equity threshold for strict proportional sizing. A source below the TRUE minimum is not executable while retaining exact proportion and unchanged small capital; no fake copy count, accumulated future trades, substitute coin or covert sizing deviation is used.

## Safety and tradeoffs

The user deliberately requests no backfill, so simulated total holding count may exceed live count even in a perfectly working copier. Genuine exchange minimum, margin, missing specs, partial fill, risk caps, source expiry and network errors can still block a new eligible order. Decimal support fixes false integer rejection, not these constraints. The strict-size funding threshold is arithmetic for that source at that price, not a recommendation or guarantee all future orders will fit. The one-time current-ON migration preserves existing exposure but does not retroactively untrade any prior catch-up.

Current LIVE ON was observed; do not hardcode owner OFF in release verification. Development verification uses the actual Worker with a FakeGate and prohibits real fetch. Actual published source/quantity/PnL coverage can be checked through public metadata; full numeric live account verification would require the owner's own authenticated view, so do not claim private-screen or real-money end-to-end success from public status alone.

## Verification

Local415direct tests include59LIVE parity tests and retained accounting/fault protections.17architecture/migration tests, typecheck, lint, build and Cloudflare dry-run are required. New tests cover no-old-catch-up, repeated ON, OFF-window source exclusion, persisted activation and one-time migration, all original lifecycle/fault cases with legitimately post-enable source fixtures, current-session change during leverage wait, fractional positive/negative string requests, exact0.1quantization, true minima, partial/zero fills, decimal private headers, restart/protection, source-ID close, native positive/negative/zero/stale/missing PnL and UI number formatting. Permanent CI includes newOrdersOnly and executionPolicy in release/monitor assertions.

Functional and offline browser results are not a real-money end-to-end test. Actual main deployment and read-only production receipt must be attached before reporting release completion.

Official docs consulted: https://www.gate.com/docs/developers/apiv4/en/futures/ and https://www.gate.com/announcements/article/48788 . These specify decimal compatibility and contract/position fields; application correctness is demonstrated separately by tests, not by citation alone.
