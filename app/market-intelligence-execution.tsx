"use client";

import {BEIJING_TIME_ZONE} from "../lib/beijing-time.ts";
import {type forwardSummary} from "../lib/forward-relations.ts";

type View=ReturnType<typeof forwardSummary>;
const bias=(v?:string)=>v==="BULLISH"?"偏多":v==="BEARISH"?"偏空":v?"中性":"待确认";
const evolution=(v?:string)=>({
  ROTATIONAL:"轮动/震荡",TREND_FORMING:"趋势正在形成",EXPANDING:"方向正在扩张",STABLE_TREND:"稳定趋势",
  DECAYING:"趋势正在衰退",TRANSITIONAL:"状态正在切换"
}[v??""]??"状态建立中");
const environmentName=(v?:string)=>({TREND:"趋势环境",TRANSITION:"过渡环境",ROTATION:"轮动/震荡",SHOCK:"同步爆发行情"}[v??""]??"环境建立中");
const tradePlanName=(v?:string)=>({
  WINNER_TREND:"独立趋势",RANGE_REVERSION:"边缘回归",LIQUIDITY_MIGRATION:"流动性迁移",LIQUIDITY_REJECTION:"离开失败回归",FAMILY_TURN:"家族提前转折",OBSERVE_ONLY:"只观察"
}[v??""]??"历史计划");
const liquidityState=(v?:string)=>({
  INSIDE:"仍在原区域",TESTING:"正在尝试离开",ACCEPTED:"离开已被接受",REJECTED:"离开失败并回归"
}[v??""]??"流动性状态待确认");
const side=(v?:string)=>v==="LONG"?"做多":v==="SHORT"?"做空":"方向观察";
const clock=(v?:number)=>v?new Date(v).toLocaleTimeString("zh-CN",{timeZone:BEIJING_TIME_ZONE,hour12:false}):"—";
const pressure=(v?:number)=>typeof v!=="number"?"待确认":v>=.65?"高":v>=.45?"上升中":"低";

function marketChangeText(data:View|null){
  const n=data?.marketIntelligence?.narrative;
  if(!n)return"市场状态建立中。";
  if(n.major.bias==="BULLISH"&&n.short.bias==="BEARISH")return"大方向偏多，短期承压；分别观察各币承接。";
  if(n.major.bias==="BEARISH"&&n.short.bias==="BULLISH")return"大方向偏空，短期反弹；分别观察各币恢复。";
  return `大方向${bias(n.major.bias)}，短期${bias(n.short.bias)}；持续比较各币自身推进。`;
}
function nextMarketText(data:View|null){
  const now=data?.updatedAt??0,active=[...(data?.hypothesisResearch?.active??[])].filter(h=>h.updatedAt<=now&&now-h.updatedAt<=15*60_000&&h.expiresAt>now)
    .sort((a,b)=>Number(b.status==="CONFIRMED")-Number(a.status==="CONFIRMED")||b.confidence-a.confidence),h=active[0];
  return h?`${h.status==="CONFIRMED"?"已持续确认":"仍在观察"}：${h.thesis}`:"暂无持续确认的新变化，按各笔原计划执行。";
}
function planText(p:View["opportunities"][number]["winnerPlan"],stop?:number){
  if(!p)return"";
  const fmt=(v:number)=>Number(v.toPrecision(7)).toString(),a=p.origin;
  return `${a?`本单参考区 ${fmt(a.lower)}–${fmt(a.upper)}`:"本单区域未知"} · ${stop==null?"失败价":"当前保护"} ${fmt(stop??p.initialStop)}${p.intent==="RANGE"&&p.target!=null?` · 回归目标 ${fmt(p.target)}`:""}`;
}

function observeReason(o:View["opportunities"][number],state?:{departure?:{state?:string}}){
  const current=liquidityState(state?.departure?.state);
  if(o.winnerPlan)return o.winnerPlan.intent==="TREND"?"观察独立推进与回调承接；区域只辅助位置，不必等待整体突破。":"观察边缘拒绝后的回归；目标为原量价重心，不默认横穿区域。";
  if(o.tradePlan==="LIQUIDITY_MIGRATION")return`${current}；等待持续站稳及足够目标空间。`;
  if(o.tradePlan==="LIQUIDITY_REJECTION")return`${current}；等待重新回到区域内及足够回归空间。`;
  if(o.tradePlan==="FAMILY_TURN")return`${current}；等待相关币共同转向与本币结构确认。`;
  return`${current}；尚无确认的入场计划。`;
}

function waitingReason(v:NonNullable<View["entryValidation"]>["records"][number],o?:View["opportunities"][number]){
  if(v.phase==="RETEST_WAIT")return"等回调重启；当前位置不追价。";
  if(o?.winnerPlan?.entryResearch?.entryAction==="CONFIRM_MORE")return"研究预警持续；补足本币实时响应，不追价。";
  if(v.stableThesis)return"已武装；等待实时价格确认。";
  return v.reason??(o?.tradePlan==="LIQUIDITY_MIGRATION"?"等待迁移持续确认。":"等待执行条件完成。");
}

function positionAction(t:View["positions"][number]){
  if(t.inverseCopy)return"仅跟随影子";
  if(t.winnerManagement?.research){
    const m=t.winnerManagement;
    return m.appliedAction==="EXIT"?"准备退出":m.appliedAction==="REDUCE"?"已部分兑现":m.research!.level==="MARKET_CAUTION"?"预警但继续持有":m.research!.level==="LOCAL_REVIEW"||m.research!.level==="PROTECT"?"复核本币变化":"继续持有";
  }
  const d=t.positionIntelligence?.decision;
  return d==="EXIT"?"准备退出":d==="REVIEW"?"重点复核":"继续持有";
}

