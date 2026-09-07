# Decisions

## 2026-09-07 — 突破分级确认、分段经济性与长期登录

- 生产从 #568 部署到诊断时超过七小时没有新成交，后台健康且行情持续推进；期间 BTC、ETH、SOL 各形成过突破计划但均在入场前取消。问题不是数据中断，而是所有突破统一等待完整1分钟后仍要求价格处于0.5R内，强突破常在确认前已经越界，形成自我阻塞。
- 高质量突破改为实时路径：冻结计划确认度至少78%、当前假突破风险不高于25%、价格至少越过0.1R且不超过0.5R时，需要连续三个不同的两秒盘口快照成立；任一快照失败即清零。满足后 PAPER 与 LIVE 同时放行，LIVE按当前价提交IOC。中等质量仍等待完整1分钟收盘，高假突破风险继续放弃。
- 诊断时 SOL `106.2614 → 106.83` 路线确认度约94.6%、假突破风险约5.5%，但第一段净盈亏比约0.95R、模型净利润11.40U，略低于当时12.04U最低门槛；同一路线已经明确映射下一节点107.13。强分段路线现在可用下一节点做入场经济性，实际持仓目标仍先停在106.83并必须重新判断，绝不把107.13变成无需确认的固定止盈。
- owner 页面退出来自固定8小时登录有效期，不代表Gate凭据丢失。签名HttpOnly、Secure、SameSite=Strict会话延长为30天，并在每次已认证页面打开时重新签发；登录或续期仍不能改变LIVE开关。

## 2026-09-06 — 假突破实时确认、软退出耐心与净保护垫

- 后台最新四笔已结束订单合计净亏 24.85 U，模型费用与压力滑点为 23.54 U，占净亏约94.7%；真实方向毛亏只有1.31 U。四单均未因5%组合风险上限被迫结束，因此把组合风险提高到15%或把单笔风险提高到5%只会放大执行摩擦，不会增加止损价格空间。
- BTC 空单在79,526.05触发时，该分钟最低到79,517.6，但收于79,556.5，重新回到突破位上方，最大顺向仅约0.06R；这是影线刺穿后立即失败的假突破。Gate价格触发单只能判断一次价格穿越，不能同时等待K线收盘，因此BREAKOUT不再向交易所预挂触发单：内部观察计划等官方Gate完整1m K线方向实体一致、收盘至少越过0.1R且保留55%振幅；刚收完的1m数据在三币之间优先刷新，最多约三个2秒循环，然后只在当前价仍位于突破侧且距触发位不超过0.5R时按当前价重算并用IOC实时进场，走远则等待回测而不追价。RANGE/REVERSAL仍预挂被动限价。
- SOL多单从105.675最多走到105.92，约1.2R顺向；目标身份重算后，系统在完整分钟约0.6R逆向时以`TARGET_DISAPPEARED`提前退出，之后价格恢复。这证明软退出的0.25R门槛仍然过敏。目标消失或反向效用继续要求三个不同完整分钟，但现在只有新完整分钟收盘逆向达到至少0.75R才执行；两秒实时价格只能触发原始结构止损，不能触发软退出。
- 最新SOL多单105.575→105.755实际方向毛盈5.48 U，却因5.78 U模型成本显示净亏0.31 U；当前动态保护位恰好只覆盖0.18%模型摩擦，没有留下成交偏差空间。动态保护首次跨过进场价后现在至少锁定“模型摩擦+0.15R”净垫，防止一笔方向正确且已经保护的订单仅因一个价格档位仍显示为亏损。
- ETH多单在首轮修复部署完成前已经成交，冻结的原始止损仅约0.045%；它属于升级时保留的旧持仓，不能用来判断新0.18%/噪声止损下限失效。风险预算继续保持单笔1%–1.8%、组合5%；需要更宽结构止损时仍通过缩小名义仓位腾出价格空间，而不是提高账户最大亏损。

## 2026-09-06 — 四笔原始止损后的执行质量修复

