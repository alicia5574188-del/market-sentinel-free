# 私人登录密钥与独立会员账户

主账户在「系统 → 朋友与登录密钥」生成并复制一人一把密钥。「生成下一位」只创建新账户，旧密钥继续有效，包括尚未首次登录的朋友。同一密钥只能进入同一个账户，不会生成新的使用资格；它是密码式持有凭据，转发密钥仍可能让别人进入同一账户，不能声称识别本人。

朋友打开同一网址输入密钥，看到共享的当前模拟策略，但实盘API、开关、订单、浮盈亏和成交记录均隔离；默认关闭，只跟随本人开启后的新模拟单。主账户只能在会员汇总里看到备注/编号/激活状态/本程序实际成交额及截至时间，不显示朋友余额、盈亏、API或代开开关。当前主账户和稳定策略不重置、不改参数、不因会员登录重新训练。

为保护当前部署，首批20个登录账户，最多2个会员实盘执行账户同时占用执行席位（主账户不计入）。已有会员持仓仍占用席位直到保护/平仓完成；新增超额请求被拒绝，已有交易不被挤出。容量是保守准入，不代表免费资源无限或保证永不延迟；更多并发需要单独验证/配置资源。

会员注册与每个人的执行分别使用新增SQLite Durable Objects，主循环不遍历或等待用户；共享行情由独立目录缓存合并读取。没有会员时没有新增后台交易工作。原有owner密码、凭据加密格式、主账户开启时间以及原始10个关键交易方法保持不变。程序API现在需要登录；`/__health`继续仅供运行监测。新数据和原状态独立，旧v1-v7迁移不改，只增加v8会员命名空间。

验证：`npm run test:members`、`npm run test:direct`、`npm test`、`npm run typecheck`、`npm run lint`、`npx wrangler deploy --dry-run --config dist/server/wrangler.json`。`npm run test:members:workerd`以虚构密钥启动临时本地SQLite环境检验编译后的登录/密钥/权限，不触及Gate或主源，测试专用兼容日期不改变生产。详情见`MEMBER_ACCESS_CONTRACT.md`。

---

# LIVE copy coverage and actual turnover

Current execution repair keeps `new-orders-decimal-pnl-v1` and the PAPER algorithm unchanged. Unicode Gate signatures are corrected; internal write budgets roll at UTC midnight and forward state is losslessly compressed. The LIVE page separates copied/eligible/missing and adds **实盘累计成交额** from deduplicated actual Gate fills: opens, closes, total and system-tagged subset. Scope is the current Gate USDT account since the displayed original forward start, including manual fills. Numeric amounts remain owner-only, partial backfill is explicit, no estimated order value is counted. No forced one-lot enlargement or pre-enable catch-up. See `research/LIVE_COPY_COVERAGE_TURNOVER.md` for evidence, tests and boundaries.

# LIVE correction: new-orders-decimal-pnl-v1

**只跟随本次开启后新产生的模拟单，不补开此前已有持仓。** 关闭再开启建立新起点；重复开启、登录、刷新和重启不改变起点。升级时已经在管理的实盘仓位继续原保护与退出，不被强平；所有者开关保持原选择。

实盘数量读取每个Gate合约的小数开关和实际最小量，按十进制精确向下适配，不再统一截断为整数1张。当前公开规格中SOL最小0.1张，ZEC最小1张；规格会刷新，不能硬编码到币种。低于真正最低量时显示目标/最低数量、最低名义额及严格比例所需净值门槛，不擅自补一张、加杠杆或伪造复制数。

持仓浮盈浮亏使用Gate持仓原生回报，显示金额、浮盈/实际保证金百分比和更新时间。数据过期仍标示最后真实回报，缺失不填0，也不用模拟单或临时盘口代替。总模拟持仓、开启后可跟随、旧单排除、实际复制、真实最低量受限和待确认分别显示；由于不补旧单及交易所最低量，不能保证两个总订单数永远相等。

固定验收见 `LIVE_MIRROR_CONTRACT.md`；执行标识 `new-orders-decimal-pnl-v1`，原模拟策略/账户/历史/冷启动状态不变。验证必须包含59项真实Worker/FakeGate复制回归及当前源上线检查；真实私有账户不用于开发测试。上线检查不得假设所有者一定处于关闭。

# Current PAPER → owner-controlled LIVE

最新版模拟账户现在是实盘复制的唯一新单来源。每笔关联原模拟ID、完整规则与订单快照、原始保护和退出决定；按实盘标记权益／当前模拟标记权益冻结复制比例，申请源单原杠杆。实盘开始/关闭只由所有者操作，升级不会替用户开启。

