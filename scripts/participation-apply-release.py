from pathlib import Path
import hashlib

def edit(path, before, after, edits):
    p=Path(path);raw=p.read_bytes() if p.exists() else b""
    assert hashlib.sha256(raw).hexdigest()==before, f"Base mismatch: {path}"
    lines=raw.decode().splitlines(keepends=True)
    for a,b,text in reversed(edits):lines[a:b]=[text]
    out="".join(lines).encode()
    assert hashlib.sha256(out).hexdigest()==after, f"Target mismatch: {path}"
    p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(out)
    print("Verified",path,after)

edit('.codex/goal-to-done/DECISIONS.md', '9141c3a16a337b87773cb50aad8421afd13aebf718b6bd7e2da5e910fcdceaae', 'd769ff40f3a6e1393a5d4b4562af727116c66ab890843e58a66efa745b7047ef', [
(0, 0, r'''# Participation-first targeted repair — 2026-09-17

The user explicitly retains the active first-forward version as a useful baseline. Replace v1.1 universal concentration/individual-positive/feedback vetoes with visible confidence and bounded risk scoring; this knowingly retains uncertain PAPER hypotheses, not proven edges. Keep raw-after-modeled-cost discovery, execution safety and total/individual risk caps. Correct missed-quote timing and cost-inconsistent giveback separately. Full account remains continuous; preserve previous upgrade boundary. Details and tradeoffs in `research/FORWARD_PARTICIPATION_REPAIR.md`.

'''),
])

edit('.codex/goal-to-done/GOAL.md', 'b51a64d640339f060fd0a47973c7c8db9179f382ec2fc5f61d09b52c5ba84f05', '062bdd2b8151cca96e88edcb8e16cb62176fd470258c43019d0b78658f557412', [
(0, 0, r'''# Active participation correction — 2026-09-17

Preserve the user-approved active forward system's candidate breadth while correcting execution timing and cost geometry. Do not improve loss statistics by eliminating participation. Implement only the documented changes in `research/FORWARD_PARTICIPATION_REPAIR.md`; authorize reviewed-main deployment after tests and check actual production. No forced trades, shadow promotion, account reset, LIVE bridge or switch action.

'''),
])

edit('.codex/goal-to-done/STATUS.md', '354b18d4978ce6fa353c430783ca8053dbbc4a540d0e7547cdd651ccdfddc72c', 'dd67e1a772f085f5cfee92ea91616cfe52340523416fcb6570a86c01a053cbd1', [
(0, 0, r'''# Participation repair candidate — 2026-09-17

49-recorded-cutoff diagnostic retains526of528active-baseline hypotheses, versus10for strictv1.1; not fills or profit. Implemented bounded quote retry, cost-aware new-rule giveback, hypothesis/confidence separation, shared existing capital and non-reset v1.2 migration.354direct tests including78forward tests pass locally. Build/type/lint/dry-run and actual production receipt determine completion; this heading is not a deployment claim.

'''),
])

edit('AGENTS.md', '8fca8c81f161729d62b0ae6cabdab3168ac09800ac14ca23de58a9a14b1b4271', '9ef00e3336912cebf058f7168cf54739f5f0a680e2f3996aa80864fcc2921712', [
(0, 0, r'''# Current participation authority — 2026-09-17

The user authorizes restoring the active forward baseline's opportunity breadth with targeted execution/cost corrections. Current specification: `research/FORWARD_PARTICIPATION_REPAIR.md`. Reject no-trade-as-success. Keep PAPER-only authority, continuous accounts/losses, original position geometry, owner LIVE intent, native dark UI, existing Worker and deployment paths. Algorithm marker is participation-execution-v1.2; storage schema stays v1.0. Earlier v1.1 hard-unanimity gates below are superseded only as documented.

'''),
])

edit('README.md', '988dbe3a33e7b4f211d628e4d8b092891b29def20077fac9e9da97abe45b9eaa', '8f89993c7678dec466aab91c7b4af13f6761bf570887b6ba2282292dcf29c4d9', [
(0, 0, r'''# Current policy: participation-execution-v1.2

当前恢复活跃版的机会发现广度；证据集中度和实际成交偏差用于提示、排序和有限风险缩放，不再层层否决到只剩单币。跨币规则明确是待验证假设，不是已证明的优势；原始估计、稳健估计和成交校准后估计分别显示。

报价暂缺的已触发信号在当前5分钟K线剩余窗口内按既有10秒回调重试；过期作废，使用当前价、计成本，不补历史成交。同币同根K线不重复，之后的新完整K线可提供新机会。当前可执行标的共享原有风险/名义额/保证金预算；未提高1.5%单笔、10%总风险、6.5%同向和4倍总名义额上限。新增规则的回吐保护边界考虑费用，旧仓位不改。

账户、样本、亏损、历史、实盘权限全部保留，不重新冷启动。规则仍仅模拟；LIVE不会自动启用。新增机会/重试/实际开仓计数，不能把匹配当成交。354项直接测试包括78项前向测试；机会保留率检查不是盈利回测。实现、结果与副作用见 `research/FORWARD_PARTICIPATION_REPAIR.md`。

以下旧说明中的逐币正收益门槛和同向同期限3%门槛已被本策略覆盖；费用模型、数据连续性和执行隔离仍有效。

'''),
])

