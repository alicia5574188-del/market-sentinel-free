# Eligible LIVE copy repair and actual turnover — 2026-09-18

## User scope

PnL display already works. Repair missing eligible copies without changing the active PAPER strategy, sizing ratio, source leverage or owner ON/OFF control. The interruption adds LIVE traded notional. Never equalize all holdings by backfilling pre-enable sources, enlarging a subminimum order, netting unrelated parents or counting unfilled orders.

## Evidence before changes

Two captures at 07:29 and 08:00 Asia/Vientiane retained exactly 11 current PAPER sources / 7 matched actual holdings. Of the difference, 3 unbound sources were intentionally before the owner's activation and must remain excluded. Of 3 eligible post-enable parents, ETH and BTC were copied; `龙虾_USDT` failed the leverage request with Gate 401 INVALID_SIGNATURE. True minimum-size blocked count was **0** at those snapshots. Artifacts 10526810571 and 10526208974, public-only, no owner login.

At 08:00 the runtime still labeled its resource day 2026-09-17 with 7,995/8,000 non-alarm writes. The account engine was explicitly blocked on its internal persistence guard, not on inadequate learning samples. The resource-day helper used America/New_York, but Cloudflare free daily resource limits reset at 00:00 UTC. The previous production platform quota warning is distinct; this patch does not identify the actual Cloudflare account plan or eliminate all future quota risk.

## Targeted changes

1. Gate signatures follow the official Go SDK: sign decoded UTF-8 `URL.Path` and the unescaped raw query, while retaining percent-escaped transport. ASCII requests and body hashing are unchanged. No alternate-signature fallback or ambiguous submission replay. The observed Chinese-symbol failure occurred before the market submission, so the existing safe leverage retry can work when the source is still eligible and valid; expired parents are not forced into the market.
2. Resource counters roll on UTC with the previous bounded counter record retained. No account, PnL, strategy/learning or owner-session record is reset. An older in-flight timestamp cannot roll a day backwards. No quota cap is increased.
3. Full forward state is losslessly gzip-compressed before its existing atomic chunk transaction; immutable evidence archives are unchanged. Legacy uncompressed checkpoints remain readable. Digests, decompressed-size limits, byte-length validation and corrupt-state failure remain. This reduces storage write amplification, not data completeness or sampling cadence. The protected forward-store hash is updated only for this serialization change; pure trading/owner-auth sources stay frozen.
4. Coverage now shows post-enable **copied / eligible** and a separate missing count. Pre-enable carried exposure, deliberate exclusions, minimum restriction, partial/other deviations remain separate. Counts are not fake fills.
5. New private LIVE turnover uses Gate `/futures/usdt/my_trades_timerange` confirmed fill records, not order requests or PAPER notional. Amount is native trade value when present, otherwise absolute actual filled contracts × actual fill price × actual published multiplier. No multiplier=1 guess. `close_size` splits opens/closes, including a reversal; missing classification stays explicitly unclassified while valid total is retained. Zero or invalid fill records cannot create turnover.

## Turnover scope and accounting

- Cumulative Gate USDT-account turnover since the current forward account's original start, including manual fills. The UI separately identifies system-tagged turnover; neither number is profit or margin. The account's earlier lifetime volume outside this explicit start is not claimed.
- Each Gate fill ID is deduplicated within a durable account/UTC-day ledger. Two fills from one order count separately; repeated API pages do not. Quantity/price corrections under an existing ID are surfaced, not silently added twice. Account identity is hashed and kept private. API changes to the same reported Gate user resume that account; another user never adds to its totals.
- Fixed time windows of at most 24h, pages of 100, retained offset and a 15s upper-bound delay; revisit the frontier's last 120s for indexing lag. Backfill/lagging state is marked as partial. Extremely late exchange records beyond this overlap, delisted-contract metadata missing, oversized daily ledgers and corrected fills remain explicit limitations requiring an audit; there is no unbounded historical completeness claim.
- One optional read at most every 60s, at most one summary plus affected daily bucket writes per page. No per-fill D1 writes. Same-day fill IDs compress into one lossless bucket; missing pages are not skipped. Summary and dedupe changes commit atomically before display. Analytics has a separate error state and consumes only existing write reserve after retaining a larger execution reserve; it cannot block trade/stop work or change requestedEnabled.
- Numeric amounts remain owner-authenticated. Public status exposes only version, readiness, count and scan times. Cached cumulative totals survive restart and OFF after a checkpoint, while stale/partial coverage remains visible.

## Functional verification

438 direct tests, including 82 combined actual-Worker/FakeGate parity and coverage/turnover tests, pass locally. There are 17 architecture/migration tests. New tests cover independent HMAC vectors and an encoded Unicode mock server, no network replay, decimal fills/int64 IDs, duplicates and pagination, reversals and missing classification, atomic-failure rollback, private/public separation, cached totals on restart, UTC rollover without financial reset, old checkpoint compatibility and decompression corruption/size bounds.

Exact-head PR CI, existing reviewed-main deployment and separate public production receipt are required before saying deployed. No real Gate test order, owner login, private account-value view, leverage/lot increase or mode toggle is performed by this implementation session. A production receipt may confirm turnover record presence/count, not private numeric amounts. UI numbers are exercised with synthetic component fixtures only.

## Primary references checked 2026-09-18

- https://raw.githubusercontent.com/gateio/gateapi-go/master/client.go — requestUrl.Path, QueryUnescape and SHA512/HMAC canonical string.
- https://www.gate.com/docs/developers/apiv4/en/futures/ — my_trades_timerange pagination, trade_id, actual size/price, close_size and trade value semantics.
- https://developers.cloudflare.com/durable-objects/platform/pricing/ — daily reset at00:00UTC and backend-specific row/request-unit billing. The local counter is not an authoritative account-wide Cloudflare meter.