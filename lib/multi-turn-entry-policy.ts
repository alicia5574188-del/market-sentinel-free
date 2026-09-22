import { TURN_CONFIG, TURN_TIMEFRAMES, type TurnCandidate, type TurnTimeframe } from "./multi-turn-engine.ts";

export const MULTI_TURN_ENTRY_POLICY_VERSION="multi-turn-entry-policy-v1";
export const MULTI_TURN_MIN_LEVERAGE=6;
export const MULTI_TURN_TARGET_LEVERAGE=12;

export function multiTurnEntryLeverage(stopRate:number,maintenanceRate:number,costRate:number,leverageMax:number){
  if(![stopRate,maintenanceRate,costRate,leverageMax].every(Number.isFinite)||stopRate<=0||maintenanceRate<0||costRate<0||leverageMax<1)return 0;
  const structuralTarget=stopRate<=.015?12:stopRate<=.025?10:stopRate<=.04?8:6;
  const safeLeverage=Math.max(1,Math.floor(.8/Math.max(stopRate+maintenanceRate+costRate,1e-9)));
  const leverage=Math.floor(Math.min(MULTI_TURN_TARGET_LEVERAGE,structuralTarget,leverageMax,safeLeverage));
  return leverage>=MULTI_TURN_MIN_LEVERAGE?leverage:0;
}

type Contract={quantoMultiplier:number;leverageMax:number;maintenanceRate:number;minContracts?:number};
type Reject={ok:false;reason:string;rotationEligible:boolean;remainingSpaceRate:number};
export type MultiTurnEntryPlan={price:number;count:number;quantity:number;notional:number;leverage:number;margin:number;plannedRisk:number;entryFee:number;remainingSpaceRate:number;quality:number;lossRate:number;};
type Accept={ok:true;plan:MultiTurnEntryPlan};
const clip=(v:number,a=0,b=1)=>Math.max(a,Math.min(b,v));