edit('app/forward-dashboard.tsx', '432cb5b1cf54d8ee79729ad3d2250801735f7728fb7c667bdcf513a1d6cb2044', '3d65876ecd226c3403dc1217404e4c6643f2aa466f773fbd90f50f4506086d4c', [
(36, 36, r'''      <section className="fr-section"><div className="fr-section-head"><h2>机会与执行</h2><span>本次算法升级后</span></div><div className="fr-three"><div><small>匹配次数（非订单）</small><b>{fmt(data?.participation?.matches,0)}</b></div><div><small>当前等待报价</small><b>{fmt(data?.quoteRetries?.length,0)}</b></div><div><small>新开仓 / 重试成交</small><b>{fmt(data?.participation?.opened,0)} / {fmt(data?.participation?.retryFills,0)}</b></div></div><p className="fr-note">报价暂缺会在当前5分钟信号剩余窗口内重试；超时作废，不补成交，不设强制交易数。同一币同一根K线不重复开仓。</p></section>
'''),
(44, 45, r'''      <section className="fr-section"><div className="fr-section-head"><h2>关系与成交校准</h2><span>不是胜率</span></div><div className="fr-three"><div><small>单币集中度提示</small><b>{fmt(data?.evidenceDiagnostics?.concentrationWarnings,0)}</b></div><div><small>成交偏差提示</small><b>{fmt(data?.evidenceDiagnostics?.calibrationWarnings,0)}</b></div><div><small>保留的已平仓反馈</small><b>{fmt(data?.feedbackCount,0)}</b></div></div><p className="fr-note">跨币候选是待验证交易假设，不再要求每个币都先独立盈利。集中度、稳健估计和已平仓偏差用于排序与风险，证据不足不伪装成已证明优势。单币规则仍只用于自身。</p>{data?.policyUpgrade&&<p className="fr-note">升级时间 {time(data.policyUpgrade.at)} · 当时净值 {fmt(data.policyUpgrade.equity)} U{data.policyUpgrade.stalePositions?"（含最近估值，非同步结算）":""}。原账户、亏损和持仓保留，不重新从1,000 U计成绩。</p>}</section>
'''),
(58, 59, r'''      <section className="fr-section"><div className="fr-section-head"><div><h2>所有者与实盘管理</h2><p>实盘账户、API和开关已整合到新版实盘页，沿用原有所有者权限。</p></div></div><button className="fr-button" onClick={()=>select("live")}>打开实盘控制台 ↗</button><p className="fr-note">历史账户记录保留在后台；算法升级不重置账户或学习状态，实盘仍由所有者控制。</p></section></>}
'''),
(71, 72, r'''function RuleCard({rule:r}:{rule:Rule}){return<article className="fr-rule"><header><span>{r.horizon}分钟反应 · v{r.version}</span><b className={r.side==="LONG"?"fr-positive":"fr-negative"}>{r.side==="LONG"?"做多":"做空"}</b></header><h3>{condition(r)}</h3><p>{r.reason}</p>{r.evidence&&<p className="fr-note">{r.evidence.scope==="SINGLE_ASSET"?"仅限本币":"跨币实验范围（尚未证明通用）"}：{r.evidence.symbols.slice(0,6).join("、")}{r.evidence.symbols.length>6?` 等${r.evidence.symbols.length}个已观测标的`:""}。稳健估计 {signed(r.evidence.boundedNet==null?null:r.evidence.boundedNet*100,3)}%，成交校准后 {signed((r.evidence.calibratedNet??r.estimatedNetRate)*100,3)}%。这些估计可能为负；保留实验不等于承诺盈利。</p>}{r.evidence?.warnings?.length?<p className="fr-note">{r.evidence.warnings.join("；")}</p>:null}<div className="fr-rule-numbers"><div><small>原始净反应假设</small><b>{signed(r.estimatedNetRate*100,3)}%</b></div><div><small>已见市场样本</small><b>{r.samples}</b></div><div><small>生成止损距离</small><b>{fmt(r.stopRate*100)}%</b></div></div><footer><span>{r.status==="EXPERIMENTAL"?"前向实验中":"已休眠 / 被替代"}</span><span>{time(r.createdAt)}</span></footer></article>;}
'''),
])

edit('lib/forward-evidence.ts', 'd97207cfb0994cd499e1e1480c5ad8613ab31b52b6593333372015a6df169c3b', 'd586dbee7ada97df8948c830a9ffe8582f11e85ebb3376a45235e90c8fdc3ca3', [
(6, 7, r'''export const EVIDENCE_POLICY = "participation-execution-v1.2";
export const PREVIOUS_POLICY = "evidence-calibration-v1.1";
'''),
(27, 28, r'''  worstWithoutSymbol:number|null; calibration:Calibration;
  boundedNet?:number; calibratedNet?:number; uncertain?:boolean; warnings?:string[] };
'''),
(33, 34, r'''  concentrationRejected:number; calibrationRejected:number; applicabilityRejected:number; expired:number;
  concentrationWarnings?:number; calibrationWarnings?:number };
'''),
(35, 36, r'''  concentrationRejected:0,calibrationRejected:0,applicabilityRejected:0,expired:0,concentrationWarnings:0,calibrationWarnings:0}; }
'''),
(88, 88, r'''// Discovery and confidence are distinct. The raw estimate reproduces the
// active baseline's hypothesis test; it is NOT a confidence bound or proof of
// transferable edge. Bounded statistics below score how much to trust it.
export function evidenceQuality(rawNet:number,boundedNet:number,se:number,cost:number,penalty:number) {
  return .5 + .5 * clip((Math.min(rawNet,boundedNet)-penalty)/(cost+se),0,1);
}
export function costAwareGiveback(armRate:number,givebackRate:number,cost:number) {
  return Math.min(givebackRate,Math.max(0,armRate-cost*1.25));
}
'''),
(97, 98, r'''  const initial=stats(train,1,Infinity),sign=initial.mean>=0?1:-1;
  const a=stats(train,sign,Infinity),b=stats(check,sign,Infinity);
  const boundedA=stats(train,sign,cap),boundedB=stats(check,sign,cap);
'''),
(100, 102, r'''  const se=.5*Math.max(a.se,b.se),cost=modeledCost(horizon);
  const rawNet=Math.min(a.mean,b.mean)-cost-se;
  if(!(rawNet>0)){diagnostics.costRejected++;return null;}
  const boundedNet=Math.min(boundedA.mean,boundedB.mean)-cost-.5*Math.max(boundedA.se,boundedB.se);
  let worstWithoutSymbol:number|null=null;
  const warnings:string[]=[];
'''),
(104, 107, r'''    // Sensitivity is retained as evidence, not a chain of unanimity vetoes.
    // Unknown transferability is explicitly an experimental pooled hypothesis.
'''),
(111, 114, r'''    const worst=Math.min(...leave);worstWithoutSymbol=Number.isFinite(worst)?worst:null;
    if(worst-cost-se<=0){diagnostics.concentrationWarnings=(diagnostics.concentrationWarnings??0)+1;warnings.push("跨币反应依赖少数样本，作为待验证假设而非通用优势");}
'''),
(115, 121, r'''  const applicable=scopeSymbol?[scopeSymbol]:[...new Set(ordered.map(r=>r.symbol))].sort();
'''),
(124, 125, r'''  if(net<=0){diagnostics.calibrationWarnings=(diagnostics.calibrationWarnings??0)+1;warnings.push("实际成交校准为非正，保留实验候选但降低排序与风险，不标作已证实盈利");}
  if(boundedNet<=0)warnings.push("稳健估计尚未支持成本后优势");
'''),
(127, 128, r'''  const givebackRate=costAwareGiveback(armRate,clip(q(selected.map((r,i)=>Math.max(0,favorable[i]-sign*r.response)),.6),.0025,Math.max(.0025,armRate*.8)),cost);
'''),
(129, 130, r'''  const sourceKey=evidenceHash(JSON.stringify([scopeSymbol??"CROSS",applicable,conditions,selected.map(r=>[r.symbol,r.at,r.response,r.up,r.down]),calibration.sourceKey]));
'''),
(132, 133, r'''    trainGroups:a.groups,checkGroups:b.groups,estimatedNetRate:rawNet,priorResponse:sign*a.mean,recentResponse:sign*b.mean,standardError:se,
'''),
(134, 135, r'''      rawNet,boundedNet,calibratedNet:net,uncertain:warnings.length>0,warnings,costRate:cost,
      quality:evidenceQuality(rawNet,boundedNet,se,cost,calibration.penalty),worstWithoutSymbol,calibration}};
'''),
(143, 144, r'''  return {remaining,contextInvalid,quality:remaining>0?.5+.5*clip(remaining/(cost+r.standardError),0,1):0};
'''),
])

