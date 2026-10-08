import test from 'node:test';
import assert from 'node:assert/strict';
import {initialForward,type Trade,type Quote} from '../lib/forward-relations.ts';
import {newInverseTrial,applyInverseSourceTrade,applyDeskOrderExits,applyInverseSoftLossExits,assertInverseTrial,shadowCapsule,sourceDecisionState} from '../lib/shadow-inverse-ledger.ts';
import {attachProposal,beijingSession,classifyClaim,ensureResearchDesk,observeResearch,readNarrative,refreshStance,sampleStance,
  CLAIM_HORIZON_MS,HOLD_HORIZON_MS,RESEARCH_DESK_VERSION,ROUND_TRIP_COST,type ResearchClaim,type ResearchDesk} from '../lib/research-decision.ts';

const US=Date.UTC(2026,9,8,14,0,0);
const EUROPE=Date.UTC(2026,9,8,8,0,0);
const quote=(bid:number,ask=bid,at=US):Quote=>({bestBid:bid,bestAsk:ask,observedAt:at,fresh:true,entryReady:true,sourceCount:4});
function desk():ResearchDesk{return ensureResearchDesk(undefined);}
function claim(id:string,kind:ResearchClaim['kind'],correct:boolean|undefined,settledAt:number,session:ResearchClaim['session']):ResearchClaim{
  return {id,symbol:'TEST_USDT',openedAt:settledAt-CLAIM_HORIZON_MS,session,engineSide:'LONG',kind,slow:1,fast:1,
    entryMid:100,confirmExtreme:98,swept:false,settledAt,settleMid:100,engineReturn:0,...(correct===undefined?{}:{correct})};
}
function fill(d:ResearchDesk,kind:ResearchClaim['kind'],correct:boolean,n:number,start:number,session:ResearchClaim['session']){
  for(let i=0;i<n;i++)d.claims.push(claim(`${kind}-${start}-${i}`,kind,correct,start+i,session));
}

