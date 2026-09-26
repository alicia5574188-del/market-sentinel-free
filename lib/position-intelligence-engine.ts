import type {CandleLike,MarketNarrative,MarketSymbolState} from "./market-intelligence-engine.ts";

export const POSITION_INTELLIGENCE_VERSION="position-intelligence-v1";
export type PositionDecision="HOLD"|"REVIEW"|"EXIT";
export type PositionPhase="BUILDING"|"HEALTHY"|"MATURE"|"DECAYING"|"AT_RISK";
export type PositionEvidenceFamily="RELATIVE"|"PATH"|"FLOW"|"STRUCTURE"|"MARKET";
export type PositionFamilyAssessment={
  family:PositionEvidenceFamily;
  stance:"SUPPORT"|"CONCERN"|"NEUTRAL";
  severity:number;
  summary:string;
  contextOnly?:boolean;
};
export type PositionIntelligenceState={
  version:string;
  updatedAt:number;
  decision:PositionDecision;
  phase:PositionPhase;
  reviewSince:number|null;
  reviewBars:number;
  lastCompletedBar:number;
  entryAdvantage:number;
  currentAdvantage:number;
  advantageChange:number;
  remainingSpaceRate:number;
  expectedPullbackRate:number;
  continuationRatio:number;
  holdValueScore:number;
  exitValueScore:number;
  dataConfidence:number;
  counterfactualNewEntry:boolean;
  supportFamilies:PositionEvidenceFamily[];
  concernFamilies:PositionEvidenceFamily[];
  assessments:PositionFamilyAssessment[];
  reasons:string[];
  concerns:string[];
  summary:string;
};

type QuoteDetail={
  sourceCount?:number;
  disagreementRate?:number;
  directionalAgreement?:number;
  sourceBreadth?:number;
  medianShortMove?:number;
  spreadRate?:number;
  bookImbalance?:number;
};

const clip=(v:number,a=0,b=1)=>Math.max(a,Math.min(b,v));
const mean=(xs:number[])=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:0;
const stdev=(xs:number[])=>{if(xs.length<2)return 0;const m=mean(xs);return Math.sqrt(mean(xs.map(x=>(x-m)**2)));};
const pct=(v:number)=>`${v>=0?"+":""}${(v*100).toFixed(2)}%`;
function minuteReturns(rows:CandleLike[]|undefined){
  const a=(rows??[]).slice(-10),out:number[]=[];for(let i=1;i<a.length;i++)if(a[i-1]!.close>0)out.push(a[i]!.close/a[i-1]!.close-1);return out;
}
function family(family:PositionEvidenceFamily,stance:PositionFamilyAssessment["stance"],severity:number,summary:string,contextOnly=false):PositionFamilyAssessment{
  return{family,stance,severity:clip(severity),summary,...(contextOnly?{contextOnly:true}:{})};
}
function sideScore(state:MarketSymbolState|undefined,side:"LONG"|"SHORT"){return state?(side==="LONG"?state.longScore:state.shortScore):50;}
function oppositeScore(state:MarketSymbolState|undefined,side:"LONG"|"SHORT"){return state?(side==="LONG"?state.shortScore:state.longScore):50;}
function marketAlignment(n:MarketNarrative|undefined,side:"LONG"|"SHORT"){
  const d=side==="LONG"?1:-1,b=(x?:string)=>x==="BULLISH"?1:x==="BEARISH"?-1:0;
  if(!n)return 0;return d*(b(n.major.bias)*.45+b(n.short.bias)*.35+b(n.transition.direction)*Math.min(.2,(n.transition.pressure??0)/500));
}