edit('lib/forward-relations.ts', '91d751571695e1c9a003c90b15b8e7dba015c0bf0a62f97d68c3bd0e6c84011e', 'e7181351e844cc1207724f7958f0a035fbc47333766aa362cfeef6826adae68f', [
(4, 5, r'''import { EVIDENCE_POLICY, PREVIOUS_POLICY, blankDiagnostics, collectFeedback, entryEconomics, executionCalibration, evidenceQuality, familyKey, inspectCondition,
'''),
(35, 36, r'''    calibratedNetRate:number; remainingNetRate:number; quality:number; sizingEquity?:number } };
'''),
(39, 39, r'''export type QuoteRetry = { symbol:string; ruleId:string; signalAt:number; expiresAt:number; firstAt:number };
'''),
(48, 49, r'''  entryDiagnostics?:{at:number;matched:number;opened:number;reasons:Record<string,number>;retry?:boolean;queued?:number};
  quoteRetries?:QuoteRetry[];
  participation?:{since:number;cycles:number;matches:number;quoteWaits:number;retryChecks:number;retryFills:number;opened:number};
  policyUpgrades?:NonNullable<ForwardState["policyUpgrade"]>[];
'''),
(74, 75, r'''  if(v.policyVersion&&![EVIDENCE_POLICY,PREVIOUS_POLICY].includes(v.policyVersion))throw new Error("未知前向算法版本，拒绝降级或重置");
'''),
(95, 96, r'''  const rank=(a:Candidate,b:Candidate)=>b.estimatedNetRate-a.estimatedNetRate;
'''),
(153, 155, r'''    const scope=c.evidence.scope==="SINGLE_ASSET"?`仅${c.evidence.symbols[0]}`:`已观测${c.evidence.symbols.length}币的跨币实验，适用性尚待成交验证`;
    const reason=`${text} 后${c.horizon}分钟${scope}；${c.side==="LONG"?"多":"空"}向原始净反应假设${(c.estimatedNetRate*100).toFixed(3)}%，成交校准后${((c.evidence.calibratedNet??c.estimatedNetRate)*100).toFixed(3)}%。${c.evidence.uncertain?"证据不确定，降低排序/风险而不假装已证明通用优势。":""}退出采用${c.exitMode==="REACTION_DECAY"?"回吐保护":"反应期限"}；不是胜率或盈利保证。`;
'''),
(164, 166, r'''  s.latestReason=active?`${active}条交易假设；集中度和成交偏差用于排序/风险，报价暂缺在本根5分钟窗口内重试。未证明盈利。`
    :`当前未形成满足原始成本后估计的交易假设；检查${diagnostics.tested}项表达。不是冷启动或停机，不强制开单。`;
'''),
(210, 211, r'''  s.lastEntryBars[t.symbol]=Math.max(s.lastEntryBars[t.symbol]??0,s.frames[t.symbol]?.at??0,Math.floor(now/BAR_MS)*BAR_MS);
'''),
(227, 228, r'''function openTrades(s:ForwardState,quotes:Record<string,Quote>,contracts:Record<string,Contract>,now:number,retry=false){
  const waiting=s.quoteRetries??[];
'''),
(229, 233, r'''    &&f.at>=s.startedAt&&now-f.at<BAR_MS&&conditionMatches(f.x,r.conditions)
    &&(!retry||waiting.some(w=>w.ruleId===r.id&&w.symbol===f.symbol&&w.signalAt===f.at&&w.expiresAt>now)))
    .map(r=>({f,r}))).sort((a,b)=>(b.r.evidence?.quality??0)-(a.r.evidence?.quality??0)
      ||b.r.estimatedNetRate-a.r.estimatedNetRate||a.f.symbol.localeCompare(b.f.symbol));
  let blocker="";const diagnostics={at:now,matched:candidates.length,opened:0,reasons:{} as Record<string,number>,retry,queued:0};
  s.entryDiagnostics=diagnostics;s.relationEntries??={};s.quoteRetries=[];
  s.participation??={since:now,cycles:0,matches:0,quoteWaits:0,retryChecks:0,retryFills:0,opened:0};
  if(retry)s.participation.retryChecks++;else{s.participation.cycles++;s.participation.matches+=candidates.length;}
'''),
(234, 234, r'''  const readySymbols=(side:Trade["side"])=>new Set(candidates.filter(({f,r})=>r.side===side&&ruleApplies(r,f.symbol)
    &&!s.positions.some(t=>t.symbol===f.symbol)&&(s.lastEntryBars[f.symbol]??0)<f.at
    &&freshQuote(quotes[f.symbol],now)&&quotes[f.symbol].entryReady!==false).map(({f})=>f.symbol)).size;
'''),
(236, 237, r'''    if(!ruleApplies(r,f.symbol)){reject("规则为本币专用或当前币不在已观测样本范围内");continue;}
'''),
(238, 240, r'''    // A completed observation, not the whole holding horizon, is the repeat
    // unit. Same-bar entries cannot be duplicated by changing rule versions.
    const q=quotes[f.symbol],meta=contracts[f.symbol];
    if(!freshQuote(q,now)||q.entryReady===false){
      reject("等待新鲜盘口；在当前5分钟信号窗口内重试，不补过去成交");
      s.quoteRetries.push({symbol:f.symbol,ruleId:r.id,signalAt:f.at,expiresAt:f.at+BAR_MS,
        firstAt:waiting.find(w=>w.symbol===f.symbol&&w.ruleId===r.id&&w.signalAt===f.at)?.firstAt??now});
      if(!retry)s.participation.quoteWaits++;continue;
    }
'''),
(246, 247, r''''''),
(248, 249, r'''    // Discovery's raw positive-cost hypothesis is NOT a validated edge. The
    // bounded/calibrated estimate scores risk. Midpoint progression avoids
    // subtracting the entry slippage twice: it is in modeled cost already.
    const economics=entryEconomics(r,f.price,(q.bestBid+q.bestAsk)/2,spread);
'''),
(252, 256, r'''    const quality=Math.min(r.evidence!.quality,economics.quality,evidenceQuality(r.evidence!.rawNet,
      r.evidence!.boundedNet??r.evidence!.rawNet,r.standardError,r.evidence!.costRate,calibration.penalty));
    // Share existing capacity across simultaneously executable opportunities.
    // No new 3%-per-horizon veto; total and directional risk limits stay intact.
    const peers=Math.max(1,readySymbols(r.side));
    const targetRisk=Math.min(equity*.015*quality,Math.max(0,equity*.065-same)/peers);
'''),
(257, 258, r'''    const desired=Math.min(equity*1.5,targetRisk/lossRate,Math.max(0,equity*4-gross)/peers);
'''),
(260, 262, r''''''),
(265, 268, r'''      (equity*.065-same)/(lossRate+.065*immediateCost)));
    if(wanted<equity*.05||wanted<desired*.25){reject("账户可用风险预算或有效仓位不足，不填碎片订单");continue;}
'''),
(271, 273, r'''    const usedMargin=s.positions.reduce((a,t)=>a+t.margin,0),markedAfter=equity-notional*immediateCost;
    const marginTarget=Math.min(equity*.2,Math.max(0,markedAfter*.75-usedMargin)/peers);
    if(!(marginTarget>0)){reject("模拟可用保证金不足");continue;}
    // More names share margin as well as stop risk. Leverage only changes
    // reserved margin here; neither notional nor planned loss is increased.
    const leverage=Math.max(1,Math.min(meta.leverageMax,Math.ceil(notional/marginTarget),Math.floor(.8/(r.stopRate+meta.maintenanceRate+COST_FLOOR)))),margin=notional/leverage;
    if(usedMargin+margin>markedAfter*.75){reject("模拟可用保证金不足");continue;}
'''),
(278, 280, r'''      forecast:{policy:EVIDENCE_POLICY,family,signalAt:f.at,signalPrice:f.price,baseNetRate:economics.remaining,
        calibratedNetRate:calibratedNet,remainingNetRate:economics.remaining,quality,sizingEquity:equity-notional*immediateCost}};
'''),
(281, 284, r'''    s.relationEntries[episodeKey]=f.at+BAR_MS;diagnostics.opened++;s.participation.opened++;
    if(retry)s.participation.retryFills++;
    event(s,now,"ENTRY",t.id,`${f.symbol}按实验假设${r.id}使用新鲜买卖价模拟成交；不是Gate实盘成交。`,
      {ruleId:r.id,notional,contracts:count,remainingNet:economics.remaining,calibrationPenalty:calibration.penalty,quality,quoteRetry:Number(retry)});
'''),
(286, 287, r'''  s.quoteRetries=[...new Map(s.quoteRetries.map(w=>[`${w.symbol}:${w.ruleId}:${w.signalAt}`,w])).values()].slice(0,90);
  diagnostics.queued=s.quoteRetries.length;
  if(diagnostics.opened)s.latestReason=`本轮${retry?"报价重试后":""}模拟开仓${diagnostics.opened}笔；管理${s.positions.length}笔持仓。`;
  else if(blocker)s.latestReason=blocker;else if(s.positions.length)s.latestReason=`管理${s.positions.length}笔前向模拟持仓；原始保护止损不会放宽。`;
'''),
(292, 293, r'''    if(s.policyVersion&&s.policyVersion!==PREVIOUS_POLICY)throw new Error("未知算法版本，禁止自动覆盖");
'''),
(294, 295, r'''    if(s.policyUpgrade)s.policyUpgrades=[...(s.policyUpgrades??[]),s.policyUpgrade].slice(-16);
    s.policyUpgrade={at:now,from:s.policyVersion??"legacy-forward-v1.0",to:EVIDENCE_POLICY,equity:mark.equity,stalePositions:mark.stalePositions,
'''),
(297, 297, r'''    s.quoteRetries=[];s.participation={since:now,cycles:0,matches:0,quoteWaits:0,retryChecks:0,retryFills:0,opened:0};
'''),
(300, 301, r'''    event(s,now,"UPGRADE",EVIDENCE_POLICY,"恢复广度与及时执行：证据疑问用于排序/风险，报价短窗重试，新增规则回吐边界考虑费用；账户、亏损、历史和原持仓保护保持连续。",
'''),
(310, 311, r'''  if(dataDue)openTrades(s,quotes,contracts,now);
  else if(s.quoteRetries?.some(w=>w.expiresAt>now))openTrades(s,quotes,contracts,now,true);
  else s.quoteRetries=[];
  const marked=forwardEquity(s,quotes,now);
'''),
(322, 323, r'''    policyVersion:s.policyVersion??"legacy-forward-v1.0",policyUpgrade:s.policyUpgrade??null,policyUpgrades:s.policyUpgrades??[],
    participation:s.participation??null,quoteRetries:s.quoteRetries?.filter(w=>w.expiresAt>now)??[],
'''),
(332, 333, r'''      risk:"单笔风险上限1.5%，置信信息用于0.5至1倍预算缩放；总风险10%，同向6.5%，总名义额4倍；当前可执行机会分配预算，不以少交易冒充改善",
'''),
])