test('a flat narrative does not vote, and disagreement is suspect',()=>{
  assert.equal(classifyClaim('LONG',0,1),'SKIP');
  assert.equal(classifyClaim('LONG',1,0),'SKIP');
  assert.equal(classifyClaim('LONG',1,1),'CONTINUE');
  assert.equal(classifyClaim('SHORT',-1,-1),'CONTINUE');
  assert.equal(classifyClaim('LONG',-1,-1),'SUSPECT');
  assert.equal(classifyClaim('LONG',1,-1),'SUSPECT');
  assert.deepEqual(readNarrative({major:'BULLISH',short:'NEUTRAL',breadth3:.2}),{slow:1,fast:1});
  assert.deepEqual(readNarrative({major:'BULLISH',short:'NEUTRAL',breadth3:.01}),{slow:1,fast:0});
  assert.equal(beijingSession(US),'US');
  assert.equal(beijingSession(EUROPE),'EUROPE');
});
test('settlement uses the first fresh mid after 30 minutes and ignores an earlier price',()=>{
  const d=desk();
  attachProposal(d,{id:'a',symbol:'TEST_USDT',openedAt:US,engineSide:'LONG',slow:1,fast:1,entryMid:100,confirmExtreme:98});
  assert.equal(d.claims[0]!.kind,'CONTINUE');
  const early=US+CLAIM_HORIZON_MS-1;
  assert.equal(observeResearch(d,{TEST_USDT:quote(110,110,early)},early),false);
  assert.equal(d.claims[0]!.settledAt,undefined);
  const at=US+CLAIM_HORIZON_MS;
  assert.equal(observeResearch(d,{TEST_USDT:quote(99,99,at-1000)},at),false);
  assert.equal(observeResearch(d,{TEST_USDT:quote(100.1,100.1,at)},at),true);
  assert.equal(d.claims[0]!.correct,false);
  assert.ok(Math.abs((d.claims[0]!.engineReturn??0)-ROUND_TRIP_COST)<1e-12);
  const up=desk();
  attachProposal(up,{id:'b',symbol:'TEST_USDT',openedAt:US,engineSide:'LONG',slow:-1,fast:-1,entryMid:100,confirmExtreme:98});
  observeResearch(up,{TEST_USDT:quote(100.2,100.2,at)},at);
  assert.equal(up.claims[0]!.kind,'SUSPECT');
  assert.equal(up.claims[0]!.correct,false);
  const fade=desk();
  attachProposal(fade,{id:'c',symbol:'TEST_USDT',openedAt:US,engineSide:'LONG',slow:-1,fast:1,entryMid:100,confirmExtreme:98});
  observeResearch(fade,{TEST_USDT:quote(100.05,100.05,at)},at);
  assert.equal(fade.claims[0]!.correct,true);
});
test('a sweep is recorded before the claim is allowed to vote',()=>{
  const d=desk();
  attachProposal(d,{id:'a',symbol:'TEST_USDT',openedAt:US,engineSide:'LONG',slow:1,fast:1,entryMid:100,confirmExtreme:98});
  observeResearch(d,{TEST_USDT:quote(97.5,97.5,US+60_000)},US+60_000);
  assert.equal(d.claims[0]!.swept,true);
  assert.equal(d.claims[0]!.settledAt,undefined);
  assert.equal(sampleStance(d,US+60_000),'FORWARD');
});
test('fewer than 20 of either kind stays forward',()=>{
  const d=desk();
  fill(d,'CONTINUE',false,20,US,beijingSession(US));
  fill(d,'SUSPECT',true,19,US+100,beijingSession(US));
  refreshStance(d,US+200);
  assert.equal(d.stance,'FORWARD');
  assert.equal(d.latch,undefined);
});
test('both losing readings pause, and a clean fade flips, then the latch holds for 20 new settles',()=>{
  const paused=desk();
  fill(paused,'CONTINUE',false,14,1,beijingSession(US));
  fill(paused,'CONTINUE',true,6,20,beijingSession(US));
  fill(paused,'SUSPECT',true,6,40,beijingSession(US));
  fill(paused,'SUSPECT',false,14,60,beijingSession(US));
  refreshStance(paused,US);
  assert.equal(paused.stance,'FLAT');
  assert.equal(paused.latch?.need,20);
  const flipped=desk();
  fill(flipped,'CONTINUE',false,14,1,beijingSession(US));
  fill(flipped,'CONTINUE',true,6,20,beijingSession(US));
  fill(flipped,'SUSPECT',true,14,40,beijingSession(US));
  fill(flipped,'SUSPECT',false,6,60,beijingSession(US));
  refreshStance(flipped,US);
  assert.equal(flipped.stance,'REVERSE');
  const since=flipped.latch!.since;
  for(let i=0;i<19;i++)flipped.claims.push(claim(`next-${i}`,'SKIP',undefined,since+1+i,beijingSession(US)));
  refreshStance(flipped,US+50_000);
  assert.equal(flipped.stance,'REVERSE');
  for(let i=0;i<20;i++)flipped.claims.push(claim(`eu-${i}`,'SKIP',undefined,since+100+i,beijingSession(EUROPE)));
  refreshStance(flipped,EUROPE);
  assert.equal(flipped.stance,'FORWARD');
});
test('thirteen of twenty is not enough to leave forward',()=>{
  const d=desk();
  fill(d,'CONTINUE',false,13,1,beijingSession(US));
  fill(d,'CONTINUE',true,7,20,beijingSession(US));
  fill(d,'SUSPECT',true,14,40,beijingSession(US));
  fill(d,'SUSPECT',false,6,60,beijingSession(US));
  refreshStance(d,US);
  assert.equal(d.stance,'FORWARD');
});

