"use client";
import {useEffect,useMemo,useRef,useState,useSyncExternalStore,type PointerEvent} from "react";
import {DAY_MS,EQUITY_CURVE_VERSION,curveSegments,equityReference,mergeEquity,nearestPoint,smoothPath,
  type CurveContext,type EquityPoint} from "../lib/equity-curve.ts";
import type {forwardSummary} from "../lib/forward-relations.ts";
import {EquityHistoryCache,EQUITY_CACHE_VERSION} from "../lib/equity-cache.ts";
import "./equity-curve.css";
type View=ReturnType<typeof forwardSummary>;
const number=(v:number)=>v.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
const stamp=(t:number)=>new Date(t).toLocaleString("zh-CN",{timeZone:"Asia/Vientiane",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false});
type Range="24h"|"7d"|"all";
export default function EquityCurve({data,healthy,fixture,cache,cacheScope="owner"}:{data:View|null;healthy:boolean;
  fixture?:{points:EquityPoint[];complete:boolean};cache?:EquityHistoryCache;cacheScope?:string}){
  const [ownCache]=useState(()=>new EquityHistoryCache());
  const store=cache??ownCache;
  const history=useSyncExternalStore(store.subscribe,store.getSnapshot,store.getSnapshot);
  const {loading,error}=history;
  const [range,setRange]=useState<Range>("7d"),[loadBatch,setLoadBatch]=useState(0);
  const [clock,setClock]=useState(()=>Date.now()),[oldestRequest,setOldestRequest]=useState<number|null>(null);
  const [selected,setSelected]=useState<EquityPoint|null>(null),[width,setWidth]=useState(480),[offset,setOffset]=useState(0);
  const scroll=useRef<HTMLDivElement>(null),atLatest=useRef(true),cycle=useRef(0);
  useEffect(()=>{cycle.current=data?.lastCycleAt??0;},[data?.lastCycleAt]);
  const liveNow=data?.updatedAt??0;
  const context:CurveContext=useMemo(()=>({startedAt:data?.startedAt??0,initialEquity:data?.initialEquity??1000,
    policy:data?.policyVersion??"adaptive-ten-slim-v1",exitPolicy:data?.engineVersion??data?.policyVersion??"adaptive-ten-slim-v1",
    comparableSince:data?.startedAt??0,persistedAt:data?.storage.persistedAt??0}),
    [data?.startedAt,data?.initialEquity,data?.policyVersion,data?.engineVersion,data?.storage.persistedAt]);
  const account=context.startedAt;
  useEffect(()=>{if(account&&!fixture)store.configure(context,cacheScope);},[store,context,cacheScope,account,fixture]);
  useEffect(()=>()=>{if(!cache)store.cancel();},[store,cache]);
  useEffect(()=>{
    if(fixture||!account)return;
    let stopped=false;let resume:ReturnType<typeof setTimeout>|undefined;
    const active=()=>!stopped&&!document.hidden;
    const target=range==="all"?account:Math.max(account,Math.min(Date.now()-7*DAY_MS,oldestRequest??Infinity));
    async function load(){
      if(!active())return;
      if(resume){clearTimeout(resume);resume=undefined;}
      await store.load(target,cycle.current,active);
      const h=store.getSnapshot();
      if(active()&&!h.error&&(store.needsHistory(target)||h.catchingUp))resume=setTimeout(()=>void load(),30_000);
    }
    void load();
    const timer=setInterval(()=>void load(),60_000);
    const visible=()=>{if(document.hidden){if(resume)clearTimeout(resume);}else void load();};
    document.addEventListener("visibilitychange",visible);
    return()=>{stopped=true;clearInterval(timer);if(resume)clearTimeout(resume);document.removeEventListener("visibilitychange",visible);};
  },[store,account,range,loadBatch,fixture,oldestRequest,cacheScope]);
  useEffect(()=>{const timer=setInterval(()=>setClock(Date.now()),30_000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{const node=scroll.current;if(!node)return;const resize=new ResizeObserver(()=>setWidth(Math.max(180,node.clientWidth)));
    resize.observe(node);setWidth(Math.max(180,node.clientWidth));return()=>resize.disconnect();},[account]);
  const recorded=useMemo(()=>fixture?.points??(history.account===account?history.points:[]),[fixture,history,account]);
  const all=useMemo(()=>mergeEquity(recorded,context,Math.max(liveNow,context.persistedAt,clock)),[recorded,context,liveNow,clock]);
  const chartPoints=useMemo(()=>{
    if(!data||!healthy||data.stalePositions||!Number.isFinite(data.equity))return all;
    return mergeEquity([...all,{at:data.updatedAt,equity:data.equity,kind:"preview",policy:context.policy,homogeneous:false}],context,Math.max(data.updatedAt,clock));
  },[all,data,healthy,context,clock]);
  const end=Math.max(account+1,chartPoints.at(-1)?.at??account+1),span=range==="24h"?DAY_MS:range==="7d"?7*DAY_MS:Math.max(1,end-account);
  const canvasWidth=Math.min(20000,Math.max(width,width*(end-account)/span)),plot=canvasWidth-28;
  useEffect(()=>{if(atLatest.current&&scroll.current)scroll.current.scrollLeft=canvasWidth-width;},[canvasWidth,width,end,range]);
  // Persistent history can outgrow a browser's function-argument limit.
  let low=context.initialEquity,high=context.initialEquity;
  for(const point of chartPoints){low=Math.min(low,point.equity);high=Math.max(high,point.equity);}
  const pad=Math.max(1,(high-low)*.14),min=low-pad,max=high+pad,y=(v:number)=>214-(v-min)/(max-min)*192;
  const x=(t:number)=>14+(t-account)/(end-account)*plot;
  const visibleStart=account+Math.max(0,offset-14)/plot*(end-account),visibleEnd=account+Math.min(plot,offset+width)/plot*(end-account);
  useEffect(()=>{
    if(fixture||loading||error||history.done||!history.loaded||history.coveredTo==null||atLatest.current
      ||visibleStart>=history.coveredTo)return;
    const timer=setTimeout(()=>setOldestRequest(old=>Math.min(old??Infinity,Math.max(account,visibleStart-DAY_MS))),300);
    return()=>clearTimeout(timer);
  },[fixture,loading,error,history.done,history.loaded,history.coveredTo,visibleStart,account]);
  const visible=chartPoints.filter(p=>p.at>=visibleStart&&p.at<=visibleEnd);
  const peak=visible.reduce<EquityPoint|null>((a,b)=>!a||b.equity>a.equity?b:a,null),trough=visible.reduce<EquityPoint|null>((a,b)=>!a||b.equity<a.equity?b:a,null);
  const shown=(selected&&chartPoints.find(p=>p.at===selected.at))||chartPoints.at(-1);
  const covered=fixture?.complete??(history.done||(history.coveredTo!=null&&history.coveredTo<=Math.max(account,liveNow-7*DAY_MS)));
  const reference=useMemo(()=>equityReference(all,context,Math.max(liveNow,clock),healthy&&!data?.storage.error&&!error&&!history.catchingUp,covered),[all,context,liveNow,clock,healthy,data?.storage.error,error,history.catchingUp,covered]);
  const needsMore=!fixture&&!history.done&&(range==="all"||history.coveredTo==null||history.coveredTo>Math.max(account,Math.min(liveNow-7*DAY_MS,visibleStart)));
  const pick=(e:PointerEvent<SVGSVGElement>)=>{
    const r=e.currentTarget.getBoundingClientRect(),px=(e.clientX-r.left)*canvasWidth/r.width;
    setSelected(nearestPoint(chartPoints,account+(px-14)/plot*(end-account)));
  };
  const jump=(left:number)=>{setSelected(left===0?chartPoints[0]??null:null);const node=scroll.current;if(node){node.scrollTo({left,behavior:"smooth"});atLatest.current=left>=canvasWidth-width-2;}};
  const switchRange=(r:Range)=>{atLatest.current=true;setSelected(null);setRange(r);};
  const ticks=Math.min(50,Math.max(2,Math.floor(canvasWidth/100)));
  if(!data)return <div className="eq-empty">等待真实净值记录。</div>;
  return <div className="eq-module" data-equity-version={EQUITY_CURVE_VERSION} data-equity-cache={EQUITY_CACHE_VERSION}>
    <div className="eq-toolbar"><div><span className="eq-label">账户净值 · USDT</span><span className="eq-start">起始 {number(context.initialEquity)} U</span></div>
      <div className="eq-ranges" role="group" aria-label="净值时间范围">{([["24h","24小时"],["7d","7天"],["all","全部"]] as const).map(([id,label])=><button key={id} aria-pressed={range===id} onClick={()=>switchRange(id)}>{label}</button>)}</div>
    </div>
    <div className="eq-selection" aria-live="polite"><strong>{shown?number(shown.equity):"—"}<small> U</small></strong><div>{shown&&<><b className={shown.equity>=context.initialEquity?"fr-positive":"fr-negative"}>{shown.equity>=context.initialEquity?"+":""}{number(shown.equity-context.initialEquity)} U · {((shown.equity/context.initialEquity-1)*100).toFixed(2)}%</b><span>{stamp(shown.at)} · {shown.kind==="origin"?"初始本金":shown.kind==="preview"?"当前估值":shown.stale?"已保存净值 · 含陈旧报价":"已保存净值"}</span></>}</div></div>
    <div className="eq-plot"><svg className="eq-axis" width="54" height="248" aria-hidden="true">{[min,(min+max)/2,max].filter(v=>Math.abs(y(v)-y(context.initialEquity))>16).map(v=><text key={v} x="48" y={y(v)+4} textAnchor="end">{v.toFixed(0)}</text>)}<text className="eq-base-label" x="48" y={y(context.initialEquity)+4} textAnchor="end">{context.initialEquity.toFixed(0)}</text></svg>
      <div className="eq-scroll" ref={scroll} tabIndex={0} role="region" aria-label="净值曲线，可左右滑动或使用方向键" onScroll={e=>{const n=e.currentTarget;setOffset(n.scrollLeft);atLatest.current=n.scrollLeft>=n.scrollWidth-n.clientWidth-8;}}>
        <svg width={canvasWidth} height="248" viewBox={`0 0 ${canvasWidth} 248`} onPointerDown={pick} onPointerMove={e=>{if(e.buttons===1)pick(e);}} role="img" aria-label="含模拟成本的真实净值曲线；空白处缺少连续记录">
          {[min,(min+max)/2,max].map(v=><line key={v} x1="0" x2={canvasWidth} y1={y(v)} y2={y(v)} className="eq-grid"/>)}
          <line x1="0" x2={canvasWidth} y1={y(context.initialEquity)} y2={y(context.initialEquity)} className="eq-baseline"/>
          {curveSegments(chartPoints).map((segment,i)=><g key={i}><path d={smoothPath(segment.map(p=>({x:x(p.at),y:y(p.equity)})))} className="eq-curve"/>{segment.length===1&&<circle cx={x(segment[0].at)} cy={y(segment[0].equity)} r="3" className="eq-dot"/>}</g>)}
          {chartPoints[0]&&<circle cx={x(account)} cy={y(context.initialEquity)} r="4" className="eq-origin"/>}
          {shown&&<g><line x1={x(shown.at)} x2={x(shown.at)} y1="16" y2="220" className="eq-cross"/><circle cx={x(shown.at)} cy={y(shown.equity)} r="4" className="eq-dot"/></g>}
          {Array.from({length:ticks+1},(_,i)=>{const t=account+i/ticks*(end-account);return <text className="eq-time" key={i} x={14+i/ticks*plot} y="241" textAnchor={i===0?"start":i===ticks?"end":"middle"}>{range==="24h"?stamp(t).slice(-5):stamp(t).slice(0,5)}</text>;})}
        </svg>
      </div>
    </div>
    <div className="eq-controls"><button onClick={()=>jump(0)}>起点</button><button disabled={offset<2} onClick={()=>jump(Math.max(0,offset-width*.8))}>‹ 较早</button><button disabled={offset>=canvasWidth-width-2} onClick={()=>jump(Math.min(canvasWidth-width,offset+width*.8))}>较新 ›</button><button onClick={()=>jump(canvasWidth-width)}>最新</button></div>
    <p className="eq-hint">历史保存在本机，重新打开只补新增记录。左右滑动查看，轻触曲线读取原始记录。{range==="all"?"显示已加载全程。":end-account<span?"运行时间不足所选周期，显示已有记录。":canvasWidth>=20000?"长历史已压缩显示。":range==="7d"?"每屏7天。":"每屏24小时。"}空白处不补造；含陈旧报价的已保存估值只用于补全真实历史曲线，不参与实盘开启参考。曲线仅作平滑连接，数字和建议均用原始值。</p>
    {history.cacheNotice&&<p className="eq-load" role="status">{history.cacheNotice}</p>}
    <div className="eq-extremes"><span>窗口记录高点 <b>{peak?number(peak.equity):"—"} U</b></span><span>窗口记录低点 <b>{trough?number(trough.equity):"—"} U</b></span></div>
    {(loading||error||needsMore)&&<div className="eq-load" role="status"><span>{error??(loading?(history.catchingUp?"正在补充新增净值，历史曲线已保留…":"正在补充尚未读取的历史…"):"当前窗口历史尚未读取完整")}</span>{!loading&&<button onClick={()=>{setOldestRequest(old=>Math.min(old??Infinity,Math.max(account,visibleStart-DAY_MS)));setLoadBatch(n=>n+1);}}>继续加载</button>}</div>}
    <aside className="eq-reference" data-reference-state={reference.state}><div><span className="eq-label">实盘开启参考</span><small>仅供手动判断</small></div><p>{reference.sentence}</p><details><summary>依据与限制</summary><p>{reference.detail}</p><p>观察条件：从记录高点回撤至少1%，随后30分钟净值回升至少0.2%、收回至少四分之一跌幅；同一次回撤不重复计数，未完成后续观察的不算成功。图表平滑不参与判断。</p><p>此提示不能操作实盘开关，不阻止开单，也不更改当前持仓。</p></details></aside>
  </div>;
}
