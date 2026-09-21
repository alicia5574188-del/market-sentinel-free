/** Multi-timeframe turning-point state engine.
 *
 * Pure, causal, completed-candle only. It has no order, credential or LIVE
 * authority. Strategy execution consumes these states elsewhere.
 */
export const MULTI_TURN_VERSION="multi-turn-v1";
export const TURN_TIMEFRAMES=["5m","15m","30m","1h","4h","1d"] as const;
export type TurnTimeframe=typeof TURN_TIMEFRAMES[number];
export type TurnSide="LONG"|"SHORT"|"NEUTRAL";
export type TurnPhase="FLOW"|"WATCH"|"TURNING"|"CONFIRMED";
export type TurnCandle={time:number;open:number;high:number;low:number;close:number;volume:number};

export const TURN_CONFIG:Record<TurnTimeframe,{
  minutes:number;minBars:number;riskCap:number;confirmBars:number;watch:number;turning:number;confirm:number;
  minContinuation:number;maxStop:number;maxHoldMinutes:number;
}>={
  "5m": {minutes:5,minBars:24,riskCap:.015,confirmBars:1,watch:.46,turning:.62,confirm:.78,minContinuation:.34,maxStop:.025,maxHoldMinutes:360},
  "15m":{minutes:15,minBars:22,riskCap:.020,confirmBars:1,watch:.47,turning:.63,confirm:.79,minContinuation:.36,maxStop:.035,maxHoldMinutes:1080},
  "30m":{minutes:30,minBars:20,riskCap:.020,confirmBars:2,watch:.48,turning:.64,confirm:.80,minContinuation:.38,maxStop:.045,maxHoldMinutes:2160},
  "1h": {minutes:60,minBars:20,riskCap:.020,confirmBars:2,watch:.49,turning:.65,confirm:.81,minContinuation:.40,maxStop:.055,maxHoldMinutes:4320},
  "4h": {minutes:240,minBars:18,riskCap:.015,confirmBars:2,watch:.50,turning:.66,confirm:.82,minContinuation:.42,maxStop:.080,maxHoldMinutes:20160},
  "1d": {minutes:1440,minBars:20,riskCap:.010,confirmBars:2,watch:.51,turning:.67,confirm:.83,minContinuation:.44,maxStop:.120,maxHoldMinutes:64800},
};

export type TurnEvidence={
  structure:number;momentum:number;acceleration:number;cusum:number;changePoint:number;
  failedExtension:number;volatility:number;volume:number;breadth:number;propagation:number;
};
export type TurnFrameState={
  version:typeof MULTI_TURN_VERSION;symbol:string;timeframe:TurnTimeframe;observedAt:number;completedAt:number;
  ready:boolean;direction:TurnSide;rawDirection:TurnSide;directionConfidence:number;turnProbability:number;
  triggerProbability:number;continuationScore:number;phase:TurnPhase;candidateSide:TurnSide;candidateBars:number;
  justTurned:boolean;lastTurnAt:number|null;signalAgeBars:number;atrRate:number;expectedMoveRate:number;stopRate:number;
  price:number;breadthLong:number;propagationPressure:number;evidence:TurnEvidence;reason:string;
};
export type TurnCalibration={count:number;brier:number;predictedMean:number;actualMean:number;bias:number;lastResolvedAt:number};
export type TurnForecastRecord={id:string;symbol:string;timeframe:TurnTimeframe;at:number;dueAt:number;
  direction:Exclude<TurnSide,"NEUTRAL">;predicted:number;price:number;volatilityRate:number};
export type MultiTurnState={
  version:typeof MULTI_TURN_VERSION;updatedAt:number;frames:Record<string,Partial<Record<TurnTimeframe,TurnFrameState>>>;
  calibration:Record<TurnTimeframe,TurnCalibration>;pending:TurnForecastRecord[];
  diagnostics:{markets:number;readyFrames:number;confirmedTurns:number;updatedFrames:number};
};

const clip=(v:number,a=0,b=1)=>Math.max(a,Math.min(b,v));
const mean=(v:number[])=>v.length?v.reduce((a,b)=>a+b,0)/v.length:0;
const median=(v:number[])=>{const a=[...v].sort((x,y)=>x-y);return a.length?(a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2):0;};
const sigmoid=(x:number)=>1/(1+Math.exp(-Math.max(-20,Math.min(20,x))));
const opposite=(s:TurnSide):TurnSide=>s==="LONG"?"SHORT":s==="SHORT"?"LONG":"NEUTRAL";
const tfMs=(tf:TurnTimeframe)=>TURN_CONFIG[tf].minutes*60_000;
const completeAt=(c:TurnCandle,tf:TurnTimeframe)=>c.time*1000+tfMs(tf);

