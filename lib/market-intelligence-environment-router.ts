import type { MarketIntelligenceState, MarketSymbolState } from "./market-intelligence-engine.ts";
import type { MarketEvolutionPhase, MarketEvolutionState } from "./market-intelligence-lifecycle.ts";

export const ENVIRONMENT_ROUTER_VERSION="market-environment-router-v1";
export const ENVIRONMENT_OUTLOOK_VERSION="market-environment-outlook-v1";

export type MarketEnvironment="TREND"|"TRANSITION"|"ROTATION"|"SHOCK";
export type EnvironmentPlaybook="TREND_CAPTURE"|"TRANSITION_PROBE"|"ROTATION_RELATIVE"|"SHOCK_PARTICIPATION";
export type RouteAlignment="ALIGNED"|"COUNTER"|"NEUTRAL";

export type EnvironmentOutlook={
  version:typeof ENVIRONMENT_OUTLOOK_VERSION;
  persistenceScore:number;
  transitionPressure:number;
  horizonMinutes:15|30|45|60;
  pressureTarget:"TREND"|"ROTATION"|"TRANSITION";
  profitExpansion:"LOW"|"NORMAL"|"HIGH";
  reason:string;
};
export type EnvironmentFastSignal={breadth:number;agreement:number;samples:number};

export type EnvironmentRouteDecision={
  version:typeof ENVIRONMENT_ROUTER_VERSION;
  environment:MarketEnvironment;
  playbook:EnvironmentPlaybook;
  alignment:RouteAlignment;
  priority:number;
  scoreDelta:number;
  riskScale:number;
  probe:boolean;
  forceRetest:boolean;
  minimumThesisBars:number;
  probeImpulseMin:number;
  probePullbackMin:number;
  probeRestartMin:number;
  mainline:boolean;
  modeFit:number;
  outlook:EnvironmentOutlook;
  reason:string;
};

export type EnvironmentPerformanceCell={
  key:string;environment:MarketEnvironment;playbook:EnvironmentPlaybook;
  trades:number;wins:number;netRiskUnits:number;lossStreak:number;updatedAt:number;
};
export type EnvironmentPerformanceState={
  version:typeof ENVIRONMENT_ROUTER_VERSION;cells:Record<string,EnvironmentPerformanceCell>;
};

type TradeLike={
  netPnl?:number|null;plannedRisk?:number;closedAt?:number|null;
  entryContext?:{
    environment?:MarketEnvironment;playbook?:EnvironmentPlaybook;
    marketEvolutionPhase?:MarketEvolutionPhase;mode?:string;
  };
};

const clip=(v:number,a=0,b=1)=>Math.max(a,Math.min(b,v));
const sideSign=(side:"LONG"|"SHORT")=>side==="LONG"?1:-1;
const biasSign=(bias:string|undefined)=>bias==="BULLISH"?1:bias==="BEARISH"?-1:0;
const trending=(phase:MarketEvolutionPhase)=>phase==="TREND_FORMING"||phase==="EXPANDING"||phase==="STABLE_TREND";
const keyOf=(environment:MarketEnvironment,playbook:EnvironmentPlaybook)=>environment+":"+playbook;

export function classifyMarketEnvironment(market:MarketIntelligenceState,evolution:MarketEvolutionState):MarketEnvironment{
  const i=market.internals,trendSign=evolution.trendSide==="LONG"?1:evolution.trendSide==="SHORT"?-1:0,
    breadth=Math.abs(i?.breadth3??0),synchrony=clip(i?.synchrony??0),
    alignedFlow=trendSign?trendSign*(i?.venuePressure??0):0,
    shock=trendSign!==0&&trending(evolution.phase)&&evolution.expansionScore>=.68
      &&breadth>=.55&&synchrony>=.62&&alignedFlow>=.12;
  if(shock)return"SHOCK";
  if(trending(evolution.phase))return"TREND";
  if(evolution.phase==="ROTATIONAL")return"ROTATION";
  return"TRANSITION";
}

function decisionSide(market:MarketIntelligenceState,evolution:MarketEvolutionState){
  const transition=market.narrative.transition,transitionSide=biasSign(transition.direction),
    transitionTrusted=(transition.stage==="BUILDING"||transition.stage==="CONFIRMED")&&(transition.pressure??0)>=32;
  if(evolution.phase==="DECAYING"&&transitionTrusted)return transitionSide;
  if(transitionTrusted&&evolution.phase==="TRANSITIONAL")return transitionSide;
  return evolution.trendSide==="LONG"?1:evolution.trendSide==="SHORT"?-1:biasSign(market.narrative.short.bias);
}

export function initialEnvironmentPerformanceState():EnvironmentPerformanceState{
  return{version:ENVIRONMENT_ROUTER_VERSION,cells:{}};
}

