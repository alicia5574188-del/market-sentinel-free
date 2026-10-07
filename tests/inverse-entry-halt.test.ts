import test from 'node:test';
import assert from 'node:assert/strict';
import {initialForward,type Trade,type Quote} from '../lib/forward-relations.ts';
import {newInverseTrial,sourceDecisionState,shadowCapsule,applyInverseSourceTrade,assertInverseTrial,inverseId} from '../lib/shadow-inverse-ledger.ts';

const T=1790832000000;
const quote=(at:number):Quote=>({bestBid:100,bestAsk:100,observedAt:at,fresh:true,entryReady:true,sourceCount:4});
function sourceTrade(id:string,at:number,persistence:number,expansion:'HIGH'|'NORMAL'):Trade{
  return {id,symbol:'TEST_USDT',side:'LONG',openedAt:at,closedAt:null,status:'OPEN',entryPrice:100,exitPrice:null,
    quantity:10,contracts:100,quantoMultiplier:.1,notional:1000,leverage:10,margin:100,plannedRisk:22,
    stopPrice:98,armPrice:105,favorable:0,adverse:0,lastPrice:100,lastQuoteAt:at,entryFee:0.7,exitFee:0,fundingAllowance:0,
    grossPnl:null,netPnl:null,exitReason:null,relationFailureBars:0,lastRelationBar:at,execution:'REAL_QUOTE_PAPER_MODEL',liveEligible:false,
    rule:{id,signature:'synthetic',parentId:null,version:1,createdAt:at,expiresAt:at+86400000,status:'EXPERIMENTAL',conditions:[],side:'LONG',horizon:180,
      stopRate:.02,armRate:.001,givebackRate:.001,exitMode:'REACTION_DECAY',samples:0,trainGroups:0,checkGroups:0,estimatedNetRate:.05,
      priorResponse:null,recentResponse:0,standardError:0,reason:'synthetic',mutation:'CREATE',grammar:'market-intelligence-v1',liveEligible:false},
    entryContext:{version:'adaptive-ten-entry-v1',capturedAt:at,timeframe:'5m',side:'LONG',mode:'RELATIVE',reserve:false,reason:'synthetic',
      entryScore:90,directionStrength:90,spaceScore:90,positionScore:90,executionScore:100,remainingSpaceRate:.05,pullbackRiskRate:.02,edgeRatio:2.5,
      expectedHoldMinutes:180,marketFit:70,regionId:null,portfolioRiskCharge:22,strategyVersion:'market-intelligence-v1',tradePlan:'WINNER_TREND',
      environmentPersistenceScore:persistence,environmentProfitExpansion:expansion,
      winnerPlan:{version:'winner-preservation-v1',intent:'TREND',eventAt:at,initialStop:98,target:null,targetArea:null,origin:null,riskGroup:'test:LONG',source:'RELATIVE_CORE'}}} as Trade;
}
function closeSource(t:Trade,price:number,now:number){
  const gross=(price-t.entryPrice)*t.quantity,fee=t.quantity*price*.0007,
    funding=t.notional*.0002*(now-t.openedAt)/86400000;
  Object.assign(t,{status:'CLOSED',closedAt:now,exitPrice:price,exitReason:'WINNER_THESIS_EXIT',lastPrice:price,lastQuoteAt:now,
    grossPnl:gross,exitFee:fee,fundingAllowance:funding,netPnl:gross-t.entryFee-fee-funding});
  t.exitAudit={trigger:'WINNER_THESIS_EXIT',at:now,evidence:{quoteAt:now}};
}
test('a real-direction halt skips a new inverse and still lets an open inverse follow its source out',()=>{
  const s=initialForward(T-300000);s.inverseTrial=newInverseTrial(s,T,1000);
  const source=structuredClone(sourceDecisionState(s));
  const plant=(id:string,at:number,persistence:number,expansion:'HIGH'|'NORMAL',exit:number)=>{
    const t=sourceTrade(id,at,persistence,expansion);
    source.positions.push(t);applyInverseSourceTrade(s,t,quote(at),at);
    closeSource(t,exit,at+1000);applyInverseSourceTrade(s,t,quote(at+1000),at+1000);
    source.positions=source.positions.filter(x=>x.id!==id);source.history.unshift(t);
  };
  for(let i=0;i<6;i++)plant('high-'+i,T+i,0.74,'HIGH',99);
  const held=sourceTrade('held',T+50000,0.74,'HIGH');
  source.positions.push(held);applyInverseSourceTrade(s,held,quote(T+50000),T+50000);
  assert.ok(s.positions.some(t=>t.id===inverseId(held.id)));
  for(let i=0;i<12;i++)plant('real-'+i,T+100000+i,0.58,'NORMAL',102);
  const blocked=sourceTrade('blocked',T+300000,0.58,'NORMAL');
  applyInverseSourceTrade(s,blocked,quote(T+300000),T+300000);
  assert.equal(s.positions.some(t=>t.id===inverseId(blocked.id)),false);
  assert.ok(s.inverseTrial!.entryHaltSkipped?.includes(blocked.id));
  source.positions.push(blocked);
  s.inverseTrial!.source=shadowCapsule(source);s.inverseTrial!.lastSourceRevision=source.revision;
  assert.doesNotThrow(()=>assertInverseTrial(s));
  closeSource(held,99,T+400000);applyInverseSourceTrade(s,held,quote(T+400000),T+400000);
  assert.equal(s.positions.some(t=>t.id===inverseId(held.id)),false);
  assert.equal(s.history.some(t=>t.id===inverseId(held.id)&&t.status==='CLOSED'),true);
});
