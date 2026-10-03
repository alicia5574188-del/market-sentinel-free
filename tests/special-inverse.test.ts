import test from 'node:test';
import assert from 'node:assert/strict';
import {initialForward,normalizeForward,forwardSummary,resetForwardAccountPreservingLearning,type Quote} from '../lib/forward-relations.ts';
import {advanceDirectStrategy,openDirectPlan} from '../lib/direct-strategy.ts';
import {inverseSpecialEntryExecutable,inverseSpecialPlan} from '../lib/special-inverse.ts';
import {validMarketRoute} from '../lib/market-authority.ts';
import {buildProportionalMirror} from '../lib/live-parity.ts';
import {prepareForwardWrite,readForwardStore} from '../lib/forward-store.ts';
import {buildForwardProtectionCheckpoint,restoreForwardProtectionCheckpoint} from '../lib/forward-protection-checkpoint.ts';
import {buildReviewSnapshot} from '../lib/research-snapshot.ts';
import type {CandleLike,MarketSymbolState} from '../lib/market-intelligence-engine.ts';
import {directOpportunityView,directStrategySummary} from '../lib/direct-strategy-view.ts';
const T=1791000000000,B=300000;
const bars=(prices:number[],step=B,end=T):CandleLike[]=>prices.map((p,i)=>({time:(end-(prices.length-i)*step)/1000,
  open:p,close:p,high:p+.04,low:p-.04,volume:100,turnoverUsd:10000,volumeVenue:'GATE'}));
const q=(price=101,now=T):Quote=>({bestBid:price-.005,bestAsk:price+.005,observedAt:now,fresh:true,entryReady:true,
  sourceCount:3,disagreementRate:0,directionalAgreement:1,medianShortMove:.0005,bookCoverage:'DEPTH20',
  bids:[{price:price-.005,size:100000}],asks:[{price:price+.005,size:100000}]});
const c={quantoMultiplier:.1,leverageMax:20,maintenanceRate:.005,minContracts:1,tickSize:.01,
  orderSizeMin:'1',orderSizeMax:'100000',marketOrderSizeMax:'100000',enableDecimal:false};
const timing={version:'native-position-first-observed-v1' as const,prepareMs:2000,confirmMs:0,basis:'EXECUTION_CLOCK' as const,samples:0};
const state:MarketSymbolState={symbol:'A_USDT',clusterId:'A_USDT',correlation:.8,beta:1,volatility:.001,
  watchScore:70,regime:'DIVERGENT',stage:'READY',dataConfidence:90,actualMove:0,expectedMove:0,residual:0,residualZ:0,
  residualPersistence:1,relativeStrength:.5,longScore:70,shortScore:70,pathLong:.8,pathShort:.8,roomLong:.1,roomShort:.1,
  sourceCount:3,venueAgreement:1,venuePressure:0,reasons:[],signalSide:'LONG',signalSince:T-600000,signalBars:3,signalLastBar:T};
