# Liquidity Three State

A deliberately small Gate USDT perpetuals system with one shared strategy and separate PAPER/owner-controlled LIVE execution. It maps several hierarchical liquidity routes per coin, then promotes exactly one current segment to `BREAKOUT`, `REVERSAL`, or `RANGE` execution.

## Runtime

- One SQLite Durable Object (`MarketStream`) owns the fixed BTC/ETH/SOL loop.
- Every two seconds it fetches three full futures order-book snapshots with IDs. There is no continuous WebSocket and no foreground market-data producer.
- Every five minutes, Gate futures metadata is refreshed for BTC, ETH, and SOL only. Other cycles pair three books with at most two ancillary requests: contract stats for OI plus rotating signed trades, public liquidations, or completed 1m/15m/1h structure candles. Completed 4h candles are aggregated locally from 1h rows, so higher-timeframe routing adds no Gate request.
- A detected 15m balance exposes upper/lower breakouts and edge rejections as soft routes. While that local route map exists, it is the only entry authority: the legacy all-timeframe fallback cannot create a distant order. The first breakout leg uses the nearest viable 15m/1h/4h node within a 1.2%–1.5% adaptive segment; farther higher-timeframe liquidity remains context until price approaches and a new local segment is evaluated.
- A 30-second compact checkpoint, immediate authority checkpoints for PAPER state changes, and a one-minute Cron watchdog recover eviction, stale alarms, 429s, and partial market outages. The hard budget is 43,200 alarm writes + 8,000 non-alarm writes + 2,880 watchdog reserve = 54,080/day.
- Actual chart candles are mirrored from the same authority to D1 at most once every five minutes; one continuously open operator page adds only cached D1 reads and no Durable Object request load. Each PAPER fill also keeps a bounded entry/exit review window and a close diagnostic in `paper_events`, so History can draw the real Gate 1m candles and exact entry/exit markers without replaying old market data. Every PAPER bankruptcy is retained there as a permanent account-level report.
- PAPER runs continuously. LIVE defaults off, requires the fixed `owner` account plus the existing `OWNER_ACCESS_TOKEN`, and can be changed only from an authenticated same-origin session. The public runtime never returns balances, order IDs, positions, or credentials.
- LIVE reads the exact frozen PAPER plan. BREAKOUT uses a Gate price-triggered market order; REVERSAL and RANGE use resting Gate limit orders. Turning LIVE off cancels unfilled entries, while an already-open position keeps its exchange-side reduce-only structural stop and continues the same dynamic exit policy.
- PAPER and LIVE choose leverage from the same liquidation-aware function: approximately 10% margin per executable plan, no more than 30% aggregate pending/open margin, and no expansion of the existing 5% aggregate structural-risk budget.

## Decision and risk

`Score = P(reach) × (Liquidity + Cascade) ÷ (PathCost + DistanceCost) × Persistence`

Walls need 70% persistence across 30 snapshots and are removed when more than 50% cancel during approach. Liquidation levels are estimates built from entry-price-binned ΔOI cohorts, taker/price direction, contract multiplier, maintenance margin, 5x/10x/20x/50x leverage, opposing futures depth, and public liquidation calibration.

Prepared entries freeze their side, trigger, stop, and target for up to 15 minutes. No later score or opposite-side recalculation can move or replace them, and one two-second score change cannot veto them at the exact trigger. Stale/sequence-fault data, a crossed frozen invalidation, expiry, a passed target, or trigger-time risk/economics cancel immediately. Route/target disappearance, evidence below the lower hysteresis boundary, or movement away from the activation neighborhood must persist at two distinct completed 1m observations before cancellation. Targets that cannot cover the modeled 0.18% round-trip fee and stress-slippage friction are rejected before appearing on the order page.

Stops and exits are structural and dynamic. The original structural stop executes immediately. Soft target/utility exits require at least two minutes in the trade, three distinct completed 1m confirmations of the same reason, and at least 0.25R adverse price movement. Dynamic protection updates only from a newly completed 1m close: below 1R it cannot move; at 1R it may reduce remaining loss to 0.5R; after the favorable move covers round-trip friction plus another 0.5R it may cross entry and then ratchet gradually without widening. Original and dynamic-protection stop exits have separate audit labels. Every entry must still have at least 1.2:1 net reward/risk after modeled 0.18% round-trip friction. PAPER and LIVE first share the same equity-proportional 1%–1.8% per-entry sizing, 4×-equity planned notional ceiling, and minimum 1.5%-of-equity net target-profit gate; at 1,000 U the modeled maximum round-trip friction is therefore 7.2 U, while an accepted target must offer at least 15 U net. LIVE then applies Gate's integer contract lot: if the proportional amount is below one indivisible lot, exactly one lot is allowed only when its actual margin, economics, and aggregate loss still fit the hard 5% account limit. An untradeable symbol is reported and skipped without disabling LIVE or blocking another affordable symbol. There is no PnL pause, fixed take-profit, or fixed holding time. At 300 U PAPER equity, the authority closes only against fresh evidence, archives a complete bankruptcy report, and immediately begins a new 1,000 U cycle. The Durable Object owns both execution lanes; D1 is only an idempotent PAPER/review/account-log mirror and encrypted credential store.

LIVE is deliberately fail-closed: it refuses to start around an unrecognized Gate position/order or hedge mode, checkpoints intent before a mutation, reconciles uncertain submissions before retrying, and requests a reduce-only market close if protection cannot be created or tightened. The switch is never enabled by deployment or login.

## Verification

```bash
npm run test:direct
npm test
npm run typecheck
npm run lint
```

Ordinary production releases require the existing Cloudflare `OWNER_ACCESS_TOKEN` secret. The credential table is preserved, while the owner UI may hold either zero rows after an intentional delete or exactly the encrypted `live_exchange_credentials` row with `id=1` after save/replace. The release path never prints or rewrites either value.
