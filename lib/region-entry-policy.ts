import { TURN_CONFIG, type TurnFrameState } from "./multi-turn-engine.ts";
import { MULTI_TURN_MIN_LEVERAGE, MULTI_TURN_TARGET_LEVERAGE, multiTurnEntryLeverage } from "./multi-turn-entry-policy.ts";
import { type RegionEntrySignal } from "./region-lifecycle.ts";
import { anchorFlowExecutableProofRate } from "./anchor-flow.ts";

export const REGION_ENTRY_POLICY_VERSION="region-entry-policy-v1";

type Contract={quantoMultiplier:number;leverageMax:number;maintenanceRate:number;minContracts?:number};
type Reject={ok:false;reason:string;remainingSpaceRate:number};
export type RegionEntryPlan={price:number;count:number;quantity:number;notional:number;leverage:number;margin:number;plannedRisk:number;
  entryFee:number;remainingSpaceRate:number;lossRate:number;};
type Accept={ok:true;plan:RegionEntryPlan};

/** Only veto mean-reversion REJECTION entries when a sufficiently broad,
 * synchronized 5m + 15m market shock is still moving against that entry. */
export function rejectionAgainstSynchronizedFlow(input:{side:"LONG"|"SHORT";marketCount:number;
  five?:TurnFrameState;fifteen?:TurnFrameState}){
  const {side,marketCount,five,fifteen}=input;
  if(marketCount<8||!five?.ready||!fifteen?.ready)return false;
  const opposite=side==="LONG"?"SHORT":"LONG";
  const breadthAgainst=side==="LONG"
    ?five.breadthLong<=.18&&fifteen.breadthLong<=.32
    :five.breadthLong>=.82&&fifteen.breadthLong>=.68;
  return breadthAgainst&&five.direction===opposite&&fifteen.direction===opposite
    &&five.directionConfidence>=.35&&fifteen.directionConfidence>=.30;
}

