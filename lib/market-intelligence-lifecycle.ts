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
  decisionStable?:boolean;stabilityScore?:number;
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
  trajectory:"BASE"|"OUTPERFORMING"|"RUNNER"|"DECAYING";runner:boolean;
  expectedAtEntryRate:number;revaluedPotentialRate:number;outperformanceMultiple:number;
  platformKind:"NONE"|"PROVEN"|"RUNNER";platformFloorRate:number;platformLevel:number;platformReason:string;
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
    rotationRisk=rolling?clip(rolling.rotationScore):clip(.40*(1-leaderPersistence)+.30*clip((i?.dispersion??0)/1.2)+.30*(1-synchrony)),
    stabilityScore=rolling?clip(rolling.stabilityScore):0,
    decisionStable=rolling?.state==="STABLE_TREND"||((rolling?.trendingShare60??0)>=.65&&rotationRisk<=.48);
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
  return{version:MARKET_LIFECYCLE_VERSION,phase,trendSide,expansionScore,rotationRisk,reason,decisionStable,stabilityScore};
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
  minimumElapsedMs?:number;minimumSupportSamples?:number;minimumRetainedRate?:number;
}){
  if(!input.required)return true;
  const retained=input.bestAdvanceRate<=0?0:input.currentAdvanceRate/input.bestAdvanceRate,
    minimumElapsedMs=Math.max(12_000,input.minimumElapsedMs??12_000),
    minimumSupportSamples=Math.max(3,input.minimumSupportSamples??3),
    minimumRetainedRate=Math.max(.60,Math.min(.90,input.minimumRetainedRate??.70));
  return input.elapsedMs>=minimumElapsedMs&&input.supportSamples>=minimumSupportSamples&&retained>=minimumRetainedRate;
}

