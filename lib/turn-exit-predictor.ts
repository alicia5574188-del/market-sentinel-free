import { TURN_CONFIG, TURN_TIMEFRAMES, type TurnFrameState, type TurnSide, type TurnTimeframe } from "./multi-turn-engine.ts";

export const RBE_EXIT_VERSION = "rbe-optimal-stopping-v1";

export type PredictiveExitPhase = "HEALTHY" | "EARLY_WARNING" | "DEFENSIVE" | "PRE_TURN_EXIT";
export type TradeSide = Exclude<TurnSide, "NEUTRAL">;

export type PredictiveExitConfig = {
  name: string;
  exitHazard: number;
  maxExitSurvival: number;
  valueMarginAtr: number;
  minEvidenceFamilies: number;
  defensiveHazard: number;
};

export const RBE_EXIT_CONFIGS = {
  conservative: { name: "conservative", exitHazard: .66, maxExitSurvival: .38, valueMarginAtr: .08,
    minEvidenceFamilies: 4, defensiveHazard: .52 },
  balanced: { name: "balanced", exitHazard: .58, maxExitSurvival: .46, valueMarginAtr: .035,
    minEvidenceFamilies: 3, defensiveHazard: .48 },
  responsive: { name: "responsive", exitHazard: .53, maxExitSurvival: .52, valueMarginAtr: .02,
    minEvidenceFamilies: 3, defensiveHazard: .44 },
} as const satisfies Record<string, PredictiveExitConfig>;

export const DEFAULT_RBE_EXIT_CONFIG: PredictiveExitConfig = RBE_EXIT_CONFIGS.balanced;

export type PredictiveExitInput = {
  side: TradeSide;
  timeframe: TurnTimeframe;
  entryPrice: number;
  stopPrice: number;
  currentPrice: number;
  favorable: number;
  frames: Partial<Record<TurnTimeframe, TurnFrameState>>;
};

export type PredictiveExitDecision = {
  version: typeof RBE_EXIT_VERSION;
  phase: PredictiveExitPhase;
  shouldExit: boolean;
  reversalHazard: number;
  slowHazard: number;
  shockHazard: number;
  extensionSurvival: number;
  holdValueRate: number;
  expectedExtensionRate: number;
  expectedReversalCostRate: number;
  evidenceFamilies: number;
  eligible: boolean;
  diagnostics: {
    ownTurn: number;
    ownDecay: number;
    lowerLead: number;
    lowerSupport: number;
    upperSupport: number;
    upperOpposition: number;
    sequenceShift: number;
    structureBreak: number;
    breadthPressure: number;
    currentReturn: number;
    profitGiveback: number;
  };
  reason: string;
};

const clip=(v:number,a=0,b=1)=>Math.max(a,Math.min(b,v));
const mean=(v:number[])=>v.length?v.reduce((a,b)=>a+b,0)/v.length:0;
const opposite=(side:TradeSide):TradeSide=>side==="LONG"?"SHORT":"LONG";
const signFor=(side:TradeSide)=>side==="LONG"?1:-1;

function sameSideSupport(frame:TurnFrameState|undefined,side:TradeSide){
  if(!frame||frame.direction!==side)return 0;
  const min=TURN_CONFIG[frame.timeframe].minContinuation;
  return clip(frame.continuationScore/Math.max(.05,min*1.35));
}

function opposition(frame:TurnFrameState|undefined,side:TradeSide){
  if(!frame)return 0;
  const opp=opposite(side);
  if(frame.direction===opp)return 1;
  if(frame.candidateSide===opp)return clip(Math.max(.50,frame.triggerProbability));
  if(frame.rawDirection===opp)return clip(.30+.55*frame.triggerProbability);
  return clip(frame.triggerProbability*.20);
}

function rapidShock(frame:TurnFrameState|undefined){
  if(!frame)return 0;
  const e=frame.evidence;
  return clip(.34*e.changePoint+.28*e.acceleration+.20*Math.max(e.structure,e.failedExtension)
    +.10*e.cusum+.08*e.volatility);
}