- 后台精确匹配的四笔亏损全部触发原始结构止损；三笔 SOL 的结构止损仅为进场价的约 0.072%–0.080%，BTC 为约 0.128%，均低于模型 0.18% 往返摩擦。四笔净亏 38.03 U 中成本为 24.78 U，占约 65%。因此禁止继续用落在普通 1m 噪声内的极窄止损制造表面高盈亏比。
- 新计划的止损距离至少取 0.18% 与最近 20 根完整 1m K 线区间70分位的1.1倍之较大值；结构本身要求更远时继续使用更远结构位，仓位按新距离重新缩小，5%组合风险不变。
- 区间边缘单必须先出现完整1分钟扫边并收回，随后才可等待回踩成交；当前目标优先取区间中轴，若扣成本1.2R不足才适度延长且最多不超过区间70%，不再把另一侧极值当成唯一结果。小区间突破若最近1h/4h节点较远，先建立0.65%–0.9%的15分钟量度目标，到点后再决定退出或续接高周期节点。
- 同一路线、同方向因原始结构止损后，至少等两根完整1m K线并收复原触发位才可重启。生产中 SOL 22:43 止损后16秒再次接多的22:45订单会被该状态锁拦截；新路线或相反方向不受固定时间冷却误伤。
- BTC 22:31 空单曾从79,476.3走到79,170，约3R有利波动，但完整分钟收于79,441.1，只保留约11.5%的最大推进。突破持仓现在使用完整分钟的极值与收盘共同确认：至少2R且收盘保留不超过30%时记为 `BREAKOUT_PROFIT_REJECTION` 并退出；普通几秒波动仍不能触发该规则。

## 2026-09-06 — 本地路线独占执行与远端节点隔离

- 生产证据显示 ETH 在约 2,500 时生成了 2,419.4973 的 `RANGE LONG` 准备单；它没有 `routeId`，而当时真实 15m 区间是约 2,491–2,502.29。这证明旧 `decideThreeState` 回退越过了已经存在的15分钟路线，把远端高周期流动性插值成了当前入场位。
- 只要有效15分钟结构生成了路线列表，只有 `selectRouteDecision` 可以产生订单；路线均未达到执行条件时必须 WAIT，不再回退旧通用决策。无路线时的通用计划也只能在当前价 0.75% 内准备。
- 当前小周期段从 15m、1h、4h 结构中按价格选择最近节点，并限制为随15分钟区间宽度变化的 1.2%–1.5% 最大跨度。更远的高周期流动性仅保留为全局背景，等待价格接近后重新建立下一段。
- 已存在但没有路线身份、且本地路线已经存在的准备单属于硬错误，立即以 `NONLOCAL_FALLBACK_CANCEL` 撤销，不进入两根1分钟软失效等待。新生成的无路线通用计划自身携带0.75%激活上限，超过即不会建立或继续等待。

## 2026-09-06 — 决策迟滞与分级持仓保护

- 已准备计划不再被触发瞬间的单个两秒订单流分数否决。突破计划形成与触发使用同一冻结判断；触发时只重新核对真实成交价下的结构止损、目标是否已经越过、组合风险和扣成本经济性。
- 路线/目标短暂消失、路线跌破较低的迟滞阈值或价格离开激活邻域属于软失效，必须在两个不同的已收盘 1m 时点连续成立才撤单；行情失鲜、序列故障、15 分钟到期和价格已经越过冻结失效位仍立即撤销。
- 持仓前两分钟除原始结构止损、目标/节点到达外不使用软退出。之后目标消失或反向效用必须连续三个已收盘 1m 时点同因成立，并伴随至少 0.25R 的实际逆向价格移动，才允许提前退出。
- 动态止损只按已收盘 1m 节点更新：最大顺向波动不足 1R 时保持原始止损；达到 1R 后最多先将剩余风险降至 0.5R；顺向波动覆盖模型往返成本并额外达到 0.5R 后才越过进场价，随后只允许单向渐进收紧。
- `STRUCTURAL_STOP` 仅表示原始结构止损；收紧后的保护位触发记为 `DYNAMIC_PROTECTION_STOP`。页面和历史同时展示原始止损与当前保护位，避免把正常动态保护误报为方向判断错误。

## 2026-09-06 — 多周期分段流动性路线

