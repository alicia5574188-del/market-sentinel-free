# 历史相似预测首版

2026-09-05：用户明确用一个历史相似预测策略替换此前三策略重设计提案。状态：已通过 PR #141 上线，生产工作流33952777266的验证、部署与运行检查全部通过。实际交易频率和盈利仍待真实模拟样本检验。

## 交易与展示

- 当前输入：同币最近 24 根已收盘五分钟 K 线，即两小时。
- 历史库：最多十四天、4032 根同币五分钟 K 线；每个历史片段的形态和随后十二根结果，都必须早于当前输入窗口。新币数据少则如实显示实际范围。
- 比较：归一化价格路径、逐根收益、波幅、实现波动、斜率、相对成交量、北京时间时段、星期、周末、月末；只在双方都有记录时比较事件类型和事件前后位置。
- 事件仅使用既有 BLS／FOMC 日历中实际返回的时间记录，不增加新闻抓取。覆盖是部分的，未知不当作普通无事件；不使用事后公布的经济数值预测过去。
- 先按过去特征距离选样本，再计算后续结果。最多二十个片段，形态加结果共三小时的区间彼此不重叠；至少八个样本，有效样本量至少 7.5。
- 一小时方向支持至少 58%，中位数超过费用，目标至少为费用的两倍，真实目标／止损比至少 0.8，按止损、第一目标保本和第二目标的保守路径重放净期望至少 0.05 倍风险，才形成可交易信号。相似度和历史占比不是校准后的预测胜率。
- 目标来自相似片段顺向后续收益的六成分位，不为凑固定美元利润抬高目标。初始止损在最近六根结构外加 0.3 倍平均波幅，距离至少 1.2 倍平均波幅，超过 5% 放弃。第一目标为第二目标距离的一半，最长持有一小时。
- 当前实际报价仍须新鲜、在入场范围内、未越过下一根完整 K 线；不能使用进场前波动触发进场后止损。既有亏损保护、保证金、相关性、总风险和 D1 门槛保留。
- 单一完整预测即可进入执行，不再凑三币批次或前三名。只执行本次扫描的当前候选，避免重复执行缓存旧候选并错记开单归属。
- 新预测的证据尺度是历史净期望，风险与学习准入不再沿用旧评分合成的 0.55R／70 分门槛；风险恶化后相应提高历史支持与净期望要求。历史学习失败保护仍生效。
- 新策略取消固定 50 美元目标门槛；在原安全杠杆／保证金约束下，允许计划风险落在权益 0.5%—3.5%，而不是为达到固定 3.5% 扩杠杆或拒绝较小可执行仓位。实际计划风险逐单保存，账户总风险仍不超过 15%。旧策略默认仓位政策保持可读兼容。
- 首版只进入 PAPER 模拟验证；实盘提交边界明确拒绝未获资格的 HISTORICAL_ANALOG。既有真实订单保护、对账、资金与凭据保持原边界。

## 数据、运行与预算

复用原 Scanner、Gate 五分钟行情适配、订单生命周期、账户、通知和发布路径。每币一个有界 DO 历史键，冷启动最多五页，每页最多七十二小时、并发最多二；正常增量仅一页，当根数据完整则直接复用。历史缓存不写 D1，不由浏览器生产行情。

旧版全配置币池轮询和 25 秒周期间隔保持；默认三十币，设置最多五十。并非每五分钟同时重算全部五十币。合格信号无需等待另一币，但实际每币覆盖时间和真实开单频率仍须运行测量，不能承诺每小时固定单数。

现有账户 D1 22,000 新单准入／30,000 应用预算／65,000 写入和 3,250,000 读取观察安全线保持。扫描 D1 逐次写入仍为零，历史只占有界 DO 快照；已持仓每十五秒检查、无变化每六十秒落库。缓存中的每币候选不再重复携带 96 根图表 K 线，避免币池扩大后总快照过大。

页面增加当前走势、相似历史走势和后续八成经验区间的对照图，可展开查看相似日期。历史区间是描述性样本分布，不是经过校准的置信区间。没有样本不绘制假走势；旧数据／缺片原因可见。原始漏斗数字折叠，实际成交、净利润、账户与十二小时总结保留。

## 验证与限制

当前验证覆盖：未来／未收盘数据排除、时间对齐、历史片段去重、当前缺片／过期、价格缩放、费用敏感性、双向预测、入场风险学习连通、较小保证金安全仓位、五页有界缓存与增量读取、旧策略统计隔离、原持仓／实盘／页面能力回归。

这些测试使用确定性样例验证正确性，不能证明真实行情盈利。当前环境的直接 Gate 网络请求审批被取消，未通过该路径完成实时历史回测，不绕过取消。真实效果由正常授权部署后既有生产行情与模拟订单验证。事件日历并不覆盖突发新闻或所有历史宏观事件。

重大版本为 `direct-market-brain-v7-historical-analog`，新增迁移 `0025_direct_market_v7_historical_analog_cutover`。复用现有新鲜报价归档旧 PAPER 仓位、开始新资金周期、阻止迁移未完成时开单的流程；不删除历史、不触碰真实资金。

## 后续修改入口

- 匹配、样本与后续分布：`lib/historical-forecast.ts`。
- 缓存：`lib/historical-forecast-cache.ts`。
- 交易计划：`lib/direct-market-brain.ts`；入口、风险和学习共用既有文件。
- 页面：`app/historical-forecast-card.tsx`；其他必要能力仍由现有页面负责。
- 验收：`tests/historical-forecast.test.ts` 和既有 CI。先定位无样本／无净优势／报价过期／资金限制的实际原因，不能每次靠放松阈值制造开单。