export function predictMultiTurnExit(input:PredictiveExitInput,
  config:PredictiveExitConfig=DEFAULT_RBE_EXIT_CONFIG):PredictiveExitDecision|null{
  const own=input.frames[input.timeframe];
  if(!own||!own.ready||!(input.entryPrice>0)||!(input.currentPrice>0)||!(input.stopPrice>0))return null;

  const ownIndex=TURN_TIMEFRAMES.indexOf(input.timeframe);
  const lower=TURN_TIMEFRAMES.slice(0,ownIndex).map(tf=>input.frames[tf]).filter(Boolean) as TurnFrameState[];
  const upper=TURN_TIMEFRAMES.slice(ownIndex+1).map(tf=>input.frames[tf]).filter(Boolean) as TurnFrameState[];
  const d=signFor(input.side),cfg=TURN_CONFIG[input.timeframe];

  const ownTurn=own.direction===opposite(input.side)?1:opposition(own,input.side);
  const ownContinuity=sameSideSupport(own,input.side);
  const ownDecay=clip(1-ownContinuity);
  const lowerWeights=lower.map((_,i)=>1+(i+1)/Math.max(1,lower.length));
  const lowerOpp=lower.map((f,i)=>opposition(f,input.side)*lowerWeights[i]);
  const lowerLead=lowerOpp.length?clip(lowerOpp.reduce((a,b)=>a+b,0)/lowerWeights.reduce((a,b)=>a+b,0)):0;
  const lowerSupport=lower.length?clip(mean(lower.map(f=>sameSideSupport(f,input.side)))):ownContinuity;
  const upperSupport=upper.length?clip(mean(upper.map(f=>sameSideSupport(f,input.side)))):ownContinuity;
  const upperOpposition=upper.length?clip(mean(upper.map(f=>opposition(f,input.side)))):0;

  const e=own.evidence;
  const sequenceShift=clip(.40*e.changePoint+.32*e.cusum+.28*e.acceleration);
  const structureBreak=clip(.72*e.structure+.28*e.failedExtension);
  const breadthPressure=clip(Math.max(e.breadth,e.propagation));
  const slowHazard=clip(.25*ownTurn+.23*ownDecay+.20*lowerLead+.13*sequenceShift+.10*structureBreak
    +.09*breadthPressure+.08*upperOpposition-.18*upperSupport);
  const lowerShock=lower.length?Math.max(...lower.map(rapidShock)):0;
  const shockHazard=clip(.66*Math.max(rapidShock(own),lowerShock)+.28*lowerLead+.12*upperOpposition-.16*upperSupport);
  const reversalHazard=clip(1-(1-slowHazard)*(1-.72*shockHazard));

  const extensionSurvival=clip(.52*ownContinuity+.20*upperSupport+.13*lowerSupport+.10*(1-ownTurn)
    -.20*lowerLead-.12*sequenceShift-.10*structureBreak-.08*upperOpposition);
  const currentReturn=d*(input.currentPrice/input.entryPrice-1);
  const profitGiveback=Math.max(0,input.favorable-currentReturn);
  const stopDistance=Math.max(0,d*(input.currentPrice-input.stopPrice)/input.entryPrice);
  const expectedExtensionRate=own.expectedMoveRate*(.45+.55*extensionSurvival+.30*upperSupport);
  const expectedReversalCostRate=Math.max(own.atrRate*1.05,
    Math.min(Math.max(stopDistance,own.atrRate),Math.max(0,currentReturn)+own.atrRate*2.25));
  const holdValueRate=(1-reversalHazard)*expectedExtensionRate-reversalHazard*expectedReversalCostRate;

  const familyFlags=[
    ownDecay>=.55,
    lowerLead>=.55,
    sequenceShift>=.55,
    structureBreak>=.55,
    breadthPressure>=.55,
    shockHazard>=.68,
    upperOpposition>=.50,
  ];
  const evidenceFamilies=familyFlags.filter(Boolean).length;
  // Prediction may protect a proven runner before formal reversal confirmation.
  // A losing/unproven trade remains under its original stop unless shock evidence
  // is exceptionally broad, so this layer does not silently rewrite entry logic.
  const provenMove=Math.max(own.atrRate*.45,own.expectedMoveRate*.25);
  const eligible=input.favorable>=provenMove || (shockHazard>=.82&&evidenceFamilies>=3);
  const exitMargin=own.atrRate*config.valueMarginAtr;
  const shouldExit=eligible&&reversalHazard>=config.exitHazard&&extensionSurvival<=config.maxExitSurvival
    &&holdValueRate<=-exitMargin&&evidenceFamilies>=config.minEvidenceFamilies;

  let phase:PredictiveExitPhase="HEALTHY";
  if(shouldExit)phase="PRE_TURN_EXIT";
  else if(eligible&&reversalHazard>=config.defensiveHazard&&holdValueRate<=0&&evidenceFamilies>=2)phase="DEFENSIVE";
  else if(reversalHazard>=.34||holdValueRate<=0)phase="EARLY_WARNING";

  const reason=shouldExit
    ? `RBE提前退出：反转风险${(reversalHazard*100).toFixed(0)}%，延伸生存${(extensionSurvival*100).toFixed(0)}%，继续持有价值${(holdValueRate*100).toFixed(2)}%，独立证据${evidenceFamilies}组`
    : `RBE ${phase}：反转风险${(reversalHazard*100).toFixed(0)}%，延伸生存${(extensionSurvival*100).toFixed(0)}%，继续持有价值${(holdValueRate*100).toFixed(2)}%`;

  return{version:RBE_EXIT_VERSION,phase,shouldExit,reversalHazard,slowHazard,shockHazard,extensionSurvival,
    holdValueRate,expectedExtensionRate,expectedReversalCostRate,evidenceFamilies,eligible,
    diagnostics:{ownTurn,ownDecay,lowerLead,lowerSupport,upperSupport,upperOpposition,sequenceShift,structureBreak,
      breadthPressure,currentReturn,profitGiveback},reason};
}
