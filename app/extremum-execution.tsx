"use client";

import type {Trade,forwardSummary} from "../lib/forward-relations.ts";

type View=ReturnType<typeof forwardSummary>;
type LiveOverview={equity:number|null;available:number|null;positionCount:number;operational:boolean;lastSyncAt:number|null;copied:number|null;eligible:number|null;missing:number|null};
const fmt=(v:number|null|undefined,d=2)=>typeof v==="number"&&Number.isFinite(v)?v.toLocaleString("en-US",{minimumFractionDigits:d,maximumFractionDigits:d}):"—";
const signed=(v:number|null|undefined,d=2)=>typeof v==="number"&&Number.isFinite(v)?`${v>=0?"+":""}${fmt(v,d)}`:"—";
const regimeName=(v:string)=>({TREND_UP:"单边上涨",TREND_DOWN:"单边下跌",SWING:"震荡峰谷",WEAKENING:"趋势弱化",TRANSITION:"趋势切换"}[v]??v);
const stageName=(v:string)=>({WATCH:"观察",CANDIDATE:"极值候选",STRUCTURE_BREAK:"结构破坏",RECLAIM_TEST:"夺回测试",READY:"确认完成",IMPULSE:"强势推进"}[v]??v);
const modeName=(v:string)=>({SWING:"峰谷反转",TREND_PULLBACK:"趋势回调",IMPULSE:"单边追击"}[v]??v);
const exitName=(v:string|null)=>v?({STRUCTURE_STOP:"结构止损",PROFIT_GIVEBACK:"利润保护",ENTRY_FEEDBACK_FAILED:"入场后无正反馈",
  OPPOSITE_EXTREMUM:"相反峰谷确认",TREND_DEATH:"趋势死亡",EXTREMUM_PROFIT_EXIT:"极值利润退出",NO_PROGRESS:"长时间无进展",
  MAX_HOLD:"最大持仓时间",OPPORTUNITY_REPLACED:"更优机会替换",ACCOUNT_RESET:"手动重置"}[v]??v):"—";
const duration=(start:number,end:number|null|undefined,now:number)=>{const m=Math.floor(Math.max(0,(end??now)-start)/60000);
  return m<1?"<1分钟":m>=60?`${Math.floor(m/60)}小时${m%60}分`:`${m}分钟`;};