export function initialMultiTurn():MultiTurnState{
  return{version:MULTI_TURN_VERSION,updatedAt:0,frames:{},
    calibration:Object.fromEntries(TURN_TIMEFRAMES.map(tf=>[tf,{count:0,brier:0,predictedMean:0,actualMean:0,bias:0,lastResolvedAt:0}])) as MultiTurnState["calibration"],
    pending:[],diagnostics:{markets:0,readyFrames:0,confirmedTurns:0,updatedFrames:0}};
}

function validCandle(c:TurnCandle){
  return [c.time,c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite)&&c.time>0&&c.open>0&&c.close>0&&c.low>0
    &&c.high>=Math.max(c.open,c.close)&&c.low<=Math.min(c.open,c.close)&&c.volume>=0;
}
function contiguous(rows:TurnCandle[],seconds:number){
  return rows.every((r,i)=>validCandle(r)&&(i===0||r.time===rows[i-1].time+seconds));
}

export function aggregateTurnCandles(base5m:TurnCandle[],tf:TurnTimeframe):TurnCandle[]{
  if(tf==="1d")return[];
  const factor=TURN_CONFIG[tf].minutes/5;if(!Number.isInteger(factor)||factor<1)return[];
  const src=base5m.filter(validCandle).sort((a,b)=>a.time-b.time);
  if(!contiguous(src,300))return[];
  if(factor===1)return src;
  const groups=new Map<number,TurnCandle[]>();
  for(const c of src){
    const bucket=Math.floor(c.time/(factor*300))*factor*300;
    const a=groups.get(bucket)??[];a.push(c);groups.set(bucket,a);
  }
  return [...groups.entries()].sort((a,b)=>a[0]-b[0]).flatMap(([time,a])=>{
    if(a.length!==factor||!contiguous(a,300)||a[0].time!==time)return[];
    return[{time,open:a[0].open,high:Math.max(...a.map(x=>x.high)),low:Math.min(...a.map(x=>x.low)),
      close:a.at(-1)!.close,volume:a.reduce((n,x)=>n+x.volume,0)}];
  });
}

type RawMetrics={rows:TurnCandle[];rawDirection:TurnSide;confidence:number;atrRate:number;expectedMoveRate:number;
  structureLong:number;structureShort:number;momentum:number;acceleration:number;cusumLong:number;cusumShort:number;
  changeLong:number;changeShort:number;failedLong:number;failedShort:number;volatility:number;volume:number;latestReturn:number};
function metrics(rows:TurnCandle[],tf:TurnTimeframe):RawMetrics|null{
  const cfg=TURN_CONFIG[tf],a=rows.slice(-Math.max(cfg.minBars,24));
  if(a.length<cfg.minBars||!contiguous(a,tfMs(tf)/1000))return null;
  const closes=a.map(x=>x.close),rets=closes.slice(1).map((x,i)=>x/closes[i]-1);
  const ranges=a.map(x=>(x.high-x.low)/x.close),atrRate=Math.max(.0005,median(ranges.slice(-14)));
  const slow=a.at(-1)!.close/a[Math.max(0,a.length-9)].close-1;
  const fast=a.at(-1)!.close/a[Math.max(0,a.length-4)].close-1;
  const path=Math.abs(slow)/Math.max(1e-9,rets.slice(-8).reduce((n,x)=>n+Math.abs(x),0));
  const rawScore=(.65*slow+.35*fast)/(atrRate*Math.max(1,Math.sqrt(4)));
  const rawDirection:TurnSide=Math.abs(rawScore)<.10?"NEUTRAL":rawScore>0?"LONG":"SHORT";
  const confidence=clip(sigmoid(Math.abs(rawScore)*1.35-0.45)*(.55+.45*clip(path,0,1)),.05,.99);
  const prior=a.slice(-7,-1),last=a.at(-1)!;
  const priorHigh=Math.max(...prior.map(x=>x.high)),priorLow=Math.min(...prior.map(x=>x.low));
  const structureLong=clip((priorLow-last.close)/(atrRate*last.close)+.5,0,1);
  const structureShort=clip((last.close-priorHigh)/(atrRate*last.close)+.5,0,1);
  const recent=rets.slice(-3),older=rets.slice(-9,-3);
  const recentMean=mean(recent),olderMean=mean(older);
  const momentum=(recentMean)/(atrRate/Math.sqrt(3));
  const acceleration=(recentMean-olderMean)/(atrRate/Math.sqrt(3));
  let pos=0,neg=0,maxPos=0,maxNeg=0;
  for(const r of rets.slice(-8)){const z=r/atrRate;pos=Math.max(0,pos+z-.12);neg=Math.max(0,neg-z-.12);maxPos=Math.max(maxPos,pos);maxNeg=Math.max(maxNeg,neg);}
  const cusumLong=clip(maxPos/3.2),cusumShort=clip(maxNeg/3.2);
  const shift=(recentMean-olderMean)/Math.max(atrRate/Math.sqrt(3),1e-9);
  const changeLong=clip(sigmoid(1.15*shift-1.1)),changeShort=clip(sigmoid(-1.15*shift-1.1));
  const newHigh=last.high>=priorHigh,newLow=last.low<=priorLow,location=(last.close-last.low)/Math.max(last.high-last.low,1e-9);
  const failedLong=newLow&&location>.65?clip((location-.65)/.35):0;
  const failedShort=newHigh&&location<.35?clip((.35-location)/.35):0;
  const volatility=clip((ranges.at(-1)!/Math.max(median(ranges.slice(-14,-1)),1e-9)-1)/1.5);
  const vols=a.map(x=>x.volume),volume=clip((Math.log(Math.max(last.volume,1e-9)/Math.max(median(vols.slice(-14,-1)),1e-9))+.2)/2);
  return{rows:a,rawDirection,confidence,atrRate,expectedMoveRate:atrRate*(.8+.55*Math.sqrt(Math.max(1,cfg.minutes/15))),
    structureLong,structureShort,momentum,acceleration,cusumLong,cusumShort,changeLong,changeShort,failedLong,failedShort,
    volatility,volume,latestReturn:rets.at(-1)??0};
}

