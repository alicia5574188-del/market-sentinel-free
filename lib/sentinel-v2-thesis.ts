import type { V2MarketContext } from "./sentinel-v2-core.ts";
import { upsertV2TradeThesis } from "./sentinel-v2-repository.ts";

export type V2OpenTradeForThesis = { id:string; symbol:string; side:"LONG"|"SHORT"; regime:string; entryThesis:string; confidence:number };
function clamp(value:number,min=0,max=100){return Math.min(max,Math.max(min,value))}
function playbookFromRegime(regime:string){
  if(regime.startsWith("S2|")){const playbook=regime.split("|")[1];if(/^P(?:[1-9]|1[0-2])_/.test(playbook))return playbook}
  return /P1|回踩/.test(regime)?"P1_TREND_PULLBACK":/P4|突破/.test(regime)?"P4_COMPRESSION_BREAKOUT":"V1_POSITION_CARRYOVER";
}
export function calculateV2ThesisHealth(trade:V2OpenTradeForThesis,market:V2MarketContext){
  const directionConflict=market.bias==="NEUTRAL"||market.bias===trade.side?0:22;
  const permissionPenalty=market.permission==="RED"?28:market.permission==="ORANGE"?18:market.permission==="YELLOW"?9:market.permission==="BLUE"?3:0;
  const transitionPenalty=market.transitionRisk*.42,stabilityPenalty=(100-market.stability)*.16,velocityPenalty=Math.max(0,market.transitionVelocity)*.2,confidenceCredit=Math.max(0,Math.min(8,(trade.confidence-70)*.2));
  return Math.round(clamp(100-directionConflict-permissionPenalty-transitionPenalty-stabilityPenalty-velocityPenalty+confidenceCredit));
}
export async function syncV2OpenTradeTheses(trades:V2OpenTradeForThesis[],market:V2MarketContext){
  await Promise.all(trades.map(async trade=>{const thesisHealth=calculateV2ThesisHealth(trade,market);const currentThesis={observedAt:market.observedAt,regime:market.regime,regimeLabel:market.regimeLabel,transitionRisk:market.transitionRisk,transitionVelocity:market.transitionVelocity,stability:market.stability,permission:market.permission,bias:market.bias,directionAligned:market.bias==="NEUTRAL"||market.bias===trade.side,topDrivers:market.topDrivers,warnings:market.warnings.slice(0,5).map(w=>({type:w.type,level:w.level,severity:w.severity,title:w.title}))};await upsertV2TradeThesis({tradeId:trade.id,playbook:playbookFromRegime(trade.regime),entryRegime:trade.regime,currentRegime:market.regime,entryTransitionRisk:market.transitionRisk,currentTransitionRisk:market.transitionRisk,thesisHealth,entryThesis:{entryThesis:trade.entryThesis,entryRegime:trade.regime,confidence:trade.confidence},currentThesis})}));
}
