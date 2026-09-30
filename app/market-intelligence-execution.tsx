"use client";

import {BEIJING_TIME_ZONE} from "../lib/beijing-time.ts";
import {type forwardSummary} from "../lib/forward-relations.ts";

type View=ReturnType<typeof forwardSummary>;
const bias=(v?:string)=>v==="BULLISH"?"偏多":v==="BEARISH"?"偏空":"中性";
const evolution=(v?:string)=>({
  ROTATIONAL:"轮动/震荡",TREND_FORMING:"趋势正在形成",EXPANDING:"方向正在扩张",STABLE_TREND:"稳定趋势",
  DECAYING:"趋势正在衰退",TRANSITIONAL:"状态正在切换"
}[v??""]??"状态建立中");
const environmentName=(v?:string)=>({TREND:"趋势环境",TRANSITION:"过渡环境",ROTATION:"轮动/震荡",SHOCK:"同步爆发行情"}[v??""]??"环境建立中");
const tradePlanName=(v?:string)=>({
  LIQUIDITY_MIGRATION:"流动性迁移",LIQUIDITY_REJECTION:"离开失败回归",FAMILY_TURN:"家族提前转折",OBSERVE_ONLY:"只观察"
}[v??""]??"历史计划");
const liquidityState=(v?:string)=>({
  INSIDE:"仍在原区域积累",TESTING:"正在尝试离开",ACCEPTED:"离开已被市场接受",REJECTED:"离开失败并回归"
}[v??""]??"流动性状态建立中");
const side=(v?:string)=>v==="LONG"?"做多":v==="SHORT"?"做空":"方向观察";
const clock=(v?:number)=>v?new Date(v).toLocaleTimeString("zh-CN",{timeZone:BEIJING_TIME_ZONE,hour12:false}):"—";
const persistenceText=(v?:number)=>typeof v!=="number"?"持续性建立中":v>=.72?"当前状态较稳定":v>=.52?"当前状态还能维持，但已经需要防变化":"当前状态容易发生变化";
const transitionText=(v?:number)=>typeof v!=="number"?"转变压力建立中":v>=.65?"状态转变压力很高":v>=.45?"状态转变压力正在上升":"暂时没有很强的转变压力";
const windowText=(v?:number)=>v===60?"未来一段时间仍有较完整的延续空间":v===45?"未来一段时间仍可沿用当前判断，但要持续检查变化":
  v===30?"当前判断的有效时间正在缩短":v===15?"当前环境接近变化窗口，需要快速确认后续":"未来窗口建立中";
const profitText=(v?:string)=>v==="HIGH"?"如果方向延续，仍有较好的利润扩张空间":v==="LOW"?"利润扩张空间偏低，更重视确认和保护":
  v==="NORMAL"?"利润扩张空间一般，按市场推进情况处理":"利润扩张能力建立中";

type LiquidityView=NonNullable<View["marketIntelligence"]>["liquidity"];
function marketChangeText(liquidity:LiquidityView|undefined){
  const m=liquidity?.market;if(!m?.ready)return"流动性地图仍在建立；在覆盖完整前，系统继续沿用原研究层判断，不让未准备好的新模块改变市场结论。";
  if(m.acceptedShare>=.35){
    const direction=m.migrationBreadth>.10?"向上":m.migrationBreadth<-.10?"向下":"双向";
    return`越来越多市场已经离开原流动性区域并被接受，流动性正在${direction}迁移；系统重点确认这种迁移能否继续扩散。`;
  }
  if(m.highAccumulationShare>=.35&&m.oneSidedDepletionShare>=.25)
    return"不少市场已经积累较充分，而且同一侧边界开始持续被消耗；当前环境虽然还没完全改变，但转变条件正在形成。";
  if(m.insideShare>=.55&&m.rejectedShare>=.12)
    return"多数市场仍被原流动性区域吸住，离开尝试又经常失败，说明当前更像继续积累和轮动，而不是已经进入稳定趋势。";
  if(m.testingShare>=.25)return"不少市场正在试图离开原流动性区域，但市场是否接受新价格还没有形成一致答案；系统正在等这一步确认。";
  return"市场仍处在积累、试探和局部迁移并存的阶段，还没有出现足够统一的流动性变化。";
}