edit('package.json', 'e5464dc8704b92a66637d72c8ec59a0360f2dcbe8978bec6aa94e74ac49ddd07', '5c8c9bc22ebbd464b636160a4f28b007c2f7ff0dd8acb6b51c17674dfde39ce9', [
(17, 18, r'''    "test:direct": "node --experimental-strip-types --test tests/extreme-sequence-mirror.test.ts tests/adaptive-policy.test.ts tests/liquidity-core.test.ts tests/market-radar.test.ts tests/market-regime.test.ts tests/all-regime-engine.test.ts tests/previous-all-regime-engine.test.ts tests/arena-live.test.ts tests/dual-paper.test.ts tests/regime-portfolio.test.ts tests/rejection-audit.test.ts tests/reaction-lab.test.ts tests/outcome-research.test.ts tests/strategy-arena.test.ts tests/previous-strategy-arena.test.ts tests/strategy-coverage.test.ts tests/paper-cycle.test.ts tests/gate-market.test.ts tests/runtime-health.test.ts tests/runtime-faults.test.ts tests/credential-vault.test.ts tests/owner-auth.test.ts tests/gate-live.test.ts tests/position-metrics.test.ts tests/forward-relations.test.ts tests/operator-ui.test.ts tests/forward-evidence.test.ts tests/forward-participation.test.ts",
'''),
(22, 23, r'''    "test:forward": "node --experimental-strip-types --test tests/forward-relations.test.ts tests/forward-evidence.test.ts tests/forward-participation.test.ts",
'''),
])

