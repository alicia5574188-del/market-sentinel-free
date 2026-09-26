import {buildPredictiveFeatures} from "./predictive-path-features.ts";
import {forecastPredictivePath} from "./predictive-path-model.ts";
import {PREDICTIVE_PATH_VERSION,type PredictiveAncillary,type PredictiveBar,type PredictivePathArtifact,type PredictivePathForecast,type PredictiveQuote} from "./predictive-path-types.ts";

const clamp=(v:number,a:number,b:number)=>Math.max(a,Math.min(b,v));
export type PredictiveCandidate={
  id:string;symbol:string;side:"LONG"|"SHORT";eligible:boolean;at:number;expiresAt:number;price:number;
  catastrophicStopRate:number;expectedHoldMinutes:15|30|60|120;rankingValue:number;confidence:number;
  expectedReturnRate:number;predictedMfeRate:number;predictedMaeRate:number;targetBeforeRisk:number;entryRegretRate:number;
  forecast:PredictivePathForecast;reason:string;
};
export type PredictiveEngineState={version:typeof PREDICTIVE_PATH_VERSION;updatedAt:number;symbols:Record<string,PredictivePathForecast>};

function quoteFresh(q:PredictiveQuote|undefined,now:number){return !!q&&q.fresh&&q.bestBid>0&&q.bestAsk>=q.bestBid&&q.observedAt<=now&&now-q.observedAt<=10_000;}
function bestHorizon(f:PredictivePathForecast,side:"LONG"|"SHORT"):15|30|60|120{
  const d=side==="LONG"?1:-1,candidates=[
    [15,d*f.expectedReturn.m15],[30,d*f.expectedReturn.m30],[60,d*f.expectedReturn.m60],[120,d*f.expectedReturn.m120],
  ] as const;
  return [...candidates].sort((a,b)=>b[1]-a[1])[0]![0];
}
function candidateFromForecast(symbol:string,forecast:PredictivePathForecast,q:PredictiveQuote|undefined,now:number):PredictiveCandidate|null{
  const side=forecast.preferredSide;if(!side)return null;
  const data=side==="LONG"?forecast.long:forecast.short,
    price=q?(q.bestBid+q.bestAsk)/2:0,
    catastrophicStopRate=clamp(Math.max(.0045,data.mae60*1.75+.0019),.0045,.03),
    expectedHoldMinutes=bestHorizon(forecast,side),
    expectedReturnRate=side==="LONG"?forecast.expectedReturn.m60:-forecast.expectedReturn.m60,
    rankingValue=(Math.max(0,data.netEv60)/Math.max(catastrophicStopRate,.001))*forecast.confidence,
    eligible=forecast.enterNow&&quoteFresh(q,now)&&price>0,
    reason="预测路径｜"+side+"｜60m方向概率"+(((side==="LONG"?forecast.upProbability.m60:1-forecast.upProbability.m60)*100).toFixed(0))
      +"%｜目标先于风险"+(data.targetBeforeRisk60*100).toFixed(0)+"%｜预计MFE "+(data.mfe60*100).toFixed(2)
      +"%｜MAE "+(data.mae60*100).toFixed(2)+"%｜10m入场后悔 "+(data.entryRegret10*100).toFixed(2)+"%";
  return{id:"predictive-"+symbol+"-"+now,symbol,side,eligible,at:now,expiresAt:now+5*60_000,price,catastrophicStopRate,expectedHoldMinutes,
    rankingValue,confidence:forecast.confidence,expectedReturnRate,predictedMfeRate:data.mfe60,predictedMaeRate:data.mae60,
    targetBeforeRisk:data.targetBeforeRisk60,entryRegretRate:data.entryRegret10,forecast,reason};
}

export function buildPredictivePathEngine(input:{paths:Record<string,PredictiveBar[]>;quotes:Record<string,PredictiveQuote>;
  ancillary?:Record<string,PredictiveAncillary>;artifact:PredictivePathArtifact;now:number;allowed?:Set<string>}){
  const symbols:Record<string,PredictivePathForecast>={},candidates:PredictiveCandidate[]=[];
  for(const [symbol,path] of Object.entries(input.paths)){
    if(input.allowed&&!input.allowed.has(symbol))continue;
    const feature=buildPredictiveFeatures({symbol,decisionAt:input.now,bars5m:path,quote:input.quotes[symbol],ancillary:input.ancillary?.[symbol]});
    if(!feature)continue;
    const forecast=forecastPredictivePath(feature,input.artifact);symbols[symbol]=forecast;
    const candidate=candidateFromForecast(symbol,forecast,input.quotes[symbol],input.now);if(candidate)candidates.push(candidate);
  }
  candidates.sort((a,b)=>Number(b.eligible)-Number(a.eligible)||b.rankingValue-a.rankingValue||b.confidence-a.confidence);
  return{state:{version:PREDICTIVE_PATH_VERSION,updatedAt:input.now,symbols} satisfies PredictiveEngineState,candidates};
}

export type PredictiveExitReason="CATASTROPHIC_STOP"|"PREDICTIVE_EDGE_GONE"|"PREDICTIVE_REVERSAL"|null;
export function predictiveExitDecision(input:{side:"LONG"|"SHORT";forecast:PredictivePathForecast|undefined;stopped:boolean;ageMinutes:number}):{
  reason:PredictiveExitReason;remainingEdge:number;directionProbability:number;oppositeProbability:number;hold:boolean}{
  if(input.stopped)return{reason:"CATASTROPHIC_STOP",remainingEdge:0,directionProbability:0,oppositeProbability:1,hold:false};
  if(!input.forecast)return{reason:null,remainingEdge:0,directionProbability:.5,oppositeProbability:.5,hold:true};
  const sideData=input.side==="LONG"?input.forecast.long:input.forecast.short,
    directionProbability=input.side==="LONG"
      ?(.45*input.forecast.upProbability.m60+.35*input.forecast.upProbability.m120+.20*input.forecast.upProbability.m30)
      :(.45*(1-input.forecast.upProbability.m60)+.35*(1-input.forecast.upProbability.m120)+.20*(1-input.forecast.upProbability.m30)),
    oppositeProbability=1-directionProbability,remainingEdge=sideData.netEv60;
  if(input.forecast.enterNow&&input.forecast.preferredSide&&input.forecast.preferredSide!==input.side&&oppositeProbability>=.64)
    return{reason:"PREDICTIVE_REVERSAL",remainingEdge,directionProbability,oppositeProbability,hold:false};
  if(input.ageMinutes>=8&&remainingEdge<=0&&directionProbability<.49)
    return{reason:"PREDICTIVE_EDGE_GONE",remainingEdge,directionProbability,oppositeProbability,hold:false};
  return{reason:null,remainingEdge,directionProbability,oppositeProbability,hold:true};
}
