"use client";

import {BEIJING_TIME_ZONE} from "../lib/beijing-time.ts";
import {type forwardSummary} from "../lib/forward-relations.ts";
import {tradePaidNetPnl} from "../lib/paid-fee-view.ts";
import {exitShort} from "./order-card.tsx";
import "./pages.css";

/* 执行页：第一眼只回答四件事——现在是什么市场、实盘开没开、手上有什么仓、刚刚做了什么。
 * 没开仓的候选和等待触发的计划只记在运行日志里，这里不读也不显示（数据本身一条不少）。 */
type View=ReturnType<typeof forwardSummary>;
type Trade=View["positions"][number];
type LiveOverview={operational:boolean;lastSyncAt:number|null;positionCount:number};
const bias=(v?:string)=>v==="BULLISH"?"偏多":v==="BEARISH"?"偏空":v?"中性":"待确认";
const biasTone=(v?:string)=>v==="BULLISH"?" is-long":v==="BEARISH"?" is-short":"";
const evolution=(v?:string)=>({
  ROTATIONAL:"轮动/震荡",TREND_FORMING:"趋势正在形成",EXPANDING:"方向正在扩张",STABLE_TREND:"稳定趋势",
  DECAYING:"趋势正在衰退",TRANSITIONAL:"状态正在切换"
}[v??""]??"状态建立中");
const environmentName=(v?:string)=>({TREND:"趋势环境",TRANSITION:"过渡环境",ROTATION:"轮动/震荡",SHOCK:"同步爆发行情"}[v??""]??"环境建立中");
const tradePlanName=(v?:string)=>({
  WINNER_TREND:"独立趋势",RANGE_REVERSION:"边缘回归",LIQUIDITY_MIGRATION:"流动性迁移",LIQUIDITY_REJECTION:"离开失败回归",FAMILY_TURN:"家族提前转折",OBSERVE_ONLY:"只观察"
}[v??""]??"历史计划");
export const clock=(v?:number|null)=>v?new Date(v).toLocaleTimeString("zh-CN",{timeZone:BEIJING_TIME_ZONE,hour12:false}):"—";
export const stamp=(v?:number|null)=>v?new Date(v).toLocaleString("zh-CN",{timeZone:BEIJING_TIME_ZONE,month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}):"—";
const pressure=(v?:number)=>typeof v!=="number"?"待确认":v>=.65?"高":v>=.45?"上升中":"低";
const fmt=(v:number|null|undefined,d=2)=>typeof v==="number"&&Number.isFinite(v)?v.toLocaleString("en-US",{minimumFractionDigits:d,maximumFractionDigits:d}):"—";
export const signed=(v:number|null|undefined,d=2)=>typeof v==="number"&&Number.isFinite(v)?`${v>=0?"+":""}${fmt(v,d)}`:"—";
export const tone=(v:number|null|undefined)=>typeof v!=="number"||!Number.isFinite(v)||v===0?"":v>0?"fr-positive":"fr-negative";
export const held=(start?:number|null,end?:number|null)=>{if(!start||!end)return "";const m=Math.floor(Math.max(0,end-start)/60000);return m<1?"<1分钟":m>=60?`${Math.floor(m/60)}小时${m%60}分`:`${m}分钟`;};
export const safePnl=(t:Trade)=>{try{return tradePaidNetPnl(t);}catch{return null;}};

/** One line of the old router's market read (the owner 大脑 page folds it into "旧系统参考"). */
export function legacyMarketLine(data:View|null){
  const phase=data?.environmentRouter?.phase??data?.opportunities?.find(o=>o.marketEvolutionPhase)?.marketEvolutionPhase;
  return `${environmentName(data?.environmentRouter?.currentEnvironment)} · ${evolution(phase)}：${marketChangeText(data)}`;
}
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
function positionAction(t:Trade){
  if(t.winnerManagement?.research){
    const m=t.winnerManagement;
    return m.appliedAction==="EXIT"?"准备退出":m.appliedAction==="REDUCE"?"已部分兑现":m.research!.level==="MARKET_CAUTION"?"预警但继续持有":m.research!.level==="LOCAL_REVIEW"||m.research!.level==="PROTECT"?"复核本币变化":"继续持有";
  }
  const d=t.positionIntelligence?.decision;
  return d==="EXIT"?"准备退出":d==="REVIEW"?"重点复核":"继续持有";
}
function positionWatch(t:Trade){
  if(t.winnerManagement)return t.winnerManagement.reason;
  const plan=t.liquidityLifecycle?.currentPlan??t.entryContext?.tradePlan,concern=t.positionIntelligence?.concerns?.[0];
  if(concern)return concern;
  if(t.positionIntelligence?.decision==="EXIT")return t.positionIntelligence?.summary??"原交易假设失效，准备退出。";
  if(plan==="LIQUIDITY_MIGRATION")return"观察向目标区域推进；接近目标或回到原区域时复核。";
  if(plan==="LIQUIDITY_REJECTION")return"观察向区域内回归；再次有效离开则复核。";
  if(plan==="FAMILY_TURN")return"观察相关币是否持续共同转向。";
  return t.positionIntelligence?.summary??"观察原入场理由是否仍成立。";
}
export function Coin({symbol,side}:{symbol:string;side:string}){
  const [base,quote]=(symbol??"").split("_");
  return <span className="oc-name"><b>{base}</b>{quote&&<small>/{quote}</small>}<i className={`oc-side ${side==="LONG"?"is-long":"is-short"}`}>{side==="LONG"?"多":"空"}</i></span>;
}

