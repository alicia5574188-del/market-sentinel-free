# Decisions

- Market states are mutually exclusive: BREAKOUT, REVERSAL, RANGE; otherwise WAIT.
- Inputs are predictive liquidity, path resistance, active-flow/price response, entry-price OI cohorts, public liquidation calibration, and completed 1m/15m/1h structure. Lagging oscillator and historical-analog systems are retired.
- The universe is permanently limited to BTC_USDT, ETH_USDT, and SOL_USDT. Restart recovery prunes every old symbol from the authoritative checkpoint, so ZEC and prior rotating markets cannot return.
- Every structural loss calculation includes fees and stress slippage; total open risk is capped at 5% of current PAPER equity. Stops only tighten in 0.1R steps. Holding time and take profit are not fixed, and there is no PnL pause.
- First release is physically PAPER-only. The final Worker has no Gate mutation or credential-preflight route.
- Cloudflare Free uses REST alarms, not a high-frequency WebSocket. Planned DO requests and writes stay below 55,000/day and D1 billed writes are hard-gated below 5,000/day.
- The encrypted credential row id=1 remains byte-for-byte unchanged through cutover. Old business tables and old Durable Object classes are removed only after the new v6 Worker proves healthy.
- The v6 create-only deployment uses generated inert exports for retired Durable Object classes because Cloudflare requires them until v7 applies delete-class. These shims are not bound and are absent from the final v7 entry.
- The public dashboard is an operator product, not an engineering telemetry page. It exposes only plain-language decisions and a cached, read-only PAPER history feed. LIVE remains visibly locked because a public unauthenticated control must never mutate the preserved Gate account.
- Every market card decides freshness independently. Its switchable 1m/15m/1h chart uses a read-only cached Gate USDT futures candle endpoint and overlays liquidity, trigger, invalidation, target, or live position levels; execution intent remains explicit text rather than an ambiguous drawing.
