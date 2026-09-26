import {buildPredictiveFeatures} from "./predictive-path-features.ts";
import {forecastCausalPath} from "./predictive-path-model.ts";
import {PREDICTIVE_PATH_POLICY,PREDICTIVE_PATH_VERSION,type PredictiveAncillary,type PredictiveBar,
  type PredictiveDirectionMemory,type PredictiveEngineState,type PredictivePathForecast,type PredictiveQuote,type PredictiveSide} from "./predictive-path-types.ts";

const clamp=(v:number,a:number,b:number)=>Math.max(a,Math.min(b,v));
export type PredictiveCandidate={
  id:string;symbol:string;side:PredictiveSide;eligible:boolean;at:number;expiresAt:number;price:number;
  catastrophicStopRate:number;expectedHoldMinutes:15|30|60|120;rankingValue:number;confidence:number;
  expectedReturnRate:number;predictedMfeRate:number;predictedMaeRate:number;targetBeforeRisk:number;entryRegretRate:number;
  forecast:PredictivePathForecast;reason:string;
};

function quoteFresh(q:PredictiveQuote|undefined,now:number){return !!q&&q.fresh&&q.bestBid>0&&q.bestAsk>=q.bestBid&&q.observedAt<=now&&now-q.observedAt<=10_000;}
function sideProbability(f:PredictivePathForecast,side:PredictiveSide){
  if(f.rawSide===side)return f.directionProbability;
  if(f.rawSide&&f.rawSide!==side)return 1-f.directionProbability;
  const up=.18*f.upProbability.m30+.47*f.upProbability.m60+.35*f.upProbability.m120;return side==="LONG"?up:1-up;
}
function updateMemory(previous:PredictiveDirectionMemory|undefined,forecast:PredictivePathForecast,lastBarTime:number,now:number):PredictiveDirectionMemory{
  const prior=previous??{side:null,since:now,lastBarTime:0,oppositeBars:0,weakBars:0};
  if(lastBarTime<=prior.lastBarTime)return{...prior};
  const raw=forecast.rawSide,current=prior.side;
  if(!current){
    return raw?{side:raw,since:now,lastBarTime,oppositeBars:0,weakBars:0}:{...prior,lastBarTime,oppositeBars:0,weakBars:0};
  }
  const currentProbability=sideProbability(forecast,current);
  if(raw===current)return{...prior,lastBarTime,oppositeBars:0,weakBars:currentProbability>=PREDICTIVE_PATH_POLICY.directionKeep?0:prior.weakBars+1};
  if(raw&&raw!==current){
    const oppositeProbability=sideProbability(forecast,raw),oppositeBars=oppositeProbability>=PREDICTIVE_PATH_POLICY.directionFlip?prior.oppositeBars+1:0;
    if(oppositeBars>=PREDICTIVE_PATH_POLICY.flipBars)return{side:raw,since:now,lastBarTime,oppositeBars:0,weakBars:0};
    return{...prior,lastBarTime,oppositeBars,weakBars:currentProbability<PREDICTIVE_PATH_POLICY.directionKeep?prior.weakBars+1:0};
  }
  const weakBars=currentProbability<PREDICTIVE_PATH_POLICY.directionKeep?prior.weakBars+1:0;
  return{...prior,lastBarTime,oppositeBars:0,weakBars};
}
function bestHorizon(f:PredictivePathForecast,side:PredictiveSide):15|30|60|120{
  const d=side==="LONG"?1:-1,candidates=[
    [15,d*f.expectedReturn.m15],[30,d*f.expectedReturn.m30],[60,d*f.expectedReturn.m60],[120,d*f.expectedReturn.m120],
  ] as const;
  return [...candidates].sort((a,b)=>b[1]-a[1])[0]![0];
}
function candidateFromForecast(symbol:string,forecast:PredictivePathForecast,q:PredictiveQuote|undefined,now:number):PredictiveCandidate|null{
  const side=forecast.stableSide;if(!side||forecast.rawSide!==side)return null;
  const data=side==="LONG"?forecast.long:forecast.short,price=q?(q.bestBid+q.bestAsk)/2:0,
    catastrophicStopRate=clamp(Math.max(PREDICTIVE_PATH_POLICY.catastrophicStopMin,data.mae60*1.8+.0012),
      PREDICTIVE_PATH_POLICY.catastrophicStopMin,PREDICTIVE_PATH_POLICY.catastrophicStopMax),
    expectedHoldMinutes=bestHorizon(forecast,side),
    expectedReturnRate=side==="LONG"?forecast.expectedReturn.m60:-forecast.expectedReturn.m60,
    rankingValue=(Math.max(0,data.netEv60)/Math.max(catastrophicStopRate,.001))*forecast.confidence*forecast.entryQuality,
    eligible=forecast.enterNow&&quoteFresh(q,now)&&price>0,
    direction=sideProbability(forecast,side),
    reason="因果路径｜"+side+"｜60/120m方向"+(direction*100).toFixed(0)+"%｜目标先于风险"+(data.targetBeforeRisk60*100).toFixed(0)
      +"%｜预计MFE "+(data.mfe60*100).toFixed(2)+"%｜MAE "+(data.mae60*100).toFixed(2)
      +"%｜10m入场后悔 "+(data.entryRegret10*100).toFixed(2)+"%";
  return{id:"causal-"+symbol+"-"+now,symbol,side,eligible,at:now,expiresAt:now+5*60_000,price,catastrophicStopRate,expectedHoldMinutes,
    rankingValue,confidence:forecast.confidence,expectedReturnRate,predictedMfeRate:data.mfe60,predictedMaeRate:data.mae60,
    targetBeforeRisk:data.targetBeforeRisk60,entryRegretRate:data.entryRegret10,forecast,reason};
}

