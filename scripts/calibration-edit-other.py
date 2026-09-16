from pathlib import Path
import hashlib

def edit(path, before, after, edits):
    p=Path(path)
    data=p.read_bytes()
    assert hashlib.sha256(data).hexdigest()==before, f"Unexpected base: {path}"
    lines=data.decode().splitlines(keepends=True)
    for a,b,text in reversed(edits): lines[a:b]=[text]
    result=''.join(lines).encode()
    assert hashlib.sha256(result).hexdigest()==after, f"Unexpected result: {path}"
    p.write_bytes(result)
    print('verified',path,after)

edit('.codex/goal-to-done/DECISIONS.md', '2cde864b0e2210c70bc2ffcdf1533e10d43e828119e686ac4c13a96480f483f4', '9141c3a16a337b87773cb50aad8421afd13aebf718b6bd7e2da5e910fcdceaae', [
(0,0,r'''# Forward evidence calibration / 2026-09-17

The inspected first forward window justifies correcting pooled-outlier transfer, absent execution calibration and repeated exposure, not claiming a profitable successor. Use `research/FORWARD_EVIDENCE_REPAIR.md` as current specification. Separate algorithm `evidence-calibration-v1.1` from unchanged storage schema `forward-relations-v1.0`; preserve account/ledger and immutable original trade rules. Actual closed-PAPER outcomes influence NEW decisions; calibration never rewrites settled PnL. No shadow promotion, no loss-triggered direction reversal, no generated-rule LIVE bridge, no new network data dependency or D1 writes. Larger archive packets split into numbered parts in the same atomic write. Old UI-only byte freezes for the two explicitly modified PAPER modules are replaced by semantic/continuity tests; all Worker/LIVE/auth/canonical/deploy checks stay intact.

'''),
])

edit('.codex/goal-to-done/GOAL.md', 'a0ecd5b3a04e9f0553a25b54d8e64dc8e5a6b4160da172424256da91e7a8ae6c', 'b51a64d640339f060fd0a47973c7c8db9179f382ec2fc5f61d09b52c5ba84f05', [
(0,0,r'''# Active correction — forward evidence and execution feedback / 2026-09-17

User explicitly authorizes thinking through defects/side effects, then implementing and deploying a targeted PAPER repair. Scope and acceptance: `research/FORWARD_EVIDENCE_REPAIR.md`. Do not turn off all15-minute trading, blacklist volatile coins, revive old failed strategies or promise monthly doubling. Preserve old losses/account identity/learning and original open-position protection; LIVE and authentication authority remain unchanged.

'''),
])

edit('.codex/goal-to-done/STATUS.md', '963b465315b921ab48ffc2d9adf9e74c92bc27f280ce84d411a61a30329a08b4', '354b18d4978ce6fa353c430783ca8053dbbc4a540d0e7547cdd651ccdfddc72c', [
(0,0,r'''# Evidence calibration candidate / 2026-09-17

Implemented bounded cross-asset influence checks, separate own-symbol applicability, actual closed-PAPER forecast-error calibration, unchanged-evidence deduplication, repeated/correlated risk budget, marked-cost-aware sizing and non-reset policy upgrade. Native dark UI exposes scope, rejection reasons and upgrade baseline. See `research/FORWARD_EVIDENCE_REPAIR.md` for explicit drawbacks and limits. Functional tests and exact-head CI/production receipt determine release completion; this entry itself is not a deployment or profitability claim.

'''),
])

edit('AGENTS.md', 'a5ffb338b5d5778656c43dbe359bc9c941939d99bae1ccc6d2147e0e7de26242', '8fca8c81f161729d62b0ae6cabdab3168ac09800ac14ca23de58a9a14b1b4271', [
(0,0,r'''# Current correction authority — 2026-09-17

The user authorizes the targeted PAPER evidence/calibration repair in `research/FORWARD_EVIDENCE_REPAIR.md` and direct main deployment after verification. `lib/forward-evidence.ts` supplies bounded learning controls, not LIVE authority. Preserve the v1 storage prefix/schema and all financial records; version algorithm changes separately. Keep Worker, LIVE/auth/credentials and established deployment path unchanged. Read newest goal/status/decisions before historical instructions.

'''),
])

