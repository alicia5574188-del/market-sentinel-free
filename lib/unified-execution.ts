/** One frozen decision/reference evaluation; direct side-correct actual intents.
 * No network, clocks, reset, LIVE controls or inverse-to-reference feedback.
 * Existing holdings drain unchanged. Only post-cutover intents use this policy.
 */
import {advanceShadowInverse} from './shadow-inverse.ts';
import {normalizeForward,forwardEquity,type ForwardState,type Trade,type Quote,type Contract,type Candle} from './forward-relations.ts';
import {shadowCapsule,SHARED_MARKET_KEYS,inverseTrialSummary} from './shadow-inverse-ledger.ts';
import {INVERSE_COST} from './inverse-fee.ts';
import {closedFiveMinutes,reactionGeometry,advanceWinnerManagement,WINNER_POLICY_VERSION,type ReactionArea} from './winner-policy.ts';
import {evaluatePositionIntelligence} from './position-intelligence-engine.ts';
import {realizeTradeSlice} from './trade-realization.ts';
import {beijingDayKey} from './beijing-time.ts';
import {UNIFIED_EXECUTION_VERSION,type Acceptance,type UnifiedEpisode,type UnifiedBranch} from './unified-execution-types.ts';
export {UNIFIED_EXECUTION_VERSION} from './unified-execution-types.ts';

const d=(side:'LONG'|'SHORT')=>side==='LONG'?1:-1;
const fee=INVERSE_COST.feeRate,cost=fee*2;
const positive=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>0;
const fresh=(q:Quote|undefined,now:number):q is Quote=>!!q&&q.fresh&&positive(q.bestBid)&&q.bestAsk>=q.bestBid
  &&q.observedAt<=now&&now-q.observedAt<=10_000;
const enter=(side:Trade['side'],q:Quote)=>side==='LONG'?q.bestAsk:q.bestBid;
const exit=(side:Trade['side'],q:Quote)=>side==='LONG'?q.bestBid:q.bestAsk;
const validArea=(a:ReactionArea|null|undefined):a is ReactionArea=>!!a&&a.balanced&&positive(a.lower)&&a.upper>a.lower
  &&Number.isFinite(a.formedAt);

export function unifiedReferenceState(s:ForwardState):ForwardState{
  if(!s.unifiedExecution)return s;
  const ref={...s.unifiedExecution.reference,inverseTrial:s.inverseTrial} as ForwardState;
  for(const key of SHARED_MARKET_KEYS)Object.assign(ref,{[key]:s[key]});
  return ref;
}
/** Two causally completed, consecutive bars. A failed acceptance resets the
 * attempt; a new bar cannot reuse an old breakout across an intervening failure.
 */
export function confirmAcceptance(input:{area:ReactionArea|null;epsilon:number;rows:Candle[];now:number;after:number}):Acceptance|null{
  const a=input.area;if(!validArea(a)||a.formedAt>input.now)return null;
  const rows=closedFiveMinutes(input.rows,input.now).filter(r=>r.time*1000>=Math.max(a.formedAt,input.after)),e=input.epsilon;
  if(rows.length&&input.now-(rows.at(-1)!.time*1000+300_000)>600_000)return null;
  let result:Acceptance|null=null;
  for(const side of ['LONG','SHORT'] as const){
    let sideResult:Acceptance|null=null;
    const sign=d(side),boundary=side==='LONG'?a.upper:a.lower;
    let first:Candle|null=null,previous:Candle|null=null,retest:Candle|null=null;
    for(const r of rows){
      if(previous&&r.time-previous.time!==300){first=null;retest=null;sideResult=null;}
      if(sign*(r.close-boundary)<=e){first=null;retest=null;sideResult=null;previous=r;continue;}
      if(first){
        const holds=side==='LONG'?r.low>boundary:r.high<boundary;
        const advances=!!previous&&r.time-previous.time===300&&sign*(r.close-previous.close)>e;
        const restart=retest&&r.time-retest.time===300&&sign*(r.close-(side==='LONG'?retest.high:retest.low))>e;
        if(holds&&advances||restart){
          const basis=retest&&restart?retest:previous!;
          const candidate:Acceptance={side,at:r.time*1000+300_000,bars:[basis.time*1000,r.time*1000],
            path:restart?'RETEST_RESTART':'HOLD_OUTSIDE',boundary,epsilon:e,
            stop:(side==='LONG'?basis.low:basis.high)-sign*e};
          if(!sideResult||candidate.at>=sideResult.at)sideResult=candidate;
        }
        const touches=side==='LONG'?r.low<=boundary+e:r.high>=boundary-e;
        if(touches){retest=r;first=r;}
      }else first=r;
      previous=r;
    }
    // A confirmation is usable only while the latest completed close still
    // accepts this same direction. Do not retain an earlier direction's result.
    if(sideResult&&(!result||sideResult.at>=result.at))result=sideResult;
  }
  return result;
}

