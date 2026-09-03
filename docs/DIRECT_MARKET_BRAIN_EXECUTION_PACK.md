# Direct Market Brain — 一次完成执行包

状态：升级前可执行准备。正式升级从本文件开始，不重新讨论旧策略架构。

## 1. 固定输入与不可改变边界

- 基线：升级开始时重新获取 `origin/main`，确认 PR #111 及之后的生产修复均已包含；若有新提交，只做兼容重放，不丢弃用户修改。
- 新单唯一权威：`direct_market_brain`；旧 HT/家族模块只读兼容旧订单。
- 候选：24h USDT 成交额前十五，十五币轻扫、跨风险簇六币深扫、最多三仓。
- 学习：唯一模拟账户；每单真实观察至 720 分钟，完整后才改版本；无 shadow/第二模拟。
- 实盘：只继承实际模拟决策快照；不转资金、不改变 Owner 授权。
- 稳定性：持仓保护优先；页面只是快照消费者；任何单币/DO/D1失败不得拖成主接口整体 503。
- D1：扫描/未成交候选零写入；系统硬预算 30,000 索引调整行/UTC日；新单准入线 22,000；账户生产安全线 65,000。

## 2. 已完成的预备代码

- `lib/direct-market-d1-budget.ts`
  - 固定免费额度、账户安全线、系统硬预算、新单准入线、120单/日保险丝和每单100行承诺；
  - 证明旧逻辑行预算遗漏索引后，保守上限为105,120；
  - 提供新单预算准入纯函数。
- `tests/direct-market-d1-budget.test.ts`
  - 已验证旧预算缺陷、新预算70,000行余量和准入保护。
- `docs/DIRECT_MARKET_BRAIN_UPGRADE_PLAN.md`
  - 完整业务、学习、风险、迁移、UI、测试、发布和回滚合同。

这些模块当前未接入生产调用，不改变正在运行的系统。

## 3. 正式实现的类型合同

先定义以下稳定对象，后续模块只依赖这些对象，不互相读取旧策略类型：

```ts
type DirectMarketCandidate = {
  symbol: string;
  batchId: string;
  observedAt: number;
  freshness: "FRESH" | "STALE" | "UNAVAILABLE";
  scanStage: "LIGHT" | "DEEP";
  volumeRank: number;
  riskClusterId: string;
  btcBeta: number | null;
  location: "TOP" | "MIDDLE" | "BOTTOM" | "BREAKOUT" | "BREAKDOWN";
  paths: { up: number; down: number; rangeOrInvalid: number };
  netEdgeR: number;
  decision: "LONG" | "SHORT" | "WAIT";
  entryZone: [number, number] | null;
  invalidationPrice: number | null;
  targets: number[];
  evidence: string[];
  counterEvidence: string[];
};

type DirectBrainDecisionSnapshot = {
  id: string;
  authority: "direct_market_brain";
  brainVersion: string;
  parentVersion: string | null;
  batchId: string;
  universe: string[];
  selectedSymbol: string;
  portfolioRank: number;
  candidate: DirectMarketCandidate;
  portfolioChecks: Record<string, unknown>;
  riskState: "CALIBRATING" | "VALIDATING" | "NORMAL" | "CAUTION" | "DEFENSIVE" | "PAUSED";
  createdAt: number;
};

type DirectBrainPostExitState =
  | "PENDING"
  | "READY"
  | "STALE"
  | "UNAVAILABLE";
```

所有概率必须归一化；所有交易字段必须可从快照重放；任何 `WAIT` 不创建 D1 决策行。

## 4. 一次实现顺序与限时

| 阶段 | 直接修改 | 阶段测试 | 模型活跃时间上限 |
| --- | --- | --- | --- |
| A. 类型与迁移 | 新类型、additive schema、旧订单兼容 | 迁移＋预算 | 15分钟 |
| B. 十五币大脑 | universe/observations/brain/selection | 纯函数＋失败隔离＋相关性 | 25分钟 |
| C. 执行与学习 | execution、三仓、风险状态、七节点观察 | 风险＋复盘＋旧仓延续 | 25分钟 |
| D. 实盘血缘 | live repository/engine只解析新快照 | parity＋fail-closed | 10分钟 |
| E. 五页UI | 机会/雷达/订单/实盘/设置替换显示 | UI＋Must-Keep＋滚动 | 20分钟 |
| F. 集成修正 | scanner/DO/API、版本身份、文档 | 503、调度器、D1 | 10分钟 |