- 单币不再只有一个扁平预测。系统从最近 12 根已收盘 15m K 线识别重复上下边界，同时保留向上突破、向下突破和两侧吸收回撤软路线；软路线不提交 Gate、不占保证金。
- 当前 15m 边界突破只交易到最近可达的 1h/4h 流动性节点。该节点同时是本段目标和下一次决策门：价格到达后重新判断拒绝、吸收或延续，只有更高确认阈值通过才启动节点上方/下方的下一段。
- 4h K 线由现有连续已收盘 1h 数据按交易所时间桶聚合，不新增 Gate 请求。15m 区间与 4h 结构都有独立新鲜度；任一缺失时相关路线失败关闭。
- 假突破过滤联合订单流、微价格、主动成交、OI、清算和 1m/15m/1h/4h 方向。突破路线只有靠近自适应激活区、确认分数合格且假突破风险不过线时才进入单执行仲裁；触发时再次确认。
- 任一币同一时刻仍只允许一张真实入场单。远期路线只能观察；现有 PREPARED 计划保留 15 分钟硬有效期，并在路线消失、目标消失、行情失鲜或价格离开激活区时提前自动撤销。
- 杠杆不再用占权益 60% 的展示档位。PAPER 与 LIVE 共用安全杠杆函数，目标单计划约占 10% 保证金，全部挂单与持仓保证金不超过权益 30%，并在预计强平边界前保留约三倍结构止损距离。提高杠杆绝不提高名义仓位或 5% 组合止损风险。
- 图表默认只绘制当前执行段和 15m 边界；超出当前 K 线视窗的高周期目标显示为图外标签，不参与 Y 轴缩放。卡片另用紧凑路线表展示其他软方案，避免 K 线被远端水平线压扁。

- Market states are mutually exclusive: BREAKOUT, REVERSAL, RANGE; otherwise WAIT.
- Inputs are predictive liquidity, path resistance, active-flow/price response, entry-price OI cohorts, public liquidation calibration, and completed 1m/15m/1h structure. Lagging oscillator and historical-analog systems are retired.
- The universe is permanently limited to BTC_USDT, ETH_USDT, and SOL_USDT. Restart recovery prunes every old symbol from the authoritative checkpoint, so ZEC and prior rotating markets cannot return.
- Every structural loss calculation includes fees and stress slippage; total open risk is capped at 5% of current PAPER equity. Stops only tighten in 0.1R steps. Holding time and take profit are not fixed, and there is no PnL pause.
- LIVE is a separate execution lane over the exact same frozen plan, never a second strategy. It defaults off and can change only after `owner` login with an HttpOnly signed session and a same-origin JSON mutation. Login and deployment never auto-enable it.
- BREAKOUT is internally confirmed and then uses a Gate IOC market entry; REVERSAL and RANGE use Gate GTC limit entries. Turning LIVE off cancels unfilled entries but never abandons an open position. Every live position receives a reduce-only exchange stop and remains under dynamic strategy exits until flat.
- Ambiguous Gate submissions are reconciled by unique tags and order status before retry. Unrecognized Gate orders/positions or hedge mode block LIVE startup; failure to create or tighten protection requests a reduce-only market close.
- Cloudflare Free uses REST alarms, not a high-frequency WebSocket. Planned DO requests and writes stay below 55,000/day and D1 billed writes are hard-gated below 5,000/day.
- The encrypted credential row id=1 remains byte-for-byte unchanged through cutover. Old business tables and old Durable Object classes are removed only after the new v6 Worker proves healthy.
- The v6 create-only deployment uses generated inert exports for retired Durable Object classes because Cloudflare requires them until v7 applies delete-class. These shims are not bound and are absent from the final v7 entry.
- The public dashboard remains read-only and exposes only plain-language decisions plus cached PAPER history. Authenticated owner responses may additionally expose Gate balances and managed order/position metadata, but never credentials.
- Every market card decides freshness independently. Its switchable 1m/15m/1h chart reads a bounded D1 mirror of the same actual completed Gate candles already collected by the 24-hour MarketStream authority, avoiding a second ad-hoc Gate request path and avoiding foreground contention with the authority. It overlays liquidity, trigger, invalidation, target, or live position levels; execution intent remains explicit text rather than an ambiguous drawing.
- A prepared entry is a frozen, executable thesis, not a two-second moving suggestion. It lasts at most 15 minutes; no neutral, same-side, or opposite-side recalculation may move or replace it. It cancels for authoritative data faults, target disappearance before the trigger, expiry, or trigger-time risk/economic failure. Every plan and actual trigger fill must retain at least 1.2:1 net reward/risk after modeled 0.18% round-trip friction; REVERSAL/RANGE additionally require absorption of at least 0.55 at the trigger.
- Routine main releases run one full deploy acceptance gate; the identical monitor remains scheduled every six hours instead of repeating immediately after every successful deploy.
- Live enabling is transactional for actual Gate mutations, while a candidate that cannot fit exchange lot size, remaining 5% risk, economics, or margin is a nonfatal per-symbol skip. Affordable candidates continue and LIVE remains operational; skipped reasons are exposed on Live Orders. Any actual submission failure still forces the switch back off and reconciles/cancels every system-tagged entry; turning the switch off performs the same forced reconciliation even when runtime memory is empty.
- Only Gate orders tagged with the system entry prefix may be treated as recoverable orphans. The owner has a separate authenticated cleanup action for those orders; manual Gate orders are never cancelled by that action.
- Gate API save/replace/delete lives in the authenticated Live Center. Save validates the account read-only, encrypts server-side, never returns the secret, and never enables LIVE. Delete is allowed only while LIVE is off and no managed position or pending entry remains; scheduled schema monitoring accepts either zero or one credential row.
- The Brain decision hero and PAPER account summary belong only to the Brain tab. Orders, Live, History, and Settings start directly with their own content; the fixed iPhone bottom navigation remains global.

