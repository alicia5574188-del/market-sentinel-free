import test from 'node:test';
import assert from 'node:assert/strict';
import {initialForward,type Trade,type Quote} from '../lib/forward-relations.ts';
import {newInverseTrial,sourceDecisionState,shadowCapsule,applyInverseSourceTrade,assertInverseTrial,inverseId} from '../lib/shadow-inverse-ledger.ts';
import {RESEARCH_DESK_VERSION,type ResearchDesk,type DeskStance} from '../lib/research-decision.ts';

const T=Math.floor(1790832000000/3_600_000)*3_600_000;
const quote=(at:number):Quote=>({bestBid:100,bestAsk:100,observedAt:at,fresh:true,entryReady:true,sourceCount:4});
function sourceTrade(id:string,at:number):Trade{
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
      winnerPlan:{version:'winner-preservation-v1',intent:'TREND',eventAt:at,initialStop:98,target:null,targetArea:null,origin:null,riskGroup:'test:LONG',source:'RELATIVE_CORE'}}} as Trade;
}
function closeSource(t:Trade,price:number,now:number){
  const gross=(price-t.entryPrice)*t.quantity,fee=t.quantity*price*.0007,
    funding=t.notional*.0002*(now-t.openedAt)/86400000;
  Object.assign(t,{status:'CLOSED',closedAt:now,exitPrice:price,exitReason:'WINNER_THESIS_EXIT',lastPrice:price,lastQuoteAt:now,
    grossPnl:gross,exitFee:fee,fundingAllowance:funding,netPnl:gross-t.entryFee-fee-funding});
  t.exitAudit={trigger:'WINNER_THESIS_EXIT',at:now,evidence:{quoteAt:now}};
}
function book(){
  const s=initialForward(T-300000);s.inverseTrial=newInverseTrial(s,T,1000);
  return {s,source:structuredClone(sourceDecisionState(s))};
}
function stance(s:ReturnType<typeof book>['s'],next:DeskStance){
  const desk:ResearchDesk={version:RESEARCH_DESK_VERSION,stance:next,claims:[],note:'test'};
  s.inverseTrial!.researchDesk=desk;
}
test('a new copy follows the proposal until settled evidence says otherwise',()=>{
  const {s,source}=book();
  const held=sourceTrade('held',T+1000);
  source.positions.push(held);applyInverseSourceTrade(s,held,quote(T+1000),T+1000);
  const row=s.positions.find(t=>t.id===inverseId(held.id));
  assert.equal(row?.side,'LONG');assert.equal(row?.inverseCopy?.alignment,'WITH_SOURCE');
  assert.equal(row?.inverseCopy?.orderPolicy,'desk-v1');assert.equal(row?.quantity,held.quantity);
  assert.equal(s.inverseTrial!.researchDesk?.claims.some(c=>c.id==='held'),true);
  s.inverseTrial!.source=shadowCapsule(source);s.inverseTrial!.lastSourceRevision=source.revision;
  assert.doesNotThrow(()=>assertInverseTrial(s));
  closeSource(held,99,T+2000);applyInverseSourceTrade(s,held,quote(T+2000),T+2000);
  assert.equal(s.history.some(t=>t.id===inverseId(held.id)&&t.status==='CLOSED'),true);
});
test('a flat stance skips a new copy and an already open copy still follows its source out',()=>{
  const {s,source}=book();
  const held=sourceTrade('held',T+1000);
  source.positions.push(held);applyInverseSourceTrade(s,held,quote(T+1000),T+1000);
  stance(s,'FLAT');
  const blocked=sourceTrade('blocked',T+5000);
  source.positions.push(blocked);applyInverseSourceTrade(s,blocked,quote(T+5000),T+5000);
  assert.equal(s.positions.some(t=>t.id===inverseId(blocked.id)),false);
  assert.ok(s.inverseTrial!.entryHaltSkipped?.includes(blocked.id));
  assert.equal(s.inverseTrial!.researchDesk?.claims.some(c=>c.id==='blocked'),true);
  assert.equal(s.positions.find(t=>t.id===inverseId(held.id))?.side,'LONG');
  s.inverseTrial!.source=shadowCapsule(source);s.inverseTrial!.lastSourceRevision=source.revision;
  assert.doesNotThrow(()=>assertInverseTrial(s));
  closeSource(held,99,T+8000);applyInverseSourceTrade(s,held,quote(T+8000),T+8000);
  assert.equal(s.history.some(t=>t.id===inverseId(held.id)&&t.status==='CLOSED'),true);
});
test('a reverse stance opens the opposite side without resizing',()=>{
  const {s,source}=book();stance(s,'REVERSE');
  const rowSource=sourceTrade('fade',T+1000);
  source.positions.push(rowSource);applyInverseSourceTrade(s,rowSource,quote(T+1000),T+1000);
  const row=s.positions.find(t=>t.id===inverseId(rowSource.id));
  assert.equal(row?.side,'SHORT');assert.equal(row?.inverseCopy?.alignment,'AGAINST_SOURCE');
  assert.equal(row?.quantity,rowSource.quantity);
  s.inverseTrial!.source=shadowCapsule(source);s.inverseTrial!.lastSourceRevision=source.revision;
  assert.doesNotThrow(()=>assertInverseTrial(s));
});
