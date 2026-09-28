import type { MarketIntelligenceState, MarketSymbolState } from "./market-intelligence-engine.ts";
import type { PositionIntelligenceState } from "./position-intelligence-engine.ts";

export const MARKET_LIFECYCLE_VERSION="market-intelligence-lifecycle-v1";

export type RollingMarketResearch={
  state:"INSUFFICIENT"|"STABLE_TREND"|"ROTATIONAL"|"TRANSITIONAL";
  rotationScore:number;stabilityScore:number;leadershipRotationShare60:number;mixedShare60:number;trendingShare60:number;
};
export type MarketLifecycleResearchContext={rolling?:RollingMarketResearch|null};

export type MarketEvolutionPhase="ROTATIONAL"|"TREND_FORMING"|"EXPANDING"|"STABLE_TREND"|"DECAYING"|"TRANSITIONAL";
export type MarketEvolutionState={
  version:typeof MARKET_LIFECYCLE_VERSION;phase:MarketEvolutionPhase;trendSide:"LONG"|"SHORT"|null;
  expansionScore:number;rotationRisk:number;reason:string;
};
export type OpportunityLifecyclePhase="EMERGING"|"CONFIRMED"|"EXPANDING"|"MATURE"|"OVEREXTENDED";
export type OpportunityLifecycleState={
  version:typeof MARKET_LIFECYCLE_VERSION;phase:OpportunityLifecyclePhase;extendedConfirmation:boolean;reason:string;
};
export type ProfitLifecyclePhase="UNPROVEN"|"PROVEN"|"EXPANDING"|"PULLBACK"|"DECAYING"|"INVALIDATED";
export type ProfitLifecycleAction="HOLD"|"WATCH"|"PROTECT"|"EXIT";
export type ProfitLifecycleState={
  version:typeof MARKET_LIFECYCLE_VERSION;phase:ProfitLifecyclePhase;action:ProfitLifecycleAction;
  proof:"NONE"|"THIN"|"MEANINGFUL"|"EXPANSION";peakNetRate:number;currentNetRate:number;givebackRatio:number|null;
  floorRate:number;retentionRate:number;reason:string;
};

const clip=(v:number,a=0,b=1)=>Math.max(a,Math.min(b,v));
const biasSign=(bias:string)=>bias==="BULLISH"?1:bias==="BEARISH"?-1:0;
const trendLike=(phase:MarketEvolutionPhase)=>phase==="TREND_FORMING"||phase==="EXPANDING"||phase==="STABLE_TREND";

