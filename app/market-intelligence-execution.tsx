"use client";
import type {RangeEvent} from '../lib/anomaly-range.ts';

import {BEIJING_TIME_ZONE} from "../lib/beijing-time.ts";
import {type forwardSummary} from "../lib/forward-relations.ts";
import type {EpisodeResearch} from '../lib/episode-research.ts';
import type {SpecialResearch,SpecialWatch} from '../lib/special-move.ts';
import type {EventResearch,ResponseEvent} from '../lib/event-response.ts';

function specialDescription(w:SpecialWatch){return{reason:({ACTIVE_NONRESPONSE:'近期成交活跃，却没有响应市场波动',RELATIVE_LEADER:'相对市场明显走强或走弱',OPPOSITE_MOVE:'实际方向与市场不同',OWN_ACCELERATION:'自身推进明显加速',ORDINARY:'当前未发现特别表现'}[w.kind]),next:({SPECIAL_READY:'本币启动已确认，核对实际进场位置',SPECIAL_LOCATION:'等待有效回踩与扣费后的空间',SPECIAL_COVERAGE:'等待连续价格、真实近期成交额与新鲜报价',SPECIAL_LOW_ACTIVITY:'近期成交太低或明显萎缩，停止交易授权',SPECIAL_EVENT_ENDED:'旧段承接失效，等待新的启动',SPECIAL_EVENT_OLD:'旧启动已超出入场时效，等待新的回踩重启',SPECIAL_DORMANT:'离开扫描池，记忆保留，当前不授权交易',SPECIAL_ORDINARY:'当前只观察',SPECIAL_NO_RESPONSE:'等待本币真正启动并保留价格优势',SPECIAL_WATCH:'持续观察会跟随、继续不响应，还是走出相反方向'}[w.code]??w.code)};}

