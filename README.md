# Liquidity Three State

A deliberately small, PAPER-only Gate USDT perpetuals system. It predicts the highest-utility reachable liquidity target, then chooses exactly one of `BREAKOUT`, `REVERSAL`, or `RANGE`.

## Runtime

- One SQLite Durable Object (`MarketStream`) owns the fixed BTC/ETH/SOL loop.
- Every two seconds it fetches three full futures order-book snapshots with IDs. There is no continuous WebSocket and no foreground market-data producer.
- Every five minutes, Gate futures metadata is refreshed for BTC, ETH, and SOL only. Other cycles pair three books with at most two ancillary requests: contract stats for OI plus rotating signed trades, public liquidations, or completed 1m/15m/1h structure candles.
- A 30-second compact checkpoint, immediate authority checkpoints for PAPER state changes, and a one-minute Cron watchdog recover eviction, stale alarms, 429s, and partial market outages. The hard budget is 43,200 alarm writes + 8,000 non-alarm writes + 2,880 watchdog reserve = 54,080/day.
- Actual chart candles are mirrored from the same authority to D1 at most once every five minutes; one continuously open operator page adds only cached D1 reads and no Durable Object request load.
- New orders are PAPER only. The final Worker exposes no POST/DELETE trading endpoint.

## Decision and risk

`Score = P(reach) × (Liquidity + Cascade) ÷ (PathCost + DistanceCost) × Persistence`

Walls need 70% persistence across 30 snapshots and are removed when more than 50% cancel during approach. Liquidation levels are estimates built from entry-price-binned ΔOI cohorts, taker/price direction, contract multiplier, maintenance margin, 5x/10x/20x/50x leverage, opposing futures depth, and public liquidation calibration.

Prepared entries freeze their trigger, stop, and target for up to 15 minutes. A neutral recalculation does not cancel or move them; only stale/sequence-fault data, a vanished target, a materially stronger opposite thesis, expiry, or trigger-time risk/economics can cancel them. Targets that cannot cover the modeled 0.18% round-trip fee and stress-slippage friction are rejected before appearing on the order page.

Stops and exits are structural and dynamic. A stop tightens only in 0.1R steps and never widens. Aggregate open structural loss is hard-capped at 5% of current PAPER equity, including fees and stress slippage. There is no PnL pause, fixed take-profit, or fixed holding time. The Durable Object is the PAPER authority; D1 is only an idempotent versioned mirror, so D1 downtime cannot invent or double-settle equity.

## Verification

```bash
npm run test:direct
npm test
npm run typecheck
npm run lint
```

Production release requires two recent read-only Gate zero-exposure checks bound to one trusted preflight commit and a canonical fingerprint of all 15 credential columns. It then prepares new tables, deploys/health-checks DO v6 without deletion, deploys v7 to retire old DO classes, and only then purges old D1 tables. The encrypted `live_exchange_credentials` row with `id=1` is never rebuilt or copied.