function nextMarketText(data:View|null){
  const n=data?.marketIntelligence?.narrative,o=data?.environmentRouter?.outlook,liq=data?.marketIntelligence?.liquidity?.market;
  const base=`${persistenceText(o?.persistenceScore)}，${transitionText(o?.transitionPressure)}；${windowText(o?.horizonMinutes)}。`;
  if(liq?.ready&&liq.highAccumulationShare>=.35&&liq.oneSidedDepletionShare>=.25)
    return base+" 如果被持续消耗的一侧真正离开并被市场接受，市场可能从积累/震荡转入流动性迁移；如果再次被吸回，则继续震荡。";
  if(liq?.ready&&liq.acceptedShare>=.35)
    return base+" 如果当前迁移继续被更多市场接受，趋势有机会延续；当价格接近下一片主要流动性区域时，系统会降低扩张预期并重新评估。";
  return base+" "+profitText(o?.profitExpansion)+(n?.plan?" 当前系统计划："+n.plan:"");
}

function observeReason(o:View["opportunities"][number],state?:{departure?:{state?:string}}){
  const current=liquidityState(state?.departure?.state);
  if(o.tradePlan==="LIQUIDITY_MIGRATION")return`当前${current}；观察离开能否继续被市场接受，以及到下一片流动性是否仍有足够空间。`;
  if(o.tradePlan==="LIQUIDITY_REJECTION")return`当前${current}；观察价格是否继续被原区域重新吸收，并确认回归区域内部/另一侧的空间。`;
  if(o.tradePlan==="FAMILY_TURN")return`当前${current}；观察同家族是否继续共同反向，以及这个币自己的流动性结构是否继续配合。`;
  return`当前${current}；继续观察是否形成“流动性迁移、离开失败回归、家族提前转折”之一，纯相对强弱不会单独开仓。`;
}

function waitingReason(v:NonNullable<View["entryValidation"]>["records"][number],o?:View["opportunities"][number]){
  if(v.phase==="RETEST_WAIT")return"已经发现机会，但当前位置不追价；等待回调结束后重新启动。";
  if(v.stableThesis)return"方向和交易计划仍然有效，等待实时价格与流动性再次证明后执行。";
  return v.reason??(o?.tradePlan==="LIQUIDITY_MIGRATION"?"等待迁移继续被接受后执行。":"等待实时执行条件完成。");
}

function positionAction(t:View["positions"][number]){
  const d=t.positionIntelligence?.decision;
  return d==="EXIT"?"准备退出":d==="REVIEW"?"重点复核":"继续持有";
}

function positionWatch(t:View["positions"][number]){
  const plan=t.liquidityLifecycle?.currentPlan??t.entryContext?.tradePlan,concern=t.positionIntelligence?.concerns?.[0];
  if(t.positionIntelligence?.decision==="EXIT")return concern??t.positionIntelligence?.summary??"原交易假设已经失效，按退出计划处理。";
  if(plan==="LIQUIDITY_MIGRATION")
    return (concern?concern+"；":"")+"观察价格是否继续留在原区域之外并向下一片流动性迁移；接近目标或重新被原区域吸收时重新评估/保护利润。";
  if(plan==="LIQUIDITY_REJECTION")
    return (concern?concern+"；":"")+"观察价格是否继续回到原流动性区域；如果再次向原突破方向离开并被接受，回归计划失效。";
  if(plan==="FAMILY_TURN")
    return (concern?concern+"；":"")+"观察相关家族是否继续共同反向；如果同方向迁移被市场接受，原仓位可升级为流动性迁移，反之进入复核。";
  return concern??t.positionIntelligence?.summary??"继续观察原入场理由是否仍然成立。";
}