function audit(s:ForwardState,t:Trade,now:number,kind:'ENTRY'|'EXIT'|'PROTECTION',reason:string){
  s.events.unshift({id:`a${s.startedAt}-${++s.revision}`,at:now,kind,subject:t.id,reason,
    detail:{strategy:t.unified?.version??UNIFIED_EXECUTION_VERSION,branch:t.unified?.branch??'LEGACY',sourceId:t.unified?.sourceId??null}});
  s.events=s.events.slice(0,160);
}
function explain(t:Trade,now:number,kind:'ENTRY'|'CONFIRM'|'REDUCE'|'EXIT',reason:string){
  const u=t.unified!;u.lastDecisionAt=now;
  u.explanationEvents.push({at:now,kind,reason,price:t.lastPrice,quoteAt:t.lastQuoteAt});
  // Each lifecycle has at most two trims, one confirmation and one exit.
  if(u.explanationEvents.length>8)throw new Error('统一策略事件身份重复，禁止截断资金证据');
}
export function closeUnifiedTrade(s:ForwardState,t:Trade,q:Quote,now:number,reason:string,detail:string,administrative=false){
  if(t.status!=='OPEN'||(!administrative&&!fresh(q,now)))return false;
  if(!positive(q.bestBid)||!positive(q.bestAsk)||q.bestAsk<q.bestBid)return false;
  const price=exit(t.side,q),gross=d(t.side)*t.quantity*(price-t.entryPrice),paid=t.quantity*price*fee,r=t.realization;
  t.status='CLOSED';t.closedAt=now;t.exitPrice=price;t.lastPrice=price;t.lastQuoteAt=q.observedAt;
  t.grossPnl=gross+(r?.gross??0);t.exitFee=paid+(r?.fees??0);t.fundingAllowance=0;t.netPnl=t.grossPnl-t.entryFee-t.exitFee;
  t.exitReason=reason;t.unified!.decision='EXIT';t.unified!.holdReason=detail;explain(t,now,'EXIT',detail);
  t.exitAudit={trigger:reason,at:now,detail,evidence:{authority:t.unified!.version,branch:t.unified!.branch,
    sourceId:t.unified!.sourceId,quoteAt:q.observedAt,administrative,quoteFresh:fresh(q,now),stop:t.stopPrice,confirmationAt:t.unified!.confirmation?.at??null}};
  s.balance+=gross-paid;s.grossPnl+=gross;s.fees+=paid;s.turnover+=t.quantity*price;s.resolved++;if(t.netPnl>0)s.wins++;
  if(r)Object.assign(t,{quantity:r.initialQuantity,contracts:r.initialContracts,notional:r.initialNotional,margin:r.initialMargin,plannedRisk:r.initialRisk});
  s.positions=s.positions.filter(p=>p.id!==t.id);s.history.unshift(t);s.history=s.history.slice(0,240);s.lastExitAt[t.symbol]=now;
  audit(s,t,now,'EXIT',detail);return true;
}
/** RETURN honors an original committed reduction even when it realizes a loss.
 * The frozen source helper remains byte-for-byte unchanged; CONTINUATION still
 * uses its existing profitable partial-realization policy. */