edit('README.md', '552813a295f0327ef82e2f78ec064d13f4a8e4fb55a5107cd48f1247d7420f8c', '988dbe3a33e7b4f211d628e4d8b092891b29def20077fac9e9da97abe45b9eaa', [
(0,0,r'''# 当前算法修正：关系证据与成交校准 v1.1

算法标识 `evidence-calibration-v1.1`，持久化格式仍为 `forward-relations-v1.0`。**沿用原账户、亏损、学习记录和持仓，不重置成1,000U。** 月复利翻倍仍是尚未验证的目标，新规则仍只执行PAPER。

跨币规则增加单币影响限制与逐币剔除复核，并检查当前币是否有适用证据；自身持续有效的单币关系只用于自身。实际已平仓模拟净收益按同一时间组校准预测误差，近似阈值/版本变化不能清掉失败记录；反馈有收缩和时间衰减，不使用连胜晋级。新开仓按剩余净优势与不确定性分配风险，保留原总额度，增加同向同期限3%风险桶、同关系周期去重、碎片仓位跳过及入场前价格偏移检查。规则原始止损不因后续学习而放宽。

`/api/runtime.forward`新增 `policyVersion`、`policyUpgrade`、`evidenceDiagnostics`、`entryDiagnostics` 和 `feedbackCount`。规则的 `evidence`显示适用市场、独立时间组、校准扣减及证据摘要；这些不是胜率。完整成交反馈在不可变归档中，正常快照仍是滚动样本。极大归档批次使用 `archivePart`/`archiveParts`分片；使用原有`nextCursor`读取所有页并按时间与revision归组，不遗漏后续part。

权衡、初始算法常量、验收与局限见 `research/FORWARD_EVIDENCE_REPAIR.md`。修正会减少错误的跨币推广和重复风险，**也可能减少交易、错过机会或继续亏损；功能测试不等于盈利证明。** 数据源、Worker调用节奏、D1、实盘开关及权限未改变。

---

'''),
])