const T=1790832000000;
function trade(id:string,at=T):Trade{
  return {id,symbol:'TEST_USDT',side:'LONG',openedAt:at,closedAt:null,status:'OPEN',entryPrice:100,exitPrice:null,
    quantity:10,contracts:100,quantoMultiplier:.1,notional:1000,leverage:10,margin:100,plannedRisk:22,
    stopPrice:98,armPrice:105,favorable:0,adverse:0,lastPrice:100,lastQuoteAt:at,entryFee:.7,exitFee:0,fundingAllowance:0,
    grossPnl:null,netPnl:null,exitReason:null,relationFailureBars:0,lastRelationBar:at,execution:'REAL_QUOTE_PAPER_MODEL',liveEligible:false,
    rule:{id,signature:'synthetic',parentId:null,version:1,createdAt:at,expiresAt:at+86400000,status:'EXPERIMENTAL',conditions:[],side:'LONG',horizon:180,
      stopRate:.02,armRate:.001,givebackRate:.001,exitMode:'REACTION_DECAY',samples:0,trainGroups:0,checkGroups:0,estimatedNetRate:.05,
      priorResponse:null,recentResponse:0,standardError:0,reason:'synthetic',mutation:'CREATE',grammar:'market-intelligence-v1',liveEligible:false},
    entryContext:{version:'adaptive-ten-entry-v1',capturedAt:at,timeframe:'5m',side:'LONG',mode:'RELATIVE',reserve:false,reason:'synthetic',
      entryScore:90,directionStrength:90,spaceScore:90,positionScore:90,executionScore:100,remainingSpaceRate:.05,pullbackRiskRate:.02,edgeRatio:2.5,
      expectedHoldMinutes:180,marketFit:70,regionId:null,portfolioRiskCharge:22,strategyVersion:'market-intelligence-v1',tradePlan:'WINNER_TREND',
      winnerPlan:{version:'winner-preservation-v1',intent:'TREND',eventAt:at,initialStop:98,target:null,targetArea:null,origin:null,riskGroup:'test:LONG',source:'RELATIVE_CORE'}}} as Trade;
}
function open(){
  const s=initialForward(T-300000);s.inverseTrial=newInverseTrial(s,T,1000);
  const source=structuredClone(sourceDecisionState(s)),t=trade('source-1');
  source.positions.push(t);applyInverseSourceTrade(s,t,quote(100,100,T),T);
  s.inverseTrial.source=shadowCapsule(source);s.inverseTrial.lastSourceRevision=source.revision;
  return {s,source,t};
}
test('new copies exit on a sweep, a dead 30 minutes, a giveback, or 90 minutes, and old copies do not',()=>{
  const swept=open();
  const inv=swept.s.positions[0]!;inv.lastPrice=97;inv.lastQuoteAt=T+60_000;
  assert.equal(applyDeskOrderExits(swept.s,{TEST_USDT:quote(97,97,T+60_000)},T+60_000),true);
  assert.equal(inv.exitReason,'DESK_SWEEP_EXIT');assert.equal(inv.inverseCopy!.fills.at(-1)!.earlySoftLoss,true);
  assert.equal(swept.source.positions.length,1);
  applyInverseSourceTrade(swept.s,swept.t,quote(97,97,T+61_000),T+61_000);
  assert.equal(swept.s.positions.some(t=>t.inverseCopy),false);
  const quiet=open();
  const held=quiet.s.positions[0]!;held.openedAt=T;held.lastPrice=100;held.lastQuoteAt=T+CLAIM_HORIZON_MS;held.favorable=0;
  assert.equal(applyDeskOrderExits(quiet.s,{TEST_USDT:quote(100,100,T+CLAIM_HORIZON_MS)},T+CLAIM_HORIZON_MS),true);
  assert.equal(held.exitReason,'DESK_NO_PROGRESS_EXIT');
  const run=open();
  const runner=run.s.positions[0]!;runner.lastPrice=100.4;runner.lastQuoteAt=T+10*60_000;runner.favorable=.01;
  assert.equal(applyDeskOrderExits(run.s,{TEST_USDT:quote(100.4,100.4,T+10*60_000)},T+10*60_000),true);
  assert.equal(runner.exitReason,'DESK_GIVEBACK_EXIT');
  const aged=open();
  const old=aged.s.positions[0]!;old.lastPrice=101;old.lastQuoteAt=T+HOLD_HORIZON_MS;old.favorable=.02;
  assert.equal(applyDeskOrderExits(aged.s,{TEST_USDT:quote(101,101,T+HOLD_HORIZON_MS)},T+HOLD_HORIZON_MS),true);
  assert.equal(old.exitReason,'DESK_HORIZON_EXIT');
  const legacy=open();
  const leg=legacy.s.positions[0]!;delete leg.inverseCopy!.orderPolicy;
  leg.openedAt=T;leg.lastPrice=100;leg.lastQuoteAt=T+HOLD_HORIZON_MS;leg.favorable=0;
  assert.equal(applyDeskOrderExits(legacy.s,{TEST_USDT:quote(100,100,T+HOLD_HORIZON_MS)},T+HOLD_HORIZON_MS),false);
  assert.equal(leg.status,'OPEN');
  leg.lastPrice=98.8;
  assert.equal(applyInverseSoftLossExits(legacy.s,T+HOLD_HORIZON_MS),true);
  assertInverseTrial(legacy.s);
});
test('changing stance does not close a copy that is already open',()=>{
  const {s,source,t}=open();
  s.inverseTrial!.researchDesk!.stance='REVERSE';
  const inv=s.positions[0]!;
  assert.equal(applyDeskOrderExits(s,{TEST_USDT:quote(100,100,T+1000)},T+1000),false);
  assert.equal(inv.status,'OPEN');assert.equal(inv.side,'LONG');
  const next=trade('source-2',T+2000);
  source.positions.push(next);applyInverseSourceTrade(s,next,quote(100,100,T+2000),T+2000);
  assert.equal(s.positions.find(row=>row.inverseCopy?.sourceId==='source-2')?.side,'SHORT');
  assert.equal(s.positions.find(row=>row.inverseCopy?.sourceId===t.id)?.side,'LONG');
  s.inverseTrial!.source=shadowCapsule(source);s.inverseTrial!.lastSourceRevision=source.revision;
  assert.doesNotThrow(()=>assertInverseTrial(s));
});
