/** Paper book that does not open because a proposal opened.
 * Research only marks a one-minute wick that broke the prior 30 minutes and
 * closed back inside. Strategy fades that wick, cuts losers quickly, and
 * does not bank a winner inside the fee. */
import type {Candle, Contract, ForwardState, Quote, Rule, Trade} from './forward-relations.ts';
import {INVERSE_COST} from './shadow-inverse-ledger.ts';

export const NEEDLE_POLICY='needle-v1' as const;
export const NEEDLE_EPOCH='needle-book-2026-10-09' as const;
/** Books opened before this still follow proposals. */
export const NEEDLE_BEFORE=Date.parse('2026-10-08T08:00:00Z');
const NOTIONAL=250;
const TIP_MIN=.0025;
const TIP_MAX=.006;
const FOLLOW_MS=5*60_000;
const FOLLOW_RATE=.0015;
const WINNER_PEAK=.008;
const HOLD_MS=90*60_000;
const LOSS_CAP=4;
const COOLDOWN_MS=30*60_000;
const MAX_OPEN=3;
const FRESH_MS=120_000;
const RANGE=30;
const FEE=INVERSE_COST.feeRate;

export type NeedleMark={dir:'UP'|'DOWN';tip:number;bar:number};
const finite=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n);
const dirOf=(side:'LONG'|'SHORT')=>side==='LONG'?1:-1;
const fresh=(q:Quote|undefined,now:number)=>!!q&&q.fresh&&q.bestBid>0&&q.bestAsk>=q.bestBid&&q.observedAt<=now&&now-q.observedAt<=10_000;

export function isNeedleTrade(t:Trade){return t.exitControl?.policy===NEEDLE_POLICY;}

/** Last completed minute only. A wick still forming, or an old one, is not a signal. */
export function findNeedle(rows:Candle[]|undefined,now:number):NeedleMark|null{
  if(!rows?.length)return null;
  const done=rows.filter(r=>r.time>0&&r.high>0&&r.low>0&&r.close>0&&r.high>=Math.max(r.open,r.close)&&r.low<=Math.min(r.open,r.close)&&r.low>0&&r.time*1000+60_000<=now)
    .sort((a,b)=>a.time-b.time);
  if(done.length<RANGE+1)return null;
  const bar=done.at(-1)!,prior=done.slice(-(RANGE+1),-1);
  if(prior.length!==RANGE||now-(bar.time*1000+60_000)>FRESH_MS)return null;
  const high=Math.max(...prior.map(r=>r.high)),low=Math.min(...prior.map(r=>r.low));
  const up=bar.high>high&&bar.close<=high&&bar.close>=low;
  const down=bar.low<low&&bar.close>=low&&bar.close<=high;
  if(up===down)return null;
  return up?{dir:'UP',tip:bar.high,bar:bar.time}:{dir:'DOWN',tip:bar.low,bar:bar.time};
}

function rule(side:'LONG'|'SHORT',now:number,reason:string):Rule{
  return {id:`needle-${side}`,signature:'needle-v1',parentId:null,version:1,createdAt:now,expiresAt:now+HOLD_MS,
    status:'EXPERIMENTAL',conditions:[],side,horizon:90,stopRate:TIP_MAX,armRate:WINNER_PEAK,givebackRate:.5,
    exitMode:'HORIZON',samples:0,trainGroups:0,checkGroups:0,estimatedNetRate:0,priorResponse:null,recentResponse:0,
    standardError:0,reason,mutation:'CREATE',grammar:NEEDLE_POLICY,liveEligible:false};
}

function remember(state:ForwardState,key:string){
  const trial=state.inverseTrial!;
  const seen=trial.needleSeen??[];
  if(!seen.includes(key))seen.push(key);
  trial.needleSeen=seen.slice(-400);
}

function cooled(state:ForwardState,symbol:string,now:number){
  const at=state.inverseTrial?.needleCooldown?.[symbol];
  return finite(at)&&now-at<COOLDOWN_MS;
}

function closeNeedle(state:ForwardState,t:Trade,price:number,now:number,reason:string){
  const gross=dirOf(t.side)*t.quantity*(price-t.entryPrice),exitFee=t.quantity*price*FEE,net=gross-t.entryFee-exitFee;
  t.status='CLOSED';t.closedAt=now;t.exitPrice=price;t.lastPrice=price;t.lastQuoteAt=now;
  t.exitFee=exitFee;t.grossPnl=gross;t.netPnl=net;t.exitReason=reason;t.fundingAllowance=0;
  state.balance+=gross-exitFee;state.grossPnl+=gross;state.fees+=exitFee;state.turnover+=t.quantity*price;
  state.resolved++;if(net>0)state.wins++;
  if(reason==='NEEDLE_TIP_EXIT'||reason==='NEEDLE_NO_FOLLOW_EXIT'||reason==='NEEDLE_LOSS_CAP_EXIT'){
    const cool=state.inverseTrial!.needleCooldown??{};
    cool[t.symbol]=now;state.inverseTrial!.needleCooldown=cool;
  }
  state.positions=state.positions.filter(x=>x.id!==t.id);
  state.history=[t,...state.history.filter(x=>x.id!==t.id)].slice(0,240);
  state.revision++;state.events.unshift({id:`n${state.startedAt}-${state.revision}`,at:now,kind:'EXIT',subject:t.id,reason});
  state.events=state.events.slice(0,160);
}