关闭会撤销系统入场挂单，已有实盘持仓保留止损并继续跟随原模拟退出；不会偷偷撤销保护或一键强平。登录、刷新、保存API、重新部署都不改变开关。新旧版本都必须满足 `LIVE_MIRROR_CONTRACT.md` 和 `npm run test:live-parity`。

实盘页显示当前源接入、源单数、对应持仓、待确认及偏差。完整源单映射通过所有者权限读取；历史记录不会因同币新单覆盖而消失。最小张数取整、成交差价/时差、部分成交、拒单、实际费用属于交易所事实，不能保证和模拟完全相同，也不会用模拟收益填实盘。只支持已适配的Gate单向/经典USDT合约账户，不自动更改用户账户模式。资金不足或源杠杆不支持会明确记录未复制原因。

当前PAPER算法和数据格式保持不变。下方旧说明中的“没有LIVE桥接”是历史状态，已由本节覆盖；历史模拟对象 `liveEligible:false` 仍表示对象本身没有开关权限，不等于当前运行时未接入复制。纯策略模块仍无凭据或网络下单能力。

新增验收：`npm run test:live-parity`（真实Worker逻辑 + 假Gate，不访问真实私有接口），现有直接测试/构建/类型/lint/dry-run仍必需。发布后只读核对当前复制源、持久化、页面和用户开关未变；这不冒充实盘成交验收。

# Current policy: participation-execution-v1.2

当前恢复活跃版的机会发现广度；证据集中度和实际成交偏差用于提示、排序和有限风险缩放，不再层层否决到只剩单币。跨币规则明确是待验证假设，不是已证明的优势；原始估计、稳健估计和成交校准后估计分别显示。

报价暂缺的已触发信号在当前5分钟K线剩余窗口内按既有10秒回调重试；过期作废，使用当前价、计成本，不补历史成交。同币同根K线不重复，之后的新完整K线可提供新机会。当前可执行标的共享原有风险/名义额/保证金预算；未提高1.5%单笔、10%总风险、6.5%同向和4倍总名义额上限。新增规则的回吐保护边界考虑费用，旧仓位不改。

账户、样本、亏损、历史、实盘权限全部保留，不重新冷启动。规则仍仅模拟；LIVE不会自动启用。新增机会/重试/实际开仓计数，不能把匹配当成交。354项直接测试包括78项前向测试；机会保留率检查不是盈利回测。实现、结果与副作用见 `research/FORWARD_PARTICIPATION_REPAIR.md`。

以下旧说明中的逐币正收益门槛和同向同期限3%门槛已被本策略覆盖；费用模型、数据连续性和执行隔离仍有效。

# 当前算法修正：关系证据与成交校准 v1.1

算法标识 `evidence-calibration-v1.1`，持久化格式仍为 `forward-relations-v1.0`。**沿用原账户、亏损、学习记录和持仓，不重置成1,000U。** 月复利翻倍仍是尚未验证的目标，新规则仍只执行PAPER。

跨币规则增加单币影响限制与逐币剔除复核，并检查当前币是否有适用证据；自身持续有效的单币关系只用于自身。实际已平仓模拟净收益按同一时间组校准预测误差，近似阈值/版本变化不能清掉失败记录；反馈有收缩和时间衰减，不使用连胜晋级。新开仓按剩余净优势与不确定性分配风险，保留原总额度，增加同向同期限3%风险桶、同关系周期去重、碎片仓位跳过及入场前价格偏移检查。规则原始止损不因后续学习而放宽。

`/api/runtime.forward`新增 `policyVersion`、`policyUpgrade`、`evidenceDiagnostics`、`entryDiagnostics` 和 `feedbackCount`。规则的 `evidence`显示适用市场、独立时间组、校准扣减及证据摘要；这些不是胜率。完整成交反馈在不可变归档中，正常快照仍是滚动样本。极大归档批次使用 `archivePart`/`archiveParts`分片；使用原有`nextCursor`读取所有页并按时间与revision归组，不遗漏后续part。

权衡、初始算法常量、验收与局限见 `research/FORWARD_EVIDENCE_REPAIR.md`。修正会减少错误的跨币推广和重复风险，**也可能减少交易、错过机会或继续亏损；功能测试不等于盈利证明。** 数据源、Worker调用节奏、D1、实盘开关及权限未改变。

---

# Dark readable UI and native LIVE console — 2026-09-16