目标模型活跃时间：75–105分钟。阶段中只跑对应的小测试，不重复跑完整构建。

## 5. 精确文件路由

新增：

- `lib/direct-market-types.ts`
- `lib/direct-market-universe.ts`
- `lib/direct-market-observations.ts`
- `lib/direct-market-brain.ts`
- `lib/direct-market-selection.ts`
- `lib/direct-market-risk.ts`
- `lib/direct-market-learning.ts`
- `lib/direct-market-execution.ts`
- `db/direct-market-schema.ts`
- 一组对应的 `.test.ts`

接线修改：

- `lib/hte31-scanner.ts`：删除新单路径中的三个旧评估器、评估写入和家族路由，接十五币两阶段扫描；
- `worker/hte31-workers.ts`：轻扫/深扫分片、15秒持仓优先、七节点补齐、D1 DO计量；
- `lib/hte31-repository.ts`：新旧订单兼容、观察完整性和所有写入预算记账；
- `lib/hte31-position-sizing.ts`：新风险阶段真正进入仓位计算；
- `lib/live-trading-repository.ts`、`lib/live-trading-engine.ts`：不可变决策快照原样继承；
- `app/api/hte31/route.ts`：只读主快照、独立按需复盘；
- `app/page.tsx`、`app/resonance.css`：十五币雷达和新订单复盘；
- `package.json`、migration smoke、Must-Keep、budget测试。

暂不删除旧模块，避免旧订单和回滚断裂；测试证明新单调用图不可到达它们。

## 6. D1硬保护实现清单

1. 十五币扫描和未开仓判断只保存 DO 有界快照，D1写入断言为零。
2. 每个D1写函数声明表行、主键和显式索引的最坏计费成本。
3. DO保存 `utcDay / estimatedRows / committedRows / newOrders`；日切按UTC，计量自身不写D1。
4. 新单前调用 `directMarketD1Admission`，先为整笔订单未来七节点和学习预留100行。
5. 22,000以上不再开新单；30,000以上只有保护/平仓可继续。
6. 旧13条评估和每分钟诊断桶的调用图必须消失；历史表不删除。
7. migration不得回填旧订单；新索引必须计入预算并用D1 `meta.rows_written`实测。
8. 发布前后用Cloudflare GraphQL聚合全账户所有D1数据库；安全线65,000。
9. 若账户其他数据库占用写额度，从22,000准入线等额扣除；无法读取账户指标则不宣布额度安全。

## 7. 测试只跑一次完整套件

阶段测试：

```bash
node --experimental-strip-types --test tests/direct-market-*.test.ts
node --experimental-strip-types --test tests/hte31-position-sizing.test.ts tests/live-trading.test.ts
node --test tests/mobile-navigation.test.mjs tests/human-trader-ui.test.mjs tests/resonance-feature-preservation.test.mjs
```

最终只跑一次：

```bash
npm run test:signals
npm test
npm run lint
./node_modules/.bin/tsc --noEmit --incremental false
npx wrangler deploy --dry-run --config wrangler.cloudflare.jsonc
git diff --check
```

任何失败只修对应层并重跑该层；全部通过后才再次运行受影响的最终门禁，不无意义重复全套。

## 8. 发布与生产验收

1. 检查diff、迁移、凭据和旧仓兼容。
2. 推送一个功能分支，等待一次PR CI；绿色后合并。
3. 确认自动部署使用已配置Cloudflare环境，不再手工二次上线。
4. `/__health` 快速只读；连续两次确认Scanner、Position Monitor、Live Coordinator前进。
5. `/api/hte31` 在单币、D1和DO故障注入后仍返回HTTP 200部分快照。
6. 确认十五币三分钟覆盖、六币深扫、最多三仓和旧策略零新单调用。
7. 查询D1 GraphQL：记录部署前账户行数、部署后一小时增量及24小时外推；必须低于65,000/日。
8. 若写入外推超线，立即关闭新单准入，保留持仓保护和观察，修正后再验收。

本阶段预计20–45分钟，大部分是命令和CI等待，不应持续消耗模型推理额度。

## 9. 完成定义

只有代码、针对性测试、一次完整套件、远程CI、生产健康、调度器推进、D1账户指标和移动页面全部通过，才能通知用户“已上线”。任何一项缺失都不能用计划完成代替实际完成。