function positionWatch(t:View["positions"][number]){
  if(t.inverseCopy)return `影子${t.inverseCopy.sourceSide==="LONG"?"做多":"做空"}，模拟反向；源单退出参考 ${t.inverseCopy.sourceStopPrice}。`;
  if(t.winnerManagement)return t.winnerManagement.reason;
  const plan=t.liquidityLifecycle?.currentPlan??t.entryContext?.tradePlan,concern=t.positionIntelligence?.concerns?.[0];
  if(concern)return concern;
  if(t.positionIntelligence?.decision==="EXIT")return t.positionIntelligence?.summary??"原交易假设失效，准备退出。";
  if(plan==="LIQUIDITY_MIGRATION")return"观察向目标区域推进；接近目标或回到原区域时复核。";
  if(plan==="LIQUIDITY_REJECTION")return"观察向区域内回归；再次有效离开则复核。";
  if(plan==="FAMILY_TURN")return"观察相关币是否持续共同转向。";
  return t.positionIntelligence?.summary??"观察原入场理由是否仍成立。";
}

export default function MarketIntelligenceExecution({data,now:_,liveEnabled,liveOverview}:{
  data:View|null;now:number;liveEnabled:boolean;liveOverview?:{operational:boolean;lastSyncAt:number|null;positionCount:number};
}){
  const mi=data?.marketIntelligence,n=mi?.narrative,liquidity=mi?.liquidity,
    opportunities=[...(data?.opportunities??[])].sort((a,b)=>Number(b.eligible)-Number(a.eligible)||b.score-a.score),
    positions=[...(data?.positions??[])],
    heldSymbols=new Set(positions.map(t=>t.symbol)),
    entryValidations=data?.entryValidation?.records??[],
    waitingValidations=entryValidations.filter(v=>v.status==="WAITING"&&!heldSymbols.has(v.symbol)),
    waitingByCandidate=new Map(waitingValidations.map(v=>[v.candidateId,v])),
    queuedForAuthorization=opportunities.filter(o=>o.eligible&&!heldSymbols.has(o.symbol)&&!waitingByCandidate.has(o.id)),
    observed=[...queuedForAuthorization,...opportunities.filter(o=>!o.eligible&&!heldSymbols.has(o.symbol)&&!waitingByCandidate.has(o.id))].slice(0,8),
    currentEvolution=data?.environmentRouter?.phase??opportunities.find(o=>o.marketEvolutionPhase)?.marketEvolutionPhase,
    currentEnvironment=data?.environmentRouter?.currentEnvironment,
    outlook=data?.environmentRouter?.outlook;

  return <div className="fr-execution-page">
    <section className="fr-section fr-exec-primary">
      <div className="fr-section-head"><h2>市场作战总览</h2><span>研究更新 {clock(mi?.updatedAt)}</span></div>
      <div className="fr-exec-market-hero"><div><small>当前市场</small>
        <strong>{environmentName(currentEnvironment)} · {evolution(currentEvolution)}</strong></div>
        <p>大方向{bias(n?.major.bias)} · 短期{bias(n?.short.bias)}</p></div>
      <div className="fr-command-snapshot" data-testid="market-command-summary">
        <div><small>正在发生</small><b>{marketChangeText(data)}</b></div>
        <div><small>接下来可能</small><b>{nextMarketText(data)}</b></div>
        <div><small>转变压力</small><b>{pressure(outlook?.transitionPressure)}{outlook?.horizonMinutes?` · 观察窗口 ${outlook.horizonMinutes} 分钟`:""}</b></div>
      </div>
      <div className="fr-journal">
        <article><time>正在观察 · {observed.length}</time><div>
          {observed.length?observed.map(o=><p key={o.id}><b>{o.symbol.replace("_"," / ")} · {side(o.side)} · {tradePlanName(o.tradePlan)}</b><br/>
            {o.eligible&&!waitingByCandidate.has(o.id)?"条件已成立，等待执行队列。":observeReason(o,liquidity?.symbols?.[o.symbol])}</p>):<p>暂无重点观察标的。</p>}
        </div></article>
        <article><time>等待执行 · {waitingValidations.length}{data?.shadowInverse?" · 影子决策，模拟反向":""}</time><div>
          {waitingValidations.map(v=>{const o=v.frozenOpportunity??opportunities.find(x=>x.id===v.candidateId);return <p key={v.id}><b>{v.symbol.replace("_"," / ")} · {side(v.side)} · {tradePlanName(o?.tradePlan)}</b><br/>
            {waitingReason(v,o)}{o?.winnerPlan&&<><br/><small>{planText(o.winnerPlan)}</small></>}</p>})}
          {!waitingValidations.length&&<p>暂无已武装计划。</p>}
        </div></article>
        <article><time>{liveEnabled?'影子信号持仓':'正在持仓'} · {positions.length}</time><div>
          {positions.length?positions.map(t=><p key={t.id}><b>{t.symbol.replace("_"," / ")} · {side(t.side)} · {tradePlanName(t.liquidityLifecycle?.currentPlan??t.entryContext?.tradePlan)} · {positionAction(t)}</b><br/>
            {positionWatch(t)}{t.entryContext?.winnerPlan&&<><br/><small>{planText(t.entryContext.winnerPlan,t.stopPrice)}</small></>}</p>):<p>暂无持仓。</p>}
        </div></article>
      </div>
      <p className="fr-note">实盘 {liveEnabled?(liveOverview?.operational?"运行中":"等待核对"):"关闭"}{liveEnabled?' · 成交、实际持仓及盈亏以同步账户为准':''}</p>
    </section>
  </div>;
}
