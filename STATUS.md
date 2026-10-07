# 2026-10-07 — 实盘成本估算与价差记录，待发布

基于已部署 `18513f6`：反向模拟汇总新增「按实盘实测成本估算」（每笔成交按实盘实测
中位数不利价差 6bp 另算估算净额，不改模拟原账）；实盘对照快照新增 executionGap
（进场/出场不利价差中位数与占比、下单/平仓延迟中位数、浮亏5U提前平仓的实盘跟随
统计）；测试确保任何反向模拟平仓（含 INVERSE_SOFT_LOSS_EXIT）都驱动实盘平仓。
实盘下单流程未改，实盘开关状态未动。

# 2026-10-06 — 状态记录与线上对齐

main 最新提交为 `ea197f8`（Cut the inverse when a 5U floating loss meets a soft source hold），
其前依次为 `f33666f`、`cb3b0ed`、`021ed6b`。线上 Worker `market-sentinel-free`
最近一次部署为 2026-10-06 16:22（北京时间），与 main 一致。本文件下方 2026-10-02
及更早标注「待发布」的条目实际均已随后续部署上线，仅作历史记录保留。

# 2026-09-23 — LIVE边缘兼容与大跌连续性修复，待发布

基于已部署`e645c1d`完成五项定向修复：Gate签名请求改为Cloudflare支持的
`manual`重定向并在本地拒绝全部3xx；RegionLaunch信号及ARMED/IGNITION/READY
不再被30标的轮换挤出；BTC/ETH/SOL和有限高流动性连续性槽重新进入扫描；有效
5分钟区间外收盘增加严格的首根完整1分钟强延续确认；仅在5m/15m广度与方向
极端同步反向时拒绝REJECTION逆势单。原AnchorFlow/RegionLaunch框架、账户、历史、
持仓、风险、成本、新鲜度、实盘开关及写单不重放规则不变。

本地已通过1028直接、214 Forward、61权益、49会员、132 LIVE、19架构/迁移测试，
以及聚焦故障测试、类型、构建、Gate流workerd、lint（0错误/16条既有警告）、
diff-check和Wrangler dry-run。未调用私有Gate测试、未改变实盘开关、未重置账户。
下一步只剩reviewed main发布与生产连续性回执。

# 2026-09-23 — LIVE timeout and source-dispatch repair verified locally

Branch fix/20260923-live-sync-latency from deployed e8fabe2. Complete-body Gate
private GET fallback and immediate serialized source dispatch pass1019direct,
214Forward,61equity,49member,132LIVE and19architecture/migration tests. Native
workerd/build/typecheck/lint/dry-run passed;16existing warnings,0errors. Final
reviewed-main publication and advancing public continuity receipt in progress.
No strategy/account/history/credential/switch changes or real-money test order.
Design:research/LIVE_SYNC_LATENCY_2026-09-23.md.

# Status

- 五行情运行时、12 条冻结策略、独立账户和直接信号：已实现。
- 唯一 PAPER 10,000 U 初始权益、按系统权益比例复制、逐单冻结缩放与自身复利：已实现。
- LIVE：按唯一 PAPER 的标准化逐币净额映射实际 Gate 权益；开关与凭据不改。
- V4/V5：停止新单，已有持仓保留原生命周期排空。
- 页面：已改为五系统行情分工；设置与实盘交互未改。
- 候选审计：近触发 `FORMING` 观察与已成形 `BLOCKED` 候选已分层实现；前者没有订单权限，后者会携带真实拦截原因和可得结构进入唯一 PAPER 审计。
- 频率基线：冻结 44 个月回放共 1,821 笔，约 1.36 笔/日；最终六个月 155 笔，约 0.85 笔/日。旧 V4/V5 高频方案回放为负，不作为加频回退。
- 小时路径：首次按币请求 722 根并剔除未收盘小时，立即获得决策所需的 721 根；完成路径独立持久化，重启不再回到 0/11；失败 10 秒重试并成为显式开仓阻塞。
- 发布门槛：生产必须达到 11/11 完整小时路径、无路径错误、已形成至少 8 市场同步背景，否则 GitHub 部署健康检查不通过。
- 验证：冻结 44 个月研究证据未改；267 项直接测试、17 项架构/迁移测试、4 项全行情引擎测试、类型检查、Lint、生产构建、空白检查和 Cloudflare 部署预检均通过。
- 发布：PR #215 已通过 GitHub 审查并合并 `main`。当前 GitHub 连接器写入不会触发 `push` 工作流，且未暴露 `workflow_dispatch`；生产仍为旧版本，需从 Actions 对 `main` 手动运行一次后继续核验。

## 2026-10-07 反向 10U 硬止损
- 「浮亏5U且影子已软」之外加兜底：反向浮亏超过 10U 时不论影子强弱都提前平仓（同一退出原因，exitAudit.evidence.hardLossCap 标记）。模拟与实盘同一规则，实盘仍立即市价跟随，不减少进场。

## 2026-10-07 实盘挂单进场（第 1 步）
- 反向实盘进场改为先挂只做 maker 的限价单（买挂买价、卖挂卖价）2 秒，未成交部分撤单后用原 IOC 市价补齐；挂单被拒直接全量市价。挂单状态不明时不叠加市价单，按挂单编号核对。实盘单数不减少。平仓、止损不变。
- 第 2 步：反向实盘跟随影子的平仓（SHADOW_SOURCE_EXIT）先挂只减仓 maker 单 2 秒，剩余立即市价平；浮亏5U提前平仓、止损保持立即执行。
- 第 3 步：同一执行器已确认过相同杠杆且该合约无持仓时跳过重复设杠杆，减少进场一次网络往返；杠杆管理改动杠杆时清除缓存。

## 2026-10-07 净值曲线加载提速
- 服务器净值读取改为排队，不再返回「繁忙」；手机端遇繁忙 1.2 秒内自动重试 3 次，不再锁 60 秒；分页间隔 0.7 秒降到 0.12 秒。只改图表读取，交易不受影响。

## 2026-10-06 晚（待上线）
- 页面 10 秒刷新的数据不再携带研究专用字段（review、lossResearch、sourceEntryPlan、sourceExitAudit、重复的 entryOpportunities）；研究快照导出不受影响。
- 新增研究快照 research.inverseSoftLossExit：每次「浮亏5U提前平仓」后，记录若继续跟随影子的结局与规则收益；不参与任何交易决策。
