/** Independent research -> actual intent -> branch holding. No shadow engine,
 * companion trade, second wallet, source close event or network access. */
import {advanceForward,normalizeForward,forwardEquity,freshQuote,PAPER_COST,drainLegacyForwardPositions,executionValueAtQuote,type ForwardState,type Opportunity,type Trade,
  type Quote,type Contract,type DirectExecutionAdapter} from './forward-relations.ts';
import {confirmAcceptance,closeUnifiedTrade,reduceUnifiedTrade,manageContinuation} from './unified-execution.ts';
import {reactionGeometry,advanceWinnerManagement,trendCore,WINNER_POLICY_VERSION,type WinnerPlan} from './winner-policy.ts';
import {evaluatePositionIntelligence} from './position-intelligence-engine.ts';
import {capturePositionBaseline} from './position-evidence-contract.ts';
import {remainingTradeFraction} from './trade-realization.ts';
import {forwardProtectionChanged} from './forward-protection-checkpoint.ts';
import {DIRECT_STRATEGY_VERSION,type DirectPlan,type ReturnLogic} from './direct-strategy-types.ts';
import type {Acceptance} from './unified-execution-types.ts';
export {DIRECT_STRATEGY_VERSION} from './direct-strategy-types.ts';
export {directOpportunityView,directStrategySummary} from './direct-strategy-view.ts';
const sign=(side:'LONG'|'SHORT')=>side==='LONG'?1:-1;
const opposite=(side:'LONG'|'SHORT')=>side==='LONG'?'SHORT' as const:'LONG' as const;
const finitePositive=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n)&&n>0;
const fill=(side:Trade['side'],q:Quote)=>side==='LONG'?q.bestAsk:q.bestBid;
const mark=(side:Trade['side'],q:Quote)=>side==='LONG'?q.bestBid:q.bestAsk;
const COST=2*(PAPER_COST.feeRate+PAPER_COST.slippageRate),FEE=.0005;
type Input=Parameters<typeof advanceForward>[0];
function note(s:ForwardState,t:Trade,now:number,reason:string){
  s.events.unshift({id:`a${s.startedAt}-${++s.revision}`,at:now,kind:'ENTRY',subject:t.id,reason,
    detail:{strategy:DIRECT_STRATEGY_VERSION,branch:t.unified!.branch}});s.events=s.events.slice(0,160);
}
function legacySource(s:ForwardState,t:Trade){
  const sourceId=t.unified?.sourceId??t.inverseCopy?.sourceId;
  return [...(s.inverseTrial?.source.positions??[]),...(s.inverseTrial?.source.history??[])].find(r=>r.id===sourceId);
}
/** Carry the geometric memory and exact native/financial identities forward;
 * the old wallets stop evaluating. Closed history and receipts stay intact. */
