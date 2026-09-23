# LIVE edge compatibility and broad-shock continuity

The owner asks for one complete repair of repeated LIVE delay/missing-data
failures and a review of why a broad market selloff produced few trades and a
net loss. Keep the deployed AnchorFlow + RegionLaunch framework, stored PAPER
account, history, open-position lifecycle, risk/cost gates, credentials and
manual owner/member LIVE intent. Do not place a real-money verification order.

## Reproduced causes

1. The new signed Gate adapter sends `redirect: "error"`. Cloudflare Workers
   accepts only `follow` or `manual`, so the request fails at the edge before
   Gate can respond. The screenshot's English exception and old account-check
   timestamp are the direct result. Use `manual` and explicitly reject every
   3xx response before reading or following its location. GETs may still use the
   already reviewed second official Gate futures host; mutations stay one shot.
2. The 30-market selector locks positions, region signals and AnchorFlow, but
   omits RegionLaunch signals/states. A launch can therefore become ARMED or
   IGNITION and be removed by the next one-minute selection pass. Its one-minute
   confirmation and executable quote then disappear even though the state is
   still stored.
3. The outer selector is dominated by 24-hour travel with only a 100k-USDT
   floor. Production health during the selloff showed a realtime pool dominated
   by new small contracts while BTC/ETH/SOL were absent. Market anchors and a
   small high-turnover continuity sleeve are scan-allocation inputs only; they
   do not choose direction or bypass entry economics.
4. A valid slower 5-minute close outside the full box only accepts a later
   pullback/restart. A strong first one-minute continuation beyond the completed
   5-minute extreme is also causal confirmation and is needed when the pullback
   occurred inside the completed 5-minute candle or the market never offers a
   second pullback. It must have a long body, strong close, limited adverse wick,
   continuous data and remain inside the existing chase/economics limits.
5. REJECTION can still fade an extreme synchronized market move. When at least
   eight markets are ready and 5-minute breadth plus 15-minute context strongly
   agree against the proposed rejection side, skip only that counter-shock
   rejection. AnchorFlow and RegionLaunch retain their existing authority and
   can trade with the move.

## Bounded changes

- Preserve complete-body dual-route private GET reads, serialized source-event
  dispatch and every write ambiguity/reconciliation rule from
  `LIVE_SYNC_LATENCY_2026-09-23.md`.
- Keep open positions, live bindings, native stops, order identities, account
  history and switches unchanged. No reset or backfill.
- Reserve BTC/ETH/SOL, six high-turnover contracts and up to six strongest
  mature RegionLaunch WATCH continuities inside the existing 30 scan slots.
  Current positions/signals/READY/RETEST/ARMED/IGNITION remain ahead of these.
  Four exploration slots remain; turnover never supplies direction.
- Add only the completed-5m plus strong first-1m continuation route. Tiny drift,
  long wicks, missing/gapped minutes, return inside the box, deep pullback and
  over-chase remain rejected.
- Add a symmetric broad-shock conflict check only for REJECTION. It requires
  sufficient market count and extreme short/long breadth with confirming local
  multi-timeframe direction; neutral or incomplete context cannot block.

## Acceptance

Focused regressions cover Cloudflare-compatible redirect handling, explicit 3xx
rejection, one-shot mutations, RegionLaunch scan continuity, core/liquid sleeve
allocation, symmetric strong continuation and symmetric broad-shock rejection.
Run direct/Forward/equity/member/LIVE/feed tests, build, typecheck, lint,
architecture/migration tests, Cloudflare dry-run and `git diff --check`.
Publish only reviewed `main`; require the exact build SHA, advancing public
health, Gate stream continuity, 30 scanned markets, 11 actionable realtime
markets, unchanged LIVE intent and no strategy/account reset. These repairs
remove reproduced obstructions; they do not guarantee fills or profitability.
