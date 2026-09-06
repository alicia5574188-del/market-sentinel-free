# Decisions

- Market states are mutually exclusive: BREAKOUT, REVERSAL, RANGE; otherwise WAIT.
- Inputs are predictive liquidity, path resistance, active-flow/price response, entry-price OI cohorts, public liquidation calibration, and completed 1m/15m/1h structure. Lagging oscillator and historical-analog systems are retired.
- The universe is permanently limited to BTC_USDT, ETH_USDT, and SOL_USDT. Restart recovery prunes every old symbol from the authoritative checkpoint, so ZEC and prior rotating markets cannot return.
- Every structural loss calculation includes fees and stress slippage; total open risk is capped at 5% of current PAPER equity. Stops only tighten in 0.1R steps. Holding time and take profit are not fixed, and there is no PnL pause.
- LIVE is a separate execution lane over the exact same frozen plan, never a second strategy. It defaults off and can change only after `owner` login with an HttpOnly signed session and a same-origin JSON mutation. Login and deployment never auto-enable it.
- BREAKOUT uses a Gate price-triggered market entry; REVERSAL and RANGE use Gate GTC limit entries. Turning LIVE off cancels unfilled entries but never abandons an open position. Every live position receives a reduce-only exchange stop and remains under dynamic strategy exits until flat.
- Ambiguous Gate submissions are reconciled by unique tags and order status before retry. Unrecognized Gate orders/positions or hedge mode block LIVE startup; failure to create or tighten protection requests a reduce-only market close.
- Cloudflare Free uses REST alarms, not a high-frequency WebSocket. Planned DO requests and writes stay below 55,000/day and D1 billed writes are hard-gated below 5,000/day.
- The encrypted credential row id=1 remains byte-for-byte unchanged through cutover. Old business tables and old Durable Object classes are removed only after the new v6 Worker proves healthy.
- The v6 create-only deployment uses generated inert exports for retired Durable Object classes because Cloudflare requires them until v7 applies delete-class. These shims are not bound and are absent from the final v7 entry.
- The public dashboard remains read-only and exposes only plain-language decisions plus cached PAPER history. Authenticated owner responses may additionally expose Gate balances and managed order/position metadata, but never credentials.
- Every market card decides freshness independently. Its switchable 1m/15m/1h chart reads a bounded D1 mirror of the same actual completed Gate candles already collected by the 24-hour MarketStream authority, avoiding a second ad-hoc Gate request path and avoiding foreground contention with the authority. It overlays liquidity, trigger, invalidation, target, or live position levels; execution intent remains explicit text rather than an ambiguous drawing.
- A prepared entry is a frozen, executable thesis, not a two-second moving suggestion. It lasts at most 15 minutes; no neutral, same-side, or opposite-side recalculation may cancel, move, or replace it. A fresh trigger crossing is evaluated first. It cancels only for authoritative data faults, target disappearance before the trigger, expiry, or trigger-time risk/economic failure. Destinations inside 0.25% and plans that cannot cover modeled 0.18% round-trip friction are rejected before presentation.
- Routine main releases run one full deploy acceptance gate; the identical monitor remains scheduled every six hours instead of repeating immediately after every successful deploy.
- Live enabling is transactional at the strategy batch boundary: size/risk/margin checks for every BTC/ETH/SOL candidate complete before the first Gate mutation. Any later submission failure forces the switch back off and reconciles/cancels every system-tagged entry; turning the switch off performs the same forced reconciliation even when runtime memory is empty.
- Only Gate orders tagged with the system entry prefix may be treated as recoverable orphans. The owner has a separate authenticated cleanup action for those orders; manual Gate orders are never cancelled by that action.
- Gate API save/replace/delete lives in the authenticated Live Center. Save validates the account read-only, encrypts server-side, never returns the secret, and never enables LIVE. Delete is allowed only while LIVE is off and no managed position or pending entry remains; scheduled schema monitoring accepts either zero or one credential row.
- The Brain decision hero and PAPER account summary belong only to the Brain tab. Orders, Live, History, and Settings start directly with their own content; the fixed iPhone bottom navigation remains global.
# 2026-09-06 — Gate 撤单必须用无损订单 ID 并回查确认

- Gate 的 int64 订单编号在所有响应中都先转为字符串，禁止经过 JavaScript `number`。
- 关闭实盘和手动清理只撤销本系统 `t-ms-e-` 入场挂单或运行时已记录的订单 ID，不碰手工订单与 reduce-only 保护单。
- 撤单请求后重新读取 Gate；最多再试一次，仍存在就返回失败并保持实盘关闭，不再把“请求已发出”当作“撤单成功”。