type View=ReturnType<typeof forwardSummary>;
const researchPhase=(phase:string)=>({UNCONFIRMED:'方向待确认',ROTATION:'双向回归',ADVANCING:'推进承接有效',PULLBACK:'回调观察',SUPPORT_BROKEN:'承接受损',RECOVERY_FAILED:'恢复失败',RECOVERY_BUILDING:'恢复待确认'}[phase]??phase);
const researchSignal=(signal:string)=>({OBSERVE:'等待有效观察',HOLD:'持仓假设保留',REVIEW:'复核承接',PROTECT_CANDIDATE:'评估保护利润',EXIT_CANDIDATE:'评估旧依据退出',CLOSED:'已结算'}[signal]??signal);
function EpisodeResearchView({research,now}:{research:EpisodeResearch;now:number}){
  const held=new Set(research.holdings.filter(h=>h.status!=='CLOSED').map(h=>h.symbol)),
    priority=(p:EpisodeResearch['symbols'][string])=>held.has(p.symbol)?0:p.phase==='RECOVERY_FAILED'?1:p.phase==='SUPPORT_BROKEN'?2:p.phase==='PULLBACK'?3:4,
    rows=Object.values(research.symbols).sort((a,b)=>priority(a)-priority(b)||b.since-a.since).slice(0,8);
  return <section className="fr-section" data-testid="episode-research"><div className="fr-section-head"><h2>行情研究</h2><span>更新 {clock(research.updatedAt)}</span></div>
    <p>{research.summary}</p><div className="fr-journal">{rows.map(p=><article key={p.symbol}><time>{p.symbol.replace('_',' / ')} · {researchPhase(p.phase)} · 持续 {Math.max(0,Math.round((now-p.since)/60000))} 分钟</time><div><b>{p.fresh?p.reason:'等待本币新鲜数据'}</b><p>下一步：{p.nextEvidence}</p>
      {p.side&&<p>本段承接 {p.holdingSupport} · 入场确认 {clock(p.entryProofAt)}</p>}
      <p>{p.windows.map(w=>`${w.minutes}分钟 ${w.move==null?'数据不足':`${w.move>=0?'+':''}${(w.move*100).toFixed(2)}%`}`).join(' · ')}</p>
      {p.hypotheses.return.stage!=='UNCONFIRMED'&&<p>回归证据：{p.hypotheses.return.stage==='FAILED_DEPARTURE'?'离开失败':'旧推进恢复失败'}；{p.hypotheses.return.target==null?'尚缺稳定回归目标':`重心 ${p.hypotheses.return.target}`}</p>}
    </div></article>)}</div>
  </section>;
}
type DirectPlan=NonNullable<NonNullable<View>['directStrategy']>['plans'][number];
const planPhase=(v:string)=>({READY:'当前可执行',VALIDATING:'确认启动',WAIT_LOCATION:'等待回踩',HOLDING:'已执行',OBSERVE:'观察',EXECUTING:'等待成交确认'}[v]??v);
function PlanDetails({plan}:{plan:DirectPlan}){
  return <><p>进场：{plan.reason.replace(/^[A-Z_]+: /,'')}</p><p>持仓：{plan.holdReason}</p><p>退出：{plan.exitCondition}</p>
    {plan.marketRoute&&<p>{plan.marketRoute.relation==='INDEPENDENT'?'独立行情':plan.marketRoute.relation==='LOCAL'?'本币结构许可':'跟随市场'} · 结构确认 {clock(plan.marketRoute.proofAt)} · {plan.marketRoute.targetBasis==='VOLATILITY_ESTIMATE'?'入场空间为波动估计':'目标为已接受重心'}</p>}
    {plan.confirmation&&<p>结构确认 {clock(plan.confirmation.at)} · {plan.confirmation.path==='HOLD_OUTSIDE'?'区域外连续推进':'回踩承接后重新推进'} · 保护位置 {plan.confirmation.stop}</p>}</>;
}
function SpecialResearchView({research,now,plans,held}:{research:SpecialResearch;now:number;plans:DirectPlan[];held:Set<string>}){
  const planBySymbol=new Map(plans.map(p=>[p.symbol,p])),
    priority=(symbol:string)=>{const p=planBySymbol.get(symbol);return p?.phase==='EXECUTING'?2:p&&p.permission!=='WAIT'?1:0;},
    watches=Object.values(research.watches).filter(w=>!held.has(w.symbol)),
    rows=watches.sort((a,b)=>priority(b.symbol)-priority(a.symbol)||Number(b.phase==='READY')-Number(a.phase==='READY')||Number(b.fresh)-Number(a.fresh)||b.score-a.score),
    renderRow=(w:SpecialWatch)=>{const detail=specialDescription(w),plan=planBySymbol.get(w.symbol);
      const status=!w.fresh?'数据待补齐':!w.active?w.turnover15==null?'成交待核对':'低量观察':plan?planPhase(plan.phase):w.phase==='READY'?'启动已确认':'观察';
      return <article className="fr-exec-compact-row" key={w.symbol}>
        <div className="fr-exec-compact-head"><b>{w.symbol.replace('_',' / ')}{plan&&plan.permission!=='WAIT'?` · ${side(plan.side)}`:''}</b><span>{status}</span></div>
        <small className="fr-exec-watch-kind">{({ACTIVE_NONRESPONSE:'活跃，但未跟随大盘',RELATIVE_LEADER:'比大盘更强或更弱',OPPOSITE_MOVE:'与大盘反向',OWN_ACCELERATION:'自身走势加速',ORDINARY:'暂未发现特别表现'})[w.kind]}</small>
        <p>{plan?plan.reason.replace(/^[A-Z_]+: /,''):detail.next}</p>
        <details className="fr-exec-research-details"><summary>查看依据</summary><b>{detail.reason}</b>
          <p>已观察 {Math.max(0,Math.round((now-w.firstSeenAt)/60000))} 分钟</p>
          <p>{[15,30,45,60].map((n,i)=>`${n}分钟 ${w.moves[i]==null?'数据不足':`${(w.moves[i]!*100).toFixed(2)}%`}`).join(' · ')}</p>
          <p>近期15分钟成交 {w.turnover15==null?'未知':`${Math.round(w.turnover15).toLocaleString()} USDT`} · {w.active?'活跃':w.turnover15==null?'待核对':'低量'} · {w.fresh?'证据有效':'当前数据待补齐'}</p>
          <p>相对市场30分钟偏离 {(w.residual*100).toFixed(2)}%{w.route?` · 本币启动 ${clock(w.route.proofAt)}`:''}</p>
          {plan&&<PlanDetails plan={plan}/>}</details></article>;};
  return <section className="fr-section" data-testid="special-research"><div className="fr-section-head"><h2>重点观察</h2><span>{rows.length} 个 · {clock(research.updatedAt)}</span></div>
    <div className="fr-exec-compact-list">{rows.slice(0,3).map(renderRow)}
      {plans.filter(p=>!held.has(p.symbol)&&!research.watches[p.symbol]).map(p=><article className="fr-exec-compact-row" key={p.id}><div className="fr-exec-compact-head"><b>{p.symbol.replace('_',' / ')}{p.permission!=='WAIT'?` · ${side(p.side)}`:''}</b><span>{planPhase(p.phase)}</span></div><p>{p.reason.replace(/^[A-Z_]+: /,'')}</p><details className="fr-exec-research-details"><summary>查看计划</summary><PlanDetails plan={p}/></details></article>)}
    </div>
    {rows.length>3&&<details className="fr-exec-research-details"><summary>其余观察币 · {rows.length-3} 个</summary><div className="fr-exec-compact-list">{rows.slice(3).map(renderRow)}</div></details>}
    {!rows.length&&!plans.length&&<p>正在寻找特别的活跃币，等待本币启动。</p>}</section>;
}
function DirectExecution({data,now,liveEnabled,liveOverview}:{data:NonNullable<View>;now:number;liveEnabled:boolean;liveOverview?:{copied?:number|null;eligible?:number|null}}){
  const ds=data.directStrategy!,held=new Set(data.positions.map(t=>t.symbol)),plans=ds.plans.filter(p=>!held.has(p.symbol));
  if(ds.anomalyRange)return <RangeExecution data={data} now={now} liveEnabled={liveEnabled} liveOverview={liveOverview}/>;
  return <div className="fr-execution-page fr-exec-compact" data-testid="direct-research-execution">
    <section className="fr-section"><div className="fr-section-head"><h2>当前持仓</h2><span>{data.positions.length} 笔</span></div>
      {liveEnabled&&<p>实盘已跟上 {liveOverview?.copied??'—'} / 应执行 {liveOverview?.eligible??'—'}。实际成交及结算以实盘账户记录为准。</p>}
      {ds.execution?.pending.map(p=><div className="fr-exec-pending" key={p.id}><b>{p.symbol.replace('_',' / ')} · {p.kind==='OPEN'?'等待开仓成交':p.kind==='CLOSE'?'等待平仓成交':'等待减仓成交'}</b><details className="fr-exec-research-details"><summary>查看原因</summary><p>{p.reason}</p></details></div>)}
      <div className="fr-exec-compact-list">{data.positions.map(t=>{const observed=ds.episodeResearch?.holdings.find(h=>h.tradeId===t.id);return <article className="fr-exec-compact-row" key={t.id}>
        <div className="fr-exec-compact-head"><b>{t.symbol.replace('_',' / ')} · {side(t.side)}{t.unified?.anomaly?` · ${({EDGE_BREAKOUT:'边缘突破',EDGE_RETURN:'边缘回归',INTERNAL_TREND:'内部顺势',WICK:'影线'})[t.unified.anomaly.kind]}`:''}</b><span>{t.unified?.decision==='EXIT'?'准备退出':t.unified?.decision==='REVIEW'?'复核持仓':'继续持有'}</span></div>
        <p>{t.unified?.holdReason??positionWatch(t)}</p><p className="fr-exec-exit">退出条件：{t.unified?.exitCondition??'按原交易计划执行'}</p>
        <details className="fr-exec-research-details"><summary>查看依据</summary><p>进场：{t.unified?.entryReason??t.entryContext?.reason??'暂无记录'}</p>
        {(ds.anomalyRange?!t.unified?.anomaly:ds.eventResponse&&!t.unified?.response)&&<p>沿用入场时的原策略规则</p>}
        {t.unified?.response&&<><p>事件响应 · {({LAUNCH:'启动观察',ADVANTAGE:'优势保留',REVIEW:'复核恢复',EXIT:'准备退出'})[t.unified.response.stage]}</p>
          <p>已记录最高推进 {(t.unified.response.peak*100).toFixed(2)}% · 连续恢复失败 {t.unified.response.failedRecoveries} 次</p>
          <p>恢复耗时 {t.unified.response.recoveryMs==null?'尚未完成':`${Math.round(t.unified.response.recoveryMs/1000)} 秒`} · 风险保护 {t.stopPrice}</p></>}
        {observed&&!t.unified?.response&&<><p>研究观察：{researchSignal(observed.signal)} · {observed.reason}</p><p>研究承接 {observed.holdingSupport} · 当前执行保护 {observed.executionStop}</p>
          <p>当前净盈亏 {observed.netPnl==null?'—':`${observed.netPnl.toFixed(2)} U`} · 已记录最高净盈亏 {observed.peakNetPnl==null?'—':`${observed.peakNetPnl.toFixed(2)} U`}
          {observed.fillRatio!=null&&observed.fillRatio<.99?` · 计划成交 ${(observed.fillRatio*100).toFixed(1)}%`:''}</p></>}
        <p>最近判断 {clock(t.unified?.lastDecisionAt)} · 持有 {Math.max(0,Math.round((now-t.openedAt)/60000))} 分钟</p></details></article>;})}</div>
      {!data.positions.length&&<p>暂无持仓，等待有效启动。</p>}
      {ds.execution&&<details className="fr-exec-research-details"><summary>成交说明</summary><p>模拟按实盘的执行校验、提交和成交确认步骤结算；盘口模拟与交易所实际成交仍可能存在差异。</p></details>}</section>
    {ds.eventResearchError?<section className="fr-section"><h2>事件研究待恢复</h2><p>{ds.eventResearchError}</p></section>:ds.eventResearch?<EventResponseView research={ds.eventResearch} now={now} held={held}/>:ds.specialResearch?<SpecialResearchView research={ds.specialResearch} now={now} plans={plans} held={held}/>:<section className="fr-section"><div className="fr-section-head"><h2>重点观察</h2><span>{plans.length} 个计划</span></div>
      <div className="fr-exec-compact-list">{plans.map(p=><article className="fr-exec-compact-row" key={p.id}><div className="fr-exec-compact-head"><b>{p.symbol.replace('_',' / ')} · {p.permission==='WAIT'?'观察':side(p.side)}</b><span>{planPhase(p.phase)}</span></div><p>{p.reason.replace(/^[A-Z_]+: /,'')}</p><details className="fr-exec-research-details"><summary>查看计划</summary><PlanDetails plan={p}/></details></article>)}</div>
      {!plans.length&&<p>等待当前结构与新鲜盘口形成交易计划。</p>}
      {ds.episodeResearch&&<details className="fr-exec-research-details"><summary>详细行情研究</summary><EpisodeResearchView research={ds.episodeResearch} now={now}/></details>}</section>}
  </div>;
}
function num(v?:number){return typeof v==='number'&&Number.isFinite(v)?Number(v.toPrecision(6)).toString():'—';}
function where(e:RangeEvent){
  const band=Math.max(e.E,e.n5);
  if(e.price>e.H+e.D)return '已经收在上沿外';
  if(e.price<e.L-e.D)return '已经收在下沿外';
  if(e.price>e.H)return '刚探出上沿';
  if(e.price<e.L)return '刚探出下沿';
  if(Math.abs(e.price-e.H)<=band)return '靠近上沿';
  if(Math.abs(e.price-e.L)<=band)return '靠近下沿';
  return '在区间里面';
}
function watchLine(e:RangeEvent,now:number){
  if(e.admission&&now-e.admission.at<120000)return e.admission.reason;
  if(!e.active)return '成交不够，先看着，不下单。';
  return `扫描 ${clockFull(e.detectedAt)}。等5分钟收出影线，上影线做空，下影线做多。扫描时没走完的那根也算。`;
}
function orderLine(e:RangeEvent){
  const p=e.proof;if(!p)return e.reason;
  if(p.kind==='WICK')return `${p.side==='SHORT'?'上影线做空':'下影线做多'}。止盈 ${num(p.target)}，最远止损 ${num(p.stop)}。`;
  if(p.kind==='EDGE_RETURN'){const turned=(p.side==='SHORT'?e.upperExtreme>e.H:e.lowerExtreme<e.L);
    return `${turned?'冲出新极值后，5分钟已经往回收':'5分钟已从边界往回收'}。走到 ${num(p.target)} 出场。`;}
  if(p.kind==='EDGE_BREAKOUT')return `已经收在区间外面。错了就按 ${num(p.stop)} 出。`;
  return `顺着区间里的方向做。错了就按 ${num(p.stop)} 出。`;
}
function scanLine(a:{kind:string;own:number}){
  if(a.kind==='OPPOSITE_MOVE')return `${a.own>=0?'和大盘反着涨':'和大盘反着跌'}。等这根5分钟走出影线。`;
  return `${a.own>=0?'比大盘更强':'比大盘更强地走'}。等这根5分钟走出影线。`;
}
type Position=NonNullable<View>['positions'][number];
function holdStatus(t:Position){
  const m=t.unified?.anomaly;
  if(m?.kind==='EDGE_RETURN'){
    if(m.stage==='EXIT'||t.unified?.decision==='EXIT')return '准备出';
    if(m.returnProbeAt&&m.returnBackAt)return '再探出就止损';
    if(m.returnProbeAt)return '探出一次，还拿着';
    return '按回归拿着';
  }
  if(t.unified?.decision==='EXIT'||m?.stage==='EXIT')return '准备出';
  if(t.unified?.decision==='REVIEW'||m?.stage==='REVIEW')return '在复核';
  return '继续拿着';
}
function holdNext(t:Position){
  const m=t.unified?.anomaly;
  if(!m)return t.unified?.exitCondition??'按原来的计划走';
  if(m.kind==='WICK')return `止盈按进场那根实体的 ${m.proof.wickMultiple??'3到5'} 倍。不到1倍止盈距离的浮亏继续拿；到过2倍等回到1倍亏损或成本；到3倍直接止损`;
  if(m.kind==='EDGE_RETURN')return `走到 ${num(m.proof.target*m.scale)} 出场。下影线不算。第一根5分钟收出区间先拿着；收回去之后，再收出一根才止损`;
  if(m.kind==='EDGE_BREAKOUT')return `收回区间并确认失败才出，否则按保护价 ${num(t.stopPrice)}`;
  return t.unified?.exitCondition??`结构坏了就出，保护价 ${num(t.stopPrice)}`;
}
function RangeExecution({data,now,liveEnabled,liveOverview}:{data:NonNullable<View>;now:number;liveEnabled:boolean;liveOverview?:{copied?:number|null;eligible?:number|null}}){
  const ds=data.directStrategy!,research=ds.rangeResearch,discovery=research?.discovery,held=new Set(data.positions.map(t=>t.symbol)),
    open=Object.values(research?.events??{}).filter(e=>!held.has(e.symbol)&&e.phase!=='DONE'&&e.phase!=='EXPIRED').sort((a,b)=>(a.rank??Infinity)-(b.rank??Infinity)),
    orders=open.filter(e=>e.phase==='READY'||e.phase==='EXECUTING'),waiting=open.filter(e=>e.phase==='CONFIRMING'),
    watching=open.filter(e=>e.phase==='WATCH'||e.phase==='HOLDING'),
    seen=new Set([...held,...Object.keys(research?.events??{})]),fresh=(discovery?.anomalies??[]).filter(a=>!seen.has(a.symbol)),
    thin=new Set((research?.recent??[]).filter(r=>r.reason.includes('断层')||r.reason.includes('成交额')).map(r=>r.symbol)),
    steps=[['扫描',discovery?.scanned??'—'],['在看',watching.length],['在等',waiting.length],['下单',orders.length],['持仓',data.positions.length]] as const,
    active=data.positions.length?4:orders.length?3:waiting.length?2:watching.length?1:0,backlog=(research?.waiting??0)||(discovery?.queued??0),
    headline=research?.error??(!discovery?'还没扫完第一轮。':[data.positions.length&&`正在做 ${data.positions.length} 笔`,orders.length&&`${orders.length} 个可以下单`,waiting.length&&`${waiting.length} 个在等 K 线走完`,watching.length&&`${watching.length} 个区间还在看`,!data.positions.length&&!orders.length&&!waiting.length&&!watching.length&&fresh.length&&`扫到 ${fresh.length} 个异动，还没排上`].filter(Boolean).join('，')||`扫过 ${discovery.scanned} 个币，这次没有要盯的。`);
  const row=(e:RangeEvent,title:string,text:string)=><article className="fr-exec-compact-row" key={e.id}>
    <div className="fr-exec-compact-head"><b>{e.symbol.replace('_',' / ')}</b><span>{title}</span></div>
    <p>{text}</p><p className="fr-exec-exit">扫描 {clockFull(e.detectedAt)} · 区间 {num(e.L)} – {num(e.H)}{e.own>0?' · 这次在涨':e.own<0?' · 这次在跌':''}</p></article>;
  const watchRows=[...waiting,...watching];
  return <div className="fr-execution-page fr-exec-compact" data-testid="direct-research-execution">
    <section className="fr-section"><div className="fr-section-head"><h2>现在</h2><span>{clock(discovery?.at??research?.updatedAt)}</span></div>
      <div className="fr-pipeline">{steps.map(([name,count],i)=><div key={name} className={i===active?'current':i<active&&Number(count)>0?'done':''}><span>{i+1}</span><b>{name} {count}</b></div>)}</div>
      <p>{headline.endsWith('。')?headline:`${headline}。`}</p>
      <p className="fr-exec-exit">币池 {discovery?.shared??'—'}，扫到价格 {discovery?.scanned??'—'}，看过 K 线 {discovery?.loaded??0}{backlog?`。一次看不过来，还有 ${backlog} 个在排队`:''}。</p>
      {!data.positions.length&&!orders.length&&!waiting.length&&!watching.length&&<p className="fr-exec-exit">只做强于大盘和反向的币。扫到之后等5分钟影线：上影线做空，下影线做多。扫描时没走完的那根也算。</p>}
      {liveEnabled&&<p>实盘已跟上 {liveOverview?.copied??'—'} / 应执行 {liveOverview?.eligible??'—'}。成交以实盘账户为准。</p>}
    </section>
    <section className="fr-section"><div className="fr-section-head"><h2>正在做</h2><span>{data.positions.length} 笔</span></div>
      {ds.execution?.pending.map(p=><p key={p.id}>{p.symbol.replace('_',' / ')} · {p.kind==='OPEN'?'正在下单':p.kind==='CLOSE'?'正在平仓':'正在减仓'} · {p.reason}</p>)}
      <div className="fr-exec-compact-list">{data.positions.map(t=>{const m=t.unified?.anomaly,kind=kindName(m?.kind);
        return <article className="fr-exec-compact-row" key={t.id}><div className="fr-exec-compact-head"><b>{t.symbol.replace('_',' / ')} · {side(t.side)}{kind?` · ${kind}`:''}</b><span>{holdStatus(t)}</span></div>
          <p>{t.unified?.holdReason??positionWatch(t)}</p>
          <p className="fr-exec-exit">扫描 {clockFull(scannedAt(m))}</p>
          {m&&<p className="fr-exec-exit">进场区间 {num(m.L)} – {num(m.H)}</p>}
          <p className="fr-exec-exit">{holdNext(t)}{t.openedAt?` · 拿了 ${Math.max(0,Math.round((now-t.openedAt)/60000))} 分钟`:''}</p>
          {!m&&ds.anomalyRange&&<p className="fr-exec-exit">这笔是以前的规则，不按现在的区间走。</p>}</article>;})}</div>
      {!data.positions.length&&!ds.execution?.pending.length&&<p>还没有持仓。</p>}
    </section>
    {!!orders.length&&<section className="fr-section"><div className="fr-section-head"><h2>可以下单</h2><span>{orders.length} 个</span></div>
      <div className="fr-exec-compact-list">{orders.map(e=>row(e,e.proof?`${side(e.proof.side)} ${kindName(e.proof.kind)}`:e.phase==='EXECUTING'?'正在提交':'等成交',`${e.phase==='EXECUTING'?'正在提交。':''}扫描 ${clockFull(e.detectedAt)}。${orderLine(e)}`))}</div></section>}
    {!!watchRows.length&&<section className="fr-section"><div className="fr-section-head"><h2>还在看</h2><span>{watchRows.length} 个</span></div>
      <div className="fr-exec-compact-list">{watchRows.slice(0,8).map(e=>row(e,where(e),watchLine(e,now)))}</div>
      {watchRows.length>8&&<details className="fr-exec-research-details"><summary>其余 {watchRows.length-8} 个</summary><div className="fr-exec-compact-list">{watchRows.slice(8).map(e=>row(e,where(e),watchLine(e,now)))}</div></details>}</section>}
    {!!fresh.length&&<section className="fr-section"><div className="fr-section-head"><h2>刚扫到</h2><span>{fresh.length} 个还没排上</span></div>
      <div className="fr-exec-compact-list">{fresh.slice(0,6).map(a=><article className="fr-exec-compact-row" key={a.symbol}><div className="fr-exec-compact-head"><b>{a.symbol.replace('_',' / ')}</b><span>{thin.has(a.symbol)?'不看':'等影线'}</span></div><p>扫描 {clockFull(a.detectedAt)}。{thin.has(a.symbol)?(research?.recent??[]).find(r=>r.symbol===a.symbol)?.reason??'成交太稀，不占用观察席。':scanLine(a)}</p></article>)}</div>
      {fresh.length>6&&<p className="fr-exec-exit">还有 {fresh.length-6} 个，一样在等空位。</p>}</section>}
  </div>;
}
function EventResponseView({research,now,held}:{research:EventResearch;now:number;held:Set<string>}){
  const rows=Object.values(research.events).filter(e=>!held.has(e.symbol)).sort((a,b)=>Number(b.phase==='READY')-Number(a.phase==='READY')
    ||Number(b.fresh)-Number(a.fresh)||b.score-a.score),
    render=(e:ResponseEvent)=><article className="fr-exec-compact-row" key={e.id}>
      <div className="fr-exec-compact-head"><b>{e.symbol.replace('_',' / ')}{e.side?` · ${side(e.side)}`:''}</b>
        <span>{!e.fresh?'数据待补齐':({WATCH:'等待响应',CONFIRMING:'确认优势',READY:'核对执行',EXECUTING:'等待成交',HOLDING:'持仓中',FAILED:'失败已记录',LATE:'已走远',DORMANT:'记忆保留'})[e.phase]}</span></div>
      <p>{e.admission&&now-e.admission.at<10000?e.admission.reason:e.reason}</p>
      <details className="fr-exec-research-details"><summary>查看事件依据</summary>
        <p>{({ACTIVE_NONRESPONSE:'活跃但未响应大盘',RELATIVE_LEADER:'相对大盘特别强弱',OPPOSITE_MOVE:'与大盘反向',OWN_ACCELERATION:'自身价格加速',ORDINARY:'事件持续观察'})[e.kind]} · 已观察 {Math.max(0,Math.round((now-e.detectedAt)/60000))} 分钟</p>
        <p>近期15分钟成交 {e.turnover15==null?'未知':`${Math.round(e.turnover15).toLocaleString()} USDT`} · {e.active?'活跃':'成交待核对'}</p>
        {e.last&&<p>自身推进 {(e.last.progress*100).toFixed(2)}% · 优势保留 {(e.last.retained*100).toFixed(0)}% · 回落深度 {(e.last.counter*100).toFixed(2)}%</p>}
        <p>启动尝试 {e.attempts} 次 · 失败 {e.failures} 次 · 事件发现 {clock(e.detectedAt)}</p>
        <p>{e.outcomes.map(o=>`${o.minutes}分钟 ${o.status==='OBSERVED'?`${(o.move!*100).toFixed(2)}%`:o.status==='MISSING'?'缺少实际观察':'尚未到期'}`).join(' · ')}</p>
      </details></article>;
  return <section className="fr-section" data-testid="event-response-research"><div className="fr-section-head"><h2>重点事件</h2><span>{rows.length} 个 · {clock(research.updatedAt)}</span></div>
    <div className="fr-exec-compact-list">{rows.slice(0,3).map(render)}</div>
    {rows.length>3&&<details className="fr-exec-research-details"><summary>其余事件 · {rows.length-3} 个</summary>{rows.slice(3).map(render)}</details>}
    {!rows.length&&<p>正在寻找活跃的特别币；发现异常后等待实际价格响应。</p>}
    {research.capacitySkipped>0&&<details className="fr-exec-research-details"><summary>研究覆盖</summary><p>记忆容量不足时保留已有事件；累计暂缓记录 {research.capacitySkipped} 次新观察，不把重复观察计作独立机会。</p></details>}
  </section>;
}
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
const clockFull=(v?:number)=>v?new Date(v).toLocaleString("zh-CN",{timeZone:BEIJING_TIME_ZONE,month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}):"—";
const kindName=(k?:string)=>({EDGE_BREAKOUT:'突破',EDGE_RETURN:'回归',INTERNAL_TREND:'顺势',WICK:'影线'}[k??'']??'');
function scannedAt(m?:{scannedAt?:number;eventId?:string;detectedAt?:number}){
  if(m?.scannedAt&&Number.isFinite(m.scannedAt))return m.scannedAt;
  if(m?.detectedAt&&Number.isFinite(m.detectedAt))return m.detectedAt;
  const n=Number(m?.eventId?.split(':').at(-1));return Number.isFinite(n)&&n>1e12?n:undefined;
}
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
  if(t.unified)return `${t.unified.branch==='RETURN'?'回退':'延续'} · ${t.unified.decision==='EXIT'?'准备退出':t.unified.decision==='REVIEW'?'正在复核':'继续持有'}`;
  if(t.inverseCopy)return"仅跟随影子";
  if(t.winnerManagement?.research){
    const m=t.winnerManagement;
    return m.appliedAction==="EXIT"?"准备退出":m.appliedAction==="REDUCE"?"已部分兑现":m.research!.level==="MARKET_CAUTION"?"预警但继续持有":m.research!.level==="LOCAL_REVIEW"||m.research!.level==="PROTECT"?"复核本币变化":"继续持有";
  }
  const d=t.positionIntelligence?.decision;
  return d==="EXIT"?"准备退出":d==="REVIEW"?"重点复核":"继续持有";
}