export default function ExtremumExecution({data,now,liveEnabled,liveOverview}:{data:View|null;now:number;liveEnabled:boolean;liveOverview?:LiveOverview}){
  const states=data?.extremumRegime?.symbols??[],counts=data?.extremumRegime?.counts,
    stateBySymbol=new Map(states.map(row=>[row.symbol,row] as const)),
    positions=data?.positions??[],
    opportunities=[...(data?.opportunities??[])].sort((a,b)=>Number(b.eligible)-Number(a.eligible)||b.score-a.score),
    eligible=opportunities.filter(o=>o.eligible&&(!now||o.expiresAt>now)),
    blockers=Object.entries(data?.entryDiagnostics?.reasons??{}).sort((a,b)=>b[1]-a[1]),
    ready=(counts?.ready??0)+(counts?.impulse??0),
    risk=positions.reduce((n,t)=>n+Math.max(t.plannedRisk,t.entryContext?.portfolioRiskCharge??0),0),
    riskUse=data?.equity?risk/data.equity:0,
    liveParity=liveEnabled?(liveOverview?.operational?"同步正常":"等待同步"):"实盘关闭";
  return <>
    <section className="fr-page-title"><small>EXTREMUM REGIME V1</small><h1>执行</h1>
      <p>5分钟判断市场状态，1分钟确认峰谷、回调结束和强势延续；顶部/底部决定位置，趋势生命决定保护利润还是允许反手。</p></section>

    <section className="fr-stats">
      <Stat label="正在分析" value={data?`${states.length} 个`:"—"} note="30市场扫描；没有足够完整结构时不会伪造状态"/>
      <Stat label="完成确认" value={data?`${ready} 个`:"—"} note={`READY ${counts?.ready??0} · 强势推进 ${counts?.impulse??0}`}/>
      <Stat label="当前持仓" value={data?`${positions.length} 笔`:"—"} note={`组合计划风险已用 ${fmt(riskUse*100,1)}%`}/>
      <Stat label="实盘同步" value={liveParity} note={liveEnabled?`复制 ${liveOverview?.copied??0} / 可复制 ${liveOverview?.eligible??0} · 缺失 ${liveOverview?.missing??0}`:"PAPER继续独立运行"}/>
    </section>

    <section className="fr-section fr-now-card"><div className="fr-section-head"><div><small>NOW</small><h2>系统现在在做什么</h2></div>
      <span>{eligible.length} 个可参与</span></div>
      <div className="fr-insight"><span className="fr-dot"/><p>{data?.latestReason??"等待交易核心状态。"}</p></div>
      <div className="fr-three"><div><small>趋势上涨</small><b>{counts?.trendUp??0}</b></div><div><small>趋势下跌</small><b>{counts?.trendDown??0}</b></div>
        <div><small>震荡 / 切换</small><b>{(counts?.swing??0)+(counts?.weakening??0)+(counts?.transition??0)}</b></div></div>
    </section>

    <section className="fr-section"><div className="fr-section-head"><div><small>MARKET STATE</small><h2>30市场状态</h2>
      <p>压力分数表示极值形成程度，生命分数表示原方向还能否继续；它们不是胜率。</p></div><span>{states.length} 个已建立结构</span></div>
      {states.length?<div className="fr-rule-grid">{states.map(row=><article className="fr-setting" key={row.symbol}><div>
        <h3>{row.symbol.replace("_"," / ")} · {regimeName(row.regime)}</h3><p>{row.nextAction}</p>
        <small>{stageName(row.stage)} · {row.sourceCount}源 · 分歧 {fmt(row.disagreementRate*100,3)}% · 路径效率 {fmt(row.pathEfficiency*100,0)}%</small>
      </div><div className="fr-score-detail-grid"><Metric label="顶部压力" value={fmt(row.topPressure,0)}/><Metric label="底部压力" value={fmt(row.bottomPressure,0)}/>
        <Metric label="上涨生命" value={fmt(row.upSurvival,0)}/><Metric label="下跌生命" value={fmt(row.downSurvival,0)}/></div></article>)}</div>
        :<Empty title="正在建立市场结构" text="等待足够的已完成5分钟数据；不会因为冷启动而伪造峰谷。"/>}
    </section>

    <section className="fr-section fr-scoreboard-section"><div className="fr-section-head"><div><small>ENTRY PIPELINE</small><h2>当前交易机会</h2>
      <p>候选必须完成对应结构事件，再通过实时Gate盘口、合约规格和组合风险检查才会真正开仓。</p></div><span>{eligible.length} 个可参与</span></div>
      {opportunities.length?<div className="fr-scoreboard">{opportunities.slice(0,18).map((o,index)=><details className={`fr-score-row ${o.eligible?"is-eligible":""}`} key={o.id}>
        <summary><span className="fr-score-rank">#{index+1}</span><span className="fr-score-value">{fmt(o.score,0)}</span>
          <span className="fr-score-symbol"><b>{o.symbol.replace("_"," / ")}</b><small>{o.side==="LONG"?"做多":"做空"} · {modeName(o.mode)}</small></span>
          <span><small>极值压力</small><b>{fmt(o.side==="LONG"?o.bottomPressure:o.topPressure,0)}</b></span>
          <span><small>趋势生命</small><b>{fmt(o.side==="LONG"?o.upSurvival:o.downSurvival,0)}</b></span>
          <span><small>确认阶段</small><b>{stageName(o.confirmationStage??"WATCH")}</b></span><em>{o.eligible?"可参与":"观察"}</em></summary>
        <div className="fr-score-details"><div><h3>执行条件</h3><div className="fr-score-detail-grid">
          <Metric label="净空间" value={`${fmt(o.netRemainingSpaceRate*100,2)}%`}/><Metric label="结构风险" value={`${fmt(o.pullbackRiskRate*100,2)}%`}/>
          <Metric label="空间 / 风险" value={`${fmt(o.edgeRatio,2)}×`}/><Metric label="预计持有" value={`${fmt(o.expectedHoldMinutes,0)} 分`}/></div></div>
          <p>{o.reason}</p></div>
      </details>)}</div>:<Empty title="当前没有完成确认的交易机会" text="趋势行情继续寻找回调/反弹或强势延续，震荡行情继续等待峰谷确认。"/>}
    </section>

    <section className="fr-section"><div className="fr-section-head"><div><small>POSITION LIFECYCLE</small><h2>持仓正在等待什么</h2>
      <p>入场后先验证是否快速得到正反馈，再由利润保护、相反极值和趋势死亡决定退出。</p></div><span>{positions.length} 笔</span></div>
      {positions.length?<div className="fr-position-list">{positions.map(t=><Position key={t.id} trade={t} now={now} state={stateBySymbol.get(t.symbol)}/>)}</div>
        :<Empty title="当前没有模拟持仓" text="完成确认并通过实时执行检查后才会形成新仓。"/>}
    </section>

    {blockers.length>0&&<section className="fr-section"><div className="fr-section-head"><div><small>EXECUTION BLOCKERS</small><h2>本轮未开仓原因</h2></div>
      <span>{data?.entryDiagnostics?.matched??0} 个进入检查</span></div>
      <div className="fr-rule-grid">{blockers.slice(0,8).map(([reason,count])=><article className="fr-setting" key={reason}><div><h3>{reason}</h3>
        <p>只统计当前轮真正进入开仓检查的候选，不把普通观察状态算成错误。</p></div><b>{count}</b></article>)}</div></section>}
  </>;
}