export function deriveMarketEvolution(market:MarketIntelligenceState,research?:MarketLifecycleResearchContext|null):MarketEvolutionState{
  const i=market.internals,shortSign=biasSign(market.narrative.short.bias),transitionSign=biasSign(market.narrative.transition.direction),
    stage=market.narrative.transition.stage??"STABLE",rolling=research?.rolling??null,
    directional=market.narrative.short.phase==="ADVANCING"||market.narrative.short.phase==="DECLINING",
    alignedTransition=shortSign!==0&&transitionSign===shortSign&&(stage==="BUILDING"||stage==="CONFIRMED"),
    breadthAligned=shortSign?clip(shortSign*(i?.breadth3??0)/.45):0,
    breadthSlopeAligned=shortSign?clip(shortSign*(i?.breadthSlope??0)/.35):0,
    synchrony=clip(((i?.synchrony??.4)-.35)/.45),
    leaderPersistence=clip(((i?.leaderPersistence??.5)-.25)/.65),
    shortStrength=clip(Math.abs(market.narrative.short.score)/.45),
    transitionStrength=alignedTransition?clip((market.narrative.transition.pressure??0)/65):0,
    flowAligned=shortSign?clip(shortSign*(i?.venuePressure??0)/.45):0,
    expansionScore=clip(.22*breadthAligned+.10*breadthSlopeAligned+.17*synchrony+.19*leaderPersistence
      +.14*shortStrength+.10*transitionStrength+.08*flowAligned),
    rotationRisk=rolling?clip(rolling.rotationScore):clip(.40*(1-leaderPersistence)+.30*clip((i?.dispersion??0)/1.2)+.30*(1-synchrony));
  let phase:MarketEvolutionPhase="TRANSITIONAL";
  if(rolling?.state==="STABLE_TREND"&&directional&&expansionScore>=.44)phase="STABLE_TREND";
  else if(alignedTransition&&expansionScore>=.55)phase="TREND_FORMING";
  else if(directional&&expansionScore>=.68)phase="EXPANDING";
  else if(rolling?.state==="ROTATIONAL"&&expansionScore<.55)phase="ROTATIONAL";
  else if((rolling?.state==="TRANSITIONAL"||rolling?.state==="ROTATIONAL")
    &&shortSign!==0&&((transitionSign!==0&&transitionSign!==shortSign)||(i?.leaderPersistence??.5)<.32)
    &&market.narrative.transition.pressure>=28)phase="DECAYING";
  const trendSide:MarketEvolutionState["trendSide"]=shortSign>0?"LONG":shortSign<0?"SHORT":transitionSign>0?"LONG":transitionSign<0?"SHORT":null,
    reason=phase==="ROTATIONAL"
      ?`市场仍以轮动为主：轮动风险 ${(rotationRisk*100).toFixed(0)}%，趋势扩张证据仅 ${(expansionScore*100).toFixed(0)}%。`
      :phase==="TREND_FORMING"
      ?`轮动正在向${trendSide==="LONG"?"上行":"下行"}趋势形成迁移，扩张证据 ${(expansionScore*100).toFixed(0)}%。`
      :phase==="EXPANDING"||phase==="STABLE_TREND"
      ?`市场方向扩张仍在延续，扩张证据 ${(expansionScore*100).toFixed(0)}%，允许强势赢家继续释放空间。`
      :phase==="DECAYING"
      ?`原方向领导结构正在衰退，轮动/反向迁移风险上升。`
      :`市场处于过渡阶段，尚不足以确认稳定趋势或纯轮动。`;
  return{version:MARKET_LIFECYCLE_VERSION,phase,trendSide,expansionScore,rotationRisk,reason};
}

export function deriveOpportunityLifecycle(input:{
  side:"LONG"|"SHORT";symbol:MarketSymbolState;thesisBars:number;market:MarketEvolutionState;
}):OpportunityLifecycleState{
  const extension=Math.abs(input.symbol.residualZ),early=input.thesisBars<=2,
    marketSupports=input.market.trendSide===input.side&&trendLike(input.market.phase),
    overextended=input.market.phase==="ROTATIONAL"&&early&&extension>=2.20&&input.market.expansionScore<.55&&!marketSupports;
  let phase:OpportunityLifecyclePhase;
  if(overextended)phase="OVEREXTENDED";
  else if(early&&extension>=1.20)phase="EXPANDING";
  else if(input.thesisBars>=4&&extension>=.80)phase="MATURE";
  else if(input.thesisBars>=2)phase="CONFIRMED";
  else phase="EMERGING";
  const reason=phase==="OVEREXTENDED"
    ?"个体已经极端扩张，但全市场仍处于轮动；保留机会，不直接禁止交易，要求更完整的实时延续确认。"
    :phase==="EXPANDING"
    ?"个体强势正在扩张，仍需观察市场是否同步从轮动转向趋势。"
    :phase==="MATURE"
    ?"相对优势已持续多根完成5m，机会成熟但继续关注领导权是否开始轮换。"
    :phase==="CONFIRMED"
    ?"相对机会已经确认，沿用原有实时响应成交链。"
    :"机会仍在萌芽阶段，继续积累完成5m与实时响应证据。";
  return{version:MARKET_LIFECYCLE_VERSION,phase,extendedConfirmation:phase==="OVEREXTENDED",reason};
}

export function extendedEntryConfirmationReady(input:{
  required:boolean;elapsedMs:number;supportSamples:number;currentAdvanceRate:number;bestAdvanceRate:number;
}){
  if(!input.required)return true;
  const retained=input.bestAdvanceRate<=0?0:input.currentAdvanceRate/input.bestAdvanceRate;
  return input.elapsedMs>=12_000&&input.supportSamples>=3&&retained>=.70;
}

