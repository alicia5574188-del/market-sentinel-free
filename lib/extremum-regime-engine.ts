import type { Candle, MarketPulse, Opportunity, Quote } from "./forward-relations.ts";

export const EXTREMUM_REGIME_VERSION="extremum-regime-v1";
export type ExtremumRegime="TREND_UP"|"TREND_DOWN"|"SWING"|"WEAKENING"|"TRANSITION";
export type ExtremumStage="WATCH"|"CANDIDATE"|"STRUCTURE_BREAK"|"RECLAIM_TEST"|"READY"|"IMPULSE";
export type ExtremumSide="LONG"|"SHORT"|null;

export type ExtremumSymbolState={
  symbol:string;updatedAt:number;regime:ExtremumRegime;priorRegime:ExtremumRegime|null;trendBias:"UP"|"DOWN"|null;
  topPressure:number;bottomPressure:number;upSurvival:number;downSurvival:number;
  pathEfficiency:number;atrRate:number;normalizedMove:number;pullbackRate:number;microPullbackRate:number;recoveryScore:number;followThrough:number;
  stage:ExtremumStage;candidateSide:ExtremumSide;candidateExtreme:number|null;breakLevel:number|null;
  sourceCount:number;disagreementRate:number;sourceQuality:number;momentumOverride:boolean;watchScore:number;
  reason:string;nextAction:string;
};
export type ExtremumRegimeState={version:typeof EXTREMUM_REGIME_VERSION;updatedAt:number;symbols:Record<string,ExtremumSymbolState>};

const clamp=(v:number,a=0,b=1)=>Math.max(a,Math.min(b,v));
const pct=(v:number)=>Math.round(v*100);
const median=(values:number[])=>{
  const a=values.filter(Number.isFinite).sort((x,y)=>x-y);
  if(!a.length)return 0;const m=Math.floor(a.length/2);return a.length%2?a[m]!:(a[m-1]!+a[m]!)/2;
};
const valid=(r:Candle)=>r&&r.time>0&&r.open>0&&r.close>0&&r.low>0&&r.high>=Math.max(r.open,r.close)&&r.low<=Math.min(r.open,r.close)
  &&[r.time,r.open,r.high,r.low,r.close,r.volume].every(Number.isFinite);
const rows=(input:Candle[]|undefined,seconds:number,now:number,limit:number)=>{
  const out=(input??[]).filter(r=>valid(r)&&r.time*1000+seconds*1000<=now).sort((a,b)=>a.time-b.time);
  return [...new Map(out.map(r=>[r.time,r])).values()].slice(-limit);
};
const direction=(side:"LONG"|"SHORT")=>side==="LONG"?1:-1;
const quoteFresh=(q:Quote|undefined,now:number)=>!!q&&q.fresh&&q.bestBid>0&&q.bestAsk>=q.bestBid&&q.observedAt<=now&&now-q.observedAt<=10_000;
const sourceQuality=(q:Quote|undefined)=>{
  const count=Math.max(0,q?.sourceCount??0),disagreement=Math.max(0,q?.disagreementRate??0);
  const coverage=clamp(count/4),agreement=Math.exp(-disagreement/.006);
  return clamp(.65*coverage+.35*agreement);
};