export function migrateDirectStrategy(s:ForwardState,now:number){
  if(s.directStrategy)return false;
  for(const t of s.positions){
    const old=t.unified,source=legacySource(s,t);
    if(!old&&!t.inverseCopy)continue; // Original pre-trial obligations drain by their existing rules.
    if(old?.branch==='CONTINUATION'){
      old.version=DIRECT_STRATEGY_VERSION;old.migratedAt=now;
      old.entryReason=`原趋势计划延续：${old.entryReason}`;
      continue;
    }
    const plan=source?.entryContext?.winnerPlan??t.inverseCopy?.sourceEntryPlan?.winnerPlan;
    if(!plan)throw new Error('旧持仓缺少可抽取的几何退出依据；保留账户，禁止猜测或重置');
    const memory:ReturnLogic={moveSide:opposite(t.side),entryPrice:source?.entryPrice??t.entryPrice,
      openedAt:source?.openedAt??t.openedAt,peakAdvance:source?.favorable??t.adverse,
      firstAdvanceAt:source?.firstProfitAt??null,plan:structuredClone(plan),
      management:source?.winnerManagement?structuredClone(source.winnerManagement):undefined,
      assessment:source?.positionIntelligence?structuredClone(source.positionIntelligence):undefined,
      entryResidual:source?.entryContext?.entryResidual??0,entryRelativeStrength:source?.entryContext?.entryRelativeStrength??.5,
      entryRemainingSpaceRate:source?.entryContext?.remainingSpaceRate??0,entryScore:source?.entryContext?.entryScore??50,
      validated:!!source?.entryContext?.entryResponse,
      ...(source?.status==='CLOSED'?{pendingExitReason:source.exitReason??'LEGACY_COMMITTED_EXIT'}:{})};
    const reason=`迁移前已持有的${t.side==='LONG'?'多':'空'}仓，承接原推进衰减/回退退出边界；不补开或重置`;
    t.unified={...old,version:DIRECT_STRATEGY_VERSION,branch:'RETURN',sourceId:old?.sourceId??t.id,referenceId:old?.referenceId??t.id,
      referenceContracts:t.contracts,region:old?.region??structuredClone(plan.origin),epsilon:old?.epsilon??0,
      confirmation:old?.confirmation??null,initialStop:null,entryReason:reason,holdReason:reason,
      exitCondition:'回退兑现、推进衰减确认结束，或本币持续趋势确认使回退假设失效',lastDecisionAt:now,lastBarAt:0,
      decision:'HOLD',returnLogic:memory,migratedAt:now,legacyReceipt:t.inverseCopy?structuredClone(t.inverseCopy):old?.legacyReceipt,
      explanationEvents:old?.explanationEvents??[]};
    delete t.inverseCopy;
    if(t.entryContext){t.entryContext.side=t.side;t.entryContext.strategyVersion=DIRECT_STRATEGY_VERSION;
      t.entryContext.reason=reason;t.entryContext.thesisSummary=reason;t.entryContext.invalidationSummary=t.unified.exitCondition;}
  }
  s.directStrategy={version:DIRECT_STRATEGY_VERSION,cutoverAt:now,plans:{},memory:{},completedConversions:0,retiredAt:now,
    summary:'逐币比较推进回退与真实趋势延续；交易、持仓和退出由当前账户自己的依据决定'};
  // No replay of previously armed source candidates into a new controller.
  s.entryValidations={};s.opportunities=[];s.revision++;
  return true;
}
export function directContinuationGeometry(s:ForwardState,o:Opportunity,a:Acceptance,q:Quote,c:Contract){
  const price=fill(a.side,q),d=sign(a.side),risk=d*(price-a.stop),
    liquidity=s.extremumRegime.liquidity?.symbols[o.symbol],zone=a.side==='LONG'?liquidity?.nextAbove:liquidity?.nextBelow,
    known=[o.winnerPlan?.target,zone?(a.side==='LONG'?zone.lower:zone.upper):null]
      .filter((n):n is number=>finitePositive(n)&&d*(n-price)>0),
    target=known.sort((x,y)=>d*(x-y))[0]??null,
    netRisk=risk+(price+a.stop)*FEE,netRoom=target==null?0:d*(target-price)-(price+target)*FEE,
    ratio=netRoom/Math.max(netRisk,1e-12),leverage=Math.max(1,Math.min(5,Math.floor(c.leverageMax/2)));
  return{price,stop:a.stop,target,ratio,riskRate:netRisk/price,leverage,
    valid:finitePositive(risk)&&a.stop>0&&target!=null&&ratio>=1.35
      &&1/leverage>risk/price+c.maintenanceRate+2*FEE,
    reason:!finitePositive(risk)?'当前成交价已越过延续保护位置':target==null?'缺少可核对的下一结构障碍'
      :ratio<1.35?'当前成交价到障碍的扣费空间不足':
        1/leverage<=risk/price+c.maintenanceRate+2*FEE?'逐仓保证金不足以承受结构风险':'本币已站稳并推进，当前结构风险与扣费空间合格'};
}
function flowReady(s:ForwardState,o:Pick<Opportunity,'symbol'>,a:Acceptance,q:Quote|undefined,now:number){
  const v=s.extremumRegime.symbols[o.symbol];
  return freshQuote(q,now)&&s.extremumRegime.updatedAt<=now&&now-s.extremumRegime.updatedAt<=10_000
    &&!!v&&v.dataConfidence>=60&&v.sourceCount>=2&&(q!.sourceCount??0)>=2&&sign(a.side)*v.venuePressure>0;
}
function areaFor(o:Opportunity,input:Input){
  const frozen=o.winnerPlan?.origin;
  return frozen?.balanced&&frozen.formedAt<=input.now?structuredClone(frozen):reactionGeometry(input.paths[o.symbol],input.now).area;
}
/** Both actual sides and explanations are produced before any position exists. */
export function researchDirectPlan(s:ForwardState,o:Opportunity,input:Input,previous?:DirectPlan):DirectPlan{
  const memory=s.directStrategy?.memory?.[o.symbol],sameMemory=memory?.id===o.id?memory:null;
  const q=input.quotes[o.symbol],area=sameMemory?.region?.balanced?structuredClone(sameMemory.region):
    previous?.id===o.id&&previous.region?.balanced?structuredClone(previous.region):areaFor(o,input),epsilon=Math.max(input.contracts[o.symbol]?.tickSize??0,
    freshQuote(q,input.now)?q!.bestAsk-q!.bestBid:0,o.price*1e-10),
    proof=confirmAcceptance({area,epsilon,rows:input.paths[o.symbol]??[],now:input.now,after:area?.formedAt??input.now}),
    a=proof&&flowReady(s,o,proof,input.analysisQuotes?.[o.symbol]??q,input.now)?proof:null,
    seen=sameMemory?.continuationSeen||previous?.id===o.id&&previous.continuationSeen||!!a,
    branch=a?'CONTINUATION' as const:'RETURN' as const,side=a?.side??opposite(o.side),
    g=a&&freshQuote(q,input.now)&&input.contracts[o.symbol]?directContinuationGeometry(s,o,a,q!,input.contracts[o.symbol]!):null,
    push=o.side==='LONG'?'上涨':'下跌',reason=a?(g?.reason??'等待当前执行盘口与合约规格'):
      seen?'本次推进已出现趋势接受，等待当前趋势确认恢复，不重新建立回退仓':
        `${o.symbol.replace('_',' / ')}的${push}已形成可观察推进；尚未确认区域外持续延续，评估${side==='LONG'?'做多等待反弹':'做空等待回落'}`;
  if(s.directStrategy){const cache=s.directStrategy.memory??={};cache[o.symbol]={id:o.id,region:structuredClone(area),continuationSeen:!!seen};
    for(const key of Object.keys(cache).slice(0,Math.max(0,Object.keys(cache).length-30)))delete cache[key];}
  return{id:o.id,symbol:o.symbol,at:input.now,quoteAt:q?.observedAt??0,branch,side,phase:a?(g?.valid?'READY':'WAIT_LOCATION'):'VALIDATING',
    reason,holdReason:branch==='RETURN'?'保留正常浮亏空间，等待这次推进衰减；持续趋势确认将否定回退依据':'回踩承接与区域外推进仍成立，保留趋势仓',
    exitCondition:branch==='RETURN'?'回退兑现、推进衰减确认结束，或本币持续趋势确认使回退依据失效':'结构保护被触及、区域接受失败，或本币持有依据持续失效',
    confirmation:a,region:area,candidate:structuredClone(o),continuationSeen:!!seen,consumed:previous?.id===o.id&&previous.consumed};
}
function currentRisk(t:Trade,quotes:Record<string,Quote>){
  const q=quotes[t.symbol],p=q?mark(t.side,q):t.lastPrice;
  return Math.max(t.plannedRisk,t.quantity*(Math.max(0,-sign(t.side)*(p-t.entryPrice))+p*FEE));
}
export function openDirectPlan(s:ForwardState,p:DirectPlan,q:Quote,c:Contract,now:number,quotes:Record<string,Quote>,predecessor?:Trade,minutePath?:NonNullable<Input['minutePaths']>[string]){
  if(!finitePositive(c.quantoMultiplier)||!finitePositive(c.leverageMax)||!Number.isFinite(c.maintenanceRate))return'合约规格未确认';
  const o=p.candidate,a=p.confirmation,price=fill(p.side,q),
    g=p.branch==='CONTINUATION'&&a?directContinuationGeometry(s,o,a,q,c):null,
    geometry=o.winnerPlan,movePrice=fill(o.side,q),width=geometry?Math.abs(movePrice-geometry.initialStop)/movePrice:o.stopRate,
    riskRate=g?.riskRate??Math.max(.004,width)+COST,
    wanted=1000*(geometry?.intent==='RANGE'?.003:o.premium?.0065:.0055)*Math.max(.70,Math.min(1,o.environmentRiskScale??1)),
    markNow=forwardEquity(s,quotes,now),equity=markNow.equity,used=s.positions.reduce((n,t)=>n+currentRisk(t,quotes),0),
    sameRisk=s.positions.filter(t=>t.side===p.side).reduce((n,t)=>n+currentRisk(t,quotes),0),
    cycle=s.positions.concat(s.history).filter(t=>t.openedAt>=s.lastCandleAt).reduce((n,t)=>n+(t.realization?.initialRisk??t.plannedRisk),0),
    trendRisk=s.positions.filter(t=>t.side===p.side&&t.unified?.branch==='CONTINUATION').reduce((n,t)=>n+currentRisk(t,quotes),0),
    riskBudget=Math.min(wanted,1000*.015-cycle,equity*.099-used,equity*.0645-sameRisk,p.branch==='CONTINUATION'?equity*.025-trendRisk:Infinity),
    basePrice=p.branch==='RETURN'?movePrice:price,min=Math.max(1,Math.ceil(c.minContracts??Number(c.orderSizeMin??1))),
    contracts=Math.floor(Math.min(1000*.70,riskBudget/riskRate)/(basePrice*c.quantoMultiplier)),quantity=contracts*c.quantoMultiplier,
    leverage=g?.leverage??Math.max(1,Math.min(5,Math.floor(c.leverageMax/2))),notional=quantity*price,margin=notional/leverage;
  if(!freshQuote(q,now)||q.entryReady!==true)return'等待实时执行盘口';
  if(o.completedAt>now||o.expiresAt<=now)return'交易事件尚未完成或已失效';
  if(s.positions.some(t=>t.symbol===o.symbol)||s.positions.length>=10)return'已有持仓或当前组合容量已满';
  if(p.consumed||s.consumedTheses[o.id])return'本次交易事件已经执行，不重复开仓';
  if(p.branch==='RETURN'&&(!geometry||p.continuationSeen))return'当前推进已确认延续或缺少原回退几何依据';
  if(p.branch==='CONTINUATION'&&!g?.valid)return g?.reason??'等待本币持续趋势确认';
  if(p.branch==='RETURN'&&(width<.004||width>.035||sign(o.side)*(movePrice-geometry!.initialStop)<=0))return'回退事件的初始空间无效';
  const remainingMove=o.netRemainingSpaceRate-Math.max(0,sign(o.side)*(movePrice/o.price-1));
  if(p.branch==='RETURN'&&!executionValueAtQuote({remainingNetRate:remainingMove,pullbackRiskRate:o.pullbackRiskRate}).executable)
    return'实时入场已消耗剩余空间，等待推进事件重新具备有效位置';
  if(p.branch==='RETURN'&&geometry!.intent==='RANGE'){
    const gross=geometry!.target==null?0:sign(o.side)*(geometry!.target!/movePrice-1);
    if(gross-COST<COST*2||(gross-COST)/(width+COST)<1.25)return'推进事件的有限目标净空间不足';
  }
  const observedAssessment=p.branch==='RETURN'?evaluatePositionIntelligence({now,openedAt:now,side:o.side,
    signedRate:sign(o.side)*(mark(o.side,q)/movePrice-1),peakFavorableRate:0,ageMin:0,firstProfit:false,
    expectedHoldMinutes:Math.max(geometry!.intent==='RANGE'?30:60,Math.round(o.expectedHoldMinutes)),stopRate:Math.max(.004,width),
    entryScore:o.environmentScore??o.score,entryResidual:o.residual??0,entryRelativeStrength:o.relativeStrength??.5,entryRemainingSpaceRate:remainingMove,
    state:s.extremumRegime.symbols[o.symbol],narrative:s.extremumRegime.narrative,quote:q,minutePath,currentPrice:mark(o.side,q),
    liquidity:s.extremumRegime.liquidity?.symbols[o.symbol],entryTradePlan:o.tradePlan,
    entryOrigin:o.liquidityOriginLower!=null&&o.liquidityOriginUpper!=null?{lower:o.liquidityOriginLower,upper:o.liquidityOriginUpper}:null,
    entryTarget:o.liquidityTargetLower!=null&&o.liquidityTargetUpper!=null?{lower:o.liquidityTargetLower,upper:o.liquidityTargetUpper}:null,
    entryBaseline:capturePositionBaseline(o.side,s.extremumRegime.symbols[o.symbol],now),entryResponseValidated:true,
    marketStateAgeMs:Math.max(0,now-s.extremumRegime.updatedAt),costRate:COST}):undefined;
  if(observedAssessment?.entryConflict)return'入场与持仓证据冲突，等待推进事件重新形成持续响应';
  if(markNow.stalePositions||!finitePositive(riskBudget)||riskBudget<1000*(geometry?.intent==='RANGE'?.0015:.0035)
    ||contracts<min||s.positions.reduce((n,t)=>n+t.margin,0)+margin>equity*.75)return'当前账户风险、合约数量或逐仓保证金容量不足';
  if(s.positions.some(t=>t.side===p.side&&o.clusterId&&t.entryContext?.clusterId===o.clusterId))return'同相关组已有同方向主仓';
  if(!predecessor&&now-(s.lastExitAt[o.symbol]??0)<15*60_000&&s.lastSide[o.symbol]===p.side)return'同币同方向事件尚未重置';
  const id=`ue-d${now.toString(36)}-${o.symbol}-${p.branch==='RETURN'?'r':'c'}`,stop=g?.stop??geometry!.initialStop,
    winnerPlan:WinnerPlan=g?{version:WINNER_POLICY_VERSION,intent:'TREND',eventAt:now,initialStop:g.stop,target:g.target,targetArea:null,
      origin:structuredClone(p.region),riskGroup:`direct:${o.clusterId??o.symbol}:${p.side}`,source:'RELATIVE_CORE'}:structuredClone(geometry!);
  const u:NonNullable<Trade['unified']>={version:DIRECT_STRATEGY_VERSION,branch:p.branch,sourceId:o.id,referenceId:o.id,region:structuredClone(p.region??winnerPlan.origin),
      epsilon:a?.epsilon??0,confirmation:structuredClone(a),initialStop:g?.stop??null,referenceContracts:contracts,
      entryReason:p.reason,holdReason:p.holdReason,exitCondition:p.exitCondition,lastDecisionAt:now,lastBarAt:0,decision:'HOLD' as const,
      explanationEvents:[{at:now,kind:'ENTRY' as const,reason:p.reason,price,quoteAt:q.observedAt}],
      ...(predecessor?{predecessorId:predecessor.id,predecessorNet:predecessor.netPnl!}:{}),
      ...(p.branch==='RETURN'?{returnLogic:{moveSide:o.side,entryPrice:movePrice,openedAt:now,peakAdvance:0,firstAdvanceAt:null,
        plan:structuredClone(geometry!),entryResidual:o.residual??0,entryRelativeStrength:o.relativeStrength??.5,
        entryRemainingSpaceRate:remainingMove,entryScore:o.environmentScore??o.score,validated:true,assessment:observedAssessment} satisfies ReturnLogic}:{})};
  const t:Trade={id,symbol:o.symbol,side:p.side,status:'OPEN',openedAt:now,closedAt:null,entryPrice:price,exitPrice:null,
      quantity,contracts,quantoMultiplier:c.quantoMultiplier,notional,leverage,margin,plannedRisk:notional*riskRate,stopPrice:stop,
      armPrice:g?.target??geometry!.target??stop,lastPrice:mark(p.side,q),lastQuoteAt:q.observedAt,entryFee:notional*FEE,exitFee:0,
      fundingAllowance:0,grossPnl:null,netPnl:null,exitReason:null,favorable:0,adverse:0,firstProfitAt:null,peakPnlRate:0,profitFloorRate:0,
      holdScore:o.score,expectedHoldMinutes:o.expectedHoldMinutes,relationFailureBars:0,lastRelationBar:now,execution:'REAL_QUOTE_PAPER_MODEL',liveEligible:false,
      rule:{id:o.id,signature:`${DIRECT_STRATEGY_VERSION}:${p.branch}`,parentId:null,version:1,createdAt:now,expiresAt:o.expiresAt,status:'EXPERIMENTAL',
        conditions:[],side:p.side,horizon:o.expectedHoldMinutes,stopRate:riskRate,armRate:o.targetRate,givebackRate:.01,exitMode:'REACTION_DECAY',samples:0,
        trainGroups:0,checkGroups:0,estimatedNetRate:o.netRemainingSpaceRate,priorResponse:null,recentResponse:0,standardError:0,reason:p.reason,
        mutation:'CREATE',grammar:DIRECT_STRATEGY_VERSION,liveEligible:false},unified:u,
      entryContext:{version:'adaptive-ten-entry-v1',capturedAt:now,timeframe:'5m',side:p.side,mode:p.branch==='RETURN'?'REVERSAL':'CONTINUATION',
        strategyVersion:DIRECT_STRATEGY_VERSION,reason:p.reason,entryScore:o.score,directionStrength:o.directionStrength,spaceScore:o.spaceScore,
        positionScore:o.positionScore,executionScore:o.executionScore,remainingSpaceRate:g?sign(p.side)*(g.target!/price-1)-2*FEE:o.netRemainingSpaceRate,
        pullbackRiskRate:width,edgeRatio:g?.ratio??o.edgeRatio,expectedHoldMinutes:o.expectedHoldMinutes,marketFit:o.marketFit,regionId:o.regionId,
        clusterId:o.clusterId,thesisId:o.id,thesisSummary:p.reason,invalidationSummary:p.exitCondition,entryResidual:o.residual??0,
        entryRelativeStrength:o.relativeStrength??.5,portfolioRiskCharge:riskBudget,winnerPlan:p.branch==='CONTINUATION'?winnerPlan:undefined,
        tradePlan:p.branch==='CONTINUATION'?'WINNER_TREND':undefined},
      forecast:{remainingNetRate:o.netRemainingSpaceRate,quality:o.score,sizingEquity:1000}};
  s.balance-=t.entryFee;s.fees+=t.entryFee;s.turnover+=notional;s.positions.push(t);s.lastEntryAt[t.symbol]=now;s.lastSide[t.symbol]=t.side;
  s.consumedTheses[o.id]=now;p.consumed=true;p.phase='HOLDING';note(s,t,now,p.reason);
  return undefined;
}
/** Extract the inverse payoff: the original push's failure is a return profit
 * exit; earned push protection is a return-loss recovery exit. Only geometric
 * memory is evaluated, with actual fees booked by the one real PAPER wallet. */
