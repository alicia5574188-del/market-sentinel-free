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
const profitPhase=(v?:string)=>({
  UNPROVEN:"尚未证明",PROVEN:"已证明",EXPANDING:"利润扩张",PULLBACK:"正常回调",DECAYING:"优势衰退",INVALIDATED:"原假设失效"
}[v??""]??v??"建立中");
const action=(v?:string)=>v==="EXIT"?"退出":v==="PROTECT"?"保护利润":v==="WATCH"?"观察":v==="HOLD"?"继续持有":"观察";
const hypothesisKind=(v?:string)=>({
  PULLBACK_AHEAD:"回调正在酝酿",REBOUND_AHEAD:"反弹正在酝酿",ROTATION_AHEAD:"轮动/震荡正在形成",
  TREND_EXPANSION_AHEAD:"趋势扩张正在形成",REVERSAL_AHEAD:"真正转向正在形成"
}[v??""]??v??"未来状态研究");
const hypothesisStatus=(v?:string)=>v==="CONFIRMED"?"已被后续市场确认":v==="WEAKENING"?"确认后正在减弱":v==="CONFIRMING"?"正在加强":"正在形成";
const researchAction=(v?:string)=>v==="CONFIRM_MORE"?"加强实时确认":v==="SUPPORTED"?"前瞻研究支持":"沿用原确认";
const environmentName=(v?:string)=>({TREND:"趋势环境",TRANSITION:"过渡环境",ROTATION:"轮动/震荡",SHOCK:"同步爆发行情"}[v??""]??v??"建立中");
const playbookName=(v?:string)=>({TREND_CAPTURE:"趋势捕获",TRANSITION_PROBE:"转折验证",ROTATION_RELATIVE:"相对强弱",SHOCK_PARTICIPATION:"主线参与"}[v??""]??v??"未路由");
const routeAlignment=(v?:string)=>v==="ALIGNED"?"顺环境":v==="COUNTER"?"逆环境":"环境中性";
const entryExecutionState=(v?:{status?:string;phase?:string;stableThesis?:boolean})=>v?.status==="WAITING"
  ?(v.phase==="RETEST_WAIT"?"等回调重启":v.stableThesis?"已武装":"实时确认")
  :v?.status==="CANCELLED"?"本假设已取消":"未进入执行";
const side=(v:string)=>v==="LONG"?"做多":"做空";
const family=(v?:string)=>({
  BREADTH:"市场广度",LEADERSHIP:"领导结构",RELATIVE:"相对强弱",FLOW:"跨所/盘口响应",CORRELATION:"相关性",
  PATH:"价格路径",STRUCTURE:"结构",MARKET:"市场背景"
}[v??""]??v??"市场细节");
const trend=(v?:string)=>v==="STRENGTHENING"?"增强":v==="WEAKENING"?"减弱":"稳定";
const clock=(v?:number)=>v?new Date(v).toLocaleTimeString("zh-CN",{timeZone:BEIJING_TIME_ZONE,hour12:false}):"—";
const actionRank=(v?:string)=>v==="EXIT"?4:v==="PROTECT"?3:v==="WATCH"?2:1;
const actionClass=(v?:string)=>v==="EXIT"?"is-exit":v==="PROTECT"?"is-protect":v==="WATCH"?"is-watch":"is-hold";
function lifecycleNarrative(value?:string){
  const marker="生命周期研究：",tail=value?.includes(marker)?value.split(marker)[1]:"";
  return tail?.replace(/ 当前发现.*$/,"").replace(/ 本轮新开.*$/,"").trim()||"正在建立市场演化判断。";
}