function realizeReturnSlice(i:Parameters<typeof realizeTradeSlice>[0]){
  const t=i.trade;
  if(t.status!=='OPEN'||!fresh({bestBid:i.price,bestAsk:i.price,observedAt:i.quoteAt,fresh:true},i.now)
    ||!positive(i.minContracts)||!positive(i.fraction)||i.fraction>=1||(t.realization?.sequence??0)>=2)return null;
  const contracts=Math.floor((t.contracts*i.fraction+1e-10)/i.minContracts)*i.minContracts,
    initial=t.realization??{version:'partial-realization-v1' as const,initialQuantity:t.quantity,initialContracts:t.contracts,
      initialNotional:t.notional,initialMargin:t.margin,initialRisk:t.plannedRisk,initialEntryFee:t.entryFee,
      gross:0,fees:0,funding:0,sequence:0,fills:[]};
  if(contracts<i.minContracts||t.contracts-contracts<i.minContracts-1e-9||(t.contracts-contracts)/initial.initialContracts<.35-1e-9)return null;
  const quantity=t.quantity*contracts/t.contracts,gross=d(t.side)*quantity*(i.price-t.entryPrice),paid=quantity*i.price*fee;
  if(![gross,paid,quantity].every(Number.isFinite))return null;
  t.realization={...initial,gross:initial.gross+gross,fees:initial.fees+paid,sequence:initial.sequence+1,
    fills:[...initial.fills,{sequence:initial.sequence+1,at:i.now,quoteAt:i.quoteAt,price:i.price,contracts,quantity,gross,fee:paid,funding:0,reason:i.reason}]};
  t.contracts-=contracts;t.quantity-=quantity;t.notional=t.quantity*t.entryPrice;t.margin=t.notional/t.leverage;
  t.plannedRisk=initial.initialRisk*t.contracts/initial.initialContracts;
  return{gross,fee:paid,funding:0,notional:quantity*t.entryPrice,exitNotional:quantity*i.price,credit:gross-paid,contracts};
}
function reduce(s:ForwardState,t:Trade,q:Quote,now:number,fraction:number,reason:string,contract?:Contract){
  const input={trade:t,price:exit(t.side,q),now,quoteAt:q.observedAt,fraction,feeRate:fee,
    fundingPerDay:0,minContracts:contract?.minContracts??Number(contract?.orderSizeMin??1),reason},
    r=t.unified?.branch==='RETURN'?realizeReturnSlice(input):realizeTradeSlice(input);
  if(!r)return false;
  s.balance+=r.credit;s.grossPnl+=r.gross;s.fees+=r.fee;s.turnover+=r.exitNotional;
  explain(t,now,'REDUCE',reason);audit(s,t,now,'PROTECTION',reason);return true;
}
function supportsFlow(s:ForwardState,symbol:string,side:Trade['side'],q:Quote|undefined,now:number){
  const v=s.extremumRegime.symbols[symbol];
  return fresh(q,now)&&s.extremumRegime.updatedAt<=now&&now-s.extremumRegime.updatedAt<=10_000
    &&!!v&&v.dataConfidence>=60&&v.sourceCount>=2&&(q.sourceCount??0)>=2&&d(side)*v.venuePressure>0;
}
export function continuationGeometry(s:ForwardState,source:Trade,a:Acceptance,q:Quote,contract:Contract|undefined){
  const price=enter(a.side,q),sign=d(a.side),risk=sign*(price-a.stop),quantity=source.quantity,
    leverage=source.leverage/2,notional=quantity*price,
    plan=source.inverseCopy?.sourceEntryPlan?.winnerPlan,
    liquidity=s.extremumRegime.liquidity?.symbols[source.symbol],zone=a.side==='LONG'?liquidity?.nextAbove:liquidity?.nextBelow,
    targets=[plan?.target,zone?(a.side==='LONG'?zone.lower:zone.upper):null].filter((p):p is number=>positive(p)&&sign*(p-price)>0),
    target=targets.length?targets.sort((x,y)=>sign*(x-y))[0]!:null,
    riskU=quantity*(risk+(price+a.stop)*fee),budget=source.realization?.initialRisk??source.plannedRisk,
    remaining=target==null?0:sign*(target-price)-(price+target)*fee,
    ratio=remaining/Math.max(risk+(price+a.stop)*fee,1e-12);
  const valid=positive(risk)&&a.stop>0&&target!=null&&riskU<=budget+1e-8&&ratio>=1.35
    &&!!contract&&leverage>=1&&leverage<=contract.leverageMax
    &&1/leverage>risk/price+contract.maintenanceRate+cost;
  return{valid,price,stop:a.stop,target,riskU,budget,ratio,leverage,notional,
    reason:!positive(risk)?'新成交价与结构边界之间没有有效风险空间':target==null?'缺少当时可核对的下一结构障碍'
      :riskU>budget?'当前新边界风险超过原候选预算':ratio<1.35?'扣费后的剩余空间不足以覆盖新风险'
      :!valid?'合约或逐仓保证金余量不满足':'新结构风险与成本后空间允许建立延续仓'};
}
function openRisk(t:Trade,quotes:Record<string,Quote>){
  const q=quotes[t.symbol],price=q?exit(t.side,q):t.lastPrice;
  return Math.max(t.plannedRisk,t.quantity*(Math.max(0,-d(t.side)*(price-t.entryPrice))+price*fee));
}
function open(s:ForwardState,reference:Trade,e:UnifiedEpisode,branch:UnifiedBranch,q:Quote,now:number,
  contract:Contract|undefined,quotes:Record<string,Quote>,predecessor?:Trade){
  const a=e.confirmation,geometry=branch==='CONTINUATION'&&a?continuationGeometry(s,reference,a,q,contract):null;
  if(branch==='CONTINUATION'&&!geometry?.valid){e.reason=geometry?.reason??'尚无有效延续确认';return null;}
  const side=branch==='RETURN'?reference.side:a!.side,price=enter(side,q),leverage=reference.leverage/2,
    quantity=reference.quantity,notional=quantity*price,margin=notional/leverage,
    risk=geometry?.riskU??reference.plannedRisk,mark=forwardEquity(s,quotes,now),equity=Math.max(0,mark.equity),
    portfolioRisk=s.positions.reduce((n,t)=>n+openRisk(t,quotes),0),directionRisk=s.positions.filter(t=>t.side===side).reduce((n,t)=>n+openRisk(t,quotes),0),
    usedMargin=s.positions.reduce((n,t)=>n+t.margin,0),maintenance=contract?.maintenanceRate;
  if(!contract||!positive(quantity)||leverage<1||leverage>contract.leverageMax||maintenance==null
    ||mark.stalePositions>0||s.positions.some(t=>t.symbol===reference.symbol)||portfolioRisk+risk>equity*.10+1e-8
    ||directionRisk+risk>equity*.065+1e-8||usedMargin+margin>equity*.75+1e-8){
    e.reason='已有持仓或账户风险/逐仓保证金容量不允许新增，保留未成交事实';return null;
  }
  const id=`ue-${e.sourceId}-${branch==='RETURN'?'r':'c'}`,stop=geometry?.stop??reference.stopPrice,
    entryReason=branch==='RETURN'?`原追随入场触发，当前未确认区域外延续；按回退分支${side==='LONG'?'做多':'做空'}，等待这次推进衰减`:
      `该标的${side==='LONG'?'向上':'向下'}突破后${a!.path==='RETEST_RESTART'?'回踩成功并再次推进':'保持在原区域外并继续推进'}；新风险与剩余空间合格`,
    condition=branch==='RETURN'?'原追随仓的防守、减仓与持有价值退出事件；若本币反方向延续确认成立则提前结束回退':
      `触及新结构保护 ${stop}、重新进入原区域后未能恢复，或本币持有价值持续失效`,
    t:Trade={...structuredClone(reference),id,side,openedAt:now,closedAt:null,status:'OPEN',entryPrice:price,exitPrice:null,
      quantity,contracts:reference.contracts,notional,leverage,margin,plannedRisk:risk,stopPrice:stop,armPrice:geometry?.target??reference.armPrice,
      lastPrice:exit(side,q),lastQuoteAt:q.observedAt,entryFee:notional*fee,exitFee:0,fundingAllowance:0,grossPnl:null,netPnl:null,exitReason:null,
      favorable:0,adverse:0,firstProfitAt:null,profitFloorRate:0,peakPnlRate:0,
      rule:{...reference.rule,id,side,reason:entryReason,stopRate:geometry?Math.abs(price-stop)/price:reference.rule.stopRate},
      entryContext:reference.entryContext?{...structuredClone(reference.entryContext),side,capturedAt:now,strategyVersion:UNIFIED_EXECUTION_VERSION,
        reason:entryReason,thesisId:id,thesisSummary:entryReason,invalidationSummary:condition}:undefined,
      unified:{version:UNIFIED_EXECUTION_VERSION,branch,sourceId:e.sourceId,referenceId:reference.id,region:structuredClone(e.region),epsilon:e.epsilon,
        confirmation:branch==='CONTINUATION'?structuredClone(a):null,initialStop:geometry?.stop??null,referenceContracts:reference.contracts,
        entryReason,holdReason:entryReason,exitCondition:condition,lastDecisionAt:now,lastBarAt:0,decision:'HOLD',
        ...(predecessor?{predecessorId:predecessor.id,predecessorNet:predecessor.netPnl!}:{}),explanationEvents:[]}};
  for(const key of ['inverseCopy','review','winnerManagement','positionIntelligence','realization','holdValue','liquidityLifecycle',
    'profitLifecycle','profitProtection','profitProtectionMigration','exitAudit','exitPlan'] as const)delete t[key];
  if(t.entryContext){delete t.entryContext.winnerPlan;if(geometry)t.entryContext.winnerPlan={version:WINNER_POLICY_VERSION,intent:'TREND',
    eventAt:now,initialStop:geometry.stop,target:geometry.target,targetArea:null,origin:structuredClone(e.region),
    riskGroup:`unified:${t.symbol}:${side}`,source:'RELATIVE_CORE'};}
  if(t.entryContext&&geometry){const state=s.extremumRegime.symbols[t.symbol];
    Object.assign(t.entryContext,{mode:'CONTINUATION',tradePlan:'WINNER_TREND',entryResidual:state?.residual??0,
      entryRelativeStrength:state?.relativeStrength??.5,remainingSpaceRate:d(side)*(geometry.target!/price-1)-cost,
      pullbackRiskRate:Math.abs(price-stop)/price,edgeRatio:geometry.ratio,portfolioRiskCharge:risk,
      postEntryState:'PENDING',thesisSince:now,thesisBars:0});
    t.forecast={remainingNetRate:t.entryContext.remainingSpaceRate,quality:t.entryContext.entryScore,sizingEquity:1000};
  }
  s.balance-=t.entryFee;s.fees+=t.entryFee;s.turnover+=notional;s.positions.push(t);s.lastEntryAt[t.symbol]=now;
  explain(t,now,'ENTRY',entryReason);audit(s,t,now,'ENTRY',entryReason);e.handled=true;e.reason=entryReason;
  return t;
}
function syncLegacy(s:ForwardState,ref:ForwardState,now:number){
  const rows=new Map([...ref.positions,...ref.history].map(t=>[t.id,t]));
  for(const old of [...s.positions].filter(t=>!t.unified)){
    const next=rows.get(old.id);if(!next)throw new Error('原持仓参考缺失；保留账户，禁止猜测退出');
    const oldGross=old.realization?.gross??0,oldFees=old.realization?.fees??0,oldFunding=old.realization?.funding??0,
      newGross=next.status==='CLOSED'?next.grossPnl!:next.realization?.gross??0,
      newFees=next.status==='CLOSED'?next.exitFee:next.realization?.fees??0,
      newFunding=next.status==='CLOSED'?next.fundingAllowance:next.realization?.funding??0;
    const dg=newGross-oldGross,df=newFees-oldFees,du=newFunding-oldFunding;
    s.balance+=dg-df-du;s.grossPnl+=dg;s.fees+=df;s.fundingAllowance+=du;
    const newFills=next.inverseCopy?.fills.slice(old.inverseCopy?.fills.length??0)??[],
      slices=next.realization?.fills.slice(old.realization?.sequence??0)??[],
      turnover=newFills.length?newFills.reduce((n,f)=>n+f.quantity*f.price,0):
        slices.reduce((n,f)=>n+f.quantity*f.price,0)+(next.status==='CLOSED'?(old.quantity-slices.reduce((n,f)=>n+f.quantity,0))*next.exitPrice!:0);
    s.turnover+=turnover;
    s.positions=s.positions.filter(t=>t.id!==old.id);
    if(next.status==='CLOSED'){s.history.unshift(structuredClone(next));s.resolved++;if(next.netPnl!>0)s.wins++;
      audit(s,next,now,'EXIT','旧持仓按原规则结束');}
    else {s.positions.push(structuredClone(next));if(dg||df) audit(s,next,now,'PROTECTION','旧持仓按原规则减仓');}
  }
  s.history=s.history.slice(0,240);
}
export function manageContinuation(s:ForwardState,t:Trade,q:Quote,now:number,rows:Candle[],minuteRows:Candle[]|undefined,contract?:Contract){
  const u=t.unified!,sign=d(t.side),price=exit(t.side,q),plan=t.entryContext!.winnerPlan!,closed=closedFiveMinutes(rows,now);
  if(sign*(price-t.stopPrice)<=0)return closeUnifiedTrade(s,t,q,now,'CONTINUATION_STRUCTURE_EXIT','新延续仓的结构保护边界被触及');
  const boundary=t.side==='LONG'?u.region!.upper:u.region!.lower,last=closed.slice(-2);
  if(last.length===2&&last[1]!.time-last[0]!.time===300&&last.every(r=>r.time*1000>=t.openedAt&&sign*(r.close-boundary)<=u.epsilon))
    return closeUnifiedTrade(s,t,q,now,'CONTINUATION_ACCEPTANCE_FAILED','连续完整收盘回到原区域，未恢复推进');
  const symbol=s.extremumRegime.symbols[t.symbol],pi=evaluatePositionIntelligence({now,side:t.side,signedRate:sign*(price/t.entryPrice-1),
    peakFavorableRate:t.favorable,ageMin:(now-t.openedAt)/60_000,firstProfit:!!t.firstProfitAt,expectedHoldMinutes:t.expectedHoldMinutes??180,
    stopRate:Math.abs(plan.initialStop/t.entryPrice-1),entryScore:t.entryContext!.entryScore,
    entryResidual:t.entryContext!.entryResidual??0,entryRelativeStrength:t.entryContext!.entryRelativeStrength??.5,
    entryRemainingSpaceRate:t.entryContext!.remainingSpaceRate,state:symbol,narrative:s.extremumRegime.narrative,
    quote:q,minutePath:minuteRows,previous:t.positionIntelligence,costRate:cost,openedAt:t.openedAt,currentPrice:price,
    marketStateAgeMs:now-s.extremumRegime.updatedAt});
  t.positionIntelligence=pi;t.holdScore=pi.holdValueScore;u.decision=pi.decision;
  const result=advanceWinnerManagement({side:t.side,price,entryPrice:t.entryPrice,openedAt:t.openedAt,now,plan,
    previous:t.winnerManagement,currentStop:t.stopPrice,rows,cost,remainingFraction:t.realization?t.quantity/t.realization.initialQuantity:1,
    concernFamilies:pi.concernFamilies,supportFamilies:pi.supportFamilies,
    positionExit:pi.decision==='EXIT'&&(pi.concernFamilies.includes('PATH')||pi.concernFamilies.includes('STRUCTURE')),
    trendEligible:supportsFlow(s,t.symbol,t.side,q,now),quote:q,exitBasis:pi.exitBasis});
  t.winnerManagement=result.state;t.stopPrice=result.state.protectedStop;
  u.holdReason=pi.decision==='REVIEW'?`结构保护尚未触及；本币出现矛盾，继续复核：${pi.summary}`:'结构保护尚未触及；推进依据未被持续价格反证否定';
  u.lastDecisionAt=now;u.lastBarAt=closed.at(-1)?closed.at(-1)!.time*1000+300_000:0;
  u.exitCondition=`触及新保护 ${t.stopPrice}、区域接受失败，或本币持有依据持续失效`;
  if(result.action==='EXIT')return closeUnifiedTrade(s,t,q,now,result.reason,result.state.reason);
  if(result.action==='REDUCE'&&reduce(s,t,q,now,result.fraction,result.reason,contract)){
    result.state.trimCount++;result.state.lastTrimEvent=result.state.obstacleSince;
  }
  return false;
}
/** Pure post-reference adapter, exported for deterministic lifecycle tests. */
export function applyUnifiedReference(s:ForwardState,ref:ForwardState,input:{now:number;quotes:Record<string,Quote>;
  analysisQuotes?:Record<string,Quote>;paths:Record<string,Candle[]>;minutePaths?:Record<string,Candle[]>;contracts:Record<string,Contract>}){
  const v=s.unifiedExecution!,now=input.now;syncLegacy(s,ref,now);
  const references=[...ref.positions,...ref.history].filter(t=>t.inverseCopy&&t.openedAt>=v.cutoverAt),byId=new Map(references.map(t=>[t.inverseCopy!.sourceId,t]));
  for(const reference of ref.positions.filter(t=>t.inverseCopy&&t.openedAt>=v.cutoverAt)){
    const sourceId=reference.inverseCopy!.sourceId,q=input.quotes[reference.symbol];
    let e=v.episodes[sourceId];
    if(!e){const original=reference.inverseCopy!.sourceEntryPlan?.winnerPlan?.origin,fallback=reactionGeometry(input.paths[reference.symbol],now).area,
      area=validArea(original)&&original.formedAt<=reference.openedAt?original:validArea(fallback)?fallback:null;
      e=v.episodes[sourceId]={sourceId,symbol:reference.symbol,createdAt:now,region:structuredClone(area),
        epsilon:fresh(q,now)?Math.max(q.bestAsk-q.bestBid,input.contracts[reference.symbol]?.tickSize??0,reference.entryPrice*1e-10):0,
        handled:false,converted:false,ended:false,confirmation:null,lastBarAt:0,reason:'等待有效实际方向盘口'};}
    if(!fresh(q,now)||e.ended)continue;
    const completed=closedFiveMinutes(input.paths[reference.symbol],now).at(-1);
    e.lastBarAt=completed?completed.time*1000+300_000:0;
    // An absent initial balanced region may be established by later completed
    // data. Freeze it once; do not roll boundaries to manufacture acceptance.
    if(!e.region){const area=reactionGeometry(input.paths[reference.symbol],now).area;if(validArea(area)){e.region=structuredClone(area);e.createdAt=now;}}
    e.epsilon=Math.max(e.epsilon,q.bestAsk-q.bestBid,input.contracts[reference.symbol]?.tickSize??0,reference.entryPrice*1e-10);
    const a=confirmAcceptance({area:e.region,epsilon:e.epsilon,rows:input.paths[reference.symbol]??[],now,
      after:e.handled?reference.openedAt:e.region?.formedAt??now}),flow=input.analysisQuotes?.[reference.symbol]??q;
    e.confirmation=a&&supportsFlow(s,reference.symbol,a.side,flow,now)?a:null;
    if(e.confirmation)e.continuationSeen=true;
    if(!e.handled){
      if(e.confirmation){open(s,reference,e,'CONTINUATION',q,now,input.contracts[reference.symbol],input.quotes);}
      else if(!e.continuationSeen)open(s,reference,e,'RETURN',q,now,input.contracts[reference.symbol],input.quotes);
      else e.reason='本事件已识别延续，等待当前有效确认与进场位置，不重复建立回退仓';
    }
  }
  for(const t of [...s.positions].filter(t=>t.unified)){
    const u=t.unified!,q=input.quotes[t.symbol],e=v.episodes[u.sourceId],reference=byId.get(u.sourceId);
    if(reference?.status==='CLOSED'){u.referenceClosedAt=reference.closedAt!;u.referenceExitReason=reference.exitReason;}
    if(!fresh(q,now))continue;
    t.lastPrice=exit(t.side,q);t.lastQuoteAt=q.observedAt;
    const signed=d(t.side)*(t.lastPrice/t.entryPrice-1);t.favorable=Math.max(t.favorable,signed);t.adverse=Math.max(t.adverse,-signed);
    t.peakPnlRate=t.favorable;if(!t.firstProfitAt&&signed>cost)t.firstProfitAt=now;
    if(u.branch==='CONTINUATION'){if(manageContinuation(s,t,q,now,input.paths[t.symbol]??[],input.minutePaths?.[t.symbol],input.contracts[t.symbol]))e.ended=true;continue;}
    if(u.referenceClosedAt){
      if(closeUnifiedTrade(s,t,q,now,'RETURN_REFERENCE_EXIT',`本次推进的原持有依据已结束：${u.referenceExitReason??'原生命周期结束'}；回退仓同步退出`))e.ended=true;
      continue;
    }
    // Accepted movement invalidates a RETURN only when it moves against the
    // actual return side. A same-side breakout is not a reason to reverse it.
    if(e?.confirmation&&e.confirmation.side!==t.side&&!e.converted&&reference){
      u.confirmation=structuredClone(e.confirmation);u.region=structuredClone(e.region);explain(t,now,'CONFIRM','本币突破后已形成持续区域外推进，原等待回退依据失效');
      if(closeUnifiedTrade(s,t,q,now,'RETURN_ACCEPTANCE_INVALIDATED','本币延续已确认，结束等待回退的仓位')){
        e.converted=true;v.completedConversions++;
        const next=open(s,reference,e,'CONTINUATION',q,now,input.contracts[t.symbol],input.quotes,t);
        if(!next)e.ended=true;
      }
      continue;
    }
    if(reference&&reference.contracts<u.referenceContracts){
      const fraction=1-reference.contracts/u.referenceContracts;
      if(reduce(s,t,q,now,fraction,'RETURN_REFERENCE_REDUCTION',input.contracts[t.symbol]))u.referenceContracts=reference.contracts;
    }
    if(reference)t.stopPrice=reference.stopPrice;
    u.holdReason=`原追随仓尚未发生退出事件，继续等待推进衰减；${e?.region?'本币反方向延续确认尚不完整':'尚无有效平衡区域供延续确认'}。原判断：${s.inverseTrial?.source.positions.find(p=>p.id===u.sourceId)?.positionIntelligence?.summary??'原持有依据仍有效'}`;
    u.lastDecisionAt=now;const lastBar=closedFiveMinutes(input.paths[t.symbol],now).at(-1);
    u.lastBarAt=lastBar?lastBar.time*1000+300_000:0;
  }
  const activeIds=new Set([...ref.positions.filter(t=>t.inverseCopy).map(t=>t.inverseCopy!.sourceId),...s.positions.filter(t=>t.unified).map(t=>t.unified!.sourceId)]),
    keys=Object.keys(v.episodes).sort((a,b)=>v.episodes[b]!.createdAt-v.episodes[a]!.createdAt);
  for(const id of keys.slice(240))if(!activeIds.has(id)){delete v.episodes[id];v.droppedEpisodes++;}
}
/** Quote pressure/reason/epsilon are observations, not a new financial commit
 * every two seconds. Commit irreversible episode state and each new full bar;
 * actual entry/reduction/exit always changes financial revision and is critical. */