function Position({trade:t,now,state}:{trade:Trade;now:number;state:View["extremumRegime"]["symbols"][number]|undefined}){
  const d=t.side==="LONG"?1:-1,px=t.lastPrice,pnl=d*t.quantity*(px-t.entryPrice)-t.entryFee-t.quantity*px*.0007,
    ctx=t.entryContext,survival=t.side==="LONG"?state?.upSurvival:state?.downSurvival,
    opposite=t.side==="LONG"?state?.topPressure:state?.bottomPressure,
    watch=ctx?.strategyVersion
      ?ctx.postEntryState==="PENDING"?"等待快速正反馈"
        :ctx.mode==="SWING"?"等待相反峰谷确认或利润保护"
        :state?.regime==="TRANSITION"?"正在确认趋势死亡 / 夺回失败"
        :(t.profitFloorRate??0)>0?"利润保护已启动，同时观察趋势生命与相反极值"
        :"继续观察趋势生命、极值压力和推进反馈"
      :"旧仓按冻结生命周期兼容退出";
  return <details className="fr-position-row"><summary><span className="fr-position-primary"><b>{t.symbol.replace("_"," / ")}</b>
    <small>{t.side==="LONG"?"多单":"空单"} · {modeName(ctx?.mode??"兼容")} · {fmt(t.leverage,0)}×</small>
    <b className={pnl>=0?"fr-positive":"fr-negative"}>{signed(pnl)} U</b><small>{duration(t.openedAt,t.closedAt,now)}</small></span>
    <span className="fr-position-entry"><b>{watch}</b>
      <small>当前趋势生命 {fmt(survival,0)} · 相反极值 {fmt(opposite,0)} · 锁利 {fmt((t.profitFloorRate??0)*100,2)}%</small>
      <small>入场验证 {ctx?.postEntryState??"兼容"} · MFE {fmt(t.favorable*100,2)}% · MAE {fmt(t.adverse*100,2)}%</small></span></summary>
    <article className="fr-trade fr-trade-unified"><dl><div><dt>入场价</dt><dd>{fmt(t.entryPrice,6)}</dd></div><div><dt>当前价</dt><dd>{fmt(px,6)}</dd></div>
      <div><dt>当前防守</dt><dd>{fmt(t.stopPrice,6)}</dd></div><div><dt>名义金额</dt><dd>{fmt(t.notional)} U</dd></div>
      <div><dt>保证金 / 杠杆</dt><dd>{fmt(t.margin)} U / {fmt(t.leverage,0)}×</dd></div><div><dt>计划风险</dt><dd>{fmt(t.plannedRisk)} U</dd></div>
      <div><dt>当前状态</dt><dd>{state?regimeName(state.regime):"等待最新结构"}</dd></div><div><dt>极值阶段</dt><dd>{state?stageName(state.stage):"—"}</dd></div>
      <div><dt>预计持有</dt><dd>{fmt(t.expectedHoldMinutes,0)} 分钟</dd></div></dl>
      {ctx&&<p className="fr-trade-reason">入场依据：{ctx.reason}</p>}{t.exitReason&&<p className="fr-trade-reason">退出依据：{exitName(t.exitReason)}</p>}</article>
  </details>;
}
function Stat({label,value,note}:{label:string;value:string;note:string}){return <article><small>{label}</small><strong>{value}</strong><p>{note}</p></article>;}
function Metric({label,value}:{label:string;value:string}){return <span><small>{label}</small><b>{value}</b></span>;}
function Empty({title,text}:{title:string;text:string}){return <div className="fr-empty"><span>◎</span><h3>{title}</h3><p>{text}</p></div>;}