export function evaluateRegionEntryPolicy(input:{
  signal:RegionEntrySignal;bestBid:number;bestAsk:number;contract:Contract;equity:number;peakEquity:number;
  totalRisk:number;longRisk:number;shortRisk:number;grossNotional:number;usedMargin:number;tradeRisks:number[];
  costRate:number;feeRate:number;slippageRate:number;anchorConfirmationReferencePrice?:number|null;anchorMicroConfirmed?:boolean;
}):Accept|Reject{
  const s=input.signal,mid=(input.bestBid+input.bestAsk)/2,spread=(input.bestAsk-input.bestBid)/Math.max(mid,1e-9);
  const extra=s as RegionEntrySignal&{entryModel?:string;entryMode?:"ROTATION"|"RELEASE"|"RETEST";anchorExpectedMoveRate?:number;launchExpectedMoveRate?:number;
    launchTriggerPrice?:number;launchEffectiveTrigger?:number;launchMaxChaseRate?:number};
  const entryModel=extra.entryModel;
  const isAnchor=s.kind==="MIGRATION"&&entryModel==="ANCHOR_FLOW",isLaunch=s.kind==="MIGRATION"&&entryModel==="REGION_LAUNCH";
  // RegionLaunch and ordinary 5m participation share one portfolio envelope.
  // RegionLaunch keeps its smaller per-trade risk while remaining able to replace
  // or join ordinary holdings after the portfolio has grown beyond the old 4%.
  const totalRiskRate=.10,sideRiskRate=.065,tradeRiskRate=isAnchor?.008:.006,perTradeNotionalRate=.60,totalNotionalRate=4.0;
  if(![input.bestBid,input.bestAsk,input.equity,input.peakEquity,input.costRate].every(Number.isFinite)||input.bestBid<=0||input.bestAsk<=input.bestBid)
    return{ok:false,reason:"当前盘口无效",remainingSpaceRate:0};
  if(spread>.0015)return{ok:false,reason:"当前买卖价差过大",remainingSpaceRate:0};
  if(!(s.regionWidth>0&&s.regionUpper>s.regionLower&&s.regionCenter>0&&s.stopPrice>0))
    return{ok:false,reason:"区域结构数据无效",remainingSpaceRate:0};

  const d=s.side==="LONG"?1:-1;
  const price=(s.side==="LONG"?input.bestAsk:input.bestBid)*(1+d*input.slippageRate);
  const structuralStopRate=d*(price-s.stopPrice)/Math.max(price,1e-9);
  if(!(structuralStopRate>0))return{ok:false,reason:"区域失效位不在持仓反向一侧",remainingSpaceRate:0};
  const exitNow=(s.side==="LONG"?input.bestBid:input.bestAsk)*(1-d*input.slippageRate);
  const stopRoom=d*(exitNow-s.stopPrice);
  const minimumRoom=Math.max(mid*Math.max(.001,input.costRate*.50),2*(input.bestAsk-input.bestBid),
    isAnchor?s.regionWidth*.08:0);
  if((isAnchor||isLaunch)&&stopRoom<minimumRoom-1e-10)
    return{ok:false,reason:"结构止损贴近当前可平仓价；保留候选，等待最新回调支点与真实顺向确认",remainingSpaceRate:0};
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
    if(remaining/Math.max(lossRate,1e-9)<1)
      return{ok:false,reason:"区域拒绝虽有回归空间，但净收益不足覆盖完整结构风险与成本",remainingSpaceRate:remaining};
  }else{
    if(!isAnchor&&!isLaunch)return{ok:false,reason:"直接区域迁移已退役；只允许 AnchorFlow 回测重启或 RegionLaunch 爆发确认事件",remainingSpaceRate:0};
    if(isLaunch){
      const expected=extra.launchExpectedMoveRate??0,trigger=extra.launchEffectiveTrigger??extra.launchTriggerPrice??0,maxChase=extra.launchMaxChaseRate??0;
      // Anti-late-chase is measured from the actual effective trigger (region edge
      // or the nearest pressure/support band that had to be cleared), never from
      // the last confirmation candle. This prevents a late BNB-style fill from
      // looking "close" merely because confirmation itself arrived late.
      const triggerProgress=trigger>0?d*(price/trigger-1):Infinity;
      if(!(triggerProgress>0&&maxChase>0))
        return{ok:false,reason:"RegionLaunch有效触发位已经失效；等待回踩或新的区域机会",remainingSpaceRate:0};
      if(triggerProgress>maxChase)
        return{ok:false,reason:"RegionLaunch从有效触发位计算已经追远；不补追，保留回踩二次参与",remainingSpaceRate:0};
      remaining=Math.max(0,expected-triggerProgress-input.costRate);
      const edgeRatio=remaining/Math.max(lossRate,1e-9);
      if(remaining<=input.costRate||edgeRatio<1.05)
        return{ok:false,reason:"RegionLaunch当前位置的剩余可运行空间不足覆盖结构风险与成本",remainingSpaceRate:remaining};
    }else{
      const expected=extra.anchorExpectedMoveRate??0;
      remaining=Math.max(0,expected-input.costRate);
      const boundary=s.side==="LONG"?s.regionUpper:s.regionLower;
      const location=d*(mid-boundary);
      if(location< -s.regionWidth*.30||location>s.regionWidth*.45)
        return{ok:false,reason:"AnchorFlow READY继续保留；当前价格已离开边界优势区，等待更好的成交位置",remainingSpaceRate:remaining};
      const reference=input.anchorConfirmationReferencePrice??NaN,proof=anchorFlowExecutableProofRate(input.costRate);
      const quoteProgress=Number.isFinite(reference)&&reference>0?d*(price/reference-1):0;
      if(quoteProgress<proof&&!input.anchorMicroConfirmed)
        return{ok:false,reason:"AnchorFlow READY继续保留；等待短时真实盘口反弹，或完整1分钟推进—小回调—再启动确认",remainingSpaceRate:remaining};
      const edgeRatio=remaining/Math.max(lossRate,1e-9);
      if(remaining<=input.costRate||edgeRatio<1.10)
        return{ok:false,reason:"AnchorFlow 回测成立，但当前15m剩余空间仍不足覆盖结构风险与成本",remainingSpaceRate:remaining};
    }
  }
  const sideRisk=s.side==="LONG"?input.longRisk:input.shortRisk;
  const drawdown=Math.max(0,1-input.equity/Math.max(input.peakEquity,input.equity));
  const drawdownScale=drawdown>=.20?.50:drawdown>=.10?.70:drawdown>=.05?.85:1;
  const headroom=Math.min(input.equity*totalRiskRate-input.totalRisk,input.equity*sideRiskRate-sideRisk);
  const targetRisk=Math.max(0,Math.min(input.equity*tradeRiskRate*drawdownScale,headroom));
  const leverage=multiTurnEntryLeverage(structuralStopRate,input.contract.maintenanceRate,input.costRate,input.contract.leverageMax);
  if(leverage<MULTI_TURN_MIN_LEVERAGE)
    return{ok:false,reason:"该区域结构在6倍逐仓杠杆下仍无法保留安全余量",remainingSpaceRate:remaining};

  const immediateMarkCost=Math.max(0,2*(input.feeRate+input.slippageRate)+spread);
  const totalCapNotional=Math.max(0,(input.equity*totalRiskRate-input.totalRisk)/(lossRate+totalRiskRate*immediateMarkCost));
  const sideCapNotional=Math.max(0,(input.equity*sideRiskRate-sideRisk)/(lossRate+sideRiskRate*immediateMarkCost));
  const riskDesired=Math.min(input.equity*perTradeNotionalRate,targetRisk/Math.max(lossRate,1e-9),totalCapNotional,sideCapNotional,
    Math.max(0,input.equity*totalNotionalRate-input.grossNotional));
  if(!(riskDesired>=input.equity*.05))
    return{ok:false,reason:"组合风险额度不足有效仓位，不生成碎片订单",remainingSpaceRate:remaining};

  const marginCapNotional=Math.max(0,(input.equity*.75-input.usedMargin)/(1/leverage+.75*input.feeRate));
  if(marginCapNotional<riskDesired*.85)
    return{ok:false,reason:"可用保证金不足以维持目标名义价值，不缩成小单",remainingSpaceRate:remaining};
  const desired=Math.min(riskDesired,marginCapNotional);
  const notionalPer=price*input.contract.quantoMultiplier,riskPer=notionalPer*lossRate;
  const equityDeltaPer=-notionalPer*input.feeRate+d*input.contract.quantoMultiplier*(exitNow-price)-input.contract.quantoMultiplier*exitNow*input.feeRate;
  const capCount=(rate:number,used:number,addedRiskPer=0)=>Math.max(0,Math.floor((input.equity*rate-used)/Math.max(1e-12,addedRiskPer-rate*equityDeltaPer)));
  let count=Math.floor(desired/notionalPer);
  count=Math.min(count,
    capCount(totalRiskRate,input.totalRisk,riskPer),
    capCount(sideRiskRate,input.longRisk,s.side==="LONG"?riskPer:0),
    capCount(sideRiskRate,input.shortRisk,s.side==="SHORT"?riskPer:0),
    capCount(tradeRiskRate,0,riskPer),
    ...input.tradeRisks.map(risk=>capCount(tradeRiskRate,risk,0))
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
