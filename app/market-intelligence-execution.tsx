"use client";

import {BEIJING_TIME_ZONE} from "../lib/beijing-time.ts";
import {type forwardSummary} from "../lib/forward-relations.ts";

type View=ReturnType<typeof forwardSummary>;
const fmt=(v:number|null|undefined,d=1)=>typeof v==="number"&&Number.isFinite(v)?v.toLocaleString("en-US",{minimumFractionDigits:d,maximumFractionDigits:d}):"—";
const pct=(v:number|null|undefined,d=2)=>typeof v==="number"&&Number.isFinite(v)?`${v>=0?"+":""}${fmt(v*100,d)}%`:"—";
const bias=(v?:string)=>v==="BULLISH"?"偏多":v==="BEARISH"?"偏空":"中性";
const phase=(v?:string)=>({
  BULL_EXPANSION:"扩张阶段",BEAR_CONTRACTION:"收缩阶段",RECOVERY_UNCONFIRMED:"修复中·底部未确认",
  DISTRIBUTION_RISK:"分化/分配风险",BASE_BUILDING:"筑底修复",UNCERTAIN:"周期未确认",
  ADVANCING:"短期推进",PULLBACK_BUILDING:"回调正在形成",DECLINING:"短期下行",
  REBOUND_BUILDING:"反弹正在形成",DIVERGING:"市场分化",BALANCED:"均衡"
}[v??""]??v??"—");
const evolution=(v?:string)=>({
  ROTATIONAL:"轮动",TREND_FORMING:"趋势形成",EXPANDING:"方向扩张",STABLE_TREND:"稳定趋势",
  DECAYING:"趋势衰退",TRANSITIONAL:"状态过渡"
}[v??""]??v??"状态建立中");
const opportunityPhase=(v?:string)=>({
  EMERGING:"萌芽",CONFIRMED:"已确认",EXPANDING:"正在扩张",MATURE:"成熟",OVEREXTENDED:"过度延伸"
}[v??""]??v??"—");
const action=(v?:string)=>v==="EXIT"?"退出":v==="PROTECT"?"保护利润":v==="WATCH"?"观察":v==="HOLD"?"继续持有":"观察";
const hypothesisKind=(v?:string)=>({
  PULLBACK_AHEAD:"回调正在酝酿",REBOUND_AHEAD:"反弹正在酝酿",ROTATION_AHEAD:"轮动/震荡正在形成",
  TREND_EXPANSION_AHEAD:"趋势扩张正在形成",REVERSAL_AHEAD:"真正转向正在形成"
}[v??""]??v??"未来状态研究");
const hypothesisStatus=(v?:string)=>v==="CONFIRMED"?"已被后续市场确认":v==="WEAKENING"?"确认后正在减弱":v==="CONFIRMING"?"正在加强":"正在形成";
const researchAction=(v?:string)=>v==="CONFIRM_MORE"?"加强实时确认":v==="SUPPORTED"?"前瞻研究支持":"沿用原确认";
const environmentName=(v?:string)=>({TREND:"趋势环境",TRANSITION:"过渡环境",ROTATION:"轮动/震荡",SHOCK:"同步爆发行情"}[v??""]??v??"建立中");
const tradePlanName=(v?:string)=>({
  LIQUIDITY_MIGRATION:"流动性迁移",LIQUIDITY_REJECTION:"离开失败回归",FAMILY_TURN:"家族提前转折",OBSERVE_ONLY:"只观察"
}[v??""]??v??"旧版计划");
const liquidityState=(v?:string)=>({INSIDE:"区域内积累",TESTING:"尝试离开",ACCEPTED:"离开已被接受",REJECTED:"离开失败回归"}[v??""]??v??"—");
const entryExecutionState=(v?:{status?:string;phase?:string;stableThesis?:boolean})=>v?.status==="WAITING"
  ?(v.phase==="RETEST_WAIT"?"等回调重启":v.stableThesis?"已武装":"实时确认")
  :v?.status==="CANCELLED"?"本假设已取消":"未进入执行";
