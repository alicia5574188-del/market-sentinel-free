/**
 * Transient 2s structural-interrupt detector.
 *
 * This module never learns a strategy and never persists authority. Forward
 * Path Relation remains the normal directional authority. The detector only
 * emits a bounded emergency signal when price has already left a precomputed
 * outer 5m region and the live executable path keeps moving away from it.
 */
export const FORWARD_SHOCK_VERSION="forward-structural-interrupt-v1";

export type ShockSide="LONG"|"SHORT";
export type ForwardShockQuote={bestBid:number;bestAsk:number;observedAt:number;fresh:boolean;entryReady?:boolean};
export type ForwardShockRegion={symbol:string;lower:number;upper:number;center:number;widthRate:number;quality:number;
  outerLower?:number;outerUpper?:number;outerCenter?:number;outerWidthRate?:number;outerBars?:number;outerQuality?:number};
type ShockPoint={at:number;mid:number};
type ShockAlert={side:ShockSide;startedAt:number;lastAt:number;boundary:number;widthRate:number;bufferRate:number;
  samples:number;peakProgress:number;lastProgress:number;singleExtreme:boolean;ready:boolean;velocityRate:number};
export type ForwardShockCluster={id:string;side:ShockSide;startedAt:number;emittedSymbols:string[]};
export type ForwardShockRuntime={version:typeof FORWARD_SHOCK_VERSION;points:Record<string,ShockPoint[]>;
  alerts:Record<string,ShockAlert|undefined>;cooldownUntil:Record<string,number>;cluster:ForwardShockCluster|null};
export type ForwardShockSignal={id:string;eventId:string;symbol:string;side:ShockSide;confirmedAt:number;price:number;boundary:number;
  outerLower:number;outerUpper:number;outerCenter:number;outerWidthRate:number;outerQuality:number;progressRate:number;velocityRate:number;
  marketBreadth:number;marketCount:number;score:number;stopRate:number;targetRate:number;reason:string};
export type ForwardShockResult={state:ForwardShockRuntime;signals:ForwardShockSignal[];vetoSide:"LONG"|"SHORT"|null;
  shockSide:ShockSide|null;prealertCount:number;marketCount:number};

const clip=(v:number,a=0,b=1)=>Math.max(a,Math.min(b,v));
const mid=(q:ForwardShockQuote)=>(q.bestBid+q.bestAsk)/2;
const d=(side:ShockSide)=>side==="LONG"?1:-1;

export function initialForwardShockRuntime():ForwardShockRuntime{
  return{version:FORWARD_SHOCK_VERSION,points:{},alerts:{},cooldownUntil:{},cluster:null};
}

function fresh(q:ForwardShockQuote|undefined,now:number){
  return !!q&&q.fresh&&q.bestBid>0&&q.bestAsk>=q.bestBid&&q.observedAt<=now&&now-q.observedAt<=4_500;
}
function regionBounds(region:ForwardShockRegion){
  if(!(region.outerLower&&region.outerUpper&&region.outerUpper>region.outerLower&&region.outerCenter&&region.outerWidthRate&&region.outerQuality!=null))return null;
  return{lower:region.outerLower,upper:region.outerUpper,center:region.outerCenter,widthRate:region.outerWidthRate,quality:region.outerQuality};
}
function referencePoint(points:ShockPoint[],at:number){
  let found:ShockPoint|undefined;for(const p of points){if(p.at<=at)found=p;else break;}return found??points[0];
}
function directionalProgress(side:ShockSide,price:number,boundary:number){return d(side)*(price/boundary-1);}

