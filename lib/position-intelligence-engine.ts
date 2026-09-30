import type {CandleLike,LiquidityTradePlan,MarketNarrative,MarketSymbolState} from "./market-intelligence-engine.ts";
import type {SymbolLiquidityMap} from "./market-intelligence-liquidity.ts";

export const POSITION_INTELLIGENCE_VERSION="position-intelligence-v1";
export type PositionDecision="HOLD"|"REVIEW"|"EXIT";
export type PositionPhase="BUILDING"|"HEALTHY"|"MATURE"|"DECAYING"|"AT_RISK";
export type PositionEvidenceFamily="RELATIVE"|"PATH"|"FLOW"|"STRUCTURE"|"LIQUIDITY"|"MARKET";
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
  bidLiquidityChange?:number;
  askLiquidityChange?:number;
  liquiditySourceCount?:number;
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
  currentPrice?:number;liquidity?:SymbolLiquidityMap;entryTradePlan?:LiquidityTradePlan;
  entryOrigin?:{lower:number;upper:number}|null;entryTarget?:{lower:number;upper:number}|null;
  previous?:PositionIntelligenceState;costRate?:number;marketStateAgeMs?:number;entryResponseValidated?:boolean;
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
    alignedLiquidity=d*((q?.bidLiquidityChange??0)-(q?.askLiquidityChange??0))*.5,
    liquiditySources=q?.liquiditySourceCount??0,
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
    supportiveBook=alignedBook>.12,opposingBook=alignedBook<-.12,
    supportiveLiquidity=alignedLiquidity>.10,opposingLiquidity=alignedLiquidity<-.10,
    enoughLiquidity=liquiditySources>=2;
  if((supportivePressure&&microEfficiency>.05)
    ||(enoughLiquidity&&(supportiveBook||supportiveLiquidity)&&microEfficiency>=-.05)
    ||(opposingPressure&&microEfficiency>=0&&alignedBook>=-.1&&alignedLiquidity>=-.08))
    assessments.push(family("FLOW","SUPPORT",clip(.35+Math.abs(alignedPressure)*.25+Math.max(0,alignedBook)*.18+Math.max(0,alignedLiquidity)*.22),
      opposingPressure
        ?"逆向跨所压力没有推动价格，同时盘口/流动性没有同步恶化，当前方向仍有吸收与承接。"
        :enoughLiquidity&&supportiveLiquidity
          ?`跨所盘口流动性向持仓方向改善（${liquiditySources}路），且价格没有出现明显逆向效率。`
          :"跨所短时压力与价格推进一致，当前方向仍有真实响应。"));
  else if((supportivePressure&&(supportiveBook||supportiveLiquidity)&&microEfficiency<-.12)
    ||(opposingPressure&&(opposingBook||opposingLiquidity)&&microEfficiency<-.18)
    ||(enoughLiquidity&&opposingLiquidity&&microEfficiency<-.10))
    assessments.push(family("FLOW","CONCERN",clip(.45+Math.abs(alignedPressure)*.25+Math.max(0,-alignedBook)*.18+Math.max(0,-alignedLiquidity)*.22),
      supportivePressure
        ?"看似有利的跨所压力与盘口支持都存在，但价格推进反而转弱，出现吸收/推动效率下降。"
        :enoughLiquidity&&opposingLiquidity
          ?`跨所盘口流动性连续向持仓反方向迁移（${liquiditySources}路），同时价格开始响应。`
          :"跨所压力与盘口方向同时反向，价格也开始有效响应。"));
  else assessments.push(family("FLOW","NEUTRAL",.18,
    sourceCount>=2
      ?`跨所流动性与价格结果尚未收敛（报价${sourceCount}路，盘口尺寸${liquiditySources}路，分歧 ${(disagreement*100).toFixed(2)}%）。`
      :"跨所实时细节覆盖不足，不允许它触发退出。"));

  if(signalAligned&&same>=62)
    assessments.push(family("STRUCTURE","SUPPORT",clip(.35+(same-62)/55),`当前结构仍偏向原持仓方向，方向适配 ${same.toFixed(0)}。`));
  else if(!signalAligned&&opposite>=68&&alignedZ<0)
    assessments.push(family("STRUCTURE","CONCERN",clip(.50+(opposite-68)/45+Math.abs(alignedZ)*.10),
      `结构方向已经反向且相对表现同步恶化，反向适配 ${opposite.toFixed(0)}。`));
  else assessments.push(family("STRUCTURE","NEUTRAL",.20,"结构正在过渡，但尚未形成足够独立的反向确认。"));

  const liq=input.liquidity,plan=input.entryTradePlan,px=input.currentPrice??0,
    origin=input.entryOrigin,target=input.entryTarget,
    inOrigin=!!origin&&px>=origin.lower&&px<=origin.upper,
    inTarget=!!target&&px>=target.lower&&px<=target.upper,
    liqSide=liq?.departure.side==="UP"?"LONG":liq?.departure.side==="DOWN"?"SHORT":null;
  if(!liq?.ready||!plan||plan==="OBSERVE_ONLY")
    assessments.push(family("LIQUIDITY","NEUTRAL",0,"流动性计划信息不足，不允许它单独改变仓位。"));
  else if(plan==="LIQUIDITY_MIGRATION"){
    if(inOrigin)assessments.push(family("LIQUIDITY","CONCERN",.75,"价格已经重新被入场来源流动性区域吸收，原迁移假设明显受损。"));
    else if(liq.departure.state==="ACCEPTED"&&liqSide===input.side)
      assessments.push(family("LIQUIDITY","SUPPORT",clip(.45+liq.departure.confidence*.45+(liq.targetDistanceRate??0)*4),
        inTarget?"已经到达下一片流动性区域，迁移完成度提高但后续利润空间需要重新评估。":
          "价格仍被市场接受在原流动性区外，迁移方向继续成立。"));
    else if(inTarget)assessments.push(family("LIQUIDITY","NEUTRAL",.30,"已经进入入场时的下一片流动性目标，后续是否继续扩张需要重新建立新区域。"));
    else assessments.push(family("LIQUIDITY","NEUTRAL",.22,"迁移尚未失效，但当前接受度不足以单独支持继续扩大预期。"));
  }else if(plan==="LIQUIDITY_REJECTION"){
    const failedSide=input.side==="LONG"?"SHORT":"LONG";
    if(liq.departure.state==="ACCEPTED"&&liqSide===failedSide)
      assessments.push(family("LIQUIDITY","CONCERN",.72,"价格再次向原失败突破方向离开并被市场接受，回归计划失效风险高。"));
    else if(inOrigin||liq.departure.state==="INSIDE"||liq.departure.state==="REJECTED")
      assessments.push(family("LIQUIDITY","SUPPORT",clip(.38+liq.accumulation*.28+liq.departure.confidence*.22),
        "价格仍被原流动性区域吸收，离开失败后的回归逻辑继续成立。"));
    else assessments.push(family("LIQUIDITY","NEUTRAL",.20,"离开失败回归仍在发展，但尚未出现新的决定性流动性证据。"));
  }else{
    const opposite=input.side==="LONG"?"SHORT":"LONG";
    if((liq.departure.state==="ACCEPTED"&&liqSide===input.side)
      ||(liq.departure.state==="REJECTED"&&liqSide===opposite))
      assessments.push(family("LIQUIDITY","SUPPORT",clip(.40+liq.departure.confidence*.40),
        "个体流动性行为继续支持家族提前转折方向；若市场随后同向迁移，这笔持仓可自然升级为迁移持仓。"));
    else if(liq.departure.state==="ACCEPTED"&&liqSide===opposite)
      assessments.push(family("LIQUIDITY","CONCERN",.68,"个体已经重新接受原市场方向，家族提前转折证据正在失效。"));
    else assessments.push(family("LIQUIDITY","NEUTRAL",.20,"家族转折尚未被个体新的流动性迁移确认或否定。"));
  }

  const mAlign=marketAlignment(input.narrative,input.side);
  if(mAlign>.35)assessments.push(family("MARKET","SUPPORT",clip(mAlign),"整体市场背景仍支持当前仓位，但该信息不能单独决定平仓。",true));
  else if(mAlign<-.35)assessments.push(family("MARKET","CONCERN",clip(Math.abs(mAlign)),"整体市场背景开始不利，但市场变化不能单独平掉独立仓位。",true));
  else assessments.push(family("MARKET","NEUTRAL",.15,"整体市场背景对这笔独立仓位暂时没有决定性作用。",true));

  const self=assessments.filter(x=>!x.contextOnly),support=self.filter(x=>x.stance==="SUPPORT"&&x.severity>=.30),
    concern=self.filter(x=>x.stance==="CONCERN"&&x.severity>=.35),
    supportFamilies=support.map(x=>x.family),concernFamilies=concern.map(x=>x.family),
    stateVol=Math.max(.0005,state?.volatility??input.stopRate/3),
    structuralRoom=state?(input.side==="LONG"?state.roomLong:state.roomShort):Math.max(0,input.entryRemainingSpaceRate-input.signedRate),
    liquidityRoom=input.entryTarget&&px>0?(input.side==="LONG"?Math.max(0,input.entryTarget.lower-px):Math.max(0,px-input.entryTarget.upper))/px:
      input.entryOrigin&&px>0&&plan==="LIQUIDITY_REJECTION"?(input.side==="LONG"?Math.max(0,input.entryOrigin.upper-px):Math.max(0,px-input.entryOrigin.lower))/px:0,
    currentRoom=Math.max(structuralRoom,liquidityRoom),
    remainingSpaceRate=Math.max(0,currentRoom+Math.max(0,alignedResidual)*.20-cost),
    adverseMinute=minute.filter(v=>d*v<0).map(v=>Math.abs(v)),
    minutePullback=adverseMinute.length?mean(adverseMinute.slice(-5))*2.2:0,
    expectedPullbackRate=Math.max(cost*1.1,stateVol*Math.sqrt(3)*1.05,minutePullback),
    continuationRatio=remainingSpaceRate/Math.max(expectedPullbackRate,1e-9),
    familyNet=support.reduce((n,x)=>n+x.severity,0)-concern.reduce((n,x)=>n+x.severity,0),
    currentAdvantage=clip((same*.55+(50+alignedZ*14)*.20+pathSide*100*.15+(50+alignedPressure*25)*.10),0,100),
    entryAdvantage=clip(input.entryScore,0,100),advantageChange=currentAdvantage-entryAdvantage,
    scoredContinuationRatio=input.entryResponseValidated?Math.min(2.5,continuationRatio):continuationRatio,
    spaceWeight=input.entryResponseValidated&&concernFamilies.length>=2?10:18,
    holdValueScore=clip(50+spaceWeight*(scoredContinuationRatio-1)+12*familyNet+.28*advantageChange,0,100),
    exitValueScore=100-holdValueScore,
    stateFreshness=input.marketStateAgeMs==null?1:input.marketStateAgeMs<=8*60_000?1:input.marketStateAgeMs<=15*60_000?.55:0,
    dataConfidence=clip((((state?.dataConfidence??45)*.70+Math.min(4,sourceCount)*6.25+Math.min(3,liquiditySources)*3.5)
      -Math.min(.02,disagreement)*600)*stateFreshness,0,100),
    coreConcern=concern.some(x=>x.family==="RELATIVE"||x.family==="STRUCTURE"||x.family==="LIQUIDITY"),
    structureConcern=concern.some(x=>x.family==="STRUCTURE"),
    independentConfirm=concern.some(x=>x.family==="PATH"||x.family==="FLOW"),
    enoughIndependentConcern=coreConcern&&independentConfirm,
    entryFailureConcern=structureConcern&&independentConfirm,
    // Entry failure is evidence-based, never clock-based. A slow starter may stay
    // unproven for as long as its own structure/path/flow have not actually
    // falsified the entry. The fast path only fires when a response-validated
    // entry never achieved even the normal first-proof threshold, has no
    // surviving support family, moves materially against the entry relative to
    // its own stop/pullback geometry, and independent evidence converges.
    proofThreshold=cost*.65,
    entryFalsificationAdverse=Math.max(cost*1.15,Math.min(input.stopRate*.45,expectedPullbackRate*.55)),
    entryNeverProved=!!input.entryResponseValidated&&!input.firstProfit&&input.peakFavorableRate<proofThreshold,
    entryFalsified=entryNeverProved&&entryFailureConcern&&supportFamilies.length===0&&dataConfidence>=70
      &&input.signedRate<=-entryFalsificationAdverse&&advantageChange<-18,
    valueWeak=continuationRatio<.95||holdValueScore<38,
    noFeedbackRisk=!input.firstProfit&&input.ageMin>=Math.min(60,input.expectedHoldMinutes*.40)&&input.signedRate<cost*.25&&concernFamilies.length>=2,
    shouldReview=(concernFamilies.length>=1&&(continuationRatio<1.35||advantageChange<-10))||concernFamilies.length>=2||noFeedbackRisk,
    prior=input.previous,newCompletedBar=completedBar>0&&completedBar>(prior?.lastCompletedBar??0),
    continuedReview=shouldReview&&prior&&(prior.decision==="REVIEW"||prior.decision==="EXIT"),
    reviewBars=shouldReview?(continuedReview?(prior.reviewBars+(newCompletedBar?1:0)):1):0,
    reviewSince=shouldReview?(continuedReview?prior.reviewSince??input.now:input.now):null,
    unconfirmedFailure=entryNeverProved&&entryFailureConcern&&dataConfidence>=60&&reviewBars>=2
      &&input.signedRate<=-Math.max(cost*.35,entryFalsificationAdverse*.45),
    // Proven trades keep the normal two-family value exit. A still-unproven
    // starter cannot be value-exited while its own STRUCTURE remains neutral.
    hardExit=enoughIndependentConcern&&valueWeak&&dataConfidence>=60&&reviewBars>=2
      &&(!entryNeverProved||structureConcern),
    decision:PositionDecision=entryFalsified||hardExit||unconfirmedFailure?"EXIT":shouldReview?"REVIEW":"HOLD",
    phase:PositionPhase=decision==="EXIT"?"AT_RISK":decision==="REVIEW"?(input.signedRate>cost?"DECAYING":"AT_RISK")
      :input.ageMin<input.expectedHoldMinutes*.20?"BUILDING":continuationRatio>=1.6?"HEALTHY":"MATURE",
    counterfactualNewEntry=remainingSpaceRate>=expectedPullbackRate*1.35&&same>=65&&dataConfidence>=60,
    reasons=support.map(x=>x.summary),concerns=concern.map(x=>x.summary),
    summary=decision==="EXIT"
      ?entryFalsified
        ?`入场尚未形成过有效正向证明，价格已逆向 ${pct(input.signedRate)} 并超过该交易自身的早期证伪幅度 ${pct(entryFalsificationAdverse)}；至少两个独立证据家族同时反对且没有存活支持，判定为入场位置失败。`
        :`继续等待的剩余空间/正常回撤比已降至 ${continuationRatio.toFixed(2)}×，且至少两个独立仓位证据家族持续恶化；退出通过防误杀闸门。`
      :decision==="REVIEW"
      ?`发现矛盾但证据尚未收敛：剩余空间/正常回撤约 ${continuationRatio.toFixed(2)}×，进入复核，不因单一细节平仓。`
      :`继续持有价值仍占优：剩余空间/正常回撤约 ${continuationRatio.toFixed(2)}×，${supportFamilies.length}个独立家族支持，${concernFamilies.length}个家族担忧。`;

  return{version:POSITION_INTELLIGENCE_VERSION,updatedAt:input.now,decision,phase,reviewSince,reviewBars,lastCompletedBar:completedBar,
    entryAdvantage,currentAdvantage,advantageChange,remainingSpaceRate,expectedPullbackRate,continuationRatio,holdValueScore,exitValueScore,
    dataConfidence,counterfactualNewEntry,supportFamilies,concernFamilies,assessments,reasons,concerns,summary};
}