function inferEnvironment(phase:MarketEvolutionPhase|undefined):MarketEnvironment{
  if(phase==="ROTATIONAL")return"ROTATION";
  if(phase==="STABLE_TREND"||phase==="TREND_FORMING"||phase==="EXPANDING")return"TREND";
  return"TRANSITION";
}
function inferPlaybook(environment:MarketEnvironment,mode:string|undefined):EnvironmentPlaybook{
  if(environment==="ROTATION")return"ROTATION_RELATIVE";
  if(environment==="SHOCK")return"SHOCK_PARTICIPATION";
  if(environment==="TREND"&&mode!=="REVERSAL")return"TREND_CAPTURE";
  return"TRANSITION_PROBE";
}

export function recordEnvironmentOutcome(state:EnvironmentPerformanceState,input:{
  environment:MarketEnvironment;playbook:EnvironmentPlaybook;netPnl:number;plannedRisk:number;now:number;
}){
  const key=keyOf(input.environment,input.playbook),prev=state.cells[key]??{
    key,environment:input.environment,playbook:input.playbook,trades:0,wins:0,netRiskUnits:0,lossStreak:0,updatedAt:0
  },risk=Math.max(.01,input.plannedRisk),r=input.netPnl/risk;
  prev.trades++;if(input.netPnl>0)prev.wins++;
  prev.netRiskUnits+=r;
  prev.lossStreak=input.netPnl>0?0:Math.min(12,prev.lossStreak+1);
  prev.updatedAt=input.now;state.cells[key]=prev;
}

export function normalizeEnvironmentPerformanceState(value:unknown,history:TradeLike[],now:number){
  if(value&&typeof value==="object"){
    const raw=value as Partial<EnvironmentPerformanceState>;
    if(raw.version===ENVIRONMENT_ROUTER_VERSION&&raw.cells&&typeof raw.cells==="object"){
      const state=initialEnvironmentPerformanceState();
      for(const [key,v] of Object.entries(raw.cells)){
        if(!v||typeof v!=="object")continue;
        const c=v as Partial<EnvironmentPerformanceCell>;
        if(!c.environment||!c.playbook)continue;
        state.cells[key]={key,environment:c.environment,playbook:c.playbook,
          trades:Math.max(0,Math.floor(c.trades??0)),wins:Math.max(0,Math.floor(c.wins??0)),
          netRiskUnits:Number.isFinite(c.netRiskUnits)?c.netRiskUnits!:0,
          lossStreak:Math.max(0,Math.floor(c.lossStreak??0)),updatedAt:Number.isFinite(c.updatedAt)?c.updatedAt!:now};
      }
      return state;
    }
  }
  const state=initialEnvironmentPerformanceState();
  for(const t of [...history].filter(x=>x.closedAt!=null).slice(0,64).reverse()){
    const environment=t.entryContext?.environment??inferEnvironment(t.entryContext?.marketEvolutionPhase),
      playbook=t.entryContext?.playbook??inferPlaybook(environment,t.entryContext?.mode),
      net=typeof t.netPnl==="number"&&Number.isFinite(t.netPnl)?t.netPnl:0,
      risk=typeof t.plannedRisk==="number"&&Number.isFinite(t.plannedRisk)?Math.max(.01,t.plannedRisk):1;
    recordEnvironmentOutcome(state,{environment,playbook,netPnl:net,plannedRisk:risk,now:t.closedAt??now});
  }
  return state;
}

export function environmentPerformanceFactor(state:EnvironmentPerformanceState,environment:MarketEnvironment,playbook:EnvironmentPlaybook){
  const exact=state.cells[keyOf(environment,playbook)],
    peers=Object.values(state.cells).filter(c=>c.environment===environment),
    trades=exact?.trades??peers.reduce((n,c)=>n+c.trades,0),
    netR=exact?.netRiskUnits??peers.reduce((n,c)=>n+c.netRiskUnits,0),
    streak=exact?.lossStreak??Math.max(0,...peers.map(c=>c.lossStreak));
  if(trades<4)return 1;
  const avg=netR/Math.max(1,trades);
  let factor=avg<=-.45?.58:avg<=-.20?.72:avg>=.28?1.08:avg>=.12?1.03:1;
  if(streak>=5)factor*=.72;else if(streak>=3)factor*=.84;
  return clip(factor,.55,1.10);
}