function minuteSignals(input:Candle[]|undefined,now:number,atrRate:number){
  const m=rows(input,60,now,12);
  if(m.length<5)return{ready:false,restartUp:false,restartDown:false,breakDown:false,breakUp:false,reclaimTop:false,reclaimBottom:false,
    topExtreme:null as number|null,bottomExtreme:null as number|null,breakLow:null as number|null,breakHigh:null as number|null,
    recoveryUp:0,recoveryDown:0,pullbackUpRate:0,pullbackDownRate:0};
  const last=m.at(-1)!,prev=m.at(-2)!,prior=m.slice(-5,-2),topExtreme=Math.max(...m.slice(-8).map(r=>r.high)),
    bottomExtreme=Math.min(...m.slice(-8).map(r=>r.low)),breakLow=Math.min(...prior.map(r=>r.low)),breakHigh=Math.max(...prior.map(r=>r.high));
  const breakDown=last.close<breakLow&&last.close<last.open,breakUp=last.close>breakHigh&&last.close>last.open;
  const restartUp=last.close>prev.high&&last.close>last.open,restartDown=last.close<prev.low&&last.close<last.open;
  const topGap=(topExtreme-Math.max(last.high,prev.high))/Math.max(topExtreme,1e-12),
    bottomGap=(Math.min(last.low,prev.low)-bottomExtreme)/Math.max(bottomExtreme,1e-12);
  const reclaimTop=(prev.high<topExtreme*(1-Math.max(.00015,atrRate*.08))&&restartDown)||topGap>Math.max(.0001,atrRate*.04)&&restartDown;
  const reclaimBottom=(prev.low>bottomExtreme*(1+Math.max(.00015,atrRate*.08))&&restartUp)||bottomGap>Math.max(.0001,atrRate*.04)&&restartUp;
  const recent=m.slice(-4),up=recent.slice(1).filter((r,i)=>r.close>recent[i]!.close).length/3,
    down=recent.slice(1).filter((r,i)=>r.close<recent[i]!.close).length/3,
    anchor=m.slice(-8,-3),micro=m.slice(-3),
    anchorHigh=anchor.length?Math.max(...anchor.map(r=>r.high)):topExtreme,
    anchorLow=anchor.length?Math.min(...anchor.map(r=>r.low)):bottomExtreme,
    microLow=Math.min(...micro.map(r=>r.low)),microHigh=Math.max(...micro.map(r=>r.high)),
    pullbackUpRate=Math.max(0,(anchorHigh-microLow)/Math.max(anchorHigh,1e-12)),
    pullbackDownRate=Math.max(0,(microHigh-anchorLow)/Math.max(anchorLow,1e-12));
  return{ready:true,restartUp,restartDown,breakDown,breakUp,reclaimTop,reclaimBottom,topExtreme,bottomExtreme,breakLow,breakHigh,
    recoveryUp:up,recoveryDown:down,pullbackUpRate,pullbackDownRate};
}