export function buildPredictivePathEngine(input:{paths:Record<string,PredictiveBar[]>;quotes:Record<string,PredictiveQuote>;
  ancillary?:Record<string,PredictiveAncillary>;previous?:PredictiveEngineState;now:number;allowed?:Set<string>}){
  const symbols:Record<string,PredictivePathForecast>={},directionMemory:Record<string,PredictiveDirectionMemory>={},
    candidates:PredictiveCandidate[]=[];
  for(const [symbol,path] of Object.entries(input.paths)){
    if(input.allowed&&!input.allowed.has(symbol))continue;
    const feature=buildPredictiveFeatures({symbol,decisionAt:input.now,bars5m:path,quote:input.quotes[symbol],ancillary:input.ancillary?.[symbol]});
    if(!feature)continue;
    const last=path.at(-1),lastBarTime=last?(last.time+300)*1000:0,forecast=forecastCausalPath(feature,input.quotes[symbol]),
      memory=updateMemory(input.previous?.directionMemory[symbol],forecast,lastBarTime,input.now);
    forecast.lastBarTime=lastBarTime;forecast.stableSide=memory.side;
    forecast.directionProbability=memory.side?sideProbability(forecast,memory.side):forecast.directionProbability;
    forecast.enterNow=forecast.enterNow&&memory.side!=null&&forecast.rawSide===memory.side;
    if(!forecast.enterNow&&forecast.rawSide&&memory.side!==forecast.rawSide)
      forecast.waitReason=memory.side?"方向切换尚未完成两根5分钟确认":"方向尚未建立";
    directionMemory[symbol]=memory;symbols[symbol]=forecast;
    const candidate=candidateFromForecast(symbol,forecast,input.quotes[symbol],input.now);if(candidate)candidates.push(candidate);
  }
  for(const [symbol,memory] of Object.entries(input.previous?.directionMemory??{}))if(!directionMemory[symbol])directionMemory[symbol]=memory;
  candidates.sort((a,b)=>Number(b.eligible)-Number(a.eligible)||b.rankingValue-a.rankingValue||b.confidence-a.confidence);
  return{state:{version:PREDICTIVE_PATH_VERSION,updatedAt:input.now,symbols,directionMemory} satisfies PredictiveEngineState,candidates};
}

export type PredictiveExitReason="CATASTROPHIC_STOP"|"PREDICTIVE_EDGE_GONE"|"PREDICTIVE_REVERSAL"|null;
export function predictiveExitDecision(input:{side:PredictiveSide;forecast:PredictivePathForecast|undefined;
  memory:PredictiveDirectionMemory|undefined;stopped:boolean;ageMinutes:number}):{
  reason:PredictiveExitReason;remainingEdge:number;directionProbability:number;oppositeProbability:number;hold:boolean}{
  if(input.stopped)return{reason:"CATASTROPHIC_STOP",remainingEdge:0,directionProbability:0,oppositeProbability:1,hold:false};
  if(!input.forecast)return{reason:null,remainingEdge:0,directionProbability:.5,oppositeProbability:.5,hold:true};
  const sideData=input.side==="LONG"?input.forecast.long:input.forecast.short,
    directionProbability=sideProbability(input.forecast,input.side),oppositeProbability=1-directionProbability,
    remainingEdge=sideData.netEv60;
  if(input.memory?.side&&input.memory.side!==input.side&&oppositeProbability>=PREDICTIVE_PATH_POLICY.directionFlip)
    return{reason:"PREDICTIVE_REVERSAL",remainingEdge,directionProbability,oppositeProbability,hold:false};
  if(input.ageMinutes>=15&&(input.memory?.weakBars??0)>=2&&remainingEdge<=0
    &&directionProbability<PREDICTIVE_PATH_POLICY.edgeExitProbability)
    return{reason:"PREDICTIVE_EDGE_GONE",remainingEdge,directionProbability,oppositeProbability,hold:false};
  return{reason:null,remainingEdge,directionProbability,oppositeProbability,hold:true};
}