function calibratedProbability(raw:number,c:TurnCalibration){
  const shrink=c.count/(c.count+30),adj=clip(c.bias*shrink,-.12,.12);
  return clip(raw+adj,.02,.98);
}
function breadthOpposition(direction:TurnSide,breadthLong:number){
  return direction==="LONG"?clip((.50-breadthLong)/.35):direction==="SHORT"?clip((breadthLong-.50)/.35):0;
}

function buildFrame(input:{symbol:string;tf:TurnTimeframe;m:RawMetrics;previous?:TurnFrameState;breadthLong:number;
  propagation:number;calibration:TurnCalibration;now:number}):TurnFrameState{
  const{symbol,tf,m,previous,breadthLong,propagation,calibration,now}=input,cfg=TURN_CONFIG[tf],last=m.rows.at(-1)!;
  let incumbent=previous?.direction??m.rawDirection;
  if(incumbent==="NEUTRAL"&&m.rawDirection!=="NEUTRAL"&&m.confidence>=.42)incumbent=m.rawDirection;
  const against=incumbent==="LONG"?-1:incumbent==="SHORT"?1:0;
  const structure=incumbent==="LONG"?m.structureLong:incumbent==="SHORT"?m.structureShort:0;
  const momentum=clip(against*m.momentum/1.7);
  const acceleration=clip(against*m.acceleration/1.8);
  const cusum=incumbent==="LONG"?m.cusumShort:incumbent==="SHORT"?m.cusumLong:0;
  const changePoint=incumbent==="LONG"?m.changeShort:incumbent==="SHORT"?m.changeLong:0;
  const failedExtension=incumbent==="LONG"?m.failedShort:incumbent==="SHORT"?m.failedLong:0;
  const breadth=breadthOpposition(incumbent,breadthLong);
  // Volatility/volume are corroboration, never a prerequisite. A structural
  // break with strong sequential evidence must still be able to confirm in a
  // quiet tape; activity can only strengthen, not suppress, that conclusion.
  const volBoost=1+.12*m.volatility,activityBoost=1+.04*m.volume;
  const evidence:TurnEvidence={structure,momentum,acceleration,cusum,changePoint,failedExtension,
    volatility:m.volatility,volume:m.volume,breadth,propagation};
  const score=-2.45+1.35*structure+1.05*momentum+.75*acceleration+1.10*cusum+.90*changePoint+
    .55*failedExtension+.60*breadth+.70*propagation+.25*m.volatility+.10*m.volume;
  const raw=clip(sigmoid(score)*volBoost*activityBoost+.05*structure);
  const p=calibratedProbability(raw,calibration),opp=opposite(incumbent);
  const completedAt=completeAt(last,tf),newBar=!previous||previous.completedAt!==completedAt;
  let candidateSide:TurnSide=previous?.candidateSide??"NEUTRAL",candidateBars=previous?.candidateBars??0;
  if(incumbent==="NEUTRAL"){candidateSide="NEUTRAL";candidateBars=0;}
  else if(p>=cfg.turning){
    if(newBar){if(candidateSide===opp)candidateBars++;else{candidateSide=opp;candidateBars=1;}}
    else if(candidateSide!=="NEUTRAL"&&candidateSide!==opp){candidateSide=opp;candidateBars=0;}
  }else if(p<cfg.watch){candidateSide="NEUTRAL";candidateBars=0;}
  else if(newBar)candidateBars=Math.max(0,candidateBars-1);
  const extreme=p>=.90&&structure>=.65,confirmed=incumbent!=="NEUTRAL"&&p>=cfg.confirm&&(candidateBars>=cfg.confirmBars||extreme);
  let direction=incumbent,justTurned=false,lastTurnAt=previous?.lastTurnAt??null,phase:TurnPhase;
  let turnProbability=p;const triggerProbability=p;
  if(confirmed&&opp!=="NEUTRAL"){
    direction=opp;justTurned=true;lastTurnAt=completeAt(last,tf);candidateSide="NEUTRAL";candidateBars=0;
    phase="CONFIRMED";turnProbability=clip(1-p,.05,.32);
  }else phase=p>=cfg.turning?"TURNING":p>=cfg.watch?"WATCH":"FLOW";
  if(direction==="NEUTRAL"&&m.rawDirection!=="NEUTRAL"&&m.confidence>.52)direction=m.rawDirection;
  const continuationScore=direction==="NEUTRAL"?0:clip(m.confidence*(1-turnProbability));
  const price=last.close,prior=m.rows.slice(-7,-1);
  const swing=direction==="LONG"?Math.min(...prior.map(x=>x.low)):direction==="SHORT"?Math.max(...prior.map(x=>x.high)):price;
  const structural=Math.abs(price-swing)/price;
  const stopRate=clip(Math.max(structural,m.atrRate*1.15,.0035),.0035,cfg.maxStop);
  return{version:MULTI_TURN_VERSION,symbol,timeframe:tf,observedAt:now,completedAt:completeAt(last,tf),ready:true,
    direction,rawDirection:m.rawDirection,directionConfidence:m.confidence,turnProbability,triggerProbability,
    continuationScore,phase,candidateSide,candidateBars,justTurned,lastTurnAt,
    signalAgeBars:justTurned?0:newBar?(previous?.signalAgeBars??0)+1:(previous?.signalAgeBars??0),atrRate:m.atrRate,
    expectedMoveRate:m.expectedMoveRate,stopRate,price,breadthLong,propagationPressure:propagation,evidence,
    reason:`${tf} ${direction} | 转折${(turnProbability*100).toFixed(0)}% | 延续${(continuationScore*100).toFixed(0)}% | ${phase}`};
}

