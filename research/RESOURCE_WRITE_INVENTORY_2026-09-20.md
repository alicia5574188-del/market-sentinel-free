# 2026-09-20 持久化资源盘点与同输入压力验收

本轮为只读代码盘点及本地存储探针，已按当前候选实现更新：新增独立8640写/日保护lane，原金融8000写/日不变，compact每个已测完整包省2行，无成交turnover日1440次读取仅写288次。不改变2秒行情、10秒前向保护、5分钟学习；不删除金融账本、成交去重、证据或归档。下列频率是代码结构上界/情景，不是声称线上每天都会发生；本报告不作全账户24小时容量认证。

## 1. 计数口径

本项目wrangler将MarketStream、MemberDirectory、MemberExecutor声明为SQLite Durable Objects。官方文档的SQLite KV `put` 按写入key对应行计，多key事务不是只计一行；`setAlarm`另计写行。当前 `nonAlarmWrites` 主要按entries key数累计，不是整个Cloudflare账户账单，也不包括alarm与其他DO。官方Free写入上限为100,000 rows/day，requests另有100,000/day限制，duration另算。[Cloudflare官方说明](https://developers.cloudflare.com/durable-objects/platform/pricing/)

8000是程序自设金融/原业务预算，当前保持不变；独立保护lane是额外明确建账，不再挤占金融退出余量。旧文档的55,000/日也是自设规划目标，不是Cloudflare平台上限：主2秒alarm加两会员10秒alarm本身就达43,200+17,280=60,480，早已超过该旧规划。不能拿55,000假称平台限制，也不能默默忽略旧规划与当前拓扑的差异。

## 2. 主DO计入与未计入路径

| 路径 | 主nonAlarmWrites | 触发与频率 | 必须保留/可优化 |
| --- | --- | --- | --- |
| `advanceForwardNow`全量forward账户+不可变archive | 已计全部prepared keys | 每5分钟学习至少288次/天；开平仓/重要事件也会增加完整写，10秒尝试节奏的总上限8640次/天 | 必须原子提交；压缩格式可无损降低keys |
| 上述事务的bound `source-close` | 已计，每新归档源退出1行 | 主LIVE曾绑定的退出，每个源ID只首次 | 不可丢弃，Gate离线时仍需退出权威 |
| protection overlay | **独立lane计1行，不计原nonAlarmWrites** | 只有会改变未来决策的新高/关系确认，持久化10秒间隔；8640行/UTC日；与同次full互斥 | 计数与overlay同key/同事务，无额外计数key；普通观察不写 |
| `saveCheckpoint`主runtime及liveJournal | 已计，1+journal.size | 普通30秒最多2880次/天；预提交、未知成交、止损、平仓等force额外且替代邻近心跳 | 不可删Gate前写意图和未知成交记录 |
| Gate turnover summary及成交ID日桶 | 已计所有实际提交keys | 最多每分钟1页=1440页/天；当前空/全重复且无pending仅5分钟持久化一次；含新fill或pending分页即时写 | 实测无成交日1440读→288写，未删成交ID/金额/分页 |
| 历史settlement显示缓存 | 已计1行 | 每分钟最多1次查询，只有新匹配结算时写；无pending不写 | 属可选显示，不得挤占保护 |
| 启动兼容迁移owner-intent | 已计1行 | 仅旧启用状态缺激活围栏的一次性迁移 | 必须保留手动意图语义 |
| 其他已封装owner-intent保存路径 | 已计1行 | owner控制/保护路径触发 | 不可跳过真实意图变化 |
| `setLiveMode`的直接owner-intent.put | **未加主计数** | 每次owner开关请求，即使重复相同选择仍写 | 补计数；重复意图可在不改变围栏前提下幂等去重 |
| `refreshRegimeHourly`成功put/存储重试put | **未加主计数** | 13个执行市场×24=312行/正常天；冷启动另加，失败重试10秒节奏 | 补计数；不要删除旧持仓所需路径 |
| 每2秒alarm重新setAlarm | 明确不计nonAlarm | 理想连续节奏43200行/天；retry重臂可能另加 | 保护时钟不减速 |
| ensureAlarm/watchdog修复的set/deleteAlarm | 不计nonAlarm | 正常已有alarm时0写；异常重建可delete+set两写；watchdog每分钟最多一次=2880额外行的保守情景 | 与健康检查触发ensureAlarm一起另列，不可认为每天必写1440 |

`refreshRegimeHourly`的13个市场是11 core加SUI/UNI两个satellite，不应只按11个算。`saveCheckpoint`的openCount保留取自旧runtime.positions，不等于当前forward账户或实际LIVE未完成风险，不能拿它当完整退出容量预留。

## 3. 其他DO，不可混入主DO计数后宣称全账已覆盖

会员executor各有自己的8000计数：checkpoint+journal已计，source-close已计，继承turnover与settlement通过各自runtime计数。每个活跃会员10秒alarm=8640额外写/天。会员credential、identity直接put以及credential delete不计该计数，需另计控制预算。

MemberDirectory没有主计数：issue每新会员5 keys；首次激活/相隔一分钟的成功login 1行；实际seat变化1行；claim-account 1行；每会员每分钟usage最多1行（两会员2880行/天）；source-close命中归档缓存或分页lookup每次1行。后两项可随交易、缺档重试增加，不能把usage当Directory唯一写入。

D1写入不是DO rows：`maybeWriteStrategyRuntimeLog`、outbox、凭证与设置按独立D1日表统计。它们会影响端到端时长，但不能为了让nonAlarm漂亮而移出计数、或把DO全量写塞进未统计的D1。

## 4. 已执行的真实字节/格式对照

脚本：`node --experimental-strip-types research/resource-write-probe-2026-09-20.mjs /path/to/snapshots`。结果：`resource-write-probe-2026-09-20.json`。

真实导出不是完整持久化state：缺frames、pending明细、feedback、lastEntryBars等；每份只有80条history/events。探针第一组只使用能恢复的真实字段，第二组明确以合成重复记录填充history/events各256、30frames/90pending作字节压力，**不称其为真实全量线上state**。真实数值只在本地读取，结果仅发布字节/数量摘要。

| 情景，三快照范围 | raw JSON | gzip | 旧80KiB chunk+head+archive | 新112KiB首块inline-head+archive |
| --- | ---: | ---: | ---: | ---: |
| 可见字段下界 | 903397–912106 B | 192384–196043 B | 5行/完整写 | 3行/完整写 |
| 256热历史/事件等补齐压力 | 1643441–1651921 B | 272599–279475 B | 6行/完整写 | 4行/完整写 |

6/6新格式读取后与输入state深度相等；6/6 archive的key和value逐项完全不变。每完整写确定省2行；仅288次学习日循环省576行，额外每次金融事件完整写再省2行。此节省不依赖更少交易，也不牺牲证据；不是把多key事务假称1行。

保护overlay的保护字段在6/8/11持仓快照中约2406/3104/4188 B，Worker还在同key附加很小的writeBudget元数据（探针另给含budget字节数），均1行；不是每个仓或每个计数一行。旧算法省掉这类写的同时会遗忘高水位，因此不能把旧版缺失必要写入当优化胜利。

## 5. 当前独立保护lane及保守写模型

当前实现已将保护overlay从原金融预算分离：`nextProtectionWriteBudget`在保存overlay的同一事务中读取并递增该key内的writeBudget；UTC日计数、最后提交时间、8640上限都耐重启。全量金融退出使用原8000预算，不读取该保护lane准入，因此保护lane满或该计数损坏不能阻止本来能提交的金融退出。原始64行余量仍属于原金融路径，不能误称全天所有退出预算。

实际Worker回归已验证：nonAlarmWrites到7936或8000时新高仍能写独立overlay；新高后下一次完整平仓仍使用原有最后额度；full generation变化保留独立计数；重启/同日重复时隙/UTC跨日/写入失败/错误计数不发布未持久化状态。本轮执行`forward-write-budget`、`forward-checkpoint`、`live-coverage-turnover`三文件共65/65通过。旧的“peak写抢走close最后额度”反例已被修正，不能继续作为当前未修复缺陷描述。

代码常量的保守**声明负载模型**如下；逐项算式有意保留余量，并不是平台总账或全账户上界证明：

| 模型项 | 计划行/日 |
| --- | ---: |
| 主DO 2秒alarm | 43,200 |
| 主原金融/业务预算 | 8,000 |
| 主独立保护lane | 8,640 |
| watchdog修复预留（每分钟delete+set两行） | 2,880 |
| 13市场小时路径正常更新 | 312 |
| **主DO模型合计** | **63,032** |
| 两会员各10秒alarm及8000原业务预算 | 33,280 |
| 两会员Directory每分钟usage | 2,880 |
| **主DO＋两会员模型合计** | **99,192** |

99,192距离官方100,000仅808行。上述模型未覆盖无限异常重试、任意管理/登录/归档查询产生的辅助写、其他同Cloudflare账户Worker、所有会员Directory缓存写等；平台requests和duration也各有独立限制。**不得把99,192<100,000写成两会员24小时全负载容量已认证。** 主DO63,032同样只是声明工作负载，不是任意负载保证。

必须考虑full与overlay互斥：一天8640个10秒保护时隙中，若288个时隙发生完整学习写，最多另有8352个overlay。使用已测数据，纯学习+持续创新高持有的PAPER写为：

- 旧版：288×5=1440行（可见字段），或288×6=1728行（补齐压力）；但高水位不耐重启。
- 候选：288×3+8352=9216行，或288×4+8352=9504行，且高水位耐重启。
- 以上尚未包含其他财务事件、主LIVE source-close、runtime checkpoint、turnover、hourly或会员！不能把8640行overlay保留当作全天所有保护写的上界。

如果每个10秒时隙都有开平仓，候选完整写下界为8640×3=25920或×4=34560，另加source-close和LIVE意图journals。这个极端与当前日均115平仓不同，但必须在压力报告单列，不能声称任意无限事件密度都满足Free平台。

可执行压力矩阵至少包含：

1. 24小时无成交、正常5分钟学习、正常30秒主checkpoint：新旧各lane逐key计数，不把wall time等待当CPU。
2. 24小时每10秒产生新保护高点，恰在每5分钟full提交：overlay与full严格互斥，重启随机插入后未来退出相同。
3. 采用既有每日期间约115笔的**事件密度情景**，再做2倍/5倍，均非收益回测；每笔包含source-close、所有LIVE前写后写journal和会员原样比例；必须用实际存储mock计key而非凭空估每笔1行。
4. 集中同一时隙退出、未知成交、原生止损重试、Gate离线后恢复，保护不得被统计先耗尽余量。
5. 23:59:59跨UTC日，旧异步任务晚返回、并发optional/full/main checkpoint预算预占、随机重启。检查不重复/不倒拨日计数、不超额发布未持久化状态。
6. Archive大事件包拆分、raw接近2MiB、gzip超过112KiB多块，按实际prepared.writes核算；不能只测小fixture。
7. 全账户加两会员、Directory、alarm修复、交互余量的总writes/requests/duration，任一门超限均不能叫资源验收通过。

原实现的check→await提交→增加计数存在超订窗口；当前候选加入同步`reserveNonAlarmWrites`预占，提交成功才转实际计数、失败释放，跨UTC日保留在途预占。当前接入主/会员checkpoint、forward完整提交、turnover、settlement、owner迁移/scale以及会员source-close的原有计数路径；独立保护lane另在storage事务中更新持久计数。上表未纳原计数的owner重复控制与hourly仍另列，不因统一预占就自动纳入。各调用的并发回归仍须与最终源码一致，不能把这个进程内预算帮助函数称为Cloudflare全账户持久配额账。

## 6. 可选写削减与去重的可证明范围

Turnover每分钟的空页/重复页summary已改成内存游标推进、最多5分钟检查点；新fill、变化dedup桶、非空pending分页始终即时原子保存。重启回到旧through只会重扫，依赖既有ID去重不漏不重计。Worker回归实际执行1440次空页读取，只产生288次summary写，省1152；新成交、重复页、重启迟到成交、分页完成、存储失败及账号切换均有独立测试。每分钟都有真实新增成交时不能保证省，压力必须覆盖此上界。

主checkpoint不宜笼统“删重复save”：提交前SUBMITTING、未知结果、原生止损ID、source binding/close等每阶段都是新的耐重启事实。可只对journal为空且**持久金融/控制内容真正相同**的force调用去重，普通行情/诊断时间戳不应强迫等价金融状态重写。但计数、UTC日、outbox、手动意图、activation围栏也必须纳入正确处理，不能为了让hash相同把它们丢掉。上线节省数字需来自执行轨迹，未测前记0，不预支“可能省出的容量”。

## 7. 与requests门并行

仅主2秒alarm+watchdog、两会员10秒alarm、directory feed、共享primary feed和usage，缓存有效的后台DO requests约90720/day；feed cache失配更高，尚不含UI。此为独立代码推算并与官方查证角色交叉核对，不应因writes改善就略过。UI请求缓存、会员read-only投影复用与duration需另有验收，不能用本文件的写入探针代替。