edit('tests/forward-evidence.test.ts', '5a37d7962ff8faba8df93f9bc52002067b21101f282500a5d894b053bdbb38b8', '2488f78b71d6783dd001f412c50d77e68699bf82896b4f201f4bd04cc06076c0', [
(42, 44, r'''test("outlier-supported hypothesis cannot be presented or sized as a robust shared edge",()=>{
  const {candidate:c}=inspect(rows((_k,j)=>j===0?.5:-.004));assert.ok(c);
  assert.equal(c.evidence.uncertain,true);assert.ok(c.evidence.boundedNet!<0);assert.equal(c.evidence.quality,.5);
  assert.ok(c.evidence.warnings!.length>0);
'''),
(45, 47, r'''test("concentration diagnostic reduces confidence without erasing a PAPER hypothesis",()=>{
  const {candidate:c,diagnostics:d}=inspect(rows((_k,j)=>j===0?.03:.0001,4));assert.ok(c);
  assert.ok(d.concentrationWarnings!>0);assert.equal(d.concentrationRejected,0);assert.equal(c.evidence.quality,.5);
'''),
(91, 92, r'''test("negative execution calibration remains visible and reduces confidence instead of resetting participation",()=>{
'''),
(94, 95, r'''  const result=inspectCondition({rows:data,conditions,horizon:15,now,feedback:bad},blankDiagnostics());assert.ok(result);
  assert.ok(result.evidence.calibratedNet!<0);assert.equal(result.evidence.quality,.5);assert.equal(result.evidence.uncertain,true);
'''),
(114, 115, r'''test("same-horizon opportunities share existing directional risk instead of a separate 3% veto",()=>{
'''),
(116, 117, r'''  const eq=forwardEquity(s,m.quotes,now).equity;assert.equal(s.positions.length,4);assert.ok(s.positions.reduce((a,t)=>a+t.plannedRisk,0)<=eq*.065+1e-8);
  assert.ok(s.positions.every(t=>t.plannedRisk<=t.forecast!.sizingEquity!*.015+1e-8));
'''),
(119, 121, r'''  const now=START+BAR_MS*10,m=market(now),seed=freshState(now);seed.rules[0].stopRate=100;
  const s=advanceForward({state:seed,now,...m}).state;
  assert.equal(s.positions.length,0);assert.ok(Object.keys(s.entryDiagnostics!.reasons).some(k=>k.includes("仓位")));
'''),
(122, 123, r'''test("new completed observation may re-enter a family after closure without waiting full old horizon",()=>{
'''),
(127, 128, r'''  assert.equal(s.positions.length,1);assert.equal(s.positions[0].openedAt,now+2*BAR_MS);
'''),
])