export function evaluatePositionIntelligence(input:{
  now:number;side:"LONG"|"SHORT";signedRate:number;peakFavorableRate:number;ageMin:number;firstProfit:boolean;
  expectedHoldMinutes:number;stopRate:number;entryScore:number;entryResidual:number;entryRelativeStrength:number;
  entryRemainingSpaceRate:number;state?:MarketSymbolState;narrative?:MarketNarrative;quote?:QuoteDetail;minutePath?:CandleLike[];
  previous?:PositionIntelligenceState;costRate?:number;marketStateAgeMs?:number;
}):PositionIntelligenceState{
  const d=input.side==="LONG"?1:-1,state=input.state,q=input.quote,cost=Math.max(.0005,input.costRate??.0019),
    alignedResidual=state?d*state.residual:0,alignedZ=state?d*state.residualZ:0,
    entryAligned=Math.max(.0005,d*input.entryResidual),
    relativeRetention=state?alignedResidual/entryAligned:1,
    currentRelative=input.side==="LONG"?(state?.relativeStrength??input.entryRelativeStrength):1-(state?.relativeStrength??input.entryRelativeStrength),
    entryRelative=input.side==="LONG"?input.entryRelativeStrength:1-input.entryRelativeStrength,
    relativeDelta=currentRelative-entryRelative,
    pathSide=state?(input.side==="LONG"?state.pathLong:state.pathShort):.5,
    minute=minuteReturns(input.minutePath),microProgress=d*minute.slice(-5).reduce((a,b)=>a+b,0),
    microVol=Math.max(.00035,stdev(minute.slice(-8))),microEfficiency=microProgress/(microVol*Math.sqrt(Math.max(1,Math.min(5,minute.length)))+1e-9),
    alignedPressure=state?d*state.venuePressure:0,
    alignedBook=d*(q?.bookImbalance??0),
    sourceCount=Math.max(state?.sourceCount??0,q?.sourceCount??0),disagreement=q?.disagreementRate??0,
    same=sideScore(state,input.side),opposite=oppositeScore(state,input.side),
    signalAligned=state?.signalSide===input.side,
    completedBar=state?.signalLastBar??input.previous?.lastCompletedBar??0;

  const assessments:PositionFamilyAssessment[]=[];

  if(!state)assessments.push(family("RELATIVE","NEUTRAL",0,"当前相对市场状态暂未完整，不能据此改变仓位。"));
  else if(alignedZ>=.35&&relativeRetention>=.55&&relativeDelta>=-.08)
    assessments.push(family("RELATIVE","SUPPORT",clip(.35+alignedZ/3+Math.min(.25,Math.max(0,relativeRetention-.55))),
      `相对优势仍成立：当前残差 ${pct(alignedResidual)}，相对入场优势保留 ${Math.max(0,relativeRetention*100).toFixed(0)}%。`));
  else if(alignedZ<-.25||(relativeRetention<.20&&relativeDelta<-.10))
    assessments.push(family("RELATIVE","CONCERN",clip(.45+Math.abs(Math.min(0,alignedZ))*.2+Math.max(0,.35-relativeRetention)),
      `相对优势明显恶化：当前残差 ${pct(alignedResidual)}，已经与入场优势显著背离。`));
  else assessments.push(family("RELATIVE","NEUTRAL",clip(Math.abs(relativeDelta)*2),
    `相对优势正在重新定价：当前残差 ${pct(alignedResidual)}，尚不足以单独证明原假设失效。`));

  if(pathSide>=.62&&microEfficiency>=-.15)
    assessments.push(family("PATH","SUPPORT",clip(.35+(pathSide-.62)*1.4+Math.max(0,microEfficiency)*.12),
      `价格路径仍有效：同方向路径占优，最近分钟级推进效率 ${microEfficiency.toFixed(2)}。`));
  else if(pathSide<=.40&&microEfficiency<-.20)
    assessments.push(family("PATH","CONCERN",clip(.45+(.40-pathSide)*1.8+Math.min(1,Math.abs(microEfficiency))*.25),
      `价格路径开始反向：最近分钟级推进效率 ${microEfficiency.toFixed(2)}，恢复质量不足。`));
  else assessments.push(family("PATH","NEUTRAL",.2,`短线路径混合，当前不足以证明继续或退出更优。`));

  const supportivePressure=alignedPressure>.25,opposingPressure=alignedPressure<-.25,
    supportiveBook=alignedBook>.12,opposingBook=alignedBook<-.12;
  if((supportivePressure&&microEfficiency>.05)||(opposingPressure&&microEfficiency>=0&&alignedBook>=-.1))
    assessments.push(family("FLOW","SUPPORT",clip(.35+Math.abs(alignedPressure)*.35+Math.max(0,alignedBook)*.15),
      opposingPressure?"逆向跨所压力存在，但价格没有被有效推动，当前仓位方向仍有承接。":"跨所短时压力与价格推进一致，当前方向仍有真实响应。"));
  else if((supportivePressure&&microEfficiency<-.12)||(opposingPressure&&microEfficiency<-.18&&opposingBook))
    assessments.push(family("FLOW","CONCERN",clip(.45+Math.abs(alignedPressure)*.35+Math.max(0,-alignedBook)*.15),
      supportivePressure?"看似有利的跨所压力已经难以推动价格，出现被吸收/推进失效迹象。":"跨所压力与盘口方向同时反向，价格也开始有效响应。"));
  else assessments.push(family("FLOW","NEUTRAL",.18,
    sourceCount>=2?`跨所压力尚未形成一致的价格结果（${sourceCount}路，分歧 ${(disagreement*100).toFixed(2)}%）。`:"跨所实时细节覆盖不足，不允许它触发退出。"));

  if(signalAligned&&same>=62)
    assessments.push(family("STRUCTURE","SUPPORT",clip(.35+(same-62)/55),`当前结构仍偏向原持仓方向，方向适配 ${same.toFixed(0)}。`));
  else if(!signalAligned&&opposite>=68&&alignedZ<0)
    assessments.push(family("STRUCTURE","CONCERN",clip(.50+(opposite-68)/45+Math.abs(alignedZ)*.10),
      `结构方向已经反向且相对表现同步恶化，反向适配 ${opposite.toFixed(0)}。`));
  else assessments.push(family("STRUCTURE","NEUTRAL",.20,"结构正在过渡，但尚未形成足够独立的反向确认。"));

  const mAlign=marketAlignment(input.narrative,input.side);
  if(mAlign>.35)assessments.push(family("MARKET","SUPPORT",clip(mAlign),"整体市场背景仍支持当前仓位，但该信息不能单独决定平仓。",true));
  else if(mAlign<-.35)assessments.push(family("MARKET","CONCERN",clip(Math.abs(mAlign)),"整体市场背景开始不利，但市场变化不能单独平掉独立仓位。",true));
  else assessments.push(family("MARKET","NEUTRAL",.15,"整体市场背景对这笔独立仓位暂时没有决定性作用。",true));

  const self=assessments.filter(x=>!x.contextOnly),support=self.filter(x=>x.stance==="SUPPORT"&&x.severity>=.30),
    concern=self.filter(x=>x.stance==="CONCERN"&&x.severity>=.35),
    supportFamilies=support.map(x=>x.family),concernFamilies=concern.map(x=>x.family),
    stateVol=Math.max(.0005,state?.volatility??input.stopRate/3),
    currentRoom=state?(input.side==="LONG"?state.roomLong:state.roomShort):Math.max(0,input.entryRemainingSpaceRate-input.signedRate),
    remainingSpaceRate=Math.max(0,currentRoom+Math.max(0,alignedResidual)*.30-cost),
    adverseMinute=minute.filter(v=>d*v<0).map(v=>Math.abs(v)),
    minutePullback=adverseMinute.length?mean(adverseMinute.slice(-5))*2.2:0,
    expectedPullbackRate=Math.max(cost*1.1,stateVol*Math.sqrt(3)*1.05,minutePullback),
    continuationRatio=remainingSpaceRate/Math.max(expectedPullbackRate,1e-9),
    familyNet=support.reduce((n,x)=>n+x.severity,0)-concern.reduce((n,x)=>n+x.severity,0),
    currentAdvantage=clip((same*.55+(50+alignedZ*14)*.20+pathSide*100*.15+(50+alignedPressure*25)*.10),0,100),
    entryAdvantage=clip(input.entryScore,0,100),advantageChange=currentAdvantage-entryAdvantage,
    holdValueScore=clip(50+18*(continuationRatio-1)+12*familyNet+.28*advantageChange,0,100),
    exitValueScore=100-holdValueScore,
    stateFreshness=input.marketStateAgeMs==null?1:input.marketStateAgeMs<=8*60_000?1:input.marketStateAgeMs<=15*60_000?.55:0,
    dataConfidence=clip((((state?.dataConfidence??45)*.75+Math.min(4,sourceCount)*6.25)-Math.min(.02,disagreement)*600)*stateFreshness,0,100),
    coreConcern=concern.some(x=>x.family==="RELATIVE"||x.family==="STRUCTURE"),
    independentConfirm=concern.some(x=>x.family==="PATH"||x.family==="FLOW"),
    enoughIndependentConcern=coreConcern&&independentConfirm,
    valueWeak=continuationRatio<.95||holdValueScore<38,
    noFeedbackRisk=!input.firstProfit&&input.ageMin>=Math.min(60,input.expectedHoldMinutes*.40)&&input.signedRate<cost*.25&&concernFamilies.length>=2,
    shouldReview=(concernFamilies.length>=1&&(continuationRatio<1.35||advantageChange<-10))||concernFamilies.length>=2||noFeedbackRisk,
    prior=input.previous,newCompletedBar=completedBar>0&&completedBar>(prior?.lastCompletedBar??0),
    continuedReview=shouldReview&&prior&&(prior.decision==="REVIEW"||prior.decision==="EXIT"),
    reviewBars=shouldReview?(continuedReview?(prior.reviewBars+(newCompletedBar?1:0)):1):0,
    reviewSince=shouldReview?(continuedReview?prior.reviewSince??input.now:input.now):null,
    hardExit=enoughIndependentConcern&&valueWeak&&dataConfidence>=60&&reviewBars>=2,
    decision:PositionDecision=hardExit?"EXIT":shouldReview?"REVIEW":"HOLD",
    phase:PositionPhase=decision==="EXIT"?"AT_RISK":decision==="REVIEW"?(input.signedRate>cost?"DECAYING":"AT_RISK")
      :input.ageMin<input.expectedHoldMinutes*.20?"BUILDING":continuationRatio>=1.6?"HEALTHY":"MATURE",
    counterfactualNewEntry=remainingSpaceRate>=expectedPullbackRate*1.35&&same>=65&&dataConfidence>=60,
    reasons=support.map(x=>x.summary),concerns=concern.map(x=>x.summary),
    summary=decision==="EXIT"
      ?`继续等待的剩余空间/正常回撤比已降至 ${continuationRatio.toFixed(2)}×，且至少两个独立仓位证据家族持续恶化；退出通过防误杀闸门。`
      :decision==="REVIEW"
      ?`发现矛盾但证据尚未收敛：剩余空间/正常回撤约 ${continuationRatio.toFixed(2)}×，进入复核，不因单一细节平仓。`
      :`继续持有价值仍占优：剩余空间/正常回撤约 ${continuationRatio.toFixed(2)}×，${supportFamilies.length}个独立家族支持，${concernFamilies.length}个家族担忧。`;

  return{version:POSITION_INTELLIGENCE_VERSION,updatedAt:input.now,decision,phase,reviewSince,reviewBars,lastCompletedBar:completedBar,
    entryAdvantage,currentAdvantage,advantageChange,remainingSpaceRate,expectedPullbackRate,continuationRatio,holdValueScore,exitValueScore,
    dataConfidence,counterfactualNewEntry,supportFamilies,concernFamilies,assessments,reasons,concerns,summary};
}
