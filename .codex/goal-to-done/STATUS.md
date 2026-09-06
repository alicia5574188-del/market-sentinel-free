# Status

Release candidate in verification: the authoritative universe is now fixed to BTC, ETH, and SOL, including checkpoint cleanup so ZEC cannot return. The dashboard evaluates freshness separately for each market instead of showing every card as incomplete when only one feed is recovering.

Each market card now contains an actual Gate USDT futures candlestick chart with switchable 1m, 15m, and 1h completed candles. The chart overlays liquidity regions and current trigger, invalidation, target, or position levels. Plain text separately states direction and whether the system is waiting for real-time price, establishing a plan, or already holding. No synthetic chart data and no Gate mutation were added.

The complete local verification suite passed. Production rendered 216 actual candles across the three market cards, but repeated ad-hoc Gate requests and foreground Durable Object reads both proved unreliable under continuous alarm load. The final design mirrors the completed candles already collected by MarketStream to the existing D1 settings row at most once every five minutes, then serves charts through short public caches without competing with the authority. Period identity is tracked separately so an old 15m chart can never be mislabeled as 1h. Acceptance still requires the final deployment, advancing production health, candle smoke test, and live page inspection.