/** Pure entry economics/sizing authority. No account mutation, storage, Gate, LIVE or UI access. */
export function evaluateMultiTurnEntryPolicy(input:{
  candidate:TurnCandidate;
  bestBid:number;
  bestAsk:number;
  contract:Contract;
  equity:number;
  peakEquity:number;
  totalRisk:number;
  longRisk:number;
  shortRisk:number;
  sleeveRisks:Partial<Record<TurnTimeframe,number>>;
  grossNotional:number;
  usedMargin:number;
  tradeRisks:number[];
  costRate:number;
  feeRate:number;
  slippageRate:number;
}):Accept|Reject{
  const c=input.candidate,mid=(input.bestBid+input.bestAsk)/2,spread=(input.bestAsk-input.bestBid)/Math.max(mid,1e-9);
  if(spread>.0015)return{ok:false,reason:"当前买卖价差过大",rotationEligible:false,remainingSpaceRate:0};
  const d=c.side==="LONG"?1:-1,progress=d*(mid/c.signalPrice-1);
  const adverseLimit=Math.max(.0015,Math.min(c.stopRate*.35,c.expectedMoveRate*.60));
  if(progress< -adverseLimit)return{ok:false,reason:"方向—空间评分形成后价格已明显逆向，原入场上下文失效",rotationEligible:false,remainingSpaceRate:0};
  const remaining=c.expectedMoveRate-input.costRate-Math.max(0,progress);
  if(remaining<=0)return{ok:false,reason:"价格推进和交易成本已吃掉该周期剩余空间",rotationEligible:false,remainingSpaceRate:remaining};

  const sideRisk=c.side==="LONG"?input.longRisk:input.shortRisk,sleeveRisk=input.sleeveRisks[c.timeframe]??0;
  const drawdown=Math.max(0,1-input.equity/Math.max(input.peakEquity,input.equity));
  const drawdownScale=drawdown>=.20?.50:drawdown>=.10?.70:drawdown>=.05?.85:1;
  const quality=clip(c.continuationScore*(.65+.35*c.confidence),.15,1);
  const headroom=Math.min(input.equity*.10-input.totalRisk,input.equity*.065-sideRisk,input.equity*c.riskCap-sleeveRisk);
  const targetRisk=Math.max(0,Math.min(input.equity*.015*quality*drawdownScale,headroom));
  const lossRate=c.stopRate+input.costRate;
  const leverage=multiTurnEntryLeverage(c.stopRate,input.contract.maintenanceRate,input.costRate,input.contract.leverageMax);
  if(leverage<MULTI_TURN_MIN_LEVERAGE)return{ok:false,reason:"该结构在6倍逐仓杠杆下仍无法保留止损前安全余量，本轮放弃开仓",rotationEligible:false,remainingSpaceRate:remaining};
  const immediateMarkCost=Math.max(0,2*(input.feeRate+input.slippageRate)+spread);
  const totalCapNotional=Math.max(0,(input.equity*.10-input.totalRisk)/(lossRate+.10*immediateMarkCost));
  const sideCapNotional=Math.max(0,(input.equity*.065-sideRisk)/(lossRate+.065*immediateMarkCost));
  const sleeveCapNotional=Math.max(0,(input.equity*c.riskCap-sleeveRisk)/(lossRate+c.riskCap*immediateMarkCost));
  const riskDesired=Math.min(input.equity*1.5,targetRisk/Math.max(lossRate,1e-9),totalCapNotional,sideCapNotional,sleeveCapNotional,
    Math.max(0,input.equity*4-input.grossNotional));
  if(!(riskDesired>=input.equity*.05))return{ok:false,reason:"该周期剩余风险额度不足有效仓位，不生成碎片订单",rotationEligible:true,remainingSpaceRate:remaining};
  const marginCapNotional=Math.max(0,(input.equity*.75-input.usedMargin)/(1/leverage+.75*input.feeRate));
  if(marginCapNotional<riskDesired*.85)return{ok:false,reason:"降低杠杆后可用保证金不足以维持目标名义价值，不缩成小单",rotationEligible:false,remainingSpaceRate:remaining};
  const desired=Math.min(riskDesired,marginCapNotional);

  const price=(c.side==="LONG"?input.bestAsk:input.bestBid)*(1+d*input.slippageRate);
  const exitNow=(c.side==="LONG"?input.bestBid:input.bestAsk)*(1-d*input.slippageRate);
  const notionalPer=price*input.contract.quantoMultiplier,riskPer=notionalPer*lossRate;
  const equityDeltaPer=-notionalPer*input.feeRate+d*input.contract.quantoMultiplier*(exitNow-price)-input.contract.quantoMultiplier*exitNow*input.feeRate;
  const capCount=(rate:number,used:number,addedRiskPer=0)=>Math.max(0,Math.floor((input.equity*rate-used)/Math.max(1e-12,addedRiskPer-rate*equityDeltaPer)));
  const qualityRate=.015*quality*drawdownScale;
  let count=Math.floor(desired/notionalPer);
  const constraints=[
    capCount(.10,input.totalRisk,riskPer),
    capCount(.065,input.longRisk,c.side==="LONG"?riskPer:0),
    capCount(.065,input.shortRisk,c.side==="SHORT"?riskPer:0),
    capCount(qualityRate,0,riskPer),
    capCount(.015,0,riskPer),
    ...TURN_TIMEFRAMES.map(tf=>capCount(TURN_CONFIG[tf].riskCap,input.sleeveRisks[tf]??0,tf===c.timeframe?riskPer:0)),
    ...input.tradeRisks.map(risk=>capCount(.015,risk,0)),
  ];
  count=Math.min(count,...constraints);
  if(count<Math.max(1,input.contract.minContracts??1))return{ok:false,reason:"风险额度低于交易所最小合约张数",rotationEligible:true,remainingSpaceRate:remaining};
  const quantity=count*input.contract.quantoMultiplier,notional=quantity*price;
  if(notional<input.equity*.05||notional<desired*.25)return{ok:false,reason:"合约取整后只剩碎片仓位",rotationEligible:false,remainingSpaceRate:remaining};
  const entryFee=notional*input.feeRate,markedAfter=input.equity-entryFee,margin=notional/leverage;
  if(input.usedMargin+margin>markedAfter*.75+1e-8)return{ok:false,reason:"模拟可用保证金不足",rotationEligible:false,remainingSpaceRate:remaining};
  return{ok:true,plan:{price,count,quantity,notional,leverage,margin,plannedRisk:notional*lossRate,entryFee,remainingSpaceRate:remaining,quality,lossRate}};
}