const side=(v:string)=>v==="LONG"?"做多":"做空";
const family=(v?:string)=>({
  BREADTH:"市场广度",LEADERSHIP:"领导结构",RELATIVE:"相对强弱",FLOW:"跨所/盘口响应",CORRELATION:"相关性",
  PATH:"价格路径",STRUCTURE:"结构",LIQUIDITY:"流动性计划",MARKET:"市场背景"
}[v??""]??v??"市场细节");
const trend=(v?:string)=>v==="STRENGTHENING"?"增强":v==="WEAKENING"?"减弱":"稳定";
const clock=(v?:number)=>v?new Date(v).toLocaleTimeString("zh-CN",{timeZone:BEIJING_TIME_ZONE,hour12:false}):"—";
const actionRank=(v?:string)=>v==="EXIT"?4:v==="PROTECT"?3:v==="WATCH"?2:1;
const actionClass=(v?:string)=>v==="EXIT"?"is-exit":v==="PROTECT"?"is-protect":v==="WATCH"?"is-watch":"is-hold";

export default function MarketIntelligenceExecution({data,now:_,liveEnabled,liveOverview}:{
  data:View|null;now:number;liveEnabled:boolean;liveOverview?:{operational:boolean;lastSyncAt:number|null;positionCount:number};
}){
  const mi=data?.marketIntelligence,n=mi?.narrative,evidence=mi?.evidence??[],symbols=mi?.symbols??[],
    opportunities=[...(data?.opportunities??[])].sort((a,b)=>Number(b.eligible)-Number(a.eligible)||b.score-a.score),
    positions=[...(data?.positions??[])].sort((a,b)=>{
      const aa=a.positionIntelligence?.decision==="EXIT"?"EXIT":a.positionIntelligence?.decision==="REVIEW"?"WATCH":"HOLD",
        ba=b.positionIntelligence?.decision==="EXIT"?"EXIT":b.positionIntelligence?.decision==="REVIEW"?"WATCH":"HOLD";
      return actionRank(ba)-actionRank(aa);
    }),
    currentEvolution=data?.environmentRouter?.phase??opportunities.find(o=>o.marketEvolutionPhase)?.marketEvolutionPhase,
    hypothesisResearch=data?.hypothesisResearch,hypotheses=hypothesisResearch?.active??[],
    environmentRouter=data?.environmentRouter,liquidity=mi?.liquidity,
    entryValidations=data?.entryValidation?.records??[],
    validationById=new Map(entryValidations.map(v=>[v.candidateId,v])),
    waitingValidations=entryValidations.filter(v=>v.status==="WAITING"),
    cancelledValidations=entryValidations.filter(v=>v.status==="CANCELLED"),
    actionable=opportunities.filter(o=>o.eligible),
    candidateRows=(actionable.length?actionable:opportunities).slice(0,8);

  return <div className="fr-execution-page">
    <section className="fr-page-title fr-exec-title">
      <small>MARKET INTELLIGENCE · WINNER CORE</small>
      <h1>执行</h1>
      <p>先看市场判断和当前仓位，再看未来条件还能维持多久、转变压力是否上升，以及当前交易方式与未来窗口是否匹配。</p>
    </section>

    <section className="fr-section fr-exec-primary">
      <div className="fr-section-head"><div><small>NOW · 持仓自己的理由</small><h2>当前持仓与系统动作</h2>
        <p>打开页面第一眼只回答：现在持有什么，系统准备怎么处理。</p></div><span>{positions.length} 笔持仓</span></div>
      {positions.length?<div className="fr-exec-position-grid">{positions.map(t=>{
        const p=t.positionIntelligence,currentAction=p?.decision==="EXIT"?"EXIT":p?.decision==="REVIEW"?"WATCH":"HOLD",
          signed=(t.side==="LONG"?1:-1)*(t.lastPrice/Math.max(t.entryPrice,1e-12)-1),
          peak=t.favorable??t.peakPnlRate??0,giveback=peak>0?Math.max(0,(peak-signed)/peak):null;
        return <article className={`fr-exec-position-card ${actionClass(currentAction)}`} key={t.id}>
          <header className="fr-exec-position-head"><div><small>{side(t.side)}</small><h3>{t.symbol.replace("_"," / ")}</h3></div>
            <span className={`fr-exec-action ${actionClass(currentAction)}`}><b>{action(currentAction)}</b><small>Position Intelligence</small></span></header>
          <div className="fr-exec-metrics">
            <span><small>交易计划</small><b>{tradePlanName(t.liquidityLifecycle?.currentPlan??t.entryContext?.tradePlan)}</b></span>
            <span><small>最高浮盈</small><b>{pct(peak)}</b></span>
            <span><small>当前幅度</small><b>{pct(signed)}</b></span>
            <span><small>峰值回吐</small><b>{giveback==null?"—":fmt(giveback*100,0)+"%"}</b></span>
            <span><small>大赢家最后保险</small><b>{(t.profitFloorRate??0)>0?pct(t.profitFloorRate):"未触发"}</b></span>
          </div>
          <p className="fr-exec-judgement"><b>当前判断：</b>{p?.summary??"Position Intelligence 正在建立这笔仓位自己的连续观察基线。"}</p>
          <details className="fr-exec-research-details"><summary>查看这笔仓位的研究依据</summary>
            <p><b>入场假设：</b>{t.entryContext?.thesisSummary??t.entryContext?.reason??"历史兼容持仓"}</p>
            {t.liquidityLifecycle?.reason&&<p><b>当前流动性计划：</b>{tradePlanName(t.liquidityLifecycle.currentPlan)} · {t.liquidityLifecycle.reason}</p>}
            {t.entryContext?.futureResearchReason&&<p><b>入场时前瞻研究：</b>{researchAction(t.entryContext.futureResearchAction)} · {t.entryContext.futureResearchReason}</p>}
            {p&&<><p><b>持有价值：</b>{fmt(p.holdValueScore,0)} · 剩余空间 {pct(p.remainingSpaceRate)} · 正常回撤 {pct(p.expectedPullbackRate)} · 空间/回撤 {fmt(p.continuationRatio,2)}×</p>
              <p><b>优势变化：</b>{fmt(p.entryAdvantage,0)} → {fmt(p.currentAdvantage,0)}（{p.advantageChange>=0?"+":""}{fmt(p.advantageChange,0)}）</p>
              <p><b>独立证据：</b>支持 {p.supportFamilies?.map(family).join(" / ")||"无"} · 担忧 {p.concernFamilies?.map(family).join(" / ")||"无"} · 复核已持续 {p.reviewBars??0} 根完成5m</p>
              {!!p.concerns?.length&&<p><b>当前担忧：</b>{p.concerns.join("；")}</p>}</>}
          </details>
        </article>})}</div>:<div className="fr-empty"><span>0</span><h3>当前没有持仓</h3><p>系统仍在持续更新市场演化和候选生命周期，出现可执行机会后会显示在下方。</p></div>}
    </section>

    <section className="fr-section fr-exec-market">
      <div className="fr-section-head"><div><small>MARKET EVOLUTION</small><h2>市场现在正在变成什么</h2></div><span>{clock(mi?.updatedAt)}</span></div>
      <div className="fr-exec-market-hero"><div><small>当前演化阶段</small><strong>{evolution(currentEvolution)}</strong></div><p>{n?.summary??"持续更新市场状态；细节变化不会单独翻转主判断。"}</p></div>
      <div className="fr-exec-market-grid">
        <span><small>数小时大方向</small><b>{bias(n?.major.bias)}</b></span>
        <span><small>短期优势</small><b>{bias(n?.short.bias)} · {phase(n?.short.phase)}</b></span>
        <span><small>状态迁移</small><b>{n?.transition.stage??"STABLE"} · {fmt(n?.transition.pressure,0)}/100</b></span>
        <span><small>尾部风险</small><b>{n?.tailRisk.level==="HIGH"?"高":n?.tailRisk.level==="MEDIUM"?"中":"低"}</b></span>
      </div>
      <p className="fr-exec-judgement"><b>当前市场判断：</b>{n?.transition.detail??n?.summary??"正在建立市场基线。"}</p>
      <p className="fr-trade-reason"><b>当前计划：</b>{n?.plan??"继续观察。"}</p>
    </section>

    <section className="fr-section">
      <div className="fr-section-head"><div><small>ENVIRONMENT OUTLOOK</small><h2>未来市场条件</h2>
        <p>正式环境标签保持稳定；约每分钟只更新持续力、转变压力和未来有效窗口，用来调节交易节奏与仓位，不直接预测价格。</p></div>
        <span>{environmentRouter?.outlook?.horizonMinutes?environmentRouter.outlook.horizonMinutes+" 分钟窗口":environmentName(environmentRouter?.currentEnvironment)}</span></div>
      <div className="fr-exec-market-grid">
        <span><small>当前环境</small><b>{environmentName(environmentRouter?.currentEnvironment)}</b></span>
        <span><small>条件持续力</small><b>{environmentRouter?.outlook?fmt(environmentRouter.outlook.persistenceScore*100,0)+"%":"—"}</b></span>
        <span><small>转变压力</small><b>{environmentRouter?.outlook?fmt(environmentRouter.outlook.transitionPressure*100,0)+"%":"—"}</b></span>
        <span><small>利润扩张</small><b>{environmentRouter?.outlook?.profitExpansion==="HIGH"?"高":environmentRouter?.outlook?.profitExpansion==="LOW"?"低":environmentRouter?.outlook?.profitExpansion==="NORMAL"?"正常":"—"}</b></span>
      </div>
      <p className="fr-exec-judgement"><b>未来条件判断：</b>{environmentRouter?.reason??"正在建立市场条件持续性基线。"}</p>
    </section>

    <section className="fr-section">
      <div className="fr-section-head"><div><small>LIQUIDITY MAP</small><h2>全市场流动性地图</h2>
        <p>大视角先找真正反复交换的区域，再判断积累、离开、接受或回归；1分钟只负责最后执行，不参与定义全局环境。</p></div>
        <span>{liquidity?.market?.ready?`覆盖 ${liquidity.market.readySymbols}/${liquidity.market.totalSymbols}`:"建立中"}</span></div>
      <div className="fr-exec-market-grid">
        <span><small>仍在区域内</small><b>{liquidity?.market?fmt(liquidity.market.insideShare*100,0)+"%":"—"}</b></span>
        <span><small>已接受迁移</small><b>{liquidity?.market?fmt(liquidity.market.acceptedShare*100,0)+"%":"—"}</b></span>
        <span><small>离开失败</small><b>{liquidity?.market?fmt(liquidity.market.rejectedShare*100,0)+"%":"—"}</b></span>
        <span><small>高积累</small><b>{liquidity?.market?fmt(liquidity.market.highAccumulationShare*100,0)+"%":"—"}</b></span>
      </div>
      <p className="fr-exec-judgement"><b>流动性判断：</b>{liquidity?.market?.summary??"等待至少6小时完整5分钟路径建立全局盘中流动性地图。"}</p>
    </section>

    <section className="fr-section fr-hypothesis-section">
      <div className="fr-section-head"><div><small>FORWARD RESEARCH</small><h2>研究层正在提前推演什么</h2>
        <p>重要细节继续形成5 / 15 / 30分钟可验证的未来状态假设，但这里只做研究记录，不直接挡开仓、不改仓位、不触发平仓。</p></div>
        <span>{hypotheses.length} 个活跃假设</span></div>
      <div className="fr-hypothesis-summary">{hypothesisResearch?.summary??"前瞻研究正在建立市场状态转移基线。"}</div>
      {hypotheses.length?<div className="fr-hypothesis-grid">{hypotheses.slice(0,5).map(h=>{
        const memory=hypothesisResearch?.memory?.find(m=>m.key===h.key);
        return <article className={"fr-hypothesis-card is-"+h.direction.toLowerCase()} key={h.id}>
          <header><div><small>{h.direction==="LONG"?"偏多未来":h.direction==="SHORT"?"偏空未来":"双向 / 轮动"}</small>
            <h3>{hypothesisKind(h.kind)}</h3></div><span><b>{fmt(h.confidence*100,0)}%</b><small>{hypothesisStatus(h.status)}</small></span></header>
          <p className="fr-hypothesis-thesis">{h.thesis}</p>
          <div className="fr-hypothesis-evidence"><small>当前证据家族</small><b>{h.families.join(" / ")||"正在积累"}</b></div>
          <div className="fr-hypothesis-next"><small>如果判断正确，接下来应该看到</small>{h.expectedNext.map(x=><p key={x}>• {x}</p>)}</div>
          <p className="fr-hypothesis-invalidation"><b>否定条件：</b>{h.invalidation}</p>
          <footer><span>观察窗口 5 / 15 / 30 分钟</span><span>{memory?("历史 "+memory.observations+" 次 · 确认 "+memory.confirmed):"首次 / 样本积累中"}</span></footer>
        </article>})}</div>:<p className="fr-note">当前还没有足够集中的特殊变化形成未来状态假设；这不是停止交易，只代表继续沿用原市场智能与实时响应链。</p>}
    </section>
    <section className="fr-section">
      <div className="fr-section-head"><div><small>ENTRY EXECUTION</small><h2>入场执行状态</h2>
        <p>这里独立显示系统已经发现并正在处理的入场假设，不受候选榜前8名限制。</p></div>
        <span>{waitingValidations.length} 个进行中 · {cancelledValidations.length} 个最近取消</span></div>
      {entryValidations.length?<div className="fr-journal">{entryValidations.map(v=><article key={v.id}>
        <time>{clock(v.startedAt)}</time>
        <div><b>{v.symbol.replace("_"," / ")} · {side(v.side)} · {entryExecutionState(v)}</b>
          <p>{v.reason??"等待实时执行证据。"}</p>
          <p>{v.stableThesis?"稳定 thesis 已保留执行权":"普通实时确认"}
            {v.phase==="RETEST_WAIT"?" · 当前不追价，等待回调结束后重新启动":""}
            {v.status==="CANCELLED"?" · 已解除本轮执行权":""}</p>
        </div>
      </article>)}</div>
        :<p className="fr-note">当前没有已武装或等待回调的入场假设；系统仍在研究候选，但尚未进入实时执行状态。</p>}
    </section>

    <section className="fr-section">
      <div className="fr-section-head"><div><small>NEXT OPPORTUNITIES</small><h2>当前交易假设 · 最值得关注的机会</h2>
        <p>先看机会处于哪个阶段，再看评分。过度延伸不会直接被禁止，但会进入加强实时确认。</p></div><span>{actionable.length} 个可参与</span></div>
      {candidateRows.length?<div className="fr-exec-candidate-grid">{candidateRows.map((o,index)=>{
        const v=validationById.get(o.id),entryState=v?entryExecutionState(v):o.extendedConfirmation?"加强确认":o.eligible?"主候选":"观察";
        return <details className={`fr-exec-candidate ${o.eligible?"is-eligible":""} ${o.extendedConfirmation?"is-extended":""}`} key={o.id}>
        <summary><span className="fr-exec-candidate-rank">#{index+1}</span><div className="fr-exec-candidate-main"><div><b>{o.symbol.replace("_"," / ")}</b><small>{side(o.side)} · {tradePlanName(o.tradePlan)}</small></div>
          <strong>{opportunityPhase(o.opportunityLifecyclePhase)}</strong></div>
          <div className="fr-exec-candidate-metrics"><span><small>原始评分</small><b>{fmt(o.score,0)}</b></span><span><small>净空间</small><b>{pct(o.netRemainingSpaceRate)}</b></span>
            <span><small>空间/回撤</small><b>{fmt(o.edgeRatio,2)}×</b></span></div>
          <em>{entryState}</em></summary>
        <div className="fr-score-details"><p><b>机会阶段：</b>{opportunityPhase(o.opportunityLifecyclePhase)} · 市场阶段 {evolution(o.marketEvolutionPhase)}</p>
          <p><b>交易计划：</b>{tradePlanName(o.tradePlan)} · 计划可信度 {fmt((o.liquidityPlanConfidence??0)*100,0)}%</p>
          {o.liquidityReason&&<p><b>流动性依据：</b>{o.liquidityReason}</p>}
          {(o.liquidityOriginLower!=null&&o.liquidityOriginUpper!=null)&&<p><b>来源区域：</b>{fmt(o.liquidityOriginLower,6)} – {fmt(o.liquidityOriginUpper,6)}
            {(o.liquidityTargetLower!=null&&o.liquidityTargetUpper!=null)?` · 下一目标 ${fmt(o.liquidityTargetLower,6)} – ${fmt(o.liquidityTargetUpper,6)}`:""}</p>}
          {o.environmentReason&&<p><b>研究背景：</b>{o.environmentReason}</p>}
          {v&&<p><b>入场执行：</b>{entryState} · {v.reason??"等待实时响应。"}</p>}
          {o.lifecycleReason&&<p><b>机会研究：</b>{o.lifecycleReason}（不直接控制交易）</p>}
          {o.futureResearchReason&&<p><b>前瞻研究：</b>{researchAction(o.futureResearchAction)} · {o.futureResearchReason}（仅参考）</p>}
          <p>{o.thesisSummary??o.reason}</p><p><b>失效条件：</b>{o.invalidationSummary??"按独立交易假设与结构止损退出。"}</p></div>
      </details>})}</div>:<p className="fr-note">当前没有形成值得优先展示的交易假设。</p>}
    </section>

    <section className="fr-section">
      <div className="fr-section-head"><div><small>IMPORTANT EVIDENCE</small><h2>系统刚刚发现的细节</h2>
        <p>这里只优先展示最近仍有效、可能改变研究结论的市场证据。</p></div><span>{evidence.length} 条有效证据</span></div>
      {evidence.length?<div className="fr-journal">{evidence.slice(0,8).map(e=><article key={e.id}><time>{clock(e.lastAt??e.at)}</time>
        <div><b>{family(e.family)} · {trend(e.trend)} · 强度 {fmt(e.severity*100,0)}</b><p>{e.summary}</p>
          <p>同一事件已观察 {e.samples??1} 次 · 开始 {clock(e.firstAt??e.at)}</p></div></article>)}</div>
        :<p className="fr-note">当前没有足够持续的新细节改变市场理解。</p>}
    </section>

    <details className="fr-section fr-exec-secondary">
      <summary className="fr-expand"><div><small>RELATIVE MAP</small><h2>全市场异类与相关组</h2><p>需要检查选币和相对强弱时再展开。</p></div><span>{symbols.length} 个市场</span></summary>
      {symbols.length?<div className="fr-scoreboard fr-exec-secondary-body">{symbols.slice(0,16).map((s,index)=><details className="fr-score-row" key={s.symbol}>
        <summary><span className="fr-score-rank">#{index+1}</span><span className="fr-score-value">{fmt(s.watchScore,0)}</span>
          <span className="fr-score-symbol"><b>{s.symbol.replace("_"," / ")}</b><small>{s.regime} · {s.clusterId.replace("corr:","组 ")}</small></span>
          <span><small>多头适配</small><b>{fmt(s.longScore,0)}</b></span><span><small>空头适配</small><b>{fmt(s.shortScore,0)}</b></span>
          <em>{s.residual>=0?"强于理论 +"+fmt(s.residual*100,2)+"%":"弱于理论 "+fmt(s.residual*100,2)+"%"}</em></summary>
        <div className="fr-score-details"><div><h3>相对关系</h3><div className="fr-score-detail-grid">
          <span><small>与市场相关</small><b>{fmt(s.correlation*100,0)}%</b></span><span><small>残差持续</small><b>{fmt(s.residualPersistence*100,0)}%</b></span>
          <span><small>跨所数据</small><b>{s.sourceCount} 路</b></span><span><small>数据可信</small><b>{fmt(s.dataConfidence,0)}</b></span>
        </div></div></div></details>)}</div>:<p className="fr-note">等待足够的全市场完成K线建立相对关系。</p>}
    </details>

    <details className="fr-section fr-exec-secondary">
      <summary className="fr-expand"><div><small>MARKET BACKGROUND</small><h2>大周期与研究背景</h2><p>作为组合风险背景，不抢占当前执行信息的位置。</p></div><span>{bias(n?.macro.bias)}</span></summary>
      <div className="fr-stats fr-exec-secondary-body">
        <article><small>超大周期</small><strong>{bias(n?.macro.bias)}</strong><p>{phase(n?.macro.phase)} · 已维持 {typeof n?.macro.ageMs==="number"?fmt(n.macro.ageMs/3600000,1)+" 小时":"—"}</p></article>
        <article><small>大方向</small><strong>{bias(n?.major.bias)}</strong><p>置信 {fmt((n?.major.confidence??0)*100,0)}%</p></article>
        <article><small>短期优势</small><strong>{bias(n?.short.bias)}</strong><p>{phase(n?.short.phase)}</p></article>
        <article><small>尾部风险</small><strong>{n?.tailRisk.level==="HIGH"?"高":n?.tailRisk.level==="MEDIUM"?"中":"低"}</strong><p>{fmt(n?.tailRisk.score,0)} / 100</p></article>
      </div>
      <div className="fr-three">
        <div><small>超大周期解释</small><b>{n?.macro.detail??"—"}</b></div>
        <div><small>大方向解释</small><b>{n?.major.detail??"—"}</b></div>
        <div><small>短期解释</small><b>{n?.short.detail??"—"}</b></div>
      </div>
      {!!n?.transition.drivers?.length&&<p className="fr-note"><b>当前迁移驱动：</b>{n.transition.drivers.join(" · ")}</p>}
      <p className="fr-note"><b>风险背景：</b>{n?.tailRisk.detail??"—"}</p>
      <p className="fr-note"><b>跨所流动性：</b>盘口失衡 {fmt((mi?.internals?.bookImbalance??0)*100,0)}% · 买方流动性变化 {fmt((mi?.internals?.bidLiquidityChange??0)*100,0)}% · 卖方流动性变化 {fmt((mi?.internals?.askLiquidityChange??0)*100,0)}%</p>
    </details>

    <section className="fr-section fr-exec-system">
      <div className="fr-section-head"><div><small>SYSTEM STATUS</small><h2>数据与执行链</h2></div><span>{liveEnabled?"实盘已请求开启":"实盘关闭"}</span></div>
      <div className="fr-exec-market-grid">
        <span><small>5m市场</small><b>{mi?.coverage?.intradayMarkets??0}</b></span>
        <span><small>日线市场</small><b>{mi?.coverage?.dailyMarkets??0}</b></span>
        <span><small>实时跨所报价</small><b>{mi?.coverage?.quoteMarkets??0}</b></span>
        <span><small>多交易所确认</small><b>{mi?.coverage?.multiVenueMarkets??0}</b></span>
      </div>
      <p className="fr-note"><b>数据覆盖：</b>5m市场 {mi?.coverage?.intradayMarkets??0} · 日线市场 {mi?.coverage?.dailyMarkets??0} · 实时跨所报价 {mi?.coverage?.quoteMarkets??0} · 多交易所确认 {mi?.coverage?.multiVenueMarkets??0}。超大周期至少需要3个真实日线市场才会开始形成牛熊判断。</p>\n      <p className="fr-note">PAPER→LIVE→Gate 复制链保持原样。实盘运行 {liveOverview?.operational?"正常":"未运行"}，当前 {liveOverview?.positionCount??"—"} 笔；本次页面升级不改变任何交易、研究、账户或实盘逻辑。</p>
    </section>
  </div>;
}
