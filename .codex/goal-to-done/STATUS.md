# Status

Release candidate in verification: the authoritative universe is now fixed to BTC, ETH, and SOL, including checkpoint cleanup so ZEC cannot return. The dashboard evaluates freshness separately for each market instead of showing every card as incomplete when only one feed is recovering.

Each market card now contains an actual Gate USDT futures candlestick chart with switchable 1m, 15m, and 1h completed candles. The chart overlays liquidity regions and current trigger, invalidation, target, or position levels. Plain text separately states direction and whether the system is waiting for real-time price, establishing a plan, or already holding. No synthetic chart data and no Gate mutation were added.

The complete local verification suite passed. The first deployment published successfully and production immediately returned 119 actual BTC candles, but a subsequent Gate refresh exceeded the original 1.2-second upstream timeout and made the strict post-deploy candle probe return HTTP 500. The follow-up release gives only the public chart fetch a five-second bound, serves its last actual candle cache during refresh failures, and retries the CI proof six times. Acceptance still requires the follow-up deployment, advancing production health, candle smoke test, and live page inspection.