function positionWatch(t:View["positions"][number]){
  if(t.unified)return t.unified.holdReason;
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

export default function MarketIntelligenceExecution({data,now,liveEnabled,liveOverview}:{
  data:View|null;now:number;liveEnabled:boolean;liveOverview?:{operational:boolean;lastSyncAt:number|null;positionCount:number;copied?:number|null;eligible?:number|null};
}){
  if(data?.directStrategy)return <DirectExecution data={data} now={now} liveEnabled={liveEnabled} liveOverview={liveOverview}/>;
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
      <div className="fr-section-head"><h2>{data?.unifiedExecution?'回退与延续执行':'市场作战总览'}</h2><span>研究更新 {clock(mi?.updatedAt)}</span></div>
      <div className="fr-exec-market-hero"><div><small>当前市场</small>
        <strong>{environmentName(currentEnvironment)} · {evolution(currentEvolution)}</strong></div>
        <p>大方向{bias(n?.major.bias)} · 短期{bias(n?.short.bias)}</p></div>
      <div className="fr-command-snapshot" data-testid="market-command-summary">
        <div><small>正在发生</small><b>{marketChangeText(data)}</b></div>
        <div><small>接下来可能</small><b>{nextMarketText(data)}</b></div>
        <div><small>转变压力</small><b>{pressure(outlook?.transitionPressure)}{outlook?.horizonMinutes?` · 观察窗口 ${outlook.horizonMinutes} 分钟`:""}</b></div>
      </div>
      {data?.unifiedExecution&&<p className="fr-note">尚未确认延续时保留回退逻辑；本币突破后保持在区域外推进，或回踩后再次推进，才评估延续仓。每笔使用自己的判断，市场同步上涨不代表所有币都应做多。</p>}
      <div className="fr-journal">
        <article><time>正在观察 · {observed.length}</time><div>
          {observed.length?observed.map(o=><p key={o.id}><b>{o.symbol.replace("_"," / ")} · {data?.unifiedExecution?'参考':''}{side(o.side)} · {tradePlanName(o.tradePlan)}</b><br/>
            {o.eligible&&!waitingByCandidate.has(o.id)?"条件已成立，等待执行队列。":observeReason(o,liquidity?.symbols?.[o.symbol])}</p>):<p>暂无重点观察标的。</p>}
        </div></article>
        <article><time>等待执行 · {waitingValidations.length}{data?.unifiedExecution?' · 待选择实际分支':data?.shadowInverse?" · 影子决策，模拟反向":""}</time><div>
          {waitingValidations.map(v=>{const o=v.frozenOpportunity??opportunities.find(x=>x.id===v.candidateId);return <p key={v.id}><b>{v.symbol.replace("_"," / ")} · {data?.unifiedExecution?'参考':''}{side(v.side)} · {tradePlanName(o?.tradePlan)}</b><br/>
            {waitingReason(v,o)}{o?.winnerPlan&&<><br/><small>{planText(o.winnerPlan)}</small></>}</p>})}
          {data?.unifiedExecution?.episodes.filter(e=>!e.handled&&!e.ended).slice(0,8).map(e=><p key={e.sourceId}><b>{e.symbol.replace('_',' / ')} · 分支评估</b><br/>{e.reason}</p>)}
          {!waitingValidations.length&&<p>暂无已武装计划。</p>}
        </div></article>
        <article><time>{data?.unifiedExecution?'策略指令持仓':liveEnabled?'影子信号持仓':'正在持仓'} · {positions.length}</time><div>
          {positions.length?positions.map(t=><p key={t.id}><b>{t.symbol.replace("_"," / ")} · {side(t.side)} · {tradePlanName(t.liquidityLifecycle?.currentPlan??t.entryContext?.tradePlan)} · {positionAction(t)}</b><br/>
            {t.unified?<><small>进场：{t.unified.entryReason}</small><br/>持仓：{positionWatch(t)}<br/><small>退出：{t.unified.exitCondition}</small>
              {t.unified.predecessorId&&<><br/><small>前段已实现 {t.unified.predecessorNet?.toFixed(2)} U，计入本次账户结果</small></>}
              <br/><small>判断 {clock(t.unified.lastDecisionAt)}</small></>:<>{positionWatch(t)}{t.entryContext?.winnerPlan&&<><br/><small>{planText(t.entryContext.winnerPlan,t.stopPrice)}</small></>}</>}</p>):<p>暂无持仓。</p>}
        </div></article>
      </div>
      <p className="fr-note">实盘 {liveEnabled?(liveOverview?.operational?"运行中":"等待核对"):"关闭"}{liveEnabled?' · 成交、实际持仓及盈亏以同步账户为准':''}</p>
    </section>
  </div>;
}