function deriveState(symbol:string,input:Candle[],minute:Candle[]|undefined,q:Quote|undefined,prior:ExtremumSymbolState|undefined,now:number):ExtremumSymbolState|null{
  const p=rows(input,300,now,40);if(p.length<18)return null;
  const last=p.at(-1)!,w=p.slice(-13),prev=w.at(-2)!,
    atrRate=Math.max(.00035,median(w.slice(0,-1).map(r=>(r.high-r.low)/r.close))),
    recent=p.slice(-7),ret6=last.close/recent[0]!.close-1,
    path=recent.slice(1).reduce((n,r,i)=>n+Math.abs(r.close/recent[i]!.close-1),0),
    efficiency=clamp(Math.abs(ret6)/Math.max(path,1e-9)),
    high12=Math.max(...w.slice(0,-1).map(r=>r.high)),low12=Math.min(...w.slice(0,-1).map(r=>r.low)),
    range12=Math.max(high12-low12,last.close*atrRate),
    location=clamp((last.close-low12)/range12),
    closePos=clamp((last.close-last.low)/Math.max(last.high-last.low,1e-9)),
    upperWick=(last.high-Math.max(last.open,last.close))/Math.max(last.high-last.low,1e-9),
    lowerWick=(Math.min(last.open,last.close)-last.low)/Math.max(last.high-last.low,1e-9),
    volMedian=Math.max(1e-9,median(w.slice(0,-1).map(r=>r.volume))),volumeRatio=last.volume/volMedian,
    bodyRate=Math.abs(last.close/last.open-1),bodyAtr=bodyRate/atrRate,
    moveNorm=Math.abs(ret6)/Math.max(atrRate*2.4,1e-9);
  const transitions=recent.slice(1).map((r,i)=>r.close/recent[i]!.close-1),
    firstAbs=transitions.slice(0,3).reduce((n,v)=>n+Math.abs(v),0)/3,lastAbs=transitions.slice(-3).reduce((n,v)=>n+Math.abs(v),0)/3,
    decel=clamp((firstAbs-lastAbs)/Math.max(firstAbs,atrRate*.15));
  let upStructure=0,downStructure=0;
  for(let i=p.length-5;i<p.length;i++){const a=p[i-1],b=p[i];if(!a||!b)continue;if(b.high>a.high&&b.low>=a.low)upStructure++;if(b.low<a.low&&b.high<=a.high)downStructure++;}
  upStructure=clamp(upStructure/4);downStructure=clamp(downStructure/4);
  const peak=Math.max(...recent.map(r=>r.high)),trough=Math.min(...recent.map(r=>r.low)),
    impulse=Math.max(Math.abs(ret6),atrRate),pullbackUp=clamp((peak-last.close)/Math.max(last.close*impulse,1e-9),0,1.5),
    pullbackDown=clamp((last.close-trough)/Math.max(last.close*impulse,1e-9),0,1.5);
  const ms=minuteSignals(minute,now,atrRate),sq=sourceQuality(q),
    followUp=clamp(.55*(closePos)+.45*(transitions.slice(-2).filter(v=>v>0).length/2)),
    followDown=clamp(.55*(1-closePos)+.45*(transitions.slice(-2).filter(v=>v<0).length/2)),
    dirUp=ret6>0?1:ret6===0?.5:0,dirDown=ret6<0?1:ret6===0?.5:0;
  const sourceBreadthNow=clamp(q?.sourceBreadth??0,-1,1),sourceAgreementNow=clamp(q?.directionalAgreement??.5),
    sourceUpNow=clamp(.5+.5*sourceBreadthNow)*sourceAgreementNow,sourceDownNow=clamp(.5-.5*sourceBreadthNow)*sourceAgreementNow,
    up=100*clamp(.29*efficiency*dirUp+.22*upStructure+.15*(1-clamp(pullbackUp))+.13*followUp+.07*ms.recoveryUp+.05*sq+.09*sourceUpNow),
    down=100*clamp(.29*efficiency*dirDown+.22*downStructure+.15*(1-clamp(pullbackDown))+.13*followDown+.07*ms.recoveryDown+.05*sq+.09*sourceDownNow);
  const failedHigh=last.high>high12&&last.close<=high12||last.high>=prev.high&&closePos<.42,
    failedLow=last.low<low12&&last.close>=low12||last.low<=prev.low&&closePos>.58,
    effortFailure=volumeRatio>=1.15&&bodyAtr<.65,
    sourceBreadth=clamp(q?.sourceBreadth??0,-1,1),sourceAgreement=clamp(q?.directionalAgreement??.5),
    sourceStress=clamp((q?.disagreementRate??0)/.012),
    sourceTurnDown=ret6>0?clamp(-sourceBreadth):0,sourceTurnUp=ret6<0?clamp(sourceBreadth):0,
    top=100*clamp((ret6>0?.17:0)*location+.17*clamp(upperWick/.45)+.15*(failedHigh?1:0)+.13*decel+.09*(effortFailure?1:0)
      +.12*(ms.breakDown?1:0)+.06*sourceStress+.07*sourceTurnDown+.04*(1-efficiency)),
    bottom=100*clamp((ret6<0?.17:0)*(1-location)+.17*clamp(lowerWick/.45)+.15*(failedLow?1:0)+.13*decel+.09*(effortFailure?1:0)
      +.12*(ms.breakUp?1:0)+.06*sourceStress+.07*sourceTurnUp+.04*(1-efficiency));
  const momentumOverride=efficiency>=.72&&moveNorm>=1.25&&Math.max(up,down)>=74&&sq>=.55&&bodyAtr>=1.15
    &&sourceAgreement>=.67&&(ret6>0?sourceBreadth>=0:sourceBreadth<=0);
  const topCandidate=top>=58&&ret6>=0,bottomCandidate=bottom>=58&&ret6<=0;
  let regime:ExtremumRegime="SWING";
  const old=prior?.regime??null,priorBias=prior?.trendBias??(old==="TREND_UP"?"UP":old==="TREND_DOWN"?"DOWN":null),
    upRaw=up>=66&&up>down+16&&efficiency>=.43,downRaw=down>=66&&down>up+16&&efficiency>=.43,
    topBreak=topCandidate&&(ms.breakDown||ms.reclaimTop),bottomBreak=bottomCandidate&&(ms.breakUp||ms.reclaimBottom),
    priorTopBreak=priorBias==="UP"&&prior?.candidateSide==="SHORT"&&["STRUCTURE_BREAK","RECLAIM_TEST","READY"].includes(prior.stage),
    priorBottomBreak=priorBias==="DOWN"&&prior?.candidateSide==="LONG"&&["STRUCTURE_BREAK","RECLAIM_TEST","READY"].includes(prior.stage);
  if(old==="TREND_UP"||(old==="WEAKENING"&&priorBias==="UP")){
    if(up>=70&&top<68)regime="TREND_UP";
    else if(up<48&&top>=58)regime="TRANSITION";
    else regime="WEAKENING";
  }else if(old==="TREND_DOWN"||(old==="WEAKENING"&&priorBias==="DOWN")){
    if(down>=70&&bottom<68)regime="TREND_DOWN";
    else if(down<48&&bottom>=58)regime="TRANSITION";
    else regime="WEAKENING";
  }else if(old==="TRANSITION"){
    if(priorBias==="UP"&&downRaw&&(topBreak||priorTopBreak))regime="TREND_DOWN";
    else if(priorBias==="DOWN"&&upRaw&&(bottomBreak||priorBottomBreak))regime="TREND_UP";
    else if(efficiency<.32&&top<58&&bottom<58)regime="SWING";
    else regime="TRANSITION";
  }else if(upRaw)regime="TREND_UP";
  else if(downRaw)regime="TREND_DOWN";
  else if(efficiency>=.42&&Math.max(up,down)>=52)regime="TRANSITION";
  let stage:ExtremumStage="WATCH",candidateSide:ExtremumSide=null,candidateExtreme:number|null=null,breakLevel:number|null=null;
  if(momentumOverride){stage="IMPULSE";candidateSide=up>down?"LONG":"SHORT";}
  else if(topCandidate||bottomCandidate){
    const topWins=top>=bottom;candidateSide=topWins?"SHORT":"LONG";candidateExtreme=topWins?ms.topExtreme:ms.bottomExtreme;
    breakLevel=topWins?ms.breakLow:ms.breakHigh;stage="CANDIDATE";
    if(topWins&&ms.breakDown||!topWins&&ms.breakUp)stage="STRUCTURE_BREAK";
    if(topWins&&ms.reclaimTop||!topWins&&ms.reclaimBottom)stage="READY";
    else if(prior?.stage==="STRUCTURE_BREAK"&&prior.candidateSide===candidateSide)stage="RECLAIM_TEST";
  }
  const trendBias:ExtremumSymbolState["trendBias"]=regime==="TREND_UP"?"UP":regime==="TREND_DOWN"?"DOWN"
    :(regime==="WEAKENING"||regime==="TRANSITION")?priorBias:null;
  const watchScore=Math.max(top,bottom,up,down),pullbackRate=ret6>=0?pullbackUp:pullbackDown,
    microPullbackRate=(regime==="TREND_DOWN"||trendBias==="DOWN")?ms.pullbackDownRate:ms.pullbackUpRate,
    recoveryScore=ret6>=0?ms.recoveryUp:ms.recoveryDown,followThrough=ret6>=0?followUp:followDown;
  const reason=`${regime}｜上存活${up.toFixed(0)} 下存活${down.toFixed(0)}｜顶压${top.toFixed(0)} 底压${bottom.toFixed(0)}｜效率${pct(efficiency)}%｜${q?.sourceCount??0}源`;
  let nextAction="等待下一次结构事件";
  if(regime==="TREND_UP")nextAction="等待浅回调结束后继续做多；顶部只用于保护利润";
  else if(regime==="TREND_DOWN")nextAction="等待反弹结束后继续做空；底部只用于保护利润";
  else if(regime==="WEAKENING")nextAction="原趋势减速：停止追价，等待恢复或趋势死亡";
  else if(regime==="TRANSITION")nextAction="不立即反手：等待结构破坏与夺回失败完成";
  else if(stage==="READY")nextAction=candidateSide==="LONG"?"底部确认，等待实时盘口执行多单":"顶部确认，等待实时盘口执行空单";
  return{symbol,updatedAt:now,regime,priorRegime:old,trendBias,topPressure:top,bottomPressure:bottom,upSurvival:up,downSurvival:down,
    pathEfficiency:efficiency,atrRate,normalizedMove:moveNorm,pullbackRate,microPullbackRate,recoveryScore,followThrough,stage,candidateSide,candidateExtreme,breakLevel,
    sourceCount:q?.sourceCount??0,disagreementRate:q?.disagreementRate??0,sourceQuality:sq,momentumOverride,watchScore,reason,nextAction};
}