export default function MarketIntelligenceExecution({data,now:_,liveEnabled,liveOverview}:{
  data:View|null;now:number;liveEnabled:boolean;liveOverview?:{operational:boolean;lastSyncAt:number|null;positionCount:number};
}){
  const mi=data?.marketIntelligence,n=mi?.narrative,liquidity=mi?.liquidity,
    opportunities=[...(data?.opportunities??[])].sort((a,b)=>Number(b.eligible)-Number(a.eligible)||b.score-a.score),
    positions=[...(data?.positions??[])],
    entryValidations=data?.entryValidation?.records??[],
    waitingValidations=entryValidations.filter(v=>v.status==="WAITING"),
    waitingByCandidate=new Map(waitingValidations.map(v=>[v.candidateId,v])),
    preparedWithoutValidation=opportunities.filter(o=>o.eligible&&!waitingByCandidate.has(o.id)).slice(0,6),
    observed=opportunities.filter(o=>!o.eligible&&!waitingByCandidate.has(o.id)).slice(0,6),
    currentEvolution=data?.environmentRouter?.phase??opportunities.find(o=>o.marketEvolutionPhase)?.marketEvolutionPhase,
    currentEnvironment=data?.environmentRouter?.currentEnvironment,
    systemPlan=n?.plan??"继续观察市场变化，只有交易计划和实时执行条件同时成立时才参与。";

  return <div className="fr-execution-page">
    <section className="fr-section fr-exec-primary">
      <div className="fr-section-head"><div><small>MARKET COMMAND CENTER</small><h2>市场作战总览</h2>
        <p>一个板块只回答四件事：市场现在是什么、正在发生什么、接下来可能发生什么、系统此刻在干什么。</p></div>
        <span>研究更新 {clock(mi?.updatedAt)}</span></div>

      <div className="fr-exec-market-hero"><div><small>当前全局状态</small>
        <strong>{environmentName(currentEnvironment)} · {evolution(currentEvolution)}</strong></div>
        <p>大方向{bias(n?.major.bias)}，短期{bias(n?.short.bias)}。{n?.transition.detail??n?.summary??"市场研究层正在建立完整判断。"}</p></div>

      <div className="fr-command-snapshot">
        <div><small>当前市场</small><b>{environmentName(currentEnvironment)}，大方向{bias(n?.major.bias)}，短期{bias(n?.short.bias)}；系统不会因为小周期噪声频繁翻转全局判断。</b></div>
        <div><small>正在发生</small><b>{marketChangeText(liquidity)}</b></div>
        <div><small>接下来可能</small><b>{nextMarketText(data)}</b></div>
      </div>
      <p className="fr-trade-reason"><b>系统当前计划：</b>{systemPlan}</p>

      <div className="fr-journal">
        <article><time>正在观察 · {observed.length}</time><div><b>系统正在研究哪些币，以及具体在等什么</b>
          {observed.length?observed.map(o=><p key={o.id}><b>{o.symbol.replace("_"," / ")} · {side(o.side)} · {tradePlanName(o.tradePlan)}</b><br/>
            {observeReason(o,liquidity?.symbols?.[o.symbol])}</p>)
            :<p>当前没有需要单独列出的重点观察币；系统仍在全市场扫描新的流动性变化。</p>}
        </div></article>

        <article><time>等待执行 · {waitingValidations.length+preparedWithoutValidation.length}</time><div><b>已经接近执行条件的币，只显示还缺什么</b>
          {waitingValidations.map(v=>{const o=opportunities.find(x=>x.id===v.candidateId);return <p key={v.id}><b>{v.symbol.replace("_"," / ")} · {side(v.side)} · {tradePlanName(o?.tradePlan)}</b><br/>
            {waitingReason(v,o)}</p>})}
          {preparedWithoutValidation.map(o=><p key={o.id}><b>{o.symbol.replace("_"," / ")} · {side(o.side)} · {tradePlanName(o.tradePlan)}</b><br/>
            研究条件已经成立，等待进入实时价格响应确认；如果位置已经走远，系统会等回调/重新启动而不是追价。</p>)}
          {!waitingValidations.length&&!preparedWithoutValidation.length&&<p>当前没有进入执行等待的币；系统还在研究和筛选阶段。</p>}
        </div></article>

        <article><time>正在持仓 · {positions.length}</time><div><b>每笔持仓只显示下一步该观察什么、准备做什么</b>
          {positions.length?positions.map(t=><p key={t.id}><b>{t.symbol.replace("_"," / ")} · {side(t.side)} · {tradePlanName(t.liquidityLifecycle?.currentPlan??t.entryContext?.tradePlan)} · {positionAction(t)}</b><br/>
            接下来观察：{positionWatch(t)}</p>)
            :<p>当前没有持仓；系统只在研究和等待执行，不会为了保持仓位数量而强行开单。</p>}
        </div></article>
      </div>

      <p className="fr-note">系统状态：流动性地图 {liquidity?.market?.ready?"已进入正式研究":"仍在建立"} ·
        实盘 {liveEnabled?(liveOverview?.operational?"正常运行":"已请求开启，等待执行链就绪"):"关闭"} ·
        PAPER→LIVE 复制逻辑和交易策略本身没有因为这次页面精简而改变。</p>
    </section>
  </div>;
}