export function environmentProbeRetestDecision(input:{
  side:"LONG"|"SHORT";price:number;currentAdvanceRate:number;bestAdvanceRate:number;
  retestBasePrice?:number|null;retestSeen:boolean;impulseMin:number;pullbackMin:number;restartMin:number;
}){
  const best=Math.max(0,input.bestAdvanceRate,input.currentAdvanceRate),current=input.currentAdvanceRate,
    retrace=Math.max(0,best-current),d=sideSign(input.side);
  if(best<input.impulseMin)return{action:"WAIT_IMPULSE" as const,best,current,retrace,restart:0};
  if(!input.retestSeen){
    if(retrace<input.pullbackMin)return{action:"WAIT_PULLBACK" as const,best,current,retrace,restart:0};
    return{action:"SET_RETEST_BASE" as const,best,current,retrace,restart:0};
  }
  const base=input.retestBasePrice??input.price,restart=d*(input.price/base-1);
  if(restart<0)return{action:"UPDATE_RETEST_BASE" as const,best,current,retrace,restart};
  if(restart<input.restartMin)return{action:"WAIT_RESTART" as const,best,current,retrace,restart};
  return{action:"READY" as const,best,current,retrace,restart};
}

export function deriveFastEnvironmentSignal(rows:Array<{medianShortMove?:number;directionalAgreement?:number;sourceCount?:number}>):EnvironmentFastSignal{
  const usable=rows.filter(x=>(x.sourceCount??0)>=2&&Number.isFinite(x.medianShortMove));
  if(!usable.length)return{breadth:0,agreement:0,samples:0};
  const signed=usable.map(x=>(x.medianShortMove??0)>.00008?1:(x.medianShortMove??0)<-.00008?-1:0),
    breadth=signed.reduce((a,b)=>a+b,0)/usable.length,
    agreement=usable.reduce((a,b)=>a+clip(b.directionalAgreement??0),0)/usable.length;
  return{breadth:clip(breadth,-1,1),agreement:clip(agreement),samples:usable.length};
}

export function deriveEnvironmentOutlook(market:MarketIntelligenceState,evolution:MarketEvolutionState,input?:{
  fast?:EnvironmentFastSignal;previous?:EnvironmentOutlook;
}):EnvironmentOutlook{
  const major=biasSign(market.narrative.major.bias),short=biasSign(market.narrative.short.bias),
    directionAgreement=major!==0&&short!==0?(major===short?1:.15):major===0&&short===0?.45:.55,
    leader=clip(market.internals?.leaderPersistence??.5),rotation=clip(evolution.rotationRisk),
    transitionBase=clip((market.narrative.transition.pressure??0)/100),
    trendPersistence=clip(.35*directionAgreement+.25*leader+.20*(1-rotation)+.20*(1-transitionBase)),
    rotationPersistence=clip(.55*rotation+.25*(1-directionAgreement)+.20*(1-transitionBase)),
    slowPersistence=Math.max(trendPersistence,rotationPersistence),
    slowTransition=clip(.45*transitionBase+.30*rotation+.15*(1-leader)+.10*(1-directionAgreement)),
    currentSide=short||major||(evolution.trendSide==="LONG"?1:evolution.trendSide==="SHORT"?-1:0),
    fast=input?.fast,fastReliable=!!fast&&fast.samples>=6,
    fastAligned=fastReliable&&currentSide?clip(currentSide*fast!.breadth*fast!.agreement,0,1):0,
    fastOpposed=fastReliable&&currentSide?clip(-currentSide*fast!.breadth*fast!.agreement,0,1):0,
    fastMixed=fastReliable?clip((1-Math.abs(fast!.breadth))*fast!.agreement):0,
    rawPersistence=clip(slowPersistence+.08*fastAligned-.12*fastOpposed-.05*fastMixed),
    rawTransition=clip(slowTransition+.22*fastOpposed+.06*fastMixed-.05*fastAligned),
    rapidShift=fastOpposed>=.55,
    prior=input?.previous?.version===ENVIRONMENT_OUTLOOK_VERSION?input.previous:null,
    priorWeight=prior?(rapidShift?.45:.75):0,
    persistenceScore=clip((prior?.persistenceScore??rawPersistence)*priorWeight+rawPersistence*(1-priorWeight)),
    transitionPressure=clip((prior?.transitionPressure??rawTransition)*priorWeight+rawTransition*(1-priorWeight)),
    effectivePersistence=clip(persistenceScore*(1-.35*transitionPressure)),
    horizonMinutes:EnvironmentOutlook["horizonMinutes"]=rapidShift&&effectivePersistence<.64?15:
      effectivePersistence>=.78?60:effectivePersistence>=.64?45:effectivePersistence>=.50?30:15,
    pressureTarget:EnvironmentOutlook["pressureTarget"]=trendPersistence>rotationPersistence+.12?"TREND":
      rotationPersistence>trendPersistence+.12?"ROTATION":"TRANSITION",
    profitExpansion:EnvironmentOutlook["profitExpansion"]=pressureTarget==="TREND"&&horizonMinutes>=45&&transitionPressure<.40?"HIGH":
      horizonMinutes===15||transitionPressure>=.62?"LOW":"NORMAL",
    reason=`条件持续力 ${(persistenceScore*100).toFixed(0)}%，转变压力 ${(transitionPressure*100).toFixed(0)}%，预计当前可交易假设有效窗口约 ${horizonMinutes} 分钟；变化压力更偏向 ${pressureTarget==="TREND"?"趋势":pressureTarget==="ROTATION"?"轮动":"过渡"}。`;
  return{version:ENVIRONMENT_OUTLOOK_VERSION,persistenceScore,transitionPressure,horizonMinutes,pressureTarget,profitExpansion,reason};
}