function exitPlan(targetRate:number,stopRate:number,hold:number){
  const protection=Math.max(.0032,Math.min(targetRate*.45,Math.max(.0035,stopRate*.65)));
  return{version:"sample-exit-plan-v2" as const,bestHoldMinutes:hold as 15|30|45|60,feedbackDeadlineMinutes:5,maxHoldMinutes:Math.max(hold+10,hold*2),
    normalAdverseRate:Math.max(.002,stopRate*.55),targetRate,protectionActivationRate:protection,retentionRate:.80,samples:0,groups:0,path:{}};
}
function makeOpportunity(state:ExtremumSymbolState,p:Candle[],minute:Candle[]|undefined,q:Quote|undefined,now:number,
  side:"LONG"|"SHORT",mode:"SWING"|"TREND_PULLBACK"|"IMPULSE",baseScore:number,reason:string):Opportunity|null{
  const last=p.at(-1)!;if(!last)return null;const d=direction(side),m=rows(minute,60,now,12),
    structural=side==="LONG"?Math.min(...(m.length?m.slice(-6).map(r=>r.low):p.slice(-4).map(r=>r.low)))
      :Math.max(...(m.length?m.slice(-6).map(r=>r.high):p.slice(-4).map(r=>r.high))),
    rawStop=Math.abs(last.close-structural)/last.close,
    stopRate=Math.max(.002,Math.min(.018,Math.max(rawStop+state.atrRate*.15,state.atrRate*1.15))),
    targetRate=Math.max(.0045,Math.min(.035,Math.max(stopRate*1.45,state.atrRate*2.2))),
    net=Math.max(0,targetRate-.0019),edge=net/Math.max(stopRate,1e-9),fresh=quoteFresh(q,now),
    sourceOk=state.sourceCount>=2&&state.disagreementRate<=.015,
    score=Math.max(0,Math.min(100,baseScore+8*state.sourceQuality+6*Math.min(1,edge))),
    hold=mode==="IMPULSE"?15:mode==="TREND_PULLBACK"?30:30,
    price=last.close,stopPrice=price*(1-d*stopRate),targetPrice=price*(1+d*targetRate);
  return{id:`ext-${mode.toLowerCase()}-${state.symbol}-${last.time}`,symbol:state.symbol,side,mode,premium:true,reserve:false,score,
    eligible:fresh&&sourceOk&&score>=64&&net>0&&edge>=.45,completedAt:(last.time+300)*1000,expiresAt:now+4*60_000,price,stopPrice,targetPrice,
    stopRate,targetRate,directionStrength:side==="LONG"?state.upSurvival:state.downSurvival,pathEfficiency:state.pathEfficiency*100,
    momentumPersistence:state.followThrough*100,positionScore:side==="LONG"?state.bottomPressure:state.topPressure,
    spaceScore:100*Math.min(1,edge/1.5),executionScore:fresh?100:10,grossRemainingSpaceRate:targetRate,netRemainingSpaceRate:net,
    pullbackRiskRate:stopRate,edgeRatio:edge,expectedHoldMinutes:hold,marketFit:Math.max(state.upSurvival,state.downSurvival),
    regionId:null,regionQuality:null,reason,strategyVersion:EXTREMUM_REGIME_VERSION,regime:state.regime,topPressure:state.topPressure,
    bottomPressure:state.bottomPressure,upSurvival:state.upSurvival,downSurvival:state.downSurvival,confirmationStage:state.stage,
    sourceCount:state.sourceCount,disagreementRate:state.disagreementRate,exitPlan:exitPlan(targetRate,stopRate,hold)};
}
function opportunitiesFor(state:ExtremumSymbolState,p:Candle[],minute:Candle[]|undefined,q:Quote|undefined,now:number){
  const out:Opportunity[]=[],m=rows(minute,60,now,12),lastM=m.at(-1),prevM=m.at(-2),
    restartUp=!!lastM&&!!prevM&&lastM.close>prevM.high&&lastM.close>lastM.open,
    restartDown=!!lastM&&!!prevM&&lastM.close<prevM.low&&lastM.close<lastM.open;
  if(state.regime==="SWING"&&state.stage==="READY"&&state.candidateSide){
    const side=state.candidateSide,pressure=side==="LONG"?state.bottomPressure:state.topPressure;
    const o=makeOpportunity(state,p,minute,q,now,side,"SWING",56+pressure*.34,
      `${side==="LONG"?"底部":"顶部"}确认｜结构破坏后夺回失败｜${state.reason}`);if(o)out.push(o);
  }
  const microPullbackNorm=state.microPullbackRate/Math.max(state.atrRate,1e-9),
    controlledPullback=microPullbackNorm>=.25&&microPullbackNorm<=2.2;
  if(state.regime==="TREND_UP"&&state.upSurvival>=68&&controlledPullback&&restartUp){
    const pullbackQuality=100*clamp(1-Math.abs(microPullbackNorm-.85)/1.35);
    const o=makeOpportunity(state,p,minute,q,now,"LONG","TREND_PULLBACK",54+state.upSurvival*.30+pullbackQuality*.10,
      `上涨趋势浅回调结束再启动｜1m回调${(microPullbackNorm).toFixed(1)}×5m常态振幅｜${state.reason}`);if(o)out.push(o);
  }
  if(state.regime==="TREND_DOWN"&&state.downSurvival>=68&&controlledPullback&&restartDown){
    const pullbackQuality=100*clamp(1-Math.abs(microPullbackNorm-.85)/1.35);
    const o=makeOpportunity(state,p,minute,q,now,"SHORT","TREND_PULLBACK",54+state.downSurvival*.30+pullbackQuality*.10,
      `下跌趋势浅反弹结束再启动｜1m反弹${(microPullbackNorm).toFixed(1)}×5m常态振幅｜${state.reason}`);if(o)out.push(o);
  }
  if(state.momentumOverride&&state.stage==="IMPULSE"){
    const side: "LONG"|"SHORT"=state.upSurvival>=state.downSurvival?"LONG":"SHORT",
      restart=side==="LONG"?restartUp:restartDown,survival=side==="LONG"?state.upSurvival:state.downSurvival;
    if(restart&&survival>=76){
      const o=makeOpportunity(state,p,minute,q,now,side,"IMPULSE",60+survival*.30,
        `单边强推进延续｜不逆势猜顶底｜${state.reason}`);if(o)out.push(o);
    }
  }
  return out;
}