edit('app/forward-dashboard.tsx', 'd9ce534c360e05060e83716b9e4f3caebbe48b39ab41bb6919af2db5ae36b70d', '432cb5b1cf54d8ee79729ad3d2250801735f7728fb7c667bdcf513a1d6cb2044', [
(28,29,r'''      <section className="fr-hero"><div className="fr-hero-copy"><span className="fr-kicker">市场在变化，规则随证据更新</span><h1>{title}</h1><p>{data?.latestReason??"读取已持久化的账户、规则和观测记录；连接前不显示虚构成交或收益。"}</p><div className="fr-hero-tags"><span>前向运行 {elapsed==null?"—":fmt(elapsed,1)} 小时</span><span>{data?.policyVersion??"读取算法版本"}</span><span>新规则仅模拟</span></div></div>
'''),
(44,44,r'''      <section className="fr-section"><div className="fr-section-head"><h2>关系与成交校准</h2><span>不是胜率</span></div><div className="fr-three"><div><small>单币集中度拒绝</small><b>{fmt(data?.evidenceDiagnostics?.concentrationRejected,0)}</b></div><div><small>成交偏差拒绝</small><b>{fmt(data?.evidenceDiagnostics?.calibrationRejected,0)}</b></div><div><small>保留的已平仓反馈</small><b>{fmt(data?.feedbackCount,0)}</b></div></div><p className="fr-note">跨币关系需要逐币剔除复核；单币关系只用于自身。同一时间的多币交易合并校准，不把复制订单当成独立证据。过去的失败逐渐减重，市场观测不中断。</p>{data?.policyUpgrade&&<p className="fr-note">升级时间 {time(data.policyUpgrade.at)} · 当时净值 {fmt(data.policyUpgrade.equity)} U{data.policyUpgrade.stalePositions?"（含最近估值，非同步结算）":""}。原账户、亏损和持仓保留，不重新从1,000 U计成绩。</p>}</section>
'''),
(56,57,r'''      <section className="fr-section"><Setting title="当前主系统" value={data?.policyVersion??data?.version??"读取中"} text="旧策略已停止新开仓；已有旧仓位、历史账户、凭据与保护逻辑保留。"/><Setting title="月度研究目标" value="本金 × 2" text="以新账户实际净值检验，含浮动盈亏和成本。允许未达标，不制造成功记录。"/><Setting title="规则自动适应" value="在线运行" text="每5分钟整理新观测，按新完成的反应更新规则。固定语法不是无限自编程；需要新增表达能力时再进行受测的软件更新。"/><Setting title="执行权限" value="仅模拟" text="新生成规则与Gate下单路径物理分开，实盘开关不会因登录、部署或学习结果而开启。"/><Setting title="初始实验风险预算" value="权益随动" text={data?.boundaries.risk??"读取中"}/><Setting title="成本口径" value="显式假设" text={data?.cost.assumption??"读取中"}/><Setting title="连续性" value="持久化" text="重启恢复学习状态和账户。写入失败不提交新订单，不重置本金掩盖亏损。"/></section>
'''),
(70,71,r'''function RuleCard({rule:r}:{rule:Rule}){return<article className="fr-rule"><header><span>{r.horizon}分钟反应 · v{r.version}</span><b className={r.side==="LONG"?"fr-positive":"fr-negative"}>{r.side==="LONG"?"做多":"做空"}</b></header><h3>{condition(r)}</h3><p>{r.reason}</p>{r.evidence&&<p className="fr-note">{r.evidence.scope==="SINGLE_ASSET"?"仅限本币":"有适用证据的市场"}：{r.evidence.symbols.join("、")}。成交偏差扣减 {fmt(r.evidence.calibration.penalty*100,3)} 个百分点；无足够反馈不等于盈利已验证。</p>}<div className="fr-rule-numbers"><div><small>校准后净反应估计</small><b>{signed(r.estimatedNetRate*100,3)}%</b></div><div><small>已见市场样本</small><b>{r.samples}</b></div><div><small>生成止损距离</small><b>{fmt(r.stopRate*100)}%</b></div></div><footer><span>{r.status==="EXPERIMENTAL"?"前向实验中":"已休眠 / 被替代"}</span><span>{time(r.createdAt)}</span></footer></article>;}
'''),
(74,75,r'''function Journal({data,limit}:{data:View|null;limit:number}){const events=data?.events.slice(0,limit)??[];const names={START:"启动",RULE:"生成 / 修订",DORMANT:"休眠",ENTRY:"模拟开仓",EXIT:"模拟平仓",PROTECTION:"保护更新",DATA_GAP:"样本作废",FIT:"关系检查",UPGRADE:"连续升级"};return events.length?<div className="fr-journal">{events.map(e=><article key={e.id}><time>{time(e.at)}</time><div><b>{names[e.kind]}</b><p>{e.reason}</p></div></article>)}</div>:<Empty title="等待第一条运行记录" text="记录由后台实际事件产生，不预置成功示例。"/>;}
'''),
])

edit('lib/forward-store.ts', 'f6aa999e31e0fa8c14b86603c68efb976045a319743981197193da8b3808958b', '434ca376673904aea5d0754abd1aa3a9aa4f9770f5242909ef97c1c7c47d9dd0', [
(30,32,r'''  const archiveKey=`${FORWARD_STORAGE}archive:${String(now).padStart(16,"0")}:${next.revision}`;
  const packet={
    at:now,version:FORWARD_VERSION,policyVersion:next.policyVersion,policyUpgrade:next.policyUpgrade,
    startedAt:next.startedAt,revision:next.revision,events,
    evidenceDiagnostics:next.evidenceDiagnostics,entryDiagnostics:next.entryDiagnostics,
    feedback:next.feedback?.filter(f=>!(previous?.feedback??[]).some(p=>p.id===f.id))??[],
'''),
(38,38,r'''  const encodedSize=(v:unknown)=>new TextEncoder().encode(JSON.stringify(v)).length;
  if(encodedSize(packet)<=112*1024)entries[archiveKey]=packet;
  else {
    // Large simultaneous label/exit/upgrade batches must not stall protective
    // commits. Split the ARCHIVE packet only; never split the atomic account
    // transaction or drop events. Existing paging traverses every part.
    const fields=["events","measurements","rules","trades","feedback"] as const;
    const header:Record<string,unknown>={...packet};for(const field of fields)delete header[field];
    const parts:Record<string,unknown>[]=[];let part:Record<string,unknown>={...header};
    for(const field of fields)for(const item of packet[field]){
      const prev=(part[field]??[]) as unknown[],trial={...part,[field]:[...prev,item]};
      if(encodedSize(trial)>112*1024){
        parts.push(part);part={at:now,version:FORWARD_VERSION,policyVersion:next.policyVersion,
          startedAt:next.startedAt,revision:next.revision,[field]:[item]};
        if(encodedSize(part)>112*1024)throw new Error("单项前向证据超出归档预算，拒绝截断");
      }else part=trial;
    }
    parts.push(part);
    for(let i=0;i<parts.length;i++)entries[i?`${archiveKey}:part:${String(i).padStart(2,"0")}`:archiveKey]={
      ...parts[i],archivePart:i,archiveParts:parts.length};
  }
'''),
])