function settleCalibration(state:MultiTurnState,paths:Record<string,TurnCandle[]>,daily:Record<string,TurnCandle[]>,now:number){
  const keep:TurnForecastRecord[]=[];
  for(const f of state.pending){
    if(f.dueAt>now){keep.push(f);continue;}
    const rows=f.timeframe==="1d"?(daily[f.symbol]??[]):aggregateTurnCandles(paths[f.symbol]??[],f.timeframe);
    const last=rows.filter(r=>completeAt(r,f.timeframe)<=now).at(-1);
    if(!last||completeAt(last,f.timeframe)<f.dueAt){if(now-f.dueAt<tfMs(f.timeframe)*2)keep.push(f);continue;}
    const signed=(f.direction==="LONG"?1:-1)*(last.close/f.price-1),threshold=Math.max(.0025,f.volatilityRate*.75);
    const actual=signed<=-threshold?1:0,c=state.calibration[f.timeframe],n=c.count+1;
    const brier=((c.brier*c.count)+(f.predicted-actual)**2)/n;
    const predictedMean=(c.predictedMean*c.count+f.predicted)/n,actualMean=(c.actualMean*c.count+actual)/n;
    state.calibration[f.timeframe]={count:n,brier,predictedMean,actualMean,bias:clip(actualMean-predictedMean,-.20,.20),lastResolvedAt:now};
  }
  state.pending=keep.slice(-720);
}