Default navigation is now **总览 / 规则 / 模拟 / 实盘 / 演变 / 系统**. The entire surface is dark, body text is 16–17px and the smallest UI labels are 14px. There is no legacy-page launcher or alternate console.

The native LIVE page preserves the existing owner account, Gate credentials and owner-only server endpoints. Login and logout never toggle LIVE. Enabling requires an explicit inline confirmation (no browser dialog); OFF and system-order cleanup use the existing server action. Account balances, positions, closed records and API management use the same new design. Unknown balances remain unknown; stale quotes never produce invented zero PnL.

This is a UI/session integration only. All trading engines, forward storage, real-money execution, risk, credentials and authorization source files remain byte-identical to the deployed base, asserted by `tests/ui-authority-baseline.json`. New forward-generated rules remain PAPER-only. User switch control is not a new strategy-to-Gate bridge.

`tests/operator-ui.test.ts` covers current-side PnL, missing values, one-shot owner requests and frozen authority hashes. Private snapshots are invalidated on login/logout and stale in-flight responses cannot restore them.

# 哨兵 · 关系引擎 — 真实行情前向实验

当前版本：`forward-relations-v1.0`。**真实 Gate USDT 永续行情 + 独立 1,000 USDT PAPER 账户**。这是功能上线，不是已经证明盈利或月复利翻倍。新规则绝不进入 Gate 私有下单路径。

## 当前运行方式

- 使用现有单一 `MarketStream` 数据源，保留最多30个流动性标的5分钟路径；旧K线仅计算启动特征。只记录部署启动之后的条件与随后真正发生的15/60/180分钟反应，不导入历史收益或交易。
- 按时间去重、同币同期限不重叠测量；反应区间断口作废。市场测量不是影子订单，不设连胜晋级。
- 每15分钟按已完成的新反应生成有限、可审计的规则语法：至多两个特征条件，方向由条件反应估计，期限从15/60/180分钟选择，生成止损、保护启动、回吐边界和反应期限退出。量化阈值来自较早样本；较晚时间组作检查，重叠端点隔离。多重筛选仍有偏差，绝不称盲测或胜率。
- 规则有不可变版本与父版本、生成/修订/休眠/再识别理由。已开仓冻结原始风险边界，新证据不能扩大它；反应回吐或连续两个完成K线的相反新证据可退出。
- PAPER使用当时新鲜、顺序核对完成的买卖价与合约整数张数；不以旧K线补单，不伪造最高点退出。开平仓费用各7bp、额外滑点各2.5bp，加实际价差；每日2bp不利资金费用占位。这不是账户真实费率和资金费结算，不能称交易所真实成交。
- 初始实验预算：单笔风险1.5%，总10%，同向6.5%，总名义额4倍；按当前净值计算。不是最佳杠杆结论，也不保证回撤。月复利翻倍仅是待检验目标。

## 页面与数据

新版默认六页：**总览 / 规则 / 模拟 / 实盘 / 演变 / 系统**。启动时明确显示数据积累，不预置规则、图表或成功订单。所有者与实盘管理直接由“实盘”页进入；旧页面入口已移除；原凭据、LIVE开关选择、历史和已有仓位保护不改。旧五行情系统不再新开仓，旧账户不是新实验成绩的一部分。

学习状态、账户和去重信息使用校验分片原子持久化。规则与成交必须保存成功才发布；失败不自动清空本金。全部新样本、规则版本、成交和账户路径另外写入不可变归档，供后续分析和受测的软件优化。页面展示滚动记录，完整内容分页读取：

- `/api/runtime` 的 `forward`：当前前向账户、规则、观测进度、状态及成本。
- `/api/forward/export`：当前账户和滚动样本快照。
- `/api/forward/archive?cursor=...`：每页25个不可变归档包，使用返回的 `nextCursor` 继续，null表示结束。
- `/__health`：核心运行状态、新模块持久化状态和精确发布 `buildSha`。

每日净值是定时采样点，`exactBoundary=false`，不冒充精确午夜结算。累计净值以当前可观察退出报价计浮动盈亏和退出成本；陈旧持仓估值明确标记并阻止新增风险。仅有已见盘口保护，不声称复现交易所标记价格强平或真实排队成交。

## 验证与部署

```bash
npm run test:direct
npm run test:forward
npm test
npm run typecheck
npm run lint
npx wrangler deploy --dry-run --config dist/server/wrangler.json
git diff --check
```

发布仅通过已验证的 GitHub `main` → Cloudflare 路径。调度先比对线上 `buildSha`，相同提交不反复部署；发布后核验页面、新模块持久化和所有者LIVE选择未变。不要求额外插件或登录弹窗。生成器没有任意代码执行权限，扩展表达能力需要新的代码审查和功能测试。