export function manageDirectReturn(s:ForwardState,t:Trade,q:Quote,input:Input){
  if(t.unified?.returnLogic?.pendingExitReason)return closeUnifiedTrade(s,t,q,input.now,t.unified.returnLogic.pendingExitReason,
    '切换前已经确认退出，按当前新鲜成交盘口完成原有退出义务');
  const u=t.unified!,r=u.returnLogic!,now=input.now,d=sign(r.moveSide),px=mark(r.moveSide,q),signed=d*(px/r.entryPrice-1),
    state=s.extremumRegime.symbols[t.symbol],originalRisk=Math.abs(r.plan.initialStop/r.entryPrice-1);
  r.peakAdvance=Math.max(r.peakAdvance,signed);if(!r.firstAdvanceAt&&signed>COST)r.firstAdvanceAt=now;
  const pi=evaluatePositionIntelligence({now,openedAt:r.openedAt,side:r.moveSide,signedRate:signed,peakFavorableRate:r.peakAdvance,
    ageMin:(now-r.openedAt)/60_000,firstProfit:!!r.firstAdvanceAt,expectedHoldMinutes:t.expectedHoldMinutes??180,stopRate:originalRisk,
    entryScore:r.entryScore,entryResidual:r.entryResidual,entryRelativeStrength:r.entryRelativeStrength,entryRemainingSpaceRate:r.entryRemainingSpaceRate,
    state,narrative:s.extremumRegime.narrative,quote:q,minutePath:input.minutePaths?.[t.symbol],currentPrice:px,
    entryTradePlan:r.plan.intent==='TREND'?'WINNER_TREND':'RANGE_REVERSION',previous:r.assessment,entryBaseline:r.assessment?.baseline,
    costRate:COST,marketStateAgeMs:Math.max(0,now-s.extremumRegime.updatedAt),entryResponseValidated:r.validated}),
    trend=!!state&&trendCore({state,side:r.moveSide,price:px,cost:COST,majorScore:s.extremumRegime.narrative.major.score,
      shortScore:s.extremumRegime.narrative.short.score,quote:q}).eligible,
    outcome=advanceWinnerManagement({side:r.moveSide,price:px,entryPrice:r.entryPrice,openedAt:r.openedAt,now,plan:r.plan,
      previous:r.management,currentStop:r.management?.protectedStop??t.stopPrice,rows:input.paths[t.symbol],cost:COST,
      remainingFraction:remainingTradeFraction(t),concernFamilies:pi.concernFamilies,supportFamilies:pi.supportFamilies,
      positionExit:pi.decision==='EXIT'&&(pi.concernFamilies.includes('PATH')||pi.concernFamilies.includes('STRUCTURE')),trendEligible:trend});
    r.assessment=pi;r.management=outcome.state;t.stopPrice=outcome.state.protectedStop;u.lastBarAt=outcome.state.lastBarAt;
  const own=sign(t.side)*(mark(t.side,q)/t.entryPrice-1),boundary=outcome.state.protectedStop;
  u.holdReason=own>=0?'推进正在回退，兑现边界尚未触及，继续等待本次回退完成':
    `推进仍有惯性，暂时容忍浮亏；等待回退至 ${boundary}，同时复核本币是否已成为持续趋势`;
  u.exitCondition=`价格回退至推进退出边界 ${boundary}，或推进衰减已被持续确认；本币趋势接受成立则结束回退评估延续`;
  u.decision=pi.decision==='REVIEW'?'REVIEW':'HOLD';u.lastDecisionAt=now;
  if(outcome.action==='EXIT')return closeUnifiedTrade(s,t,q,now,'RETURN_EVENT_COMPLETE',
    own>=0?'本次推进失去持续依据，回退收益按原衰减退出规则兑现':
      '推进回退触及已建立的退出边界，结束等待；本次回退仓亏损如实结算');
  if(outcome.action==='REDUCE'&&reduceUnifiedTrade(s,t,q,now,outcome.fraction,'RETURN_OBSTACLE_REDUCTION',input.contracts[t.symbol])){
    outcome.state.trimCount++;outcome.state.lastTrimEvent=outcome.state.obstacleSince;
  }
  return false;
}
function manageDirect(s:ForwardState,input:Input,marketReady:boolean){
  const ds=s.directStrategy!,now=input.now,prior=ds.plans;
  if(s.positions.some(t=>!t.unified))drainLegacyForwardPositions(s,input);
  if(marketReady){const plans:Record<string,DirectPlan>={};
    for(const o of s.opportunities.slice(0,30)){
      const p=researchDirectPlan(s,o,input,prior[o.symbol]),held=s.positions.find(t=>t.symbol===o.symbol);
      if(held){p.phase='HOLDING';p.consumed=true;}plans[o.symbol]=p;
    }
    ds.plans=plans;
  }
  for(const t of [...s.positions]){
    if(!t.unified)continue;
    const q=input.quotes[t.symbol];if(!freshQuote(q,now))continue;
    t.lastPrice=mark(t.side,q!);t.lastQuoteAt=q!.observedAt;const signed=sign(t.side)*(t.lastPrice/t.entryPrice-1);
    t.favorable=Math.max(t.favorable,signed);t.adverse=Math.max(t.adverse,-signed);t.peakPnlRate=t.favorable;
    if(!t.firstProfitAt&&signed>2*FEE)t.firstProfitAt=now;
    if(t.unified!.branch==='CONTINUATION'){manageContinuation(s,t,q!,now,input.paths[t.symbol]??[],input.minutePaths?.[t.symbol],input.contracts[t.symbol]);continue;}
    const u=t.unified!,r=u.returnLogic!,region=u.region,epsilon=Math.max(u.epsilon,q!.bestAsk-q!.bestBid,input.contracts[t.symbol]?.tickSize??0),
      a=confirmAcceptance({area:region,epsilon,rows:input.paths[t.symbol]??[],now,after:t.openedAt}),
      candidate=ds.plans[t.symbol]?.candidate,
      confirms=!!a&&a.side!==t.side&&flowReady(s,t,a,input.analysisQuotes?.[t.symbol]??q,now);
    if(confirms){
      if(closeUnifiedTrade(s,t,q!,now,'RETURN_TREND_CONFIRMED','本币已经确认区域外持续趋势，等待回退的依据失效')){
        ds.completedConversions++;
        if(!marketReady||!candidate||!candidate.eligible||!input.contracts[t.symbol])continue;
        const p=researchDirectPlan(s,candidate,input);p.region=structuredClone(region);p.branch='CONTINUATION';p.side=a!.side;p.confirmation=a;p.continuationSeen=true;p.consumed=false;
        // New entry uses current space, own fees/risk and a separate identity.
        delete s.consumedTheses[candidate.id];
        const error=openDirectPlan(s,p,q!,input.contracts[t.symbol]!,now,input.quotes,t);
        if(error){p.phase='WAIT_LOCATION';p.reason=error;p.consumed=true;s.consumedTheses[candidate.id]=now;}ds.plans[t.symbol]=p;
      }
      continue;
    }
    // Freeze a previously absent region only from causally completed data.
    if(!u.region){const area=reactionGeometry(input.paths[t.symbol],now).area;if(area?.balanced)u.region=structuredClone(area);}
    if(!r)throw new Error('回退持仓缺少自身的推进记忆');manageDirectReturn(s,t,q!,input);
  }
  // A confirmed trend can be admitted on its own completed structure; it does
  // not wait for a losing return position or another strategy's OPEN event.
  if(marketReady)for(const p of Object.values(ds.plans).sort((a,b)=>b.candidate.score-a.candidate.score)){
    if(p.branch!=='CONTINUATION'||p.phase!=='READY'||p.consumed||!p.candidate.eligible||s.positions.some(t=>t.openedAt===now))continue;
    const q=input.quotes[p.symbol],c=input.contracts[p.symbol];if(!q||!c)continue;
    const error=openDirectPlan(s,p,q,c,now,input.quotes);if(error){p.phase='WAIT_LOCATION';p.reason=error;}else break;
  }
  ds.summary=`回退持仓 ${s.positions.filter(t=>t.unified?.branch==='RETURN').length} 笔；趋势延续 ${s.positions.filter(t=>t.unified?.branch==='CONTINUATION').length} 笔。按每个币自己的推进、区域接受与剩余空间决定，不跟随全市场统一翻向。`;
}
export function advanceDirectStrategy(input:Input){
  const state=normalizeForward(structuredClone(input.state),input.now),activated=migrateDirectStrategy(state,input.now);
  const adapter:DirectExecutionAdapter={manage:(s,ready)=>manageDirect(s,{...input,state:s},ready),
    open:(s,o,q,c,now,response)=>{
      if(s.positions.some(t=>t.openedAt===now))return'本次执行已建立新仓，下一次继续核对组合容量';
      const p=researchDirectPlan(s,o,{...input,state:s},s.directStrategy!.plans[o.symbol]);s.directStrategy!.plans[o.symbol]=p;
      if(p.branch==='CONTINUATION')return'本币已经进入趋势分支，按当前趋势位置执行';
      const error=openDirectPlan(s,p,q,c,now,input.quotes,undefined,input.minutePaths?.[o.symbol]);
      if(!error){const t=s.positions.at(-1)!;t.entryContext!.entryResponse={version:'direct-entry-response-v2',startedAt:response.validation.startedAt,
        confirmedAt:now,elapsedMs:now-response.validation.startedAt,samples:response.validation.samples,advanceRate:response.decision.currentAdvanceRate,
        bestAdvanceRate:response.decision.bestAdvanceRate,maxAdverseRate:response.decision.maxAdverseRate,supportFamilies:response.decision.supportFamilies,fastLane:response.decision.fastLane};}
      return error;
    }};
  const next=advanceForward({...input,state,directAdapter:adapter,allocationEquity:1000});
  next.state.latestReason=next.state.directStrategy!.summary;
  next.protectionChanged=next.protectionChanged||forwardProtectionChanged(input.state,next.state);
  next.changed=next.changed||activated;
  return next;
}