export function evaluateMultiTurn(input:{state?:MultiTurnState|null;paths:Record<string,TurnCandle[]>;
  daily?:Record<string,TurnCandle[]>;now:number}):MultiTurnState{
  const state=structuredClone(input.state?.version===MULTI_TURN_VERSION?input.state:initialMultiTurn()),daily=input.daily??{};
  settleCalibration(state,input.paths,daily,input.now);
  const raw:Record<string,Partial<Record<TurnTimeframe,RawMetrics>>>={};
  const breadth:Partial<Record<TurnTimeframe,number>>={};
  for(const tf of TURN_TIMEFRAMES){
    let longs=0,shorts=0;
    for(const [symbol,base] of Object.entries(input.paths)){
      const rows=tf==="1d"?(daily[symbol]??[]):aggregateTurnCandles(base,tf),m=metrics(rows,tf);
      if(!m)continue;(raw[symbol]??={})[tf]=m;
      if(m.rawDirection==="LONG")longs++;else if(m.rawDirection==="SHORT")shorts++;
    }
    breadth[tf]=(longs+shorts)?longs/(longs+shorts):.5;
  }
  let ready=0,confirmed=0,updated=0;
  const nextFrames:MultiTurnState["frames"]={};
  for(const [symbol,byTf] of Object.entries(raw)){
    const out:Partial<Record<TurnTimeframe,TurnFrameState>>={};
    for(let i=0;i<TURN_TIMEFRAMES.length;i++){
      const tf=TURN_TIMEFRAMES[i],m=byTf[tf];if(!m)continue;
      const prev=state.frames[symbol]?.[tf],incumbent=prev?.direction??m.rawDirection;
      const lowers=TURN_TIMEFRAMES.slice(0,i).flatMap(x=>out[x]?[out[x]!]:[]);
      const propagation=lowers.length&&incumbent!=="NEUTRAL"
        ?clip(mean(lowers.map(x=>x.direction===opposite(incumbent)?Math.max(.65,x.triggerProbability):x.phase==="TURNING"?x.triggerProbability*.5:0)))
        :0;
      const frame=buildFrame({symbol,tf,m,previous:prev,breadthLong:breadth[tf]??.5,propagation,
        calibration:state.calibration[tf],now:input.now});
      out[tf]=frame;ready++;updated+=Number(!prev||prev.completedAt!==frame.completedAt);confirmed+=Number(frame.justTurned);
      const id=`${symbol}:${tf}:${frame.completedAt}`;
      if(frame.direction!=="NEUTRAL"&&!state.pending.some(p=>p.id===id)){
        state.pending.push({id,symbol,timeframe:tf,at:frame.completedAt,dueAt:frame.completedAt+2*tfMs(tf),
          direction:frame.direction,predicted:frame.turnProbability,price:m.rows.at(-1)!.close,volatilityRate:frame.atrRate});
      }
    }
    nextFrames[symbol]=out;
  }
  state.frames=nextFrames;state.updatedAt=input.now;state.pending=state.pending.slice(-720);
  state.diagnostics={markets:Object.keys(nextFrames).length,readyFrames:ready,confirmedTurns:confirmed,updatedFrames:updated};
  return state;
}

export type TurnCandidate={symbol:string;timeframe:TurnTimeframe;side:Exclude<TurnSide,"NEUTRAL">;
  score:number;riskCap:number;stopRate:number;expectedMoveRate:number;turnProbability:number;confidence:number;continuationScore:number;
  completedAt:number;signalPrice:number;reason:string};
export function turnCandidates(state:MultiTurnState,costRate:number|((tf:TurnTimeframe)=>number)){
  const rows:TurnCandidate[]=[];
  for(const [symbol,byTf] of Object.entries(state.frames))for(const tf of TURN_TIMEFRAMES){
    const f=byTf[tf];if(!f?.ready||f.direction==="NEUTRAL")continue;
    const cfg=TURN_CONFIG[tf],cost=typeof costRate==="function"?costRate(tf):costRate,costEdge=f.expectedMoveRate-cost;
    if(f.rawDirection!=="NEUTRAL"&&f.rawDirection!==f.direction)continue;\n    if(f.continuationScore<cfg.minContinuation||costEdge<=0)continue;
    rows.push({symbol,timeframe:tf,side:f.direction,score:f.continuationScore*Math.max(.1,costEdge/Math.max(cost,.001)),
      riskCap:cfg.riskCap,stopRate:f.stopRate,expectedMoveRate:f.expectedMoveRate,turnProbability:f.turnProbability,
      confidence:f.directionConfidence,continuationScore:f.continuationScore,completedAt:f.completedAt,signalPrice:f.price,reason:f.reason});
  }
  return rows.sort((a,b)=>b.score-a.score||TURN_CONFIG[b.timeframe].minutes-TURN_CONFIG[a.timeframe].minutes||a.symbol.localeCompare(b.symbol));
}