## 2026-09-05 — Historical preparation diagnosis and compact summary

- Production browser showed AKE already had4031 valid5m bars from08/22 through09/05, yet only1/8 independent analogs. This observed candidate is similarity-starved, not waiting to accumulate live data or a12h report. Public health showed scanner/position live with no errors. Complete current account/order data was unavailable in the observed partial response; do not infer all-symbol or global counts from it.
- Reproduced a separate cache defect: fresh80-bar tail prevented any upstream request despite4032 available bars. Repair now checks the whole bounded14d window, retains successful bootstrap pages after a sibling failure, and heals at most one old page alongside the normal current page. No-progress old repairs back off30min; successful repairs can continue after1min. Concurrency remains2 and D1 scan writes remain0.
- UI hides prediction charts/proportions below the existing8-sample eligibility gate, labels real shortage, hides empty performance grids, and reduces the12h report to actual entries/exits/net results and a completed conclusion. Technical counters remain collapsed.
- No similarity, direction, edge, risk, order, epoch or live policy changed. This patch does not prove restored trade frequency; AKE's observed sample shortage remains a real trading restriction. Direct local Gate history access was cancelled; no bypass or real-history profitability claim.

## Historical readiness correction — production verified

- PR #142 merged main b6075da3e066b54b13f878128d8e2313e5e243c4; PR CI33961370914 and production33961439540 verify/deploy/operations all passed. Worker347457c4-d94e-4532-bc5e-5de7bf02e79a. ActiveV7, targetnull, legacyPAPER0; no new epoch.
- Browser verified4031 bars: AKE1/8 andBNB2/8 before release; DASH1/8 after release correctly labels complete history/sparse matches, hides insufficient forecast and empty stats, and collapses summary counters. XAU17 matches still WAIT with outcomes within costs: sparse matches are not the only entry restriction. No new trade or restored frequency claim. Partial-source display delays remain observed and labeled; not claimed fixed by this patch.
- Scanner success1788605148945→1788605205860; position alarm1788605204393→1788605264471, no errors. D1 at2026-09-05T10:47:09.470Z: UTCday133262reads/1155writes; rounded24h852165reads/3739writes. Bounded verification only.
- Completed diagnosis/cache/UI scope. Proof retained in PR #142 comment. Do not redeploy only to sync documentation; frequency calibration remains a separate unmet product objective.


## 2026-09-05 — Persistent historical archive and fixed six-symbol coverage

- Owner explicitly supersedes the14-day historical boundary and the top-volume changing universe. Active scan pool is BTC/ETH/SOL/BNB/XRP/DOGE; rank changes cannot replace members. Missing exchange symbols are skipped, no automatic high-volume replacement. Existing position protection is independent and remains active for holdings outside this scan pool.
- HistoricalArchive is a new stable per-symbol SQLite-backed Durable Object namespace, separately exported/bound by additive Worker migration v5-historical-archive. It has no generation reset, eviction, alarm, D1 table or foreground data producer. Existing hot14-day cache seeds it and remains the recent-candle source. All received valid raw bars are retained as daily compact tuples, not individual D1 rows. Cursor/day writes are atomic.
- Each symbol attempts at most one72h older page every10min: at most864 history requests/day across6 symbols. New candles remain priority. Exceptions retain the cursor and use exponential cooldown. Empty pages are retried before slowly probing earlier; partial pages retain a bounded repair queue. Outage gaps between saved and current days are separately repaired. Never fabricate missing candles or declare an empty response definitive exchange inception.
- Default inference no longer discards rows older than14days. Recent14days plus14 rotating older daily chunks are read locally per evaluation, at most about30days of raw input. Every stored older day participates across rotation; this is not an exhaustive all-history nearest-neighbor search each cycle. Page explicitly shows total stored bars, earliest saved date, current searched bars and progress. Event coverage remains partial; this upgrade does not invent old news/calendar data.
- D1 historical writes remain0. Archive recurring planning estimate: under20000 packed row writes and200000 row reads/day. Durable local guard caps archive writes at3500 per symbol/UTCday, at most21000 across6; reserve24 rows before a batch. Existing Scanner/position/live DO operations are a separate budget, so this is a contribution bound, not account-wide observed usage. Retain current D1 admission22k/app30k/account65k boundaries.
- Packed-byte archive ceiling256MiB per symbol (six at most1.5GiB plus metadata/SQLite overhead), below the5GB Free-account storage allowance with room for existing data; account capacity is shared and not measured by this bound. Capacity/daily-budget protection retains saved history and keeps fresh data usable. Existing risk, costs,8 independent samples, live eligibility and epoch stay unchanged.
- Cloudflare primary documentation checked2026-09-05: https://developers.cloudflare.com/durable-objects/platform/pricing/ and https://developers.cloudflare.com/durable-objects/platform/limits/ . Free SQL DO limits are5m reads/100k writes daily and5GB total; SQLite KV key+value limit2MB. No paid service enabled or R2 setup required.
- Browser/API slowdown is isolated: unavailable archive falls back to the same strategy's already valid recent data with an explicit unavailable-library label, never invented stored counts or a legacy strategy. No promise of fixed trade frequency or profitability.
- Local tests42 Direct +7 architecture,231 signals/risk,115 build/UI passed; lint and TypeScript passed. Final CI/deployment verification pending.