export function deriveProfitLifecycle(input:{
  side:"LONG"|"SHORT";signedRate:number;peakFavorableRate:number;pullbackRiskRate:number;firstProfit:boolean;costRate:number;
  initialExpectedNetRate?:number;position:PositionIntelligenceState;market:MarketEvolutionState;
  forwardResearch?:{supportConfidence:number;adverseConfidence:number;confirmedAdverse:boolean};
}):ProfitLifecycleState{
  const cost=Math.max(.0005,input.costRate),peakNet=Math.max(0,input.peakFavorableRate-cost),currentNet=input.signedRate-cost,
    givebackNet=Math.max(0,peakNet-currentNet),giveback=peakNet>1e-12?givebackNet/peakNet:null,
    expectedAtEntryRate=Math.max(0,input.initialExpectedNetRate??0),
    meaningfulThreshold=Math.max(cost*1.5,input.pullbackRiskRate*.20),
    expansionThreshold=Math.max(cost*5,input.pullbackRiskRate*.45),
    proof:ProfitLifecycleState["proof"]=peakNet<=0?"NONE":peakNet<meaningfulThreshold?"THIN":peakNet<expansionThreshold?"MEANINGFUL":"EXPANSION",
    concerns=input.position.concernFamilies.length,supports=input.position.supportFamilies.length,
    researchAdverse=input.forwardResearch?.adverseConfidence??0,researchSupport=input.forwardResearch?.supportConfidence??0,
    researchDeteriorating=!!input.forwardResearch?.confirmedAdverse&&researchAdverse>=.68&&concerns>=1,
    persistentDeterioration=input.position.decision==="EXIT"
      ||(input.position.reviewBars>=2&&(concerns>=2||input.position.advantageChange<=-30))
      ||(researchDeteriorating&&input.position.reviewBars>=1),
    earlyDeterioration=input.position.decision==="REVIEW"&&input.position.reviewBars>=1
      &&(concerns>=2||input.position.advantageChange<=-24),
    stableMarketSupport=(input.market.decisionStable??input.market.phase==="STABLE_TREND")
      &&input.market.trendSide===input.side&&trendLike(input.market.phase),
    independentStrength=supports>=2&&input.position.continuationRatio>=1.25&&input.position.advantageChange>-30,
    researchSupported=researchSupport>=.72&&researchAdverse<.55&&supports>=2,
    outperformanceMultiple=expectedAtEntryRate>Math.max(cost,1e-9)?peakNet/expectedAtEntryRate:0,
    runnerByReprice=expectedAtEntryRate>0&&outperformanceMultiple>=1.55
      &&peakNet>=Math.max(expectedAtEntryRate*1.55,cost*7),
    runnerByAbsolute=peakNet>=Math.max(.045,input.pullbackRiskRate*1.6)&&supports>=3,
    runner=proof==="EXPANSION"&&(runnerByReprice||runnerByAbsolute),
    runnerHealthy=runner&&!persistentDeterioration&&(independentStrength||stableMarketSupport||researchSupported),
    healthyTrend=!persistentDeterioration&&((stableMarketSupport&&supports>=1)
      ||(supports>=3&&input.position.continuationRatio>=1.35&&input.position.advantageChange>-25)
      ||researchSupported),
    revaluedPotentialRate=Math.max(expectedAtEntryRate,peakNet,
      currentNet+Math.max(0,input.position.remainingSpaceRate)*(runner?.90:.60)),
    provenProfit=input.firstProfit&&peakNet>=Math.max(cost*4,input.pullbackRiskRate*.75),
    runnerLevel=runner?(outperformanceMultiple>=4.5?4:outperformanceMultiple>=3.2?3:outperformanceMultiple>=2.4?2:
      outperformanceMultiple>=1.6?1:runnerByAbsolute?1:0):0,
    runnerPlatformNet=runnerLevel===4?Math.max(expectedAtEntryRate*2.40,peakNet*.55):
      runnerLevel===3?Math.max(expectedAtEntryRate*1.85,peakNet*.48):
      runnerLevel===2?Math.max(expectedAtEntryRate*1.35,peakNet*.40):
      runnerLevel===1?Math.max(expectedAtEntryRate*.80,peakNet*.30):0,
    provenPlatformNet=!runner&&provenProfit?Math.max(cost*.25,peakNet*.30):0,
    platformKind:ProfitLifecycleState["platformKind"]=runnerPlatformNet>0?"RUNNER":provenPlatformNet>0?"PROVEN":"NONE",
    platformNet=Math.max(runnerPlatformNet,provenPlatformNet),
    platformFloorRate=platformNet>0?cost+platformNet:0,
    platformReason=platformKind==="RUNNER"
      ?`Runner已跨过第${runnerLevel}级已证明利润平台；平台只限制灾难性回吐，不限制继续创新高。`
      :platformKind==="PROVEN"
      ?"订单已经形成超过正常噪声的已证明利润；建立宽松利润平台，避免正收益完整回吐成亏损。"
      :"尚未形成需要独立锁定的已证明利润平台。",
    trajectory:ProfitLifecycleState["trajectory"]=persistentDeterioration?"DECAYING":runner?"RUNNER":
      outperformanceMultiple>=1.25?"OUTPERFORMING":"BASE";

  let phase:ProfitLifecyclePhase="UNPROVEN",action:ProfitLifecycleAction="HOLD",
    reason="交易尚未形成足够可兑现利润，继续由原持仓研究判断。";
  if(!input.firstProfit||proof==="NONE"){
    if(input.position.decision==="EXIT"){phase="INVALIDATED";action="EXIT";reason="尚未证明交易价值且独立持仓证据已经持续确认失效。";}
    else if(input.position.decision==="REVIEW"){action="WATCH";reason="尚未形成有效利润，同时持仓证据开始冲突，进入观察。";}
  }else{
    phase=proof==="EXPANSION"?"EXPANDING":"PROVEN";
    if(runnerHealthy){
      if((giveback??0)>=.40){
        phase="PULLBACK";action="WATCH";
        reason="实际发展已显著超过入场预期并成长为Runner；当前仅属回调，稳定失效证据不足，不提前截断大赢家。";
      }else{
        action="HOLD";
        reason="实际发展显著超过入场预期，未来空间已上调；Runner仍健康，继续允许利润扩张。";
      }
    }else if(runner){
      if(input.position.decision==="EXIT"&&persistentDeterioration
        &&((giveback??0)>=.42||currentNet<=Math.max(cost*.40,peakNet*.18))){
        phase="INVALIDATED";action="EXIT";
        reason="Runner曾显著超预期，但持仓优势已持续失效且利润大幅回吐，确认结束尾部持有。";
      }else if(persistentDeterioration&&(giveback??0)>=.48){
        phase="DECAYING";action="PROTECT";
        reason="Runner不再只是普通回调：多轮独立证据持续恶化且利润明显回吐，开始建立真实利润底线。";
      }else if((giveback??0)>=.28||earlyDeterioration){
        phase="PULLBACK";action="WATCH";
        reason="Runner出现回调/早期衰退迹象，但尚未达到稳定状态迁移标准，继续观察而不机械锁利。";
      }else{
        action="HOLD";reason="Runner尚未出现持续性失效证据，继续持有。";
      }
    }else if(input.position.decision==="EXIT"&&((giveback??0)>=.22||currentNet<=0)){
      phase="INVALIDATED";action="EXIT";
      reason="已获得利润但核心持仓假设经过持续复核后确认失效，避免由浮盈继续转成亏损。";
    }else if(persistentDeterioration&&proof==="EXPANSION"&&(giveback??0)>=.36){
      phase="DECAYING";action="PROTECT";
      reason="非Runner的扩张利润已出现持续性优势衰退，优先保护已兑现空间，避免不错浮盈最终转亏。";
    }else if(persistentDeterioration&&proof==="MEANINGFUL"&&(giveback??0)>=.30){
      phase="DECAYING";action="PROTECT";
      reason="已有意义利润且多轮独立证据持续恶化，开始保护利润，重点阻止浮盈转亏。";
    }else if(healthyTrend&&(giveback??0)<.55){
      if((giveback??0)>=.30){phase="PULLBACK";action="WATCH";reason="利润回调，但稳定趋势/独立优势仍成立，暂不把正常呼吸误判为结束。";}
      else{action="HOLD";reason="利润仍处于健康扩张，稳定趋势或独立优势支持继续持有。";}
    }else if(earlyDeterioration||(giveback??0)>=.35){
      phase="PULLBACK";action="WATCH";
      reason="利润从峰值回调，但尚未形成持续的新状态；记录风险，不直接触发保护或退出。";
    }else{
      action="HOLD";reason="利润已被证明且尚未出现持续性衰退证据。";
    }
  }

  let retention=0;
  if(action==="PROTECT"){
    retention=runner
      ?(input.market.phase==="DECAYING"?.52:input.market.phase==="ROTATIONAL"?.46:.40)
      :(input.market.phase==="DECAYING"?.70:input.market.phase==="ROTATIONAL"?.62:
        input.market.phase==="STABLE_TREND"?.48:.58);
    if(concerns>=3)retention=Math.min(.80,retention+.06);
  }
  const floorRate=action==="PROTECT"&&peakNet>0?cost+peakNet*retention:0;
  return{version:MARKET_LIFECYCLE_VERSION,phase,action,proof,peakNetRate:peakNet,currentNetRate:currentNet,
    givebackRatio:giveback,floorRate,retentionRate:retention,reason,trajectory,runner,
    expectedAtEntryRate,revaluedPotentialRate,outperformanceMultiple,platformKind,platformFloorRate,platformLevel:runnerLevel,platformReason};
}
