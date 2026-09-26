import type {LinearHead,PredictiveFeatureVector,PredictiveHead,PredictivePathArtifact,PredictivePathForecast,PredictiveTreeNode} from "./predictive-path-types.ts";
import {PREDICTIVE_PATH_VERSION} from "./predictive-path-types.ts";

const sigmoid=(x:number)=>x>=0?1/(1+Math.exp(-x)):Math.exp(x)/(1+Math.exp(x));
const clamp=(v:number,a:number,b:number)=>Math.max(a,Math.min(b,v));
function normalized(feature:PredictiveFeatureVector,artifact:PredictivePathArtifact){
  if(feature.names.length!==artifact.featureNames.length||feature.names.some((x,i)=>x!==artifact.featureNames[i]))
    throw new Error("predictive feature schema mismatch");
  const mean=artifact.mean??Array(feature.values.length).fill(0),scale=artifact.scale??Array(feature.values.length).fill(1);
  return feature.values.map((v,i)=>(v-(mean[i]??0))/Math.max(scale[i]??1,1e-9));
}
function treeValue(node:PredictiveTreeNode,x:number[]):number{
  if(typeof node.v==="number")return node.v;
  const f=node.f;if(typeof f!=="number"||!node.l||!node.r)throw new Error("invalid predictive tree node");
  const value=x[f],goLeft=Number.isFinite(value)?value<=Number(node.t??0):node.d!==false;
  return treeValue(goLeft?node.l:node.r,x);
}
function raw(head:PredictiveHead,feature:PredictiveFeatureVector,artifact:PredictivePathArtifact){
  if(head.kind==="lgbm")return head.baseScore+head.trees.reduce((s,t)=>s+treeValue(t,feature.values),0);
  const x=normalized(feature,artifact);if(head.weights.length!==x.length)throw new Error("predictive head width mismatch");
  return head.bias+head.weights.reduce((s,w,i)=>s+w*x[i]!,0);
}
function prob(head:PredictiveHead,feature:PredictiveFeatureVector,artifact:PredictivePathArtifact){
  const z=raw(head,feature,artifact);return head.calibration?sigmoid(head.calibration.a*z+head.calibration.b):sigmoid(z);
}
function reg(head:PredictiveHead,feature:PredictiveFeatureVector,artifact:PredictivePathArtifact){return raw(head,feature,artifact);}

export function forecastPredictivePath(feature:PredictiveFeatureVector,artifact:PredictivePathArtifact):PredictivePathForecast{
  if(artifact.version!==PREDICTIVE_PATH_VERSION)throw new Error("predictive artifact version mismatch");
  const p15=prob(artifact.direction["15"],feature,artifact),p30=prob(artifact.direction["30"],feature,artifact),
    p60=prob(artifact.direction["60"],feature,artifact),p120=prob(artifact.direction["120"],feature,artifact),
    r15=reg(artifact.expectedReturn["15"],feature,artifact),r30=reg(artifact.expectedReturn["30"],feature,artifact),
    r60=reg(artifact.expectedReturn["60"],feature,artifact),r120=reg(artifact.expectedReturn["120"],feature,artifact),
    lm=Math.max(0,reg(artifact.longMfe60,feature,artifact)),la=Math.max(0,reg(artifact.longMae60,feature,artifact)),
    sm=Math.max(0,reg(artifact.shortMfe60,feature,artifact)),sa=Math.max(0,reg(artifact.shortMae60,feature,artifact)),
    touchLong=prob(artifact.longTargetBeforeRisk60,feature,artifact),touchShort=prob(artifact.shortTargetBeforeRisk60,feature,artifact),
    regretLong=Math.max(0,reg(artifact.longEntryRegret10,feature,artifact)),regretShort=Math.max(0,reg(artifact.shortEntryRegret10,feature,artifact)),
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
    preferredSide=longEv>=artifact.policy.minNetEv&&directionalLong>=artifact.policy.directionMin?"LONG"
      :shortEv>=artifact.policy.minNetEv&&directionalShort>=artifact.policy.directionMin?"SHORT":null,
    sideProbability=preferredSide==="LONG"?directionalLong:preferredSide==="SHORT"?directionalShort:.5,
    sideTouch=preferredSide==="LONG"?touchLong:preferredSide==="SHORT"?touchShort:.5,
    sideRegret=preferredSide==="LONG"?regretLong:preferredSide==="SHORT"?regretShort:Infinity,
    confidence=clamp(.6*sideProbability+.25*sideTouch+.15*multiConfidence,0,1),
    enterNow=!!preferredSide&&sideProbability>=artifact.policy.directionMin&&sideTouch>=artifact.policy.touchMin
      &&sideRegret<=artifact.policy.regretMax&&sourceCount>=artifact.policy.minSources&&disagreementRate<=artifact.policy.maxDisagreement,
    waitReason=enterNow?null:!preferredSide?"未来路径没有正的成本后期望"
      :sideProbability<artifact.policy.directionMin?"方向概率不足"
      :sideTouch<artifact.policy.touchMin?"目标先于风险概率不足"
      :sideRegret>artifact.policy.regretMax?"模型预计未来10分钟有更好入场价"
      :sourceCount<artifact.policy.minSources?"多数据源不足"
      :disagreementRate>artifact.policy.maxDisagreement?"多市场分歧过大":"等待";
  return{version:PREDICTIVE_PATH_VERSION,symbol:feature.symbol,at:feature.decisionAt,
    upProbability:{m15:p15,m30:p30,m60:p60,m120:p120},expectedReturn:{m15:r15,m30:r30,m60:r60,m120:r120},
    long:{mfe60:lm,mae60:la,targetBeforeRisk60:touchLong,entryRegret10:regretLong,netEv60:longEv},
    short:{mfe60:sm,mae60:sa,targetBeforeRisk60:touchShort,entryRegret10:regretShort,netEv60:shortEv},
    crossVenue:{sourceCount,agreement,breadth,disagreementRate},preferredSide,enterNow,waitReason,confidence};
}
