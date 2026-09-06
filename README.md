# Liquidity Three State

A deliberately small Gate USDT perpetuals system with one shared strategy and separate PAPER/owner-controlled LIVE execution. It predicts the highest-utility reachable liquidity target, then chooses exactly one of `BREAKOUT`, `REVERSAL`, or `RANGE`.

## Runtime

- One SQLite Durable Object (`MarketStream`) owns the fixed BTC/ETH/SOL loop.
- Every two seconds it fetches three full futures order-book snapshots with IDs. There is no continuous WebSocket and no foreground market-data producer.
- Every five minutes, Gate futures metadata is refreshed for BTC, ETH, and SOL only. Other cycles pair three books with at most two ancillary requests: contract stats for OI plus rotating signed trades, public liquidations, or completed 1m/15m/1h structure candles.
- A 30-second compact checkpoint, immediate authority checkpoints for PAPER state changes, and a one-minute Cron watchdog recover eviction, stale alarms, 429s, and partial market outages. The hard budget is 43,200 alarm writes + 8,000 non-alarm writes + 2,880 watchdog reserve = 54,080/day.
- Actual chart candles are mirrored from the same authority to D1 at most once every five minutes; one continuously open operator page adds only cached D1 reads and no Durable Object request load.
- PAPER runs continuously. LIVE defaults off, requires the fixed `owner` account plus the existing `OWNER_ACCESS_TOKEN`, and can be changed only from an authenticated same-origin session. The public runtime never returns balances, order IDs, positions, or credentials.
- LIVE reads the exact frozen PAPER plan. BREAKOUT uses a Gate price-triggered market order; REVERSAL and RANGE use resting Gate limit orders. Turning LIVE off cancels unfilled entries, while an already-open position keeps its exchange-side reduce-only structural stop and continues the same dynamic exit policy.

## Decision and risk

`Score = P(reach) × (Liquidity + Cascade) ÷ (PathCost + DistanceCost) × Persistence`

Walls need 70% persistence across 30 snapshots and are removed when more than 50% cancel during approach. Liquidation levels are estimates built from entry-price-binned ΔOI cohorts, taker/price direction, contract multiplier, maintenance margin, 5x/10x/20x/50x leverage, opposing futures depth, and public liquidation calibration.

Prepared entries freeze their side, trigger, stop, and target for up to 15 minutes. No later score or opposite-side recalculation can cancel, move, or replace them. When price reaches the frozen trigger, execution is evaluated before a coincident target-book recalculation; only stale/sequence-fault data, a target that vanishes before the trigger, expiry, or trigger-time risk/economics can cancel the plan. Targets that cannot cover the modeled 0.18% round-trip fee and stress-slippage friction are rejected before appearing on the order page.

Stops and exits are structural and dynamic. A stop tightens only in 0.1R steps and never widens. Aggregate open structural loss is hard-capped at 5% of the applicable PAPER or actual Gate equity, including fees and stress slippage; LIVE recalculates notional, margin, leverage, and risk from the actual fill. There is no PnL pause, fixed take-profit, or fixed holding time. The Durable Object owns both execution lanes; D1 is only an idempotent PAPER mirror and encrypted credential store.

LIVE is deliberately fail-closed: it refuses to start around an unrecognized Gate position/order or hedge mode, checkpoints intent before a mutation, reconciles uncertain submissions before retrying, and requests a reduce-only market close if protection cannot be created or tightened. The switch is never enabled by deployment or login.

## Verification

```bash
npm run test:direct
npm test
npm run typecheck
npm run lint
```

Ordinary production releases require the existing Cloudflare `OWNER_ACCESS_TOKEN` secret and the preserved encrypted `live_exchange_credentials` row with `id=1`. The release path never prints or rewrites either value.