edit('package.json', 'f426549ab1442f35fd117d6409a2f2b14999be11cdd6164767f3ddade988b871', 'e5464dc8704b92a66637d72c8ec59a0360f2dcbe8978bec6aa94e74ac49ddd07', [
(17,18,r'''    "test:direct": "node --experimental-strip-types --test tests/extreme-sequence-mirror.test.ts tests/adaptive-policy.test.ts tests/liquidity-core.test.ts tests/market-radar.test.ts tests/market-regime.test.ts tests/all-regime-engine.test.ts tests/previous-all-regime-engine.test.ts tests/arena-live.test.ts tests/dual-paper.test.ts tests/regime-portfolio.test.ts tests/rejection-audit.test.ts tests/reaction-lab.test.ts tests/outcome-research.test.ts tests/strategy-arena.test.ts tests/previous-strategy-arena.test.ts tests/strategy-coverage.test.ts tests/paper-cycle.test.ts tests/gate-market.test.ts tests/runtime-health.test.ts tests/runtime-faults.test.ts tests/credential-vault.test.ts tests/owner-auth.test.ts tests/gate-live.test.ts tests/position-metrics.test.ts tests/forward-relations.test.ts tests/operator-ui.test.ts tests/forward-evidence.test.ts",
'''),
(22,23,r'''    "test:forward": "node --experimental-strip-types --test tests/forward-relations.test.ts tests/forward-evidence.test.ts",
'''),
])

edit('tests/forward-relations.test.ts', 'fabbeee55e865a581929220f17720fc689057b0272b482a3ea6d27f4576a6a1f', 'c801dfd3488837f67216a3222e8f29a07d96c11878ac72ae4bce0270aa38b858', [
(6,6,r'''import { EVIDENCE_POLICY, familyKey } from "../lib/forward-evidence.ts";
'''),
(13,14,r'''function rule(now:number):Rule{const r:Rule={id:"fr-test",signature:"test",parentId:null,version:1,createdAt:now-1000,expiresAt:now+DAY,
'''),
(16,17,r'''  reason:"synthetic functional fixture, never a market result",mutation:"CREATE",grammar:"test",liveEligible:false};
  r.evidence={policy:EVIDENCE_POLICY,scope:"CROSS_ASSET",symbols:["BTC_USDT"],sourceKey:"fixture",family:familyKey(r),cap:.03,
    rawNet:.01,costRate:.0022,quality:1,worstWithoutSymbol:.02,
    calibration:{groups:0,effectiveGroups:0,penalty:0,meanResidual:0,meanNet:0,latestAt:0,sourceKey:"fixture"}};return r;}
'''),
])

edit('tests/operator-ui.test.ts', 'b67ba763a1ad4e335931e401643696e96ca688e9993807e9b31bc79ecc97e3ea', 'ff87b7adf22030466c0869d8fb9101a551668c88986b75b297601abe2c151daf', [
(46,47,r'''test("Worker, LIVE execution, authentication and deployment remain byte-identical to the UI release",()=>{
'''),
])

edit('tests/ui-authority-baseline.json', 'ae7e6ab388faf11e9e182ac3271b8ff8dd0775fe23a67cba4c60ec55b354c4d7', '0e86d24756ce162d7b3ebaac1001f389bbbad360fc57beeb785db2f427db4f41', [
(2,4,r''''''),
])