export function deriveProfitLifecycle(input:{
  signedRate:number;peakFavorableRate:number;pullbackRiskRate:number;firstProfit:boolean;costRate:number;
  position:PositionIntelligenceState;market:MarketEvolutionState;
}):ProfitLifecycleState{
  const cost=Math.max(.0005,input.costRate),peakNet=Math.max(0,input.peakFavorableRate-cost),currentNet=input.signedRate-cost,
    givebackNet=Math.max(0,peakNet-currentNet),giveback=peakNet>1e-12?givebackNet/peakNet:null,
    meaningfulThreshold=Math.max(cost*1.5,input.pullbackRiskRate*.20),
    expansionThreshold=Math.max(cost*5,input.pullbackRiskRate*.45),
    proof:ProfitLifecycleState["proof"]=peakNet<=0?"NONE":peakNet<meaningfulThreshold?"THIN":peakNet<expansionThreshold?"MEANINGFUL":"EXPANSION",
    concerns=input.position.concernFamilies.length,supports=input.position.supportFamilies.length,
    deteriorating=concerns>=2||input.position.advantageChange<=-22||(input.position.decision==="REVIEW"&&concerns>=1),
    healthyTrend=trendLike(input.market.phase)&&supports>=2&&concerns<=1&&input.position.advantageChange>-25,
    independentRunner=supports>=3&&concerns<=1&&input.position.continuationRatio>=1.45&&input.position.advantageChange>-28,
    runnerHealthy=healthyTrend||independentRunner;
  let phase:ProfitLifecyclePhase="UNPROVEN",action:ProfitLifecycleAction="HOLD",reason="交易尚未形成足够可兑现利润，继续由原持仓研究判断。";
  if(!input.firstProfit||proof==="NONE"){
    if(input.position.decision==="EXIT"){phase="INVALIDATED";action="EXIT";reason="尚未证明交易价值且独立持仓证据已经确认失效。";}
    else if(input.position.decision==="REVIEW"){action="WATCH";reason="尚未形成有效利润，同时持仓证据开始冲突，进入观察。";}
  }else{
    phase=proof==="EXPANSION"?"EXPANDING":"PROVEN";
    if(runnerHealthy&&(giveback??0)<.60){
      if((giveback??0)>=.30){phase="PULLBACK";action="WATCH";reason="利润发生回调，但市场正在形成/延续趋势，保留大赢家尾部空间。";}
      else{action="HOLD";reason="利润仍处于健康扩张，市场趋势证据支持继续持有。";}
    }else if(input.position.decision==="EXIT"&&((giveback??0)>=.30||currentNet<=0)){
      phase="INVALIDATED";action="EXIT";reason="利润生命周期与独立持仓证据同时确认原交易优势已经失效。";
    }else if(proof==="EXPANSION"&&(giveback??0)>=.42&&deteriorating){
      phase="DECAYING";action="PROTECT";reason="扩张利润明显回吐且优势衰退，开始建立真实利润底线。";
    }else if(proof==="MEANINGFUL"&&(giveback??0)>=.50&&deteriorating){
      phase="DECAYING";action="PROTECT";reason="可兑现利润已回吐过半且优势衰退，进入保护阶段。";
    }else if((giveback??0)>=.30){
      phase="PULLBACK";action="WATCH";reason="利润从峰值回调，但独立证据尚不足以证明趋势结束。";
    }else{
      action="HOLD";reason="利润已被证明且尚未出现足够衰退证据。";
    }
  }
  let retention=0;
  if(action==="PROTECT"){
    retention=input.market.phase==="ROTATIONAL"?.58:input.market.phase==="DECAYING"?.65:
      trendLike(input.market.phase)?.38:.50;
    if(concerns>=3)retention=Math.min(.78,retention+.08);
  }
  const floorRate=action==="PROTECT"&&peakNet>0?cost+peakNet*retention:0;
  return{version:MARKET_LIFECYCLE_VERSION,phase,action,proof,peakNetRate:peakNet,currentNetRate:currentNet,
    givebackRatio:giveback,floorRate,retentionRate:retention,reason};
}