function filled(sign:number,inverse=true){
  const paths={A_USDT:bars(Array(36).fill(100))},minutes={A_USDT:bars([...Array(12).fill(100),100+sign*.5,100+sign*.8,100+sign],60000)};
  let s=advanceDirectStrategy({state:initialForward(T-7200000),now:T-120000,specialInverse:inverse,eventResponse:false,specialMove:true,marketAuthority:true,
    paths:{},quotes:{},contracts:{},paperTiming:timing}).state;
  s.extremumRegime.symbols={A_USDT:state};let now=T;
  for(let n=0;n<=45;n++){
    now=T+n*2000;const quotes={A_USDT:q(100+sign*(1+n*.014),now)};
    s=advanceDirectStrategy({state:s,now,specialInverse:inverse,eventResponse:false,specialMove:true,marketAuthority:true,allowDataCycle:false,entrySymbols:['A_USDT'],
      quotes,analysisQuotes:quotes,paths,minutePaths:minutes,contracts:{A_USDT:c},paperTiming:timing}).state;
    if(s.positions[0]?.paperOrder?.phase==='FILLED')break;
  }
  assert.equal(s.positions.length,1,JSON.stringify({plans:s.directStrategy?.plans,diagnostics:s.entryDiagnostics,validations:s.entryValidations}));
  assert.equal(s.positions[0]!.paperOrder?.phase,'FILLED');return{s,t:s.positions[0]!,now,paths,minutes};
}
test('original completed source and response open opposite native PAPER in both directions with actual risk and one wallet',()=>{
  for(const sign of [1,-1]){
    const {s,t}=filled(sign),r=t.unified!.marketRoute!,original=filled(sign,false).t;
    assert.deepEqual(r.sourceRoute,original.unified!.marketRoute);
    assert.deepEqual(t.entryContext!.entryResponse,original.entryContext!.entryResponse);
    assert.equal(t.openedAt,original.openedAt);assert.equal(t.paperOrder!.confirmedAt,original.paperOrder!.confirmedAt);
    assert.equal(s.startedAt,T-7200000);assert.equal(s.inverseTrial,undefined);
    assert.equal(r.sourceRoute!.side,sign>0?'LONG':'SHORT');assert.equal(t.side,sign>0?'SHORT':'LONG');
    assert.equal(t.rule.side,t.side);assert.equal(r.side,t.side);assert.equal(r.sourceRoute!.controllerVersion,'special-move-v1');
    assert.equal(r.controllerVersion,'special-move-inverse-v1');assert.ok(validMarketRoute(r));
    assert.equal(t.unified!.response,undefined);assert.ok(t.notional>16);assert.ok(t.entryFee>0);
    assert.ok((t.side==='LONG'?1:-1)*(t.entryPrice-t.stopPrice)>0);assert.ok(t.plannedRisk<=7.1);
    assert.equal(t.forecast?.remainingNetRate,0);assert.equal(s.history.length,0);normalizeForward(s,T+100000);
    assert.match(t.unified!.entryReason,/原信号.* → 实际/);assert.ok(s.consumedTheses[r.sourceRoute!.version+`:A_USDT:CONTINUATION:${r.sourceRoute!.side}:${r.proofAt}`]);
  }
});
test('same-source repeat is consumed and same actual side needs a post-exit retest; cutover keeps older filled rules',()=>{
  const old=filled(-1,false),now=old.now+2000;
  const activated=advanceDirectStrategy({state:old.s,now,specialMove:true,marketAuthority:true,allowDataCycle:false,
    paths:{},quotes:{A_USDT:q(old.t.entryPrice,now)},contracts:{A_USDT:c},paperTiming:timing}).state;
  assert.equal(activated.startedAt,old.s.startedAt);assert.equal(activated.balance,old.s.balance);
  assert.equal(activated.positions[0]!.id,old.t.id);assert.equal(activated.positions[0]!.side,'SHORT');
  assert.deepEqual(activated.positions[0]!.unified!.marketRoute,old.t.unified!.marketRoute);
  assert.equal(activated.history.length,0);assert.equal(activated.directStrategy!.specialInverse!.cutoverAt,now);
  const f=filled(-1),s=structuredClone(f.s),r=f.t.unified!.marketRoute!;
  s.positions=[];s.directStrategy!.plans.A_USDT!.consumed=false;
  const source=structuredClone(old.s.directStrategy!.plans.A_USDT!);source.consumed=false;
  const plan=inverseSpecialPlan(source,q(f.t.entryPrice,f.now));
  assert.match(openDirectPlan(s,plan,q(f.t.entryPrice,f.now),c,f.now,{A_USDT:q(f.t.entryPrice,f.now)})!,/已经执行/);
  delete s.consumedTheses[plan.id];s.lastSide.A_USDT=f.t.side;s.lastExitAt.A_USDT=f.now;
  assert.match(openDirectPlan(s,plan,q(f.t.entryPrice,f.now),c,f.now,{A_USDT:q(f.t.entryPrice,f.now)})!,/退出之后真实回踩重启/);
  assert.equal(s.positions.length,0);assert.equal(r.sourceRoute!.side,'SHORT');
});
test('unconsumed actual plans are not inverted twice in public explanations; ten holdings fit the protection receipt',()=>{
  const f=filled(-1),s=structuredClone(f.s),plan=s.directStrategy!.plans.A_USDT!;
  plan.consumed=false;
  // Model an actual plan that has been adapted but not yet admitted.
  const original=filled(-1,false).s.directStrategy!.plans.A_USDT!;
  const actual=inverseSpecialPlan(original,q(f.t.entryPrice,f.now));actual.consumed=false;
  s.directStrategy!.plans.A_USDT=actual;
  assert.equal(directOpportunityView(s,original.candidate).side,'LONG');
  const summary=directStrategySummary(s)!;
  assert.equal(summary.plans[0]!.side,'LONG');assert.equal(summary.plans[0]!.sourceSide,'SHORT');
  assert.equal(summary.plans[0]!.reason.split('原信号').length,2);assert.match(summary.explanation,/实际方向反过来/);
  // Capacity projection only; not a synthetic financial account or order.
  s.positions=Array.from({length:10},(_,n)=>({...structuredClone(f.t),id:`capacity-${n}`,symbol:`CAPACITY_${n}_USDT`}));
  const receipt=buildForwardProtectionCheckpoint(s);
  assert.ok(Buffer.byteLength(JSON.stringify(receipt))<112*1024);
  assert.equal(receipt.positions.length,10);
  assert.ok(receipt.positions.every(t=>t.unified!.marketRoute!.sourceRoute!.side==='SHORT'));
});
test('shared native admission uses actual opposite side and refuses stale source proof or adverse drift without a target forecast',()=>{
  for(const sign of [1,-1]){
    const {t,now}=filled(sign);assert.ok(inverseSpecialEntryExecutable(t,t.entryPrice,now));
    assert.equal(inverseSpecialEntryExecutable(t,t.entryPrice,now+13*60000),false);
    assert.equal(inverseSpecialEntryExecutable(t,t.entryPrice*1.03,now),false);
    const mirror=buildProportionalMirror({source:t,sourceEquity:1000,equity:1000,available:1000,entryPrice:t.entryPrice,
      quantoMultiplier:c.quantoMultiplier,leverageMax:c.leverageMax,maintenanceRate:c.maintenanceRate,openRisk:0,
      sameDirectionRisk:0,openMargin:0,openNotional:0,now,policy:'synthetic',sourceRiskAuthority:true,
      sizeRules:{enableDecimal:false,orderSizeMin:'1',orderSizeMax:'100000',marketOrderSizeMax:'100000'}});
    assert.equal(mirror.binding.sourceAtCopy.side,t.side);assert.ok(mirror.intent);
    const bad=structuredClone(t.unified!.marketRoute!);bad.sourceRoute!.side=bad.side;assert.equal(validMarketRoute(bad),false);
    bad.sourceRoute=structuredClone(bad);assert.equal(validMarketRoute(bad),false);
  }
});
test('inverse holding survives five minutes without event launch exits; actual hard loss closes through the original queue',()=>{
  for(const sign of [1,-1]){
    const f=filled(sign),d=f.t.side==='LONG'?1:-1,now=T+300000,price=f.t.entryPrice*(1+d*.002);
    const next=advanceDirectStrategy({state:f.s,now,specialMove:true,marketAuthority:true,allowDataCycle:false,paths:{},
      quotes:{A_USDT:q(price,now)},contracts:{A_USDT:c},paperTiming:timing}).state;
    assert.equal(next.positions.length,1);assert.equal(next.positions[0]!.paperOrder?.action,undefined);
    assert.equal(next.positions[0]!.unified!.response,undefined);assert.ok(next.positions[0]!.unified!.adaptive);
    const loss=advanceDirectStrategy({state:next,now:now+2000,specialMove:true,marketAuthority:true,allowDataCycle:false,paths:{},
      quotes:{A_USDT:q(f.t.stopPrice*(1-d*.002),now+2000)},contracts:{A_USDT:c},paperTiming:timing}).state;
    assert.equal(loss.positions[0]!.paperOrder?.action?.kind,'CLOSE');
    assert.match(loss.positions[0]!.paperOrder!.action!.detail,/保护/);
  }
});
test('lossless store/protection restore and snapshot retain original vs actual directions; manual reset retains research but not old orders',async()=>{
  const {s,t,now}=filled(-1);s.storage.persistedAt=now;s.revision++;
  const restoredProtection=restoreForwardProtectionCheckpoint(s,buildForwardProtectionCheckpoint(s));
  assert.deepEqual(restoredProtection.positions[0]!.unified!.marketRoute,t.unified!.marketRoute);
  const full=await prepareForwardWrite(null,s,now,{compact:true}),db=new Map(Object.entries(full.entries));
  const read=await readForwardStore({get:async<V>(k:string)=>structuredClone(db.get(k)) as V|undefined},now+2000);
  assert.deepEqual(read.positions[0]!.unified!.marketRoute,t.unified!.marketRoute);
  const snapshot=buildReviewSnapshot({view:forwardSummary(read,{A_USDT:q(t.entryPrice,now+2000)},now+2000),exportedAt:now+2000,buildSha:'synthetic',strategyFingerprint:'synthetic'});
  const audit=snapshot.research.specialInverseAudit as {trades:{source:{side:string};actualSide:string}[]};
  assert.equal(audit.trades[0]!.source.side,'SHORT');assert.equal(audit.trades[0]!.actualSide,'LONG');
  const reset=resetForwardAccountPreservingLearning(s,now+10000);assert.deepEqual(reset.extremumRegime,s.extremumRegime);
  normalizeForward(reset,now+10001);assert.equal(reset.positions.length,0);assert.equal(reset.history.length,0);assert.equal(reset.balance,1000);
});