edit('research/FORWARD_PARTICIPATION_REPAIR.md', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', '3d7526d2aba220eb94bca4ddd70d3486720d9c47ac545cf176c9622523676d96', [
(0, 0, r'''# Forward participation and execution repair — 2026-09-17

The user accepts the first forward version as an ACTIVE research baseline and explicitly rejects improving apparent loss by eliminating trading. They authorize research, targeted optimization and deployment after verification. This does not authorize Gate orders, owner-switch actions, resetting the account, shadow strategies or arbitrary trade quotas. Monthly compounding to 2x remains unproven.

## Recorded evidence, not a new historical profit search

Public read-only workspace run35170504316 captured216 complete immutable packets and2215 unique matured market measurements. Archive SHA256:985c87d16b821c25194b313ea72e2922c5e8c24859932f0d734f8a59fa8fb0f2. At capture the unchanged account had61closed/0open,959.4353379255655USDT,0post-v1.1 entries. The user-supplied earlier snapshot had48closed/4open and943.9077694430488USDT. They are different timestamps, not competing account totals.

At49 recorded FIT times, reconstruct only measurements available by that time, using the same384-per-horizon rolling capacity. Apply generated rules to subsequent recorded feature anchors. Feedback uses the same ACTUALLY closed original PAPER orders available at each cutoff, not counterfactual future trades.1728 distinct recorded symbol/time anchors are available; these are sparse measurement anchors, not a full five-minute quote tape. No modeled fill or portfolio-profit claim is made.

| Generator | Unique matching symbol/time/direction hypotheses | Original528 hypotheses retained |
| --- | ---: | ---: |
| Active v1 baseline | 528 | 528 |
| Strict v1.1 | 25 | 10 |
| Participation repair | 547 | 526 |

The repair preserves99.62% of those baseline matches versus1.89% for strict v1.1. It also produces additional local hypotheses. These numbers measure candidate coverage, NOT orders, independent trials, daily frequency or profitability. The inspected history cannot be called blind evidence. No parameters were selected by maximizing account return.

An earlier ablation on three saved snapshots found that only removing leave-one-out rejection still leaves0 shared stumps under the bounded central lower bound, while the active raw estimator has2/4/1 shared stumps at60minutes. Quote retry alone cannot repair candidate starvation.

Eight of the original48closed trades had arm-minus-giveback geometry below the modeled explicit round-trip fees. This is a cost-geometry defect; it does not establish how much profit a different stop would have produced, because the complete quote path is not present.

## Implemented boundaries

- Restore the active causal raw positive-after-modeled-cost hypothesis estimator and bounded expression search. Confidence is separate: retain clipped/leave-one-symbol-out diagnostics, raw and calibrated estimates, warnings and0.5–1risk scaling. A pooled hypothesis is explicitly NOT a proven transferable edge. Only previously observed cohort symbols are eligible; local hypotheses remain local. Flat/below-cost raw observations still produce no hypotheses.
- Keep actual closed-PAPER forecast-error feedback, time grouping and decay. Negative calibrated estimates remain visible and affect confidence/risk instead of becoming another universal veto. Positive past PnL never boosts the original risk maximum. The calibration is not a proof of optimal exits.
- Preserve1.5%individual-at-entry,10%total,6.5%same-direction and4xgross maxima. Remove the extra3%same-horizon veto. Share risk, gross capacity and margin across simultaneous executable names. Leverage may differ to share margin but NEVER increases proposed notional or stop risk; exchange max leverage and stop-distance limit still apply. Keep meaningful integer lots and reject tiny residuals.
- Stage only current completed-bar signals missing a fresh sequence-valid quote. Retry on the existing10-second engine callback, ending at the NEXT five-minute bar boundary, not five minutes from retry. Revalidate active rule, signal, current executable quote, remaining raw opportunity and all capital checks. No retry fill is backdated. One same-symbol/bar entry; a close cannot immediately reopen in the same evaluation. New completed bars can provide new opportunities without a full-horizon lockout.
- Midpoint movement is used for entry opportunity depletion because the modeled base cost already includes entry slippage. Actual simulated entry still pays ask/bid, slippage and fees; no fee rate is reduced to beautify results.
- For NEW rule versions only, cap giveback to retain1.25times modeled cost at ideal activation. Existing cost-sufficient geometry is unchanged; old open positions retain their original protection and amounts. Gaps/stale intervals still exit only at real observable quotes and can lose.
- Record participation-execution-v1.2 separately from the unchanged forward-relations-v1.0 storage schema. Preserve prior upgrade marker, account identity, loss history and learning. Atomic persistence remains ahead of publishing a simulated fill. Waiting retries do not force extra writes; fills still do. No new network calls or D1 writes. Existing DO write-budget guard remains.
- Native dark UI shows raw versus bounded/calibrated estimates, uncertainty, matches, pending quote retries and actual new/retry entries. Matches are never advertised as trades.

## Expected benefit and possible regressions

The tested benefits are restored opportunity coverage, elimination of a deterministic stale-quote timing miss and correction of an internally cost-insufficient protection boundary. Restored participation can also restore losses. Outlier transfer, selection bias and small samples still affect pooled hypotheses, explicitly including ones with nonpositive bounded/calibrated estimates. The initial bounded risk scaling is an experiment, not an optimal fraction. Narrower cost-aware giveback can cut off a later winner. Quote retries can execute losing opportunities previously missed. Shared allocation can reduce exposure to the best candidate. More simulated fills can consume more write budget despite no per-retry writes. None of these fixes guarantees positive net expectancy or monthly doubling.

## Verification and reproducibility

`tests/forward-participation.test.ts` covers current-bar quote retries, expiry, retirement, changed features, no lookahead/backdating, no duplicate fills, unchanged waiting-write cadence, atomic recovery, meaningful multi-coin allocation under existing caps, no same-bar churn, non-reset v1.1 migration, upgrade-boundary retention, cost-aware exit geometry and explicit gap losses. Existing v1.1 policy-specific tests are updated to assert warnings/risk rather than obsolete unanimity vetoes; safety/accounting tests remain.

Local direct tests:354 total, including78 forward tests. Run build/architecture/type/lint/dry-run and actual production receipt before declaring release complete. Worker/LIVE/authentication/canonical/deployment files remain byte-identical, verified by the existing authority-hash test. No fake return target is a CI success criterion.

The research bundle contains the original read-only evidence, comparison source versions, coverage script and detailed per-cutoff results. Do not publish private credentials or account-auth responses. Production receipt must report exact build, continuous start/equity/history, LIVE intent, saved policy, advancing cycle and actual new entries separately from inherited positions; no requirement to force a trade for the receipt.'''),
])

