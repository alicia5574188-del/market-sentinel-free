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
- A prepared entry is a frozen, executable thesis, not a two-second moving suggestion. It lasts at most 15 minutes; no neutral, same-side, or opposite-side recalculation may move or replace it. It cancels for authoritative data faults, target disappearance before the trigger, expiry, or trigger-time risk/economic failure. Every plan and actual trigger fill must retain at least 1.2:1 net reward/risk after modeled 0.18% round-trip friction; REVERSAL/RANGE additionally require absorption of at least 0.55 at the trigger.
- Routine main releases run one full deploy acceptance gate; the identical monitor remains scheduled every six hours instead of repeating immediately after every successful deploy.
- Live enabling is transactional at the strategy batch boundary: size/risk/margin checks for every BTC/ETH/SOL candidate complete before the first Gate mutation. Any later submission failure forces the switch back off and reconciles/cancels every system-tagged entry; turning the switch off performs the same forced reconciliation even when runtime memory is empty.
- Only Gate orders tagged with the system entry prefix may be treated as recoverable orphans. The owner has a separate authenticated cleanup action for those orders; manual Gate orders are never cancelled by that action.
- Gate API save/replace/delete lives in the authenticated Live Center. Save validates the account read-only, encrypts server-side, never returns the secret, and never enables LIVE. Delete is allowed only while LIVE is off and no managed position or pending entry remains; scheduled schema monitoring accepts either zero or one credential row.
- The Brain decision hero and PAPER account summary belong only to the Brain tab. Orders, Live, History, and Settings start directly with their own content; the fixed iPhone bottom navigation remains global.

# 2026-09-06 — 亏损归因、动态退出去噪与逐单复盘

- 生产的首批 6 笔已结束订单全部只持有 2 秒；两笔 BTC 在进出场价格完全相同的情况下只损失往返成本，另有一笔 SOL 毛盈利但仍被成本变成净亏。这证明首要故障是两秒流动性重算直接触发退出，而不是六次方向判断全部错误。
- 结构止损继续实时执行。`TARGET_DISAPPEARED` 和 `OPPOSITE_UTILITY_DOMINANT` 改为必须在进场后两个不同的已收盘 1m K 线上连续成立；同一分钟重复轮询不重复计数，信号恢复就清零。反向效用阈值提高到原目标效用的 1.5 倍。
- 目标身份允许同方向、价格相差不超过 0.15% 的连续区域，避免订单簿分桶抖动把同一目标误判为消失。PAPER 与 LIVE 使用完全相同的目标连续性和确认逻辑。
- 历史订单的真实 Gate 1m 进场片段随 OPEN 写入，出场片段在已收盘 K 线可用后补齐；每单最多保存 120 根，保留开头 40 根与结尾 80 根，受既有 D1 4,800 次/日硬上限约束。
# 2026-09-06 — Gate 撤单必须用无损订单 ID 并回查确认

- Gate 的 int64 订单编号在所有响应中都先转为字符串，禁止经过 JavaScript `number`。
- 关闭实盘和手动清理只撤销本系统 `t-ms-e-` 入场挂单或运行时已记录的订单 ID，不碰手工订单与 reduce-only 保护单。
- 撤单请求后重新读取 Gate；最多再试一次，仍存在就返回失败并保持实盘关闭，不再把“请求已发出”当作“撤单成功”。

# 2026-09-06 — Gate 触发有效期与页面会话状态

- Gate 价格触发单有效期只能使用 86400 秒的整数倍且最多 30 天。突破入场提交 1 天、保护止损提交 30 天；内部 15 分钟计划到期仍由两秒运行循环主动撤单，不能把交易所有效期当作策略有效期。
- 五个主页面和实盘的三个子页面在当前打开期间分别保存滚动位置；主页面内容保持挂载，以保留 K 线周期、展开项、实盘子页和 API 表单状态。关闭或重新载入页面后允许重置。
- 全局右上角不再重复提供模拟/实盘切换；实盘开关只保留在实盘账户与设置页。
- 模拟订单页分组显示当前持仓、等待进场和最近 15 分钟刚结束的订单。这样两秒内完成、快于页面轮询的真实模拟成交也不会从用户视野中消失；历史数据同时每 15 秒刷新。