export function advanceForwardShock(input:{state:ForwardShockRuntime;now:number;regions:Record<string,ForwardShockRegion>;
  quotes:Record<string,ForwardShockQuote>;entrySymbols?:Iterable<string>}):ForwardShockResult{
  const state:ForwardShockRuntime={version:FORWARD_SHOCK_VERSION,
    points:structuredClone(input.state?.points??{}),alerts:structuredClone(input.state?.alerts??{}),
    cooldownUntil:{...(input.state?.cooldownUntil??{})},cluster:input.state?.cluster?structuredClone(input.state.cluster):null};
  const allowed=input.entrySymbols?new Set(input.entrySymbols):null;
  const facts:Array<{symbol:string;side:ShockSide;price:number;lower:number;upper:number;center:number;widthRate:number;quality:number;
    progress:number;velocity:number;ready:boolean;singleExtreme:boolean;score:number}>=[];
  let marketCount=0;

  for(const [symbol,region] of Object.entries(input.regions??{})){
    if(allowed&&!allowed.has(symbol))continue;
    const q=input.quotes[symbol];if(!fresh(q,input.now)||q!.entryReady!==true)continue;
    marketCount++;
    const price=mid(q!),bounds=regionBounds(region);
    if(!bounds||bounds.quality<48||!(bounds.lower>0&&bounds.upper>bounds.lower&&bounds.widthRate>0))continue;
    const bufferRate=Math.max(.0006,Math.min(.003,bounds.widthRate*.04));
    const shortProgress=(bounds.lower-price)/bounds.lower,longProgress=(price-bounds.upper)/bounds.upper;
    const side:ShockSide|null=shortProgress>bufferRate?"SHORT":longProgress>bufferRate?"LONG":null;
    const points=state.points[symbol]??[];
    if(!points.length||q!.observedAt>points.at(-1)!.at)points.push({at:q!.observedAt,mid:price});
    state.points[symbol]=points.filter(p=>input.now-p.at<=22_000).slice(-16);
    if(!side){
      const prior=state.alerts[symbol];if(prior&&input.now-prior.lastAt>2_500)delete state.alerts[symbol];
      continue;
    }
    if((state.cooldownUntil[symbol]??0)>input.now)continue;
    const boundary=side==="SHORT"?bounds.lower:bounds.upper,progress=directionalProgress(side,price,boundary);
    let alert=state.alerts[symbol];
    if(!alert||alert.side!==side||input.now-alert.lastAt>8_000){
      alert={side,startedAt:input.now,lastAt:input.now,boundary,widthRate:bounds.widthRate,bufferRate,samples:1,
        peakProgress:progress,lastProgress:progress,singleExtreme:false,ready:false,velocityRate:0};
    }else{
      const priorProgress=alert.lastProgress;
      alert.samples++;alert.lastAt=input.now;alert.lastProgress=progress;alert.peakProgress=Math.max(alert.peakProgress,progress);
      const ref=referencePoint(state.points[symbol]!,input.now-5_000),velocity=ref?d(side)*(price/ref.mid-1):0,
        duration=input.now-alert.startedAt,pullback=Math.max(0,alert.peakProgress-progress),
        minProgress=Math.max(.0015,bounds.widthRate*.08),minVelocity=Math.max(.0008,bounds.widthRate*.035),
        maxPullback=Math.max(.0012,bounds.widthRate*.07),
        continuing=progress>=priorProgress-Math.max(.0005,bounds.widthRate*.025);
      alert.velocityRate=velocity;
      alert.singleExtreme=progress>=Math.max(.006,bounds.widthRate*.25)&&velocity>=Math.max(.003,bounds.widthRate*.10);
      alert.ready=duration>=3_500&&alert.samples>=3&&progress>=minProgress&&velocity>=minVelocity&&pullback<=maxPullback&&continuing;
    }
    state.alerts[symbol]=alert;
    const score=clip(78+progress*1_200+Math.max(0,alert.velocityRate)*900+(bounds.quality/100)*6,0,99);
    facts.push({symbol,side,price,lower:bounds.lower,upper:bounds.upper,center:bounds.center,widthRate:bounds.widthRate,
      quality:bounds.quality,progress,velocity:alert.velocityRate,ready:alert.ready,singleExtreme:alert.singleExtreme,score});
  }

  const recent=(side:ShockSide)=>facts.filter(f=>f.side===side&&(input.now-(state.alerts[f.symbol]?.startedAt??0))<=14_000);
  const longRows=recent("LONG"),shortRows=recent("SHORT");
  const dominant:ShockSide|null=shortRows.length>longRows.length?"SHORT":longRows.length>shortRows.length?"LONG":
    shortRows.reduce((n,x)=>n+x.score,0)>longRows.reduce((n,x)=>n+x.score,0)?"SHORT":
      longRows.length?"LONG":shortRows.length?"SHORT":null;
  const dominantRows=dominant?recent(dominant):[],broadRequired=Math.max(3,Math.ceil(marketCount*.22)),
    broad=dominantRows.length>=broadRequired;
  const extreme=dominantRows.some(r=>r.singleExtreme);
  const vetoSide=dominant&&(broad||extreme)?(dominant==="LONG"?"SHORT":"LONG"):null;
  const candidates=dominantRows.filter(r=>r.ready&&(broad||r.singleExtreme)).sort((a,b)=>b.score-a.score);

  if(state.cluster&&input.now-state.cluster.startedAt>90_000)state.cluster=null;
  if(candidates.length&&(!state.cluster||state.cluster.side!==dominant)){
    const eventAt=Math.floor(input.now/2_000)*2_000;
    state.cluster={id:`shock-${dominant!.toLowerCase()}-${eventAt.toString(36)}`,side:dominant!,startedAt:input.now,emittedSymbols:[]};
  }
  const signals:ForwardShockSignal[]=[];
  if(state.cluster&&state.cluster.side===dominant){
    const capacity=Math.max(0,2-state.cluster.emittedSymbols.length);
    for(const row of candidates.filter(r=>!state.cluster!.emittedSymbols.includes(r.symbol)).slice(0,capacity)){
      const eventId=state.cluster.id,stopRate=clip(row.progress+Math.max(.0015,row.widthRate*.035),.003,.018),
        targetRate=clip(Math.max(.006,row.widthRate*.45+row.progress*.55),.006,.03),
        breadth=marketCount?dominantRows.length/marketCount:0;
      signals.push({id:`${eventId}-${row.symbol}`,eventId,symbol:row.symbol,side:row.side,confirmedAt:input.now,price:row.price,
        boundary:row.side==="SHORT"?row.lower:row.upper,outerLower:row.lower,outerUpper:row.upper,outerCenter:row.center,
        outerWidthRate:row.widthRate,outerQuality:row.quality,progressRate:row.progress,velocityRate:row.velocity,
        marketBreadth:breadth,marketCount,score:row.score,stopRate,targetRate,
        reason:`结构中断｜外层成熟区${row.side==="SHORT"?"下破":"上破"}｜2秒路径持续${((input.now-(state.alerts[row.symbol]?.startedAt??input.now))/1000).toFixed(0)}秒｜位移${(row.progress*100).toFixed(2)}%｜5秒速度${(row.velocity*100).toFixed(2)}%｜同向${dominantRows.length}/${marketCount}`});
      state.cluster.emittedSymbols.push(row.symbol);state.cooldownUntil[row.symbol]=input.now+10*60_000;delete state.alerts[row.symbol];
    }
  }
  return{state,signals,vetoSide,shockSide:dominant,prealertCount:dominantRows.length,marketCount};
}
