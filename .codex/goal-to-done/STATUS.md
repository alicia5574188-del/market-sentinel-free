# Status

Release candidate in verification: the authoritative universe is now fixed to BTC, ETH, and SOL, including checkpoint cleanup so ZEC cannot return. The dashboard evaluates freshness separately for each market instead of showing every card as incomplete when only one feed is recovering.

Each market card now contains an actual Gate USDT futures candlestick chart with switchable 1m, 15m, and 1h completed candles. The chart overlays liquidity regions and current trigger, invalidation, target, or position levels. Plain text separately states direction and whether the system is waiting for real-time price, establishing a plan, or already holding. No synthetic chart data and no Gate mutation were added.

Acceptance still requires the complete local verification suite, one atomic main deployment, advancing production health, a real candle-endpoint smoke test, and live page inspection.