# 2026-09-06 — 共享仓位上限与模拟账户破产日志

- PAPER 与 LIVE 先按账户权益比例使用同一个仓位函数：单笔结构风险随置信度在账户权益 1%–1.8% 之间变化，计划名义价值上限为权益 4 倍，组合风险不得超过 5%。若按比例后的实盘仓位不足 Gate 不可分割的 1 张合约，只允许取整到 1 张，并重新核对真实保证金、目标经济性和 5% 总风险；任何一项不合格就只跳过该币，不关闭整个实盘。
- 除至少 1.2:1 扣成本盈亏比外，目标扣除 0.18% 模型往返成本后的利润空间还必须达到当前账户权益 1.5%。以 1,000 U 为例，单笔名义价值最多 4,000 U、模型往返成本最多 7.2 U、可接受目标的净利润空间至少 15 U；这些是进场门槛，不是收益保证。
- PAPER 权益达到 300 U 时判定本轮破产。系统先取消准备计划，并只使用三秒内的新鲜价格结束尚存 PAPER 仓位；没有新鲜价格时继续保护而不以旧价结算。全部结束后，权威状态先将完整报告与新周期一起写入 Durable Object 检查点，再异步幂等写入 D1。
- 每份破产报告保存逐单诊断、方向正确率、曾经覆盖成本的顺向波动比例、目标到达率与进度、止损命中和最大逆向波动、净盈亏比、成本、持仓时长、退出原因，以及按币种/三态/方向的分解和自动排序的主要原因。报告永久显示在历史页的“账户日志”，并可复制为 JSON 发给 Codex。
- 归档完成后立即建立新的 1,000 U PAPER 周期，不设置亏损暂停。部署升级不会重置当前模拟权益：缺少周期字段的旧检查点以当时实际权益作为第一轮起点。

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

- Gate 价格触发单有效期只能使用86400秒的整数倍且最多30天。此前突破入场提交1天、保护止损提交30天；当前突破入场已被收盘确认后的IOC实时单替代，价格触发单只继续用于保护止损。内部15分钟计划到期仍由两秒运行循环主动撤销，不能把交易所有效期当作策略有效期。
- 五个主页面和实盘的三个子页面在当前打开期间分别保存滚动位置；主页面内容保持挂载，以保留 K 线周期、展开项、实盘子页和 API 表单状态。关闭或重新载入页面后允许重置。
- 全局右上角不再重复提供模拟/实盘切换；实盘开关只保留在实盘账户与设置页。
- 模拟订单页分组显示当前持仓、等待进场和最近 15 分钟刚结束的订单。这样两秒内完成、快于页面轮询的真实模拟成交也不会从用户视野中消失；历史数据同时每 15 秒刷新。
# 2026-09-07 — Parent/child structure semantics (authorized, implementation pending)

- The candle interval is not the structural grade. The current twelve-completed-15m-candle quartile box is a child balance when it is nested inside a broader repeated 15m balance.
- A child break inside the parent is `INTERNAL_ROTATION` and may target the parent boundary; only acceptance beyond the parent boundary is a parent `LOCAL_BREAKOUT`.
- Breakout plans must be armed while price remains on the pre-trigger side. Already-crossed, consumed, or structurally replaced boundaries are missed/invalid and cannot be revived as fresh breakouts.
- The actual first target alone must pass net economics. A farther 1h/4h node cannot subsidize admission before price reaches and re-evaluates the nearer node.
- This correction does not increase leverage, per-trade loss, aggregate risk, request cadence, or LIVE authority.