export type ExtremumExitReason="STRUCTURE_STOP"|"PROFIT_GIVEBACK"|"ENTRY_FEEDBACK_FAILED"|"OPPOSITE_EXTREMUM"|"TREND_DEATH"
  |"EXTREMUM_PROFIT_EXIT"|"NO_PROGRESS"|"MAX_HOLD"|null;
export function extremumExitDecision(input:{side:"LONG"|"SHORT";mode:string;ageMin:number;signedRate:number;peakFavorableRate:number;
  firstProfit:boolean;stopRate:number;stopped:boolean;profitFloorRate:number;expectedHoldMinutes:number;maxHoldMinutes:number;
  state?:ExtremumSymbolState|null}){
  const survival=input.side==="LONG"?(input.state?.upSurvival??50):(input.state?.downSurvival??50),
    opposite=input.side==="LONG"?(input.state?.topPressure??0):(input.state?.bottomPressure??0),
    oppositeReady=!!input.state&&input.state.stage==="READY"&&input.state.candidateSide===(input.side==="LONG"?"SHORT":"LONG"),
    trendEntry=input.mode==="TREND_PULLBACK"||input.mode==="IMPULSE",
    trendDeath=trendEntry&&!!input.state&&input.state.regime==="TRANSITION"&&survival<=42&&opposite>=66
      &&(input.state.stage==="STRUCTURE_BREAK"||input.state.stage==="RECLAIM_TEST"||input.state.stage==="READY"),
    swingOpposite=input.mode==="SWING"&&oppositeReady&&opposite>=70,
    weakening=!!input.state&&(input.state.regime==="WEAKENING"||input.state.regime==="TRANSITION"),
    activation=Math.max(.0019*1.35,Math.min(.007,Math.max(.0032,input.stopRate*.52))),
    retention=trendEntry&&survival>=82&&!weakening?.76:weakening?.88:.82,
    floorCandidate=input.peakFavorableRate>=activation?input.peakFavorableRate*retention:0,
    feedbackAdverse=Math.max(.0019*.75,Math.min(.0022,input.stopRate*.24)),
    noFastFeedback=input.ageMin>=3&&!input.firstProfit&&input.peakFavorableRate<.0019*.45,
    feedbackFailed=noFastFeedback&&(input.signedRate<=-feedbackAdverse||opposite>=72&&survival<=48),
    noProgress=input.ageMin>=Math.max(8,input.expectedHoldMinutes*.55)&&!input.firstProfit&&Math.abs(input.signedRate)<.0019*.65,
    maxHold=input.ageMin>=Math.max(15,input.maxHoldMinutes);
  let reason:ExtremumExitReason=null;
  if(input.stopped)reason=input.profitFloorRate>0?"PROFIT_GIVEBACK":"STRUCTURE_STOP";
  else if(feedbackFailed)reason="ENTRY_FEEDBACK_FAILED";
  else if(swingOpposite)reason="OPPOSITE_EXTREMUM";
  else if(trendDeath)reason="TREND_DEATH";
  else if(weakening&&opposite>=78&&input.peakFavorableRate>=.0019)reason="EXTREMUM_PROFIT_EXIT";
  else if(noProgress)reason="NO_PROGRESS";
  else if(maxHold)reason="MAX_HOLD";
  const holdScore=100*clamp(.55*(survival/100)+.25*(1-opposite/100)+.20*clamp(.5+input.signedRate/Math.max(input.stopRate,.001)*.25));
  return{reason,survival,opposite,activation,retention,floorCandidate,feedbackFailed,trendDeath,swingOpposite,weakening,holdScore};
}