function episodeAuthority(episodes:Record<string,UnifiedEpisode>){
  return Object.values(episodes).map(e=>[e.sourceId,e.createdAt,e.region,e.handled,e.converted,e.ended,!!e.continuationSeen,e.lastBarAt]);
}
export function advanceUnifiedExecution(input:Parameters<typeof advanceShadowInverse>[0]){
  const s=normalizeForward(structuredClone(input.state),input.now),activated=!s.unifiedExecution;
  if(!s.unifiedExecution){s.unifiedExecution={version:UNIFIED_EXECUTION_VERSION,cutoverAt:input.now,reference:shadowCapsule(s),
    episodes:{},legacyIds:s.positions.map(t=>t.id),completedConversions:0,droppedEpisodes:0};
    s.events.unshift({id:`a${s.startedAt}-${++s.revision}`,at:input.now,kind:'START',subject:UNIFIED_EXECUTION_VERSION,
      reason:'新单启用回退/延续；原持仓按原规则收尾，固定1000U'});}
  const v=s.unifiedExecution!,before=JSON.stringify([s.balance,s.resolved,s.revision,s.positions.map(t=>[t.id,t.contracts]),episodeAuthority(v.episodes)]),
    next=advanceShadowInverse({...input,state:unifiedReferenceState(s)});
  for(const key of SHARED_MARKET_KEYS)Object.assign(s,{[key]:structuredClone(next.state[key])});
  s.inverseTrial=next.state.inverseTrial;
  applyUnifiedReference(s,next.state,input);v.reference=shadowCapsule(next.state);
  const mark=forwardEquity(s,input.quotes,input.now);s.peakEquity=Math.max(s.peakEquity,mark.equity);
  s.maxDrawdown=Math.max(s.maxDrawdown,1-mark.equity/Math.max(1,s.peakEquity));
  const day=beijingDayKey(input.now),daily=s.daily.at(-1);
  if(daily?.day===day){daily.lastAt=input.now;daily.endEquity=mark.equity;}
  else s.daily.push({day,firstAt:input.now,lastAt:input.now,startEquity:mark.equity,endEquity:mark.equity,exactBoundary:false});
  s.daily=s.daily.slice(-45);s.latestReason=`回退 ${s.positions.filter(t=>t.unified?.branch==='RETURN').length} 笔，延续 ${s.positions.filter(t=>t.unified?.branch==='CONTINUATION').length} 笔；原持仓 ${s.positions.filter(t=>!t.unified).length} 笔按原规则收尾。`;
  const changed=activated||next.changed||before!==JSON.stringify([s.balance,s.resolved,s.revision,s.positions.map(t=>[t.id,t.contracts]),episodeAuthority(v.episodes)]);
  const protectionChanged=next.protectionChanged||s.positions.some(t=>{const old=input.state.positions.find(p=>p.id===t.id);
    return old&&(old.stopPrice!==t.stopPrice||old.favorable!==t.favorable||old.adverse!==t.adverse||old.firstProfitAt!==t.firstProfitAt);});
  return{state:s,changed,protectionChanged};
}
export function unifiedExecutionSummary(s:ForwardState,quotes:Record<string,Quote>,now:number){
  const u=s.unifiedExecution;if(!u)return null;
  const ref=unifiedReferenceState(s),mark=forwardEquity(ref,quotes,now);
  return{version:u.version,cutoverAt:u.cutoverAt,fixedAllocationEquity:1000,completedConversions:u.completedConversions,
    returnOpen:s.positions.filter(t=>t.unified?.branch==='RETURN').length,continuationOpen:s.positions.filter(t=>t.unified?.branch==='CONTINUATION').length,
    legacyOpen:s.positions.filter(t=>!t.unified).length,
    baseline:{initialEquity:ref.initialEquity,balance:ref.balance,equity:mark.equity,resolved:ref.resolved,fees:ref.fees,netPnl:mark.equity-ref.initialEquity,
      shadowInverse:inverseTrialSummary(ref,quotes,now),retainedTrades:[...ref.positions,...ref.history].filter(t=>t.inverseCopy).slice(0,96).map(t=>{const row=structuredClone(t);delete row.review;if(row.inverseCopy)delete row.inverseCopy.lossResearch;return row;}),
      receiptScope:'RETAINED_PLUS_IMMUTABLE_REFERENCE_ARCHIVES'},
    episodes:Object.values(u.episodes).sort((a,b)=>b.createdAt-a.createdAt).slice(0,30).map(e=>({...e})),droppedEpisodes:u.droppedEpisodes,
    executionPricePolicy:'actual-side-bbo-v1',holdingPolicy:'own-branch-evidence-v1'};
}
export {reduce as reduceUnifiedTrade};