edit('tests/forward-participation.test.ts', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', '6407219aa45d27557b25111c979b780c1ad1df7afa5fa77dc9eec491353917fd', [
(0, 0, r'''import test from "node:test";
import assert from "node:assert/strict";
import { advanceForward, initialForward, normalizeForward, synthesizeRules, forwardEquity, BAR_MS,
  type Rule, type Measurement, type Candle } from "../lib/forward-relations.ts";
import { EVIDENCE_POLICY, PREVIOUS_POLICY, inspectCondition, blankDiagnostics, costAwareGiveback, modeledCost } from "../lib/forward-evidence.ts";
import { readForwardStore, prepareForwardWrite } from "../lib/forward-store.ts";
const START=1_790_000_100_000, NOW=START+10*BAR_MS+90_000;
function rows():Measurement[]{return Array.from({length:12},(_,i)=>Array.from({length:8},(_,j)=>{
  const at=START+(i+1)*900000;return{symbol:`S${j}`,at,seenAt:at+90000,price:100,x:Array(8).fill(0),horizon:15,
    endAt:at+900000,availableAt:at+990000,response:.02,up:.03,down:.003};})).flat();}
function fixture(names=["S0"]){const s=initialForward(START),data=rows(),c=inspectCondition({rows:data,conditions:[{feature:0,op:"GE",threshold:-99}],horizon:15,
  now:data.at(-1)!.availableAt+1,feedback:[]},blankDiagnostics())!;
  const r:Rule={...c,id:"r",signature:"s",parentId:null,version:1,createdAt:NOW-1000,expiresAt:NOW+3600000,
    status:"EXPERIMENTAL",reason:"Synthetic, not a market result",mutation:"CREATE",grammar:"test",liveEligible:false,
    evidence:{...c.evidence,symbols:names},stopRate:.02};s.rules=[r];s.lastFitAt=NOW;return s;
}
function market(now=NOW,names=["S0"],fresh=true,price=100){const at=Math.floor(now/BAR_MS)*BAR_MS;
  return {paths:Object.fromEntries(names.map(s=>[s,Array.from({length:25},(_,i)=>({time:(at-(25-i)*BAR_MS)/1000,
    open:100,close:100,high:100.1,low:99.9,volume:100}) satisfies Candle)])),
    quotes:Object.fromEntries(names.map(s=>[s,{bestBid:price,bestAsk:price+.01,observedAt:now,fresh,entryReady:fresh}])),
    contracts:Object.fromEntries(names.map(s=>[s,{quantoMultiplier:.001,leverageMax:20,maintenanceRate:.005}]))};}
const pending=()=>advanceForward({state:fixture(),now:NOW,...market(NOW,["S0"],false)}).state;

test("unready quote retains a bounded signal without creating a PAPER trade",()=>{
  const s=pending();assert.equal(s.positions.length,0);assert.equal(s.balance,1000);assert.equal(s.quoteRetries!.length,1);
  assert.equal(s.quoteRetries![0].expiresAt,Math.floor(NOW/BAR_MS)*BAR_MS+BAR_MS);
});
test("quote recovery enters during the same bar at the recovery price and time",()=>{
  const before=pending(),now=NOW+20000,result=advanceForward({state:before,now,...market(now)}),s=result.state;
  assert.equal(s.positions.length,1);assert.equal(s.positions[0].openedAt,now);assert.ok(s.positions[0].entryPrice>100.01);
  assert.equal(s.participation!.retryFills,1);assert.equal(s.quoteRetries!.length,0);assert.equal(result.changed,true);
  assert.equal(before.positions.length,0);assert.equal(before.balance,1000);
});
test("retry does not refit or mature additional observations between data cycles",()=>{
  const before=pending(),now=NOW+20000,s=advanceForward({state:before,now,...market(now)}).state;
  assert.equal(s.lastFitAt,before.lastFitAt);assert.equal(s.observations,before.observations);assert.equal(s.measured,before.measured);
});
test("waiting retries do not force an extra storage commit every ten seconds",()=>{
  const before=pending(),now=NOW+20000,result=advanceForward({state:before,now,...market(now,["S0"],false)});
  assert.equal(result.changed,false);assert.equal(result.state.quoteRetries![0].firstAt,NOW);
});
test("stale quote cannot be relabeled fresh by a retry",()=>{
  const before=pending(),now=NOW+20000,m=market(now);m.quotes.S0.observedAt=NOW;
  const s=advanceForward({state:before,now,...m}).state;assert.equal(s.positions.length,0);assert.equal(s.balance,1000);
});
test("quote queue expires at next completed-bar boundary without backdated fills",()=>{
  const before=pending(),now=before.quoteRetries![0].expiresAt,s=advanceForward({state:before,now,paths:{},...{quotes:market(now).quotes,contracts:market(now).contracts}}).state;
  assert.equal(s.positions.length,0);assert.equal(s.quoteRetries!.length,0);
});
test("a retired rule cannot execute its queued observation",()=>{
  const before=pending();before.rules[0].status="DORMANT";const now=NOW+20000,s=advanceForward({state:before,now,...market(now)}).state;
  assert.equal(s.positions.length,0);assert.equal(s.quoteRetries!.length,0);
});
test("moved signal feature invalidates a queued condition",()=>{
  const before=pending();before.frames.S0.x[0]=-100;const now=NOW+20000,s=advanceForward({state:before,now,...market(now)}).state;
  assert.equal(s.positions.length,0);
});
test("already-consumed favorable move cannot be recovered as hypothetical past profit",()=>{
  const before=pending(),now=NOW+20000,s=advanceForward({state:before,now,...market(now,["S0"],true,110)}).state;
  assert.equal(s.positions.length,0);assert.ok(Object.keys(s.entryDiagnostics!.reasons).some(r=>r.includes("剩余优势")));
});
test("successful retries do not duplicate an order on subsequent heartbeats",()=>{
  let s=pending();s=advanceForward({state:s,now:NOW+20000,...market(NOW+20000)}).state;
  const t=s.positions[0],n=advanceForward({state:s,now:NOW+40000,...market(NOW+40000)}).state;
  assert.equal(n.positions.length,1);assert.equal(n.positions[0].id,t.id);assert.equal(n.fees,s.fees);
});
test("pending quote and completed retry survive atomic chunk persistence exactly",async()=>{
  const original=pending(),write=await prepareForwardWrite(null,original,NOW),db=new Map(Object.entries(write.entries));
  const restored=await readForwardStore({async get<T>(key:string){return db.get(key) as T|undefined;}},NOW+10000);
  const s=advanceForward({state:restored,now:NOW+20000,...market(NOW+20000)}).state;
  assert.equal(s.positions.length,1);assert.equal(s.participation!.retryFills,1);
  const final=await prepareForwardWrite(restored,s,NOW+20000);assert.ok(Object.keys(final.entries).some(k=>k.includes("archive:")));
});
test("simultaneous eight-coin opportunities retain meaningful lots under existing total caps",()=>{
  const names=Array.from({length:8},(_,i)=>`S${i}`),m=market(NOW,names),s=advanceForward({state:fixture(names),now:NOW,...m}).state;
  assert.equal(s.positions.length,8);const eq=forwardEquity(s,m.quotes,NOW).equity;
  assert.ok(s.positions.every(t=>t.notional>=eq*.05));assert.ok(s.positions.reduce((n,t)=>n+t.plannedRisk,0)<=eq*.065+1e-8);
  assert.ok(s.positions.reduce((n,t)=>n+t.notional,0)<=eq*4+1e-8);
  const notionals=s.positions.map(t=>t.notional);assert.ok(Math.max(...notionals)/Math.min(...notionals)<1.05);
});
test("an actual same-bar close cannot reopen under another version in the same evaluation",()=>{
  let s=advanceForward({state:fixture(),now:NOW,...market()}).state;const now=Math.floor(NOW/BAR_MS)*BAR_MS+BAR_MS+90000;
  s.rules[0].version=99;s=advanceForward({state:s,now,...market(now,["S0"],true,90)}).state;
  assert.equal(s.resolved,1);assert.equal(s.positions.length,0);
});
test("v1.1 migration keeps start, loss ledger, samples and previous upgrade boundary",()=>{
  const s=fixture();s.policyVersion=PREVIOUS_POLICY;s.balance=959;s.resolved=61;s.samples=rows();
  s.policyUpgrade={at:START,from:"legacy-forward-v1.0",to:PREVIOUS_POLICY,equity:943,balance:944,stalePositions:0,resolved:48,positionIds:[]};
  const norm=normalizeForward(structuredClone(s),NOW),r=advanceForward({state:norm,now:NOW,paths:{},quotes:{},contracts:{}}).state;
  assert.equal(r.balance,959);assert.equal(r.startedAt,s.startedAt);assert.equal(r.resolved,61);assert.equal(r.policyVersion,EVIDENCE_POLICY);
  assert.deepEqual(r.policyUpgrades![0],s.policyUpgrade);assert.equal(r.policyUpgrade!.from,PREVIOUS_POLICY);assert.equal(r.initialEquity,1000);
});
test("known v1.1 migration is one-time; unknown policy still fails closed",()=>{
  const s=fixture();s.policyVersion=PREVIOUS_POLICY;let r=advanceForward({state:s,now:NOW,paths:{},quotes:{},contracts:{}}).state;
  const marker=structuredClone(r.policyUpgrade);r=advanceForward({state:r,now:NOW+10000,paths:{},quotes:{},contracts:{}}).state;
  assert.deepEqual(r.policyUpgrade,marker);r.policyVersion="future";assert.throws(()=>normalizeForward(r,NOW));
});
test("new cost-aware giveback retains cost allowance at ideal activation for all horizons",()=>{
  for(const h of[15,60,180]){const c=modeledCost(h),arm=c*2,giveback=costAwareGiveback(arm,arm*.8,c);
    assert.ok(arm-giveback>=c*1.25-1e-12);assert.ok(giveback>0);}
});
test("already cost-sufficient original exit geometry stays unchanged",()=>{
  assert.equal(costAwareGiveback(.03,.012,.0022),.012);
});
test("a delayed adverse gap after arming still realizes the observable loss, not ideal profit",()=>{
  let s=advanceForward({state:fixture(),now:NOW,...market()}).state;
  const r=s.positions[0].rule;r.exitMode="REACTION_DECAY";r.armRate=.0044;r.givebackRate=.00165;
  s=advanceForward({state:s,now:NOW+20000,...market(NOW+20000,["S0"],true,101)}).state;
  s=advanceForward({state:s,now:NOW+BAR_MS+20000,paths:{},quotes:market(NOW+BAR_MS+20000,["S0"],true,95).quotes,contracts:{}}).state;
  assert.equal(s.history.length,1);assert.ok(s.history[0].netPnl!<0);assert.ok(s.history[0].exitPrice!<96);
});
test("midpoint admission does not charge entry slippage twice",()=>{
  const s=fixture();s.rules[0].estimatedNetRate=.0004;s.rules[0].evidence!.rawNet=.0004;s.rules[0].evidence!.quality=.5;
  const r=advanceForward({state:s,now:NOW,...market()}).state;assert.equal(r.positions.length,1);
  assert.ok(r.positions[0].entryFee>0);assert.ok(r.positions[0].entryPrice>100.01);assert.ok(r.positions[0].forecast!.remainingNetRate>0);
});
test("flat data still generates no paid-trade hypotheses; no forced minimum frequency",()=>{
  const s=fixture();s.rules=[];s.samples=rows().map(r=>({...r,response:0}));synthesizeRules(s,s.samples.at(-1)!.availableAt+1);
  assert.equal(s.rules.filter(r=>r.status==="EXPERIMENTAL").length,0);
});'''),
])
