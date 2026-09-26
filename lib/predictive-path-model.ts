import type {LinearHead,PredictiveFeatureVector,PredictivePathArtifact,PredictivePathForecast,RegressionHead} from "./predictive-path-types.ts";
import {PREDICTIVE_PATH_VERSION} from "./predictive-path-types.ts";

const sigmoid=(x:number)=>x>=0?1/(1+Math.exp(-x)):Math.exp(x)/(1+Math.exp(x));
const clamp=(v:number,a:number,b:number)=>Math.max(a,Math.min(b,v));
function normalized(feature:PredictiveFeatureVector,artifact:PredictivePathArtifact){
  if(feature.names.length!==artifact.featureNames.length||feature.names.some((x,i)=>x!==artifact.featureNames[i]))
    throw new Error("predictive feature schema mismatch");
  return feature.values.map((v,i)=>(v-artifact.mean[i]!)/Math.max(artifact.scale[i]!,1e-9));
}
function raw(head:{bias:number;weights:number[]},x:number[]){if(head.weights.length!==x.length)throw new Error("predictive head width mismatch");
  return head.bias+head.weights.reduce((s,w,i)=>s+w*x[i]!,0);}
function prob(head:LinearHead,x:number[]){const z=raw(head,x),p=sigmoid(z);return head.calibration?sigmoid(head.calibration.a*z+head.calibration.b):p;}
function reg(head:RegressionHead,x:number[]){return raw(head,x);}

export function forecastPredictivePath(feature:PredictiveFeatureVector,artifact:PredictivePathArtifact):PredictivePathForecast{
  if(artifact.version!==PREDICTIVE_PATH_VERSION)throw new Error("predictive artifact version mismatch");
  const x=normalized(feature,artifact),p15=prob(artifact.direction["15"],x),p30=prob(artifact.direction["30"],x),
    p60=prob(artifact.direction["60"],x),p120=prob(artifact.direction["120"],x),
    r15=reg(artifact.expectedReturn["15"],x),r30=reg(artifact.expectedReturn["30"],x),r60=reg(artifact.expectedReturn["60"],x),r120=reg(artifact.expectedReturn["120"],x),
    lm=Math.max(0,reg(artifact.longMfe60,x)),la=Math.max(0,reg(artifact.longMae60,x)),
    sm=Math.max(0,reg(artifact.shortMfe60,x)),sa=Math.max(0,reg(artifact.shortMae60,x)),
    touchLong=prob(artifact.longTargetBeforeRisk60,x),touchShort=prob(artifact.shortTargetBeforeRisk60,x),
    regretLong=Math.max(0,reg(artifact.longEntryRegret10,x)),regretShort=Math.max(0,reg(artifact.shortEntryRegret10,x)),
    qIndex=feature.names.indexOf("source_count"),aIndex=feature.names.indexOf("source_agreement"),
    bIndex=feature.names.indexOf("source_breadth"),dIndex=feature.names.indexOf("source_disagreement"),
    sourceCount=qIndex>=0?Math.round(feature.values[qIndex]!*5):0,
    agreement=aIndex>=0?clamp(feature.values[aIndex]!+.5,0,1):.5,
    breadth=bIndex>=0?clamp(feature.values[bIndex]??0,-1,1):0,
    disagreementRate=dIndex>=0?Math.max(0,feature.values[dIndex]??0):0,
    multiConfidence=sourceCount>=3?clamp(.55+.3*agreement-.15*Math.min(1,disagreementRate/.01),0,1):sourceCount===2?.48:.32,
    directionalLong=(p60*.45+p120*.35+p30*.20),directionalShort=1-directionalLong,
    longNet=r60-artifact.costRate,shortNet=-r60-artifact.costRate,
    longEv=.5*longNet+.3*(lm-la-artifact.costRate)+.2*(touchLong-.5)*.01-regretLong*.35,
    shortEv=.5*shortNet+.3*(sm-sa-artifact.costRate)+.2*(touchShort-.5)*.01-regretShort*.35,
    preferredSide=longEv>0&&directionalLong>=.58?"LONG":shortEv>0&&directionalShort>=.58?"SHORT":null,
    sideProbability=preferredSide==="LONG"?directionalLong:preferredSide==="SHORT"?directionalShort:.5,
    sideTouch=preferredSide==="LONG"?touchLong:preferredSide==="SHORT"?touchShort:.5,
    sideRegret=preferredSide==="LONG"?regretLong:preferredSide==="SHORT"?regretShort:Infinity,
    confidence=clamp(.6*sideProbability+.25*sideTouch+.15*multiConfidence,0,1),
    enterNow=!!preferredSide&&sideProbability>=.62&&sideTouch>=.56&&sideRegret<=.0045&&multiConfidence>=.45&&disagreementRate<=.012,
    waitReason=enterNow?null:!preferredSide?"未来路径没有正的成本后期望"
      :sideProbability<.62?"方向概率不足"
      :sideTouch<.56?"目标先于风险概率不足"
      :sideRegret>.0045?"模型预计未来10分钟有更好入场价"
      :multiConfidence<.45?"多数据源不足"
      :disagreementRate>.012?"多市场分歧过大":"等待";
  return{version:PREDICTIVE_PATH_VERSION,symbol:feature.symbol,at:feature.decisionAt,
    upProbability:{m15:p15,m30:p30,m60:p60,m120:p120},expectedReturn:{m15:r15,m30:r30,m60:r60,m120:r120},
    long:{mfe60:lm,mae60:la,targetBeforeRisk60:touchLong,entryRegret10:regretLong,netEv60:longEv},
    short:{mfe60:sm,mae60:sa,targetBeforeRisk60:touchShort,entryRegret10:regretShort,netEv60:shortEv},
    crossVenue:{sourceCount,agreement,breadth,disagreementRate},preferredSide,enterNow,waitReason,confidence};
}