export default function MarketIntelligenceExecution({data,now,liveEnabled=false,liveOverview,healthy,systemStatus,feedAt,floating,onOpenOrders}:{
  data:View|null;now:number;liveEnabled?:boolean;liveOverview?:LiveOverview;
  healthy?:boolean;systemStatus?:string;feedAt?:number|null;floating?:number|null;onOpenOrders?:()=>void;
}){
  const mi=data?.marketIntelligence,n=mi?.narrative,
    positions=[...(data?.positions??[])].filter(t=>!t.inverseCopy),
    recent=[...(data?.history??[])].filter(t=>!t.inverseCopy).sort((a,b)=>(b.closedAt??0)-(a.closedAt??0)).slice(0,5),
    currentEvolution=data?.environmentRouter?.phase??data?.opportunities?.find(o=>o.marketEvolutionPhase)?.marketEvolutionPhase,
    currentEnvironment=data?.environmentRouter?.currentEnvironment,
    outlook=data?.environmentRouter?.outlook,
    clockNow=now||data?.updatedAt||0;
  const liveText=!liveEnabled?"关闭":liveOverview?.operational?"运行中":"核对中";
  const liveNote=!liveEnabled?"只跑模拟，不下单":`实盘持仓 ${liveOverview?.positionCount??0} 笔`;

  return <div className="fr-execution-page pg-exec">
    <section className="pg-card" data-testid="market-command-summary">
      <header><small>当前市场</small><time>更新 {clock(mi?.updatedAt)}</time></header>
      <strong className="pg-title">{environmentName(currentEnvironment)} · {evolution(currentEvolution)}</strong>
      <div className="pg-chips">
        <span className={`pg-chip${biasTone(n?.major.bias)}`}><small>大方向</small>{bias(n?.major.bias)}</span>
        <span className={`pg-chip${biasTone(n?.short.bias)}`}><small>短期</small>{bias(n?.short.bias)}</span>
        <span className="pg-chip"><small>转变压力</small>{pressure(outlook?.transitionPressure)}</span>
      </div>
      <div className="pg-lines">
        <p><span>正在发生</span>{marketChangeText(data)}</p>
        <p><span>接下来可能</span>{nextMarketText(data)}{outlook?.horizonMinutes?`（观察窗口 ${outlook.horizonMinutes} 分钟）`:""}</p>
      </div>
    </section>

    <div className="pg-tiles" data-testid="execution-status">
      <div><small>实盘</small><b className={liveEnabled&&liveOverview?.operational?"fr-positive":undefined}>{liveText}</b><p>{liveNote}</p></div>
      <div><small>模拟持仓</small><b>{data?`${positions.length} 笔`:"—"}</b><p className={tone(floating)}>{positions.length?`浮动 ${signed(floating)} U`:"空仓"}</p></div>
      <div><small>系统</small><b className={healthy?"fr-positive":healthy===false?"fr-negative":undefined}>{systemStatus??"—"}</b><p>行情 {clock(feedAt)}</p></div>
    </div>

    <div className="pg-desk">
      <section className="pg-section" data-testid="execution-positions">
        <h2>正在持仓<small>{positions.length} 笔</small></h2>
        {positions.length?<div className="pg-list">{positions.map(t=>{const pnl=safePnl(t);return <article className="pg-row" key={t.id}>
          <div className="oc-line"><Coin symbol={t.symbol} side={t.side}/><b className={`oc-pnl ${tone(pnl)}`}>{signed(pnl)} U</b></div>
          <div className="oc-line oc-sub"><span>{tradePlanName(t.liquidityLifecycle?.currentPlan??t.entryContext?.tradePlan)} · 已拿 {held(t.openedAt,clockNow)||"—"}</span><i className="pg-tag">{positionAction(t)}</i></div>
          <p className="pg-watch">{positionWatch(t)}</p>
          {t.entryContext?.winnerPlan&&<p className="pg-plan">{planText(t.entryContext.winnerPlan,t.stopPrice)}</p>}
        </article>;})}</div>:<div className="pg-empty">现在空仓。条件成立时会自动开仓。</div>}
      </section>

      <section className="pg-section" data-testid="execution-recent">
        <h2>最近成交<small>最新 {recent.length} 笔</small></h2>
        {recent.length?<div className="pg-recent">{recent.map(t=><div key={t.id}>
          <span><Coin symbol={t.symbol} side={t.side}/><small>{exitShort(t.exitReason,"已平仓")} · {stamp(t.closedAt)}</small></span>
          <strong className={tone(t.netPnl)}>{signed(t.netPnl)} U<small>{held(t.openedAt,t.closedAt)}</small></strong>
        </div>)}</div>:<div className="pg-empty">还没有已平订单。</div>}
        {onOpenOrders&&<button type="button" className="pg-link" onClick={onOpenOrders}>查看全部模拟订单 →</button>}
      </section>
    </div>
    <p className="pg-foot">没开仓的候选只记在运行日志里，这里不再显示；导出运行日志即可复盘。</p>
  </div>;
}