/** Mark, exit, then maybe open. Returns whether the book changed. */
export function applyNeedleBook(state:ForwardState,minutePaths:Record<string,Candle[]>|undefined,quotes:Record<string,Quote>,contracts:Record<string,Contract>|undefined,now:number){
  const trial=state.inverseTrial;
  if(!trial||trial.paperPolicy!==NEEDLE_POLICY)return false;
  let changed=false;
  for(const t of [...state.positions]){
    if(!isNeedleTrade(t)||t.status!=='OPEN')continue;
    const q=quotes[t.symbol];if(!fresh(q,now))continue;
    const px=t.side==='LONG'?q!.bestBid:q!.bestAsk,signed=dirOf(t.side)*(px/t.entryPrice-1);
    t.lastPrice=px;t.lastQuoteAt=q!.observedAt;
    if(signed>t.favorable){t.favorable=signed;t.peakPnlRate=signed;changed=true;}
    t.adverse=Math.max(t.adverse,-signed);
    const age=now-t.openedAt,gross=dirOf(t.side)*t.quantity*(px-t.entryPrice);
    const tip=t.side==='LONG'?px<=t.stopPrice:px>=t.stopPrice;
    let reason:string|null=null;
    if(tip)reason='NEEDLE_TIP_EXIT';
    else if(gross<=-LOSS_CAP)reason='NEEDLE_LOSS_CAP_EXIT';
    else if(age>=FOLLOW_MS&&t.favorable<FOLLOW_RATE)reason='NEEDLE_NO_FOLLOW_EXIT';
    else if(age>=HOLD_MS)reason='NEEDLE_HORIZON_EXIT';
    else if(t.favorable>=WINNER_PEAK&&signed<=t.favorable/2)reason='NEEDLE_GIVEBACK_EXIT';
    if(!reason)continue;
    closeNeedle(state,t,px,now,reason);changed=true;
  }
  const open=state.positions.filter(isNeedleTrade);
  if(open.length>=MAX_OPEN)return changed;
  const held=new Set(state.positions.map(t=>t.symbol));
  const names=Object.keys(minutePaths??{}).sort();
  for(const symbol of names){
    if(state.positions.filter(isNeedleTrade).length>=MAX_OPEN)break;
    if(held.has(symbol)||cooled(state,symbol,now))continue;
    const mark=findNeedle(minutePaths?.[symbol],now);if(!mark)continue;
    const key=`${symbol}:${mark.bar}`;
    if(trial.needleSeen?.includes(key))continue;
    const q=quotes[symbol],contract=contracts?.[symbol];
    if(!fresh(q,now)||!contract||!(contract.quantoMultiplier>0)){remember(state,key);changed=true;continue;}
    const side:Trade['side']=mark.dir==='UP'?'SHORT':'LONG';
    const price=side==='LONG'?q!.bestAsk:q!.bestBid;
    const gap=side==='LONG'?price-mark.tip:mark.tip-price;
    const dist=gap/price;
    if(!(gap>0)||dist<TIP_MIN||dist>TIP_MAX){remember(state,key);changed=true;continue;}
    const mult=contract.quantoMultiplier,min=Math.max(1,Math.ceil(contract.minContracts??1));
    const contractsN=Math.floor(NOTIONAL/(price*mult));
    if(contractsN<min){remember(state,key);changed=true;continue;}
    const quantity=contractsN*mult,notional=quantity*price;
    if(notional<80||notional>400){remember(state,key);changed=true;continue;}
    const entryFee=notional*FEE,id=`nd-${now.toString(36)}-${symbol.replace(/[^A-Z0-9]/g,'').slice(0,24)}-${side[0]}`;
    const reason=side==='LONG'?'向下的针收回来，做多。':'向上的针收回来，做空。';
    const t:Trade={id,symbol,side,rule:rule(side,now,reason),openedAt:now,closedAt:null,status:'OPEN',
      entryPrice:price,exitPrice:null,quantity,contracts:contractsN,quantoMultiplier:mult,notional,leverage:5,
      margin:notional/5,plannedRisk:notional*dist,stopPrice:mark.tip,armPrice:price*(1+dirOf(side)*WINNER_PEAK),
      favorable:0,adverse:0,lastPrice:price,lastQuoteAt:q!.observedAt,entryFee,exitFee:0,fundingAllowance:0,
      grossPnl:null,netPnl:null,exitReason:null,relationFailureBars:0,lastRelationBar:now,execution:'REAL_QUOTE_PAPER_MODEL',
      liveEligible:false,firstProfitAt:null,holdScore:0,profitFloorRate:0,expectedHoldMinutes:90,peakPnlRate:0,
      exitControl:{policy:NEEDLE_POLICY,armedAt:null,armedQuoteAt:null,maxObservationGapMs:30_000,maxQuoteAgeMs:10_000},
      entryContext:{version:'adaptive-ten-entry-v1',capturedAt:now,timeframe:'5m',side,mode:'REVERSAL',reserve:false,reason,
        entryScore:0,directionStrength:0,spaceScore:0,positionScore:0,executionScore:0,remainingSpaceRate:WINNER_PEAK,
        pullbackRiskRate:dist,edgeRatio:0,expectedHoldMinutes:90,marketFit:0,regionId:null,portfolioRiskCharge:notional*dist,
        strategyVersion:NEEDLE_POLICY,thesisId:key,thesisSummary:reason,
        invalidationSummary:'针尖被打穿、5分钟没走出成本、浮亏到4U，就走。顺了要到0.8%才允许回吐一半离场，最长90分钟。'}};
    state.balance-=entryFee;state.fees+=entryFee;state.turnover+=notional;
    state.positions.push(t);remember(state,key);held.add(symbol);changed=true;
    state.revision++;state.events.unshift({id:`n${state.startedAt}-${state.revision}`,at:now,kind:'ENTRY',subject:id,reason});
    state.events=state.events.slice(0,160);
  }
  return changed;
}
