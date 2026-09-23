import { TURN_CONFIG } from "./multi-turn-engine.ts";
import { MULTI_TURN_MIN_LEVERAGE, MULTI_TURN_TARGET_LEVERAGE, multiTurnEntryLeverage } from "./multi-turn-entry-policy.ts";
import { REGION_DETACH_WIDTHS, type RegionEntrySignal } from "./region-lifecycle.ts";

export const REGION_ENTRY_POLICY_VERSION="region-entry-policy-v1";

type Contract={quantoMultiplier:number;leverageMax:number;maintenanceRate:number;minContracts?:number};
type Reject={ok:false;reason:string;remainingSpaceRate:number};
export type RegionEntryPlan={price:number;count:number;quantity:number;notional:number;leverage:number;margin:number;plannedRisk:number;
  entryFee:number;remainingSpaceRate:number;lossRate:number;};
type Accept={ok:true;plan:RegionEntryPlan};

export function evaluateRegionEntryPolicy(input:{
  signal:RegionEntrySignal;bestBid:number;bestAsk:number;contract:Contract;equity:number;peakEquity:number;
  totalRisk:number;longRisk:number;shortRisk:number;grossNotional:number;usedMargin:number;tradeRisks:number[];
  costRate:number;feeRate:number;slippageRate:number;
}):Accept|Reject{
  const s=input.signal,mid=(input.bestBid+input.bestAsk)/2,spread=(input.bestAsk-input.bestBid)/Math.max(mid,1e-9);
  if(![input.bestBid,input.bestAsk,input.equity,input.peakEquity,input.costRate].every(Number.isFinite)||input.bestBid<=0||input.bestAsk<=input.bestBid)
    return{ok:false,reason:"当前盘口无效",remainingSpaceRate:0};
  if(spread>.0015)return{ok:false,reason:"当前买卖价差过大",remainingSpaceRate:0};
  if(!(s.regionWidth>0&&s.regionUpper>s.regionLower&&s.regionCenter>0&&s.stopPrice>0))
    return{ok:false,reason:"区域结构数据无效",remainingSpaceRate:0};

  const d=s.side==="LONG"?1:-1;
  const price=(s.side==="LONG"?input.bestAsk:input.bestBid)*(1+d*input.slippageRate);
  const structuralStopRate=d*(price-s.stopPrice)/Math.max(price,1e-9);
  if(!(structuralStopRate>0))return{ok:false,reason:"区域失效位不在持仓反向一侧",remainingSpaceRate:0};
  if(structuralStopRate>TURN_CONFIG["5m"].maxStop)
    return{ok:false,reason:"区域结构止损超过5分钟统一风险边界，不缩短结构止损",remainingSpaceRate:0};
  const lossRate=structuralStopRate+input.costRate;

  let remaining=0;
  if(s.kind==="REJECTION"){
    const target=s.targetPrice??s.regionCenter;
    const targetRate=d*(target/price-1);
    if(targetRate<=input.costRate*1.10)
      return{ok:false,reason:"回归区域中心的剩余空间已不足覆盖交易成本",remainingSpaceRate:targetRate-input.costRate};
    const outside=s.boundary==="UPPER"?(mid-s.regionUpper)/s.regionWidth:(s.regionLower-mid)/s.regionWidth;
    if(outside>.15)return{ok:false,reason:"边界拒绝后价格又重新跑回区域外，原回归事件失效",remainingSpaceRate:0};
    remaining=targetRate-input.costRate;
  }else{
    const boundary=s.side==="LONG"?s.regionUpper:s.regionLower;
    const travel=d*(mid-boundary)/s.regionWidth;
    if(travel<-.10)return{ok:false,reason:"价格已重新接受旧区域，迁移事件失效",remainingSpaceRate:0};
    if(travel>REGION_DETACH_WIDTHS)return{ok:false,reason:"价格已经离旧区域过远，不追迁移单；保留事件等待回踩",remainingSpaceRate:0};

    // The extension budget belongs to the REGION BOUNDARY, not to the second
    // confirmation close. Otherwise the distance already travelled while
    // waiting for two completed 5m closes is forgotten and a late confirmation
    // is incorrectly treated as a fresh full-size opportunity.
    const extensionBudget=Math.max(s.regionWidthRate*1.25,input.costRate*3);
    const consumedFromBoundary=Math.max(0,d*(price/boundary-1));
    remaining=extensionBudget-consumedFromBoundary-input.costRate;
    const edgeRatio=remaining/Math.max(lossRate,1e-9);
    if(remaining<=0||edgeRatio<1.15)
      return{ok:false,reason:"迁移已确认，但确认前已消耗过多区域外推进空间；保留事件等待回踩边界改善盈亏比",remainingSpaceRate:remaining};
  }

  const sideRisk=s.side==="LONG"?input.longRisk:input.shortRisk;
  const drawdown=Math.max(0,1-input.equity/Math.max(input.peakEquity,input.equity));
  const drawdownScale=drawdown>=.20?.50:drawdown>=.10?.70:drawdown>=.05?.85:1;
  const headroom=Math.min(input.equity*.10-input.totalRisk,input.equity*.065-sideRisk);
  const targetRisk=Math.max(0,Math.min(input.equity*.015*drawdownScale,headroom));
  const leverage=multiTurnEntryLeverage(structuralStopRate,input.contract.maintenanceRate,input.costRate,input.contract.leverageMax);
  if(leverage<MULTI_TURN_MIN_LEVERAGE)
    return{ok:false,reason:"该区域结构在6倍逐仓杠杆下仍无法保留安全余量",remainingSpaceRate:remaining};

  const immediateMarkCost=Math.max(0,2*(input.feeRate+input.slippageRate)+spread);
  const totalCapNotional=Math.max(0,(input.equity*.10-input.totalRisk)/(lossRate+.10*immediateMarkCost));
  const sideCapNotional=Math.max(0,(input.equity*.065-sideRisk)/(lossRate+.065*immediateMarkCost));
  const riskDesired=Math.min(input.equity*1.5,targetRisk/Math.max(lossRate,1e-9),totalCapNotional,sideCapNotional,
    Math.max(0,input.equity*4-input.grossNotional));
  if(!(riskDesired>=input.equity*.05))
    return{ok:false,reason:"组合风险额度不足有效仓位，不生成碎片订单",remainingSpaceRate:remaining};

  const marginCapNotional=Math.max(0,(input.equity*.75-input.usedMargin)/(1/leverage+.75*input.feeRate));
  if(marginCapNotional<riskDesired*.85)
    return{ok:false,reason:"可用保证金不足以维持目标名义价值，不缩成小单",remainingSpaceRate:remaining};
  const desired=Math.min(riskDesired,marginCapNotional);
  const exitNow=(s.side==="LONG"?input.bestBid:input.bestAsk)*(1-d*input.slippageRate);
  const notionalPer=price*input.contract.quantoMultiplier,riskPer=notionalPer*lossRate;
  const equityDeltaPer=-notionalPer*input.feeRate+d*input.contract.quantoMultiplier*(exitNow-price)-input.contract.quantoMultiplier*exitNow*input.feeRate;
  const capCount=(rate:number,used:number,addedRiskPer=0)=>Math.max(0,Math.floor((input.equity*rate-used)/Math.max(1e-12,addedRiskPer-rate*equityDeltaPer)));
  let count=Math.floor(desired/notionalPer);
  count=Math.min(count,
    capCount(.10,input.totalRisk,riskPer),
    capCount(.065,input.longRisk,s.side==="LONG"?riskPer:0),
    capCount(.065,input.shortRisk,s.side==="SHORT"?riskPer:0),
    capCount(.015,0,riskPer),
    ...input.tradeRisks.map(risk=>capCount(.015,risk,0))
  );
  if(count<Math.max(1,input.contract.minContracts??1))
    return{ok:false,reason:"风险额度低于交易所最小合约张数",remainingSpaceRate:remaining};
  const quantity=count*input.contract.quantoMultiplier,notional=quantity*price;
  if(notional<input.equity*.05||notional<desired*.25)
    return{ok:false,reason:"合约取整后只剩碎片仓位",remainingSpaceRate:remaining};
  const entryFee=notional*input.feeRate,markedAfter=input.equity-entryFee,margin=notional/leverage;
  if(input.usedMargin+margin>markedAfter*.75+1e-8)
    return{ok:false,reason:"模拟可用保证金不足",remainingSpaceRate:remaining};
  return{ok:true,plan:{price,count,quantity,notional,leverage,margin,plannedRisk:notional*lossRate,entryFee,remainingSpaceRate:remaining,lossRate}};
}

export { MULTI_TURN_MIN_LEVERAGE, MULTI_TURN_TARGET_LEVERAGE };