---

# 历史版本说明（退役新开仓，不是当前主系统）

# Five Regime Systems · 五行情独立账户

Gate USDT 永续合约交易系统。系统先用固定 11 个高流动性市场的连续 720 小时数据，把当前市场归入一个且仅一个行情域，再由该域内冻结的策略组合直接决定是否下单。

## 生产结构

- `SHOCK_TRANSITION`：冲击转折，2 条策略。
- `COMPRESSION`：波动压缩，2 条策略。
- `DIRECTIONAL_TREND`：方向趋势，4 条策略。
- `NON_TREND_EXPANSION`：非趋势扩张，2 条策略。
- `BALANCED_ROTATION`：平衡轮动，2 条策略。
- 每个系统拥有独立的 1,000 U 假想账户、权益、仓位、冷却与 10%/6.5% 风险额度。
- 行情域互斥且穷尽；当前域只控制新信号。旧域已建立的仓位继续由所属系统独立管理，因此同一币可跨系统同时持仓或方向相反。
- 冻结策略在当前行情域直接执行；没有影子订单、3 连胜、近 6 笔、30 天滚动授权或基于结果的方向切换。
- 唯一 PAPER 账户从 10,000 U 开始，把每笔系统订单的“名义价值 ÷ 该系统开仓权益”完整复制到自己的当前权益；例如系统以 1,000 U 权益开 500 U，唯一 PAPER 以 10,000 U 权益开 5,000 U。
- 每笔复制单在开仓时冻结缩放倍数，已有持仓不会因其他订单盈亏反复调仓；平仓盈亏进入唯一 PAPER 后，后续新单按增长后的权益复利。
- 唯一 PAPER 不设第三道资金或风险准入门槛。Gate 单向持仓模式只在 LIVE 边界逐币汇总标准化净额，再按实盘真实权益复制；各系统与 PAPER 的逻辑腿仍分别保留。

旧 V4/V5 不再产生新候选。部署时已有的 V4/V5 PAPER 持仓保留原止损、目标与生命周期，只作为退役排空层自然退出，避免部署突然改写现有 LIVE 仓位。

## 冻结证据

生产策略来自 `research-results/regime-system-portfolios-2026-09-14.json`，信号使用 44 个月 Gate 1h 数据，执行使用对应的 5m 数据。

| 指标 | 结果 |
| --- | ---: |
| 44 个月净收益 | +2,862.90 U |
| 最大回撤 | 5.12% |
| 活跃月份中盈利月份 | 29 / 42 |
| 发现段 | +1,559.56 U / 1,311 笔 |
| 验证段 | +1,019.75 U / 355 笔 |
| 评估段 | +283.59 U / 155 笔 |
| 高成本评估段 | +212.09 U |
| 双倍不利进场评估段 | +267.64 U |

这只是历史回放，不承诺未来收益。本次上线从新数据开始自然前向验证；策略参数不会根据新订单输赢自动改变。

## 风险与数据

- 单笔目标风险为所属系统当前权益的 1.5%，名义价值最多 0.5 倍权益、最少 0.05 倍。
- 每个系统总风险不超过 10%，同方向风险不超过 6.5%。
- 同系统同币只允许一个仓位；同策略同币平仓后冷却 24 小时。
- 完整往返摩擦按 0.14% 建模；使用新鲜 bid/ask、Gate 整数张数和真实合约乘数。
- 至少 8 个市场具备同步、无断口的 721 根完整 1h K 线才允许判定；数据不够或盘口失鲜时禁止开单。
- 冷启动会为每个固定市场直接请求 722 根 1h K 线，剔除尚未收盘的当前小时后立即保留所需的 721 根，不等待下一整点；11 个市场逐个补齐，失败约 10 秒后重试并在页面如实显示。
- 已完成的小时路径按币写入 Durable Object 独立存储，进程重启或重新部署会直接恢复，不再从 0/11 重新预热；生产健康门槛要求 11/11 完整且跨市场背景已生成。
- LIVE 继续保留原所有者登录、AES-GCM/HKDF 凭据、开关选择、实盘风险缩放、保护止损和故障闭锁。部署和登录不会自动开启或关闭 LIVE。

## 验证与发布

```bash
npm run research:regime-systems
npm run test:direct
npm test
npm run typecheck
npm run lint
npm run build
npx wrangler deploy --dry-run --config dist/server/wrangler.json
```

生产只能从 GitHub `main` 发布。