export function buildExtremumRegime(input:{paths:Record<string,Candle[]>;minutePaths?:Record<string,Candle[]>;quotes:Record<string,Quote>;
  previous?:ExtremumRegimeState|null;now:number;allowed?:ReadonlySet<string>}){
  const states:Record<string,ExtremumSymbolState>={},opportunities:Opportunity[]=[];
  for(const [symbol,path] of Object.entries(input.paths)){
    if(input.allowed&&!input.allowed.has(symbol))continue;
    const p=rows(path,300,input.now,40);if(p.length<18)continue;
    const state=deriveState(symbol,p,input.minutePaths?.[symbol],input.quotes[symbol],input.previous?.symbols?.[symbol],input.now);
    if(!state)continue;states[symbol]=state;opportunities.push(...opportunitiesFor(state,p,input.minutePaths?.[symbol],input.quotes[symbol],input.now));
  }
  const up=Object.values(states).filter(s=>s.regime==="TREND_UP").length,down=Object.values(states).filter(s=>s.regime==="TREND_DOWN").length,
    neutral=Object.keys(states).length-up-down,strength=Object.keys(states).length?Math.abs(up-down)/Object.keys(states).length:0;
  const pulse:MarketPulse={at:input.now,up,down,neutral,bias:up>down+2?"UP":down>up+2?"DOWN":"MIXED",strength,expansion:median(Object.values(states).map(s=>s.normalizedMove))};
  const best=[...opportunities].sort((a,b)=>Number(b.eligible)-Number(a.eligible)||b.score-a.score)
    .filter((o,i,a)=>a.findIndex(x=>x.symbol===o.symbol)===i);
  return{state:{version:EXTREMUM_REGIME_VERSION,updatedAt:input.now,symbols:states} satisfies ExtremumRegimeState,opportunities:best,pulse};
}

export function urgentMinuteSymbols(state:ExtremumRegimeState|undefined,allowed?:Iterable<string>){
  const keep=allowed?new Set(allowed):null;
  return Object.values(state?.symbols??{}).filter(s=>(!keep||keep.has(s.symbol))
    &&(s.stage!=="WATCH"||s.topPressure>=48||s.bottomPressure>=48||s.upSurvival>=64||s.downSurvival>=64))
    .sort((a,b)=>Number(b.stage==="READY")-Number(a.stage==="READY")||b.watchScore-a.watchScore).map(s=>s.symbol);
}