export default function MarketIntelligenceExecution({data,now:_,liveEnabled,liveOverview}:{
  data:View|null;now:number;liveEnabled:boolean;liveOverview?:{operational:boolean;lastSyncAt:number|null;positionCount:number};
}){
  const mi=data?.marketIntelligence,n=mi?.narrative,evidence=mi?.evidence??[],symbols=mi?.symbols??[],
    opportunities=[...(data?.opportunities??[])].sort((a,b)=>Number(b.eligible)-Number(a.eligible)
      ||(b.environmentPriority??0)-(a.environmentPriority??0)
      ||(b.environmentScore??b.score)-(a.environmentScore??a.score)||b.score-a.score),
    positions=[...(data?.positions??[])].sort((a,b)=>{
      const aa=a.profitLifecycle?.action??(a.positionIntelligence?.decision==="EXIT"?"EXIT":a.positionIntelligence?.decision==="REVIEW"?"WATCH":"HOLD"),
        ba=b.profitLifecycle?.action??(b.positionIntelligence?.decision==="EXIT"?"EXIT":b.positionIntelligence?.decision==="REVIEW"?"WATCH":"HOLD");
      return actionRank(ba)-actionRank(aa);
    }),
    currentEvolution=data?.environmentRouter?.phase??opportunities.find(o=>o.marketEvolutionPhase)?.marketEvolutionPhase,
    lifecycleText=lifecycleNarrative(data?.latestReason),
    hypothesisResearch=data?.hypothesisResearch,hypotheses=hypothesisResearch?.active??[],
    environmentRouter=data?.environmentRouter,
    entryValidations=data?.entryValidation?.records??[],
    validationById=new Map(entryValidations.map(v=>[v.candidateId,v])),
    waitingValidations=entryValidations.filter(v=>v.status==="WAITING"),
    cancelledValidations=entryValidations.filter(v=>v.status==="CANCELLED"),
    actionable=opportunities.filter(o=>o.eligible),
    candidateRows=(actionable.length?actionable:opportunities).slice(0,8);

  return <div className="fr-execution-page">
    <section className="fr-page-title fr-exec-title">
      <small>MARKET INTELLIGENCE 1.1 · EXECUTION</small>
      <h1>执行</h1>
      <p>先看当前仓位怎么处理，再看市场正在变成什么、下一笔机会处于什么阶段。研究细节和运行状态按重要性向下展开。</p>
    </section>

    <section className="fr-section fr-exec-primary">
      <div className="fr-section-head"><div><small>NOW · 持仓自己的理由</small><h2>当前持仓与系统动作</h2>
        <p>打开页面第一眼只回答：现在持有什么，系统准备怎么处理。</p></div><span>{positions.length} 笔持仓</span></div>
      {positions.length?<div className="fr-exec-position-grid">{positions.map(t=>{
        const p=t.positionIntelligence,l=t.profitLifecycle,
          currentAction=l?.action??(p?.decision==="EXIT"?"EXIT":p?.decision==="REVIEW"?"WATCH":"HOLD");
        return <article className={`fr-exec-position-card ${actionClass(currentAction)}`} key={t.id}>
          <header className="fr-exec-position-head"><div><small>{side(t.side)}</small><h3>{t.symbol.replace("_"," / ")}</h3></div>
            <span className={`fr-exec-action ${actionClass(currentAction)}`}><b>{action(currentAction)}</b><small>{profitPhase(l?.phase)}</small></span></header>
          <div className="fr-exec-metrics">
            <span><small>峰值净幅</small><b>{pct(l?.peakNetRate)}</b></span>
            <span><small>当前净幅</small><b>{pct(l?.currentNetRate)}</b></span>
            <span><small>利润回吐</small><b>{typeof l?.givebackRatio==="number"?fmt(l.givebackRatio*100,0)+"%":"—"}</b></span>
            <span><small>利润平台/保护</small><b>{Math.max(l?.platformFloorRate??0,l?.floorRate??0)>0?pct(Math.max(l?.platformFloorRate??0,l?.floorRate??0)):"未启动"}</b></span>
          </div>
          <p className="fr-exec-judgement"><b>研究判断：</b>{l?.reason??p?.summary??"Position Intelligence 正在建立这笔仓位自己的连续观察基线。"}</p>
          {l?.platformKind&&l.platformKind!=="NONE"&&<p className="fr-trade-reason"><b>{l.platformKind==="RUNNER"?"Runner利润平台":"已证明利润平台"}：</b>{l.platformReason}</p>}
          <details className="fr-exec-research-details"><summary>查看这笔仓位的研究依据</summary>
            {t.entryContext?.playbook&&<p><b>入场环境：</b>{environmentName(t.entryContext.environment)} · {playbookName(t.entryContext.playbook)} · {routeAlignment(t.entryContext.routeAlignment)} · 风险缩放 {fmt((t.entryContext.environmentRiskScale??1)*100,0)}%</p>}
            <p><b>入场假设：</b>{t.entryContext?.thesisSummary??t.entryContext?.reason??"历史兼容持仓"}</p>
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
      <div className="fr-exec-market-hero"><div><small>当前演化阶段</small><strong>{evolution(currentEvolution)}</strong></div><p>{lifecycleText}</p></div>
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
      <div className="fr-section-head"><div><small>ENVIRONMENT ROUTER</small><h2>当前市场环境与交易打法</h2>
        <p>环境不会决定“停不停单”，而是决定现在靠什么方式赚钱、用多大风险、需要什么入场证明。</p></div>
        <span>{environmentName(environmentRouter?.currentEnvironment)}</span></div>
      <div className="fr-exec-market-grid">
        <span><small>当前环境</small><b>{environmentName(environmentRouter?.currentEnvironment)}</b></span>
        <span><small>稳定阶段</small><b>{evolution(environmentRouter?.phase)} · {environmentRouter?.trendSide?side(environmentRouter.trendSide):"无单边主线"}</b></span>
        <span><small>活跃打法</small><b>{environmentRouter?.activePlaybooks?.length?environmentRouter.activePlaybooks.map(playbookName).join(" / "):"等待候选"}</b></span>
        <span><small>连续亏损应对</small><b>缩风险 + 加强证明</b></span>
        <span><small>是否允许交易</small><b>始终保留参与权</b></span>
      </div>
      <p className="fr-exec-judgement"><b>环境判断：</b>{environmentRouter?.reason??"正在建立环境路由判断。"}</p>
      {!!environmentRouter?.performance?.length&&<div className="fr-journal">{environmentRouter.performance.slice(0,4).map(p=><article key={p.key}>
        <time>{p.trades} 笔</time><div><b>{environmentName(p.environment)} · {playbookName(p.playbook)}</b>
          <p>胜 {p.wins} · 累计风险单位 {fmt(p.netRiskUnits,2)}R · 当前连亏 {p.lossStreak}</p></div>
      </article>)}</div>}
    </section>

    <section className="fr-section fr-hypothesis-section">
      <div className="fr-section-head"><div><small>FORWARD RESEARCH</small><h2>研究层正在提前推演什么</h2>
        <p>重要细节不会只停留在“现在发生了什么”，而会形成5 / 15 / 30分钟可验证的未来状态假设；后续数据会持续确认或否定。</p></div>
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
          {v.playbook&&<p><b>{environmentName(v.environment)} · {playbookName(v.playbook)}</b></p>}
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
        <summary><span className="fr-exec-candidate-rank">#{index+1}</span><div className="fr-exec-candidate-main"><div><b>{o.symbol.replace("_"," / ")}</b><small>{side(o.side)} · {o.mode}</small></div>
          <strong>{opportunityPhase(o.opportunityLifecyclePhase)}</strong></div>
          <div className="fr-exec-candidate-metrics"><span><small>环境评分</small><b>{fmt(o.environmentScore??o.score,0)}</b></span><span><small>净空间</small><b>{pct(o.netRemainingSpaceRate)}</b></span>
            <span><small>空间/回撤</small><b>{fmt(o.edgeRatio,2)}×</b></span></div>
          <em>{entryState}</em></summary>
        <div className="fr-score-details"><p><b>机会阶段：</b>{opportunityPhase(o.opportunityLifecyclePhase)} · 市场阶段 {evolution(o.marketEvolutionPhase)}</p>
          {o.playbook&&<p><b>环境打法：</b>{environmentName(o.environment)} · {playbookName(o.playbook)} · {routeAlignment(o.routeAlignment)} · 风险 {fmt((o.environmentRiskScale??1)*100,0)}%</p>}
          {o.environmentReason&&<p><b>路由理由：</b>{o.environmentReason}</p>}
          {v&&<p><b>入场执行：</b>{entryState} · {v.reason??"等待实时响应。"}</p>}
          {o.lifecycleReason&&<p><b>生命周期：</b>{o.lifecycleReason}</p>}
          {o.futureResearchReason&&<p><b>前瞻研究：</b>{researchAction(o.futureResearchAction)} · {o.futureResearchReason}</p>}
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