function layerFit(layer:number,side:number){return layer===0?.5:layer===side?1:0;}

export function environmentModeFit(input:{
  market:MarketIntelligenceState;evolution:MarketEvolutionState;side:"LONG"|"SHORT";mode:string;outlook?:EnvironmentOutlook;
}){
  const outlook=input.outlook??deriveEnvironmentOutlook(input.market,input.evolution),side=sideSign(input.side),
    major=biasSign(input.market.narrative.major.bias),short=biasSign(input.market.narrative.short.bias),
    directionAlignment=(layerFit(major,side)+layerFit(short,side))/2,
    rotation=clip(input.evolution.rotationRisk),dispersion=clip((input.market.internals?.dispersion??0)/1.2),
    synchrony=clip(input.market.internals?.synchrony??.5);
  if(input.mode==="CONTINUATION")
    return clip(.55*outlook.persistenceScore+.25*directionAlignment+.20*(1-rotation));
  if(input.mode==="REVERSAL")
    return clip(.55*rotation+.25*outlook.transitionPressure+.20*(1-outlook.persistenceScore));
  if(input.mode==="RELATIVE")
    return clip(.45*rotation+.30*dispersion+.25*(1-synchrony));
  return clip(.45*outlook.persistenceScore+.30*(1-outlook.transitionPressure)+.25*directionAlignment);
}

export function routeEnvironmentOpportunity(input:{
  market:MarketIntelligenceState;evolution:MarketEvolutionState;symbol:MarketSymbolState;
  opportunity:{
    side:"LONG"|"SHORT";mode:string;score:number;premium:boolean;edgeRatio:number;
    netRemainingSpaceRate:number;pullbackRiskRate:number;thesisBars?:number;confirmationStage?:MarketSymbolState["stage"];
  };
  performanceFactor?:number;portfolioLongRisk?:number;portfolioShortRisk?:number;outlook?:EnvironmentOutlook;
}):EnvironmentRouteDecision{
  const environment=classifyMarketEnvironment(input.market,input.evolution),o=input.opportunity,
    outlook=input.outlook??deriveEnvironmentOutlook(input.market,input.evolution),fit=environmentModeFit({market:input.market,evolution:input.evolution,
      side:o.side,mode:o.mode,outlook}),side=sideSign(o.side),marketSide=decisionSide(input.market,input.evolution),
    alignment:RouteAlignment=marketSide===0?"NEUTRAL":marketSide===side?"ALIGNED":"COUNTER",
    cost=.0019,pullback=Math.max(cost*1.5,o.pullbackRiskRate),space=Math.max(cost*2,o.netRemainingSpaceRate),
    probeImpulseMin=Math.max(cost*.75,Math.min(pullback*.20,space*.10,.0032)),
    probePullbackMin=Math.max(cost*.40,Math.min(pullback*.18,space*.08,.0025)),
    probeRestartMin=Math.max(cost*.35,Math.min(pullback*.12,space*.06,.0018)),
    mainline=fit>=.75&&outlook.horizonMinutes>=45,
    probe=fit<.50,forceRetest=false,minimumThesisBars=mainline?1:2,
    priority=fit>=.75?5:fit>=.60?4:fit>=.45?3:2,
    scoreDelta=(fit-.50)*8,riskScale=clip(.70+.30*fit,.70,1),
    playbook:EnvironmentPlaybook=environment==="SHOCK"&&alignment==="ALIGNED"?"SHOCK_PARTICIPATION":
      o.mode==="CONTINUATION"?"TREND_CAPTURE":o.mode==="RELATIVE"?"ROTATION_RELATIVE":"TRANSITION_PROBE",
    reason=`${outlook.reason} ${o.mode} 与未来条件适配度 ${(fit*100).toFixed(0)}%；${mainline?"允许主线快速确认":
      forceRetest?"只保留回调后重启参与":"保留普通实时确认"}，风险按 ${(riskScale*100).toFixed(0)}% 连续缩放，不停止交易。`;
  void input.performanceFactor;void input.portfolioLongRisk;void input.portfolioShortRisk;void input.symbol;void o.premium;void o.edgeRatio;
  return{version:ENVIRONMENT_ROUTER_VERSION,environment,playbook,alignment,priority,scoreDelta,riskScale,probe,forceRetest,
    minimumThesisBars,probeImpulseMin,probePullbackMin,probeRestartMin,mainline,modeFit:fit,outlook,reason};
}
