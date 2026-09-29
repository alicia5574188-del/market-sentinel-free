import type { MarketIntelligenceState, MarketSymbolState } from "./market-intelligence-engine.ts";
import type { MarketEvolutionPhase, MarketEvolutionState } from "./market-intelligence-lifecycle.ts";

export const ENVIRONMENT_ROUTER_VERSION="market-environment-router-v1";

export type MarketEnvironment="TREND"|"TRANSITION"|"ROTATION"|"SHOCK";
export type EnvironmentPlaybook="TREND_CAPTURE"|"TRANSITION_PROBE"|"ROTATION_RELATIVE"|"SHOCK_PARTICIPATION";
export type RouteAlignment="ALIGNED"|"COUNTER"|"NEUTRAL";

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

export function routeEnvironmentOpportunity(input:{
  market:MarketIntelligenceState;evolution:MarketEvolutionState;symbol:MarketSymbolState;
  opportunity:{
    side:"LONG"|"SHORT";mode:string;score:number;premium:boolean;edgeRatio:number;
    netRemainingSpaceRate:number;pullbackRiskRate:number;thesisBars?:number;confirmationStage?:MarketSymbolState["stage"];
  };
  performanceFactor?:number;portfolioLongRisk?:number;portfolioShortRisk?:number;
}):EnvironmentRouteDecision{
  const environment=classifyMarketEnvironment(input.market,input.evolution),o=input.opportunity,
    side=sideSign(o.side),marketSide=decisionSide(input.market,input.evolution),
    alignment:RouteAlignment=marketSide===0?"NEUTRAL":marketSide===side?"ALIGNED":"COUNTER",
    perf=clip(input.performanceFactor??1,.55,1.10),extension=Math.abs(input.symbol.residualZ),
    bars=o.thesisBars??input.symbol.signalBars,stage=o.confirmationStage??input.symbol.stage,
    cost=.0019,pullback=Math.max(cost*1.5,o.pullbackRiskRate),space=Math.max(cost*2,o.netRemainingSpaceRate),
    probeImpulseMin=Math.max(cost*.75,Math.min(pullback*.20,space*.10,.0032)),
    probePullbackMin=Math.max(cost*.40,Math.min(pullback*.18,space*.08,.0025)),
    probeRestartMin=Math.max(cost*.35,Math.min(pullback*.12,space*.06,.0018));

  let playbook:EnvironmentPlaybook="TRANSITION_PROBE",priority=2,scoreDelta=0,riskScale=.55,probe=true,forceRetest=false,
    minimumThesisBars=2,mainline=false,reason="过渡环境使用小风险验证，方向必须由价格反馈证明。";

  if(environment==="SHOCK"&&alignment==="ALIGNED"){
    playbook="SHOCK_PARTICIPATION";priority=5;scoreDelta=12+Math.min(5,extension*1.8);riskScale=1.0;probe=false;
    minimumThesisBars=1;mainline=true;
    reason="全市场同步扩张且方向一致，启用主线参与通道，优先用最强/最弱代表表达市场主线。";
  }else if(environment==="SHOCK"){
    playbook="TRANSITION_PROBE";priority=1;scoreDelta=-14;riskScale=.35;probe=true;forceRetest=true;minimumThesisBars=2;
    reason="全市场正在同步扩张，逆主线机会仍可交易，但只能以Probe→回调→再启动方式参与，避免逆势连续亏损。";
  }else if(environment==="TREND"&&alignment==="ALIGNED"){
    playbook="TREND_CAPTURE";priority=4;scoreDelta=o.mode==="CONTINUATION"?8:o.mode==="RELATIVE"?5:2;
    riskScale=1;probe=false;minimumThesisBars=1;
    reason="稳定/形成中的趋势与候选方向一致，保留原大赢家捕获链并优先让利润扩张。";
  }else if(environment==="TREND"){
    playbook="TRANSITION_PROBE";priority=1;scoreDelta=-10;riskScale=.38;probe=true;forceRetest=true;minimumThesisBars=2;
    reason="候选逆稳定趋势，不禁止交易，但降为小风险反转探针；必须完成第一段推动、回调与重新启动。";
  }else if(environment==="ROTATION"){
    playbook="ROTATION_RELATIVE";priority=o.mode==="RELATIVE"?4:3;
    scoreDelta=(o.mode==="RELATIVE"?6:o.mode==="REVERSAL"?2:-1)+Math.min(4,extension*1.4);
    riskScale=.68;probe=false;minimumThesisBars=2;
    const longRisk=input.portfolioLongRisk??0,shortRisk=input.portfolioShortRisk??0,
      balancing=(o.side==="LONG"&&shortRisk>longRisk)||(o.side==="SHORT"&&longRisk>shortRisk);
    if(balancing){scoreDelta+=4;priority+=1;}else if(Math.abs(longRisk-shortRisk)>2){scoreDelta-=2;}
    reason="轮动/震荡环境优先赚相对强弱差，并偏向补足组合另一侧，而不是押单一市场方向。";
  }else{
    const counter=alignment==="COUNTER",reversal=o.mode==="REVERSAL";
    playbook="TRANSITION_PROBE";priority=counter?1:alignment==="ALIGNED"?3:2;
    scoreDelta=alignment==="ALIGNED"?4:counter?-8:0;
    if(reversal)scoreDelta-=counter?4:2;
    riskScale=counter?.40:alignment==="ALIGNED"?.68:.55;
    probe=true;forceRetest=counter||reversal;minimumThesisBars=forceRetest?2:1;
    reason=forceRetest
      ?"过渡环境不再提前猜底/顶：先让候选产生第一段正反馈，再经历可控回调并重新启动后才放大执行。"
      :"过渡环境沿当前短期方向做小风险参与，先证明再扩张，不因环境不稳定而停止交易。";
  }

  if(!mainline&&(bars<minimumThesisBars||stage!=="READY")){
    probe=true;forceRetest=true;riskScale*=.82;scoreDelta-=3;
    reason+=" 当前交易假设尚未达到本环境的完整成熟度，继续观察并保留Probe执行权，不直接扩大风险。";
  }
  const finalRisk=clip(riskScale*perf,.20,1.10);
  return{version:ENVIRONMENT_ROUTER_VERSION,environment,playbook,alignment,priority,
    scoreDelta,riskScale:finalRisk,probe,forceRetest,minimumThesisBars,
    probeImpulseMin,probePullbackMin,probeRestartMin,mainline,
    reason:perf<.8?reason+` 该环境近期实际交易表现偏弱，继续交易但风险缩放至 ${(finalRisk*100).toFixed(0)}%。`:reason};
}
