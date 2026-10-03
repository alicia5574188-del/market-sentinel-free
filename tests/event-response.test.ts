import test from 'node:test';
import assert from 'node:assert/strict';
import {advanceEventResearch,boundedEventResearch,eventMarketRoute,confirmEventQuote,eventHoldingDecision,normalizeEventResearch,responseRows,
  EVENT_RESEARCH_BYTES,type ResponseEvent,type ResponseHolding} from '../lib/event-response.ts';
import {initialForward,normalizeForward,forwardSummary,resetForwardAccountPreservingLearning,type Quote,type Trade} from '../lib/forward-relations.ts';
import {advanceDirectStrategy} from '../lib/direct-strategy.ts';
import {buildForwardProtectionCheckpoint,restoreForwardProtectionCheckpoint} from '../lib/forward-protection-checkpoint.ts';
import {prepareForwardWrite,readForwardStore} from '../lib/forward-store.ts';
import {buildReviewSnapshot} from '../lib/research-snapshot.ts';
import type {CandleLike,MarketSymbolState} from '../lib/market-intelligence-engine.ts';
const T=1791014400000,B=300000;
const bars=(prices:number[],step=B,end=T):CandleLike[]=>prices.map((p,i)=>({time:(end-(prices.length-i)*step)/1000,
  open:i?prices[i-1]!:p,close:p,high:Math.max(p,i?prices[i-1]!:p)+.01,low:Math.min(p,i?prices[i-1]!:p)-.01,
  volume:100,turnoverUsd:10000,volumeVenue:'GATE'}));
const q=(at=T,p=100):Quote=>({bestBid:p-.005,bestAsk:p+.005,observedAt:at,fresh:true,entryReady:true,sourceCount:3,disagreementRate:0,
  bookCoverage:'DEPTH20',bids:[{price:p-.005,size:100000}],asks:[{price:p+.005,size:100000}]});
const state=(symbol:string):MarketSymbolState=>({symbol,clusterId:symbol,correlation:.8,beta:1,volatility:.001,watchScore:90,
  regime:'DIVERGENT',stage:'READY',dataConfidence:90,actualMove:0,expectedMove:0,residual:0,residualZ:0,residualPersistence:1,
  relativeStrength:.5,longScore:70,shortScore:70,pathLong:.8,pathShort:.8,roomLong:.1,roomShort:.1,sourceCount:3,
  venueAgreement:1,venuePressure:0,reasons:[],signalSide:'LONG',signalSince:T-600000,signalBars:3,signalLastBar:T});
function market(now=T,price=100){const paths:Record<string,CandleLike[]>={A_USDT:bars(Array(36).fill(100),B,now)},
  states:Record<string,MarketSymbolState>={A_USDT:state('A_USDT')},quotes:Record<string,Quote>={A_USDT:q(now,price)};
  for(const k of ['B_USDT','C_USDT','D_USDT']){paths[k]=bars(Array.from({length:36},(_,n)=>100+n*.2),B,now);states[k]=state(k);quotes[k]=q(now,107);}
  return{now,paths,states,quotes,minutes:{A_USDT:bars(Array(15).fill(100),60000,now)}};
}
function launched(side=1){const i=market(),r=advanceEventResearch(i),now=T+120000,j=market(now,100+side*.8);
  j.minutes.A_USDT=bars([...Array(13).fill(100),100+side*.65,100+side*.8],60000,now);
  const next=advanceEventResearch({...j,previous:r});return{r:next,e:next.events.A_USDT!,i:j};}
test('active nonresponse starts a stable neutral event; only later own completed response earns either side',()=>{
  for(const side of [1,-1]){const {r,e,i}=launched(side);assert.equal(e.detectedAt,T);assert.equal(e.anchorPrice,100);
    assert.equal(e.kind,'ACTIVE_NONRESPONSE');assert.equal(e.side,side>0?'LONG':'SHORT');assert.equal(e.phase,'READY');
    assert.ok(eventMarketRoute(r,'A_USDT',100+side*.8,i.now).route);assert.equal(e.proofAt,i.now);
    const again=advanceEventResearch({...i,now:i.now+2000,previous:r,quotes:{...i.quotes,A_USDT:q(i.now+2000,100+side*.8)}});
    assert.equal(again.events.A_USDT!.id,e.id);assert.equal(again.events.A_USDT!.proofAt,e.proofAt);}
});
test('unknown/low real activity and cross-venue or future minute paths never manufacture a launch',()=>{
  const i=market();for(const b of i.paths.A_USDT!)delete b.turnoverUsd;assert.equal(advanceEventResearch(i).events.A_USDT,undefined);
  const {r,i:j}=launched();for(const b of j.minutes.A_USDT)b.volumeVenue='OKX';
  assert.equal(responseRows(j.paths.A_USDT,j.minutes.A_USDT,j.now).step,B);
  const start=advanceEventResearch(i);assert.equal(Object.keys(start.events).length,0);
  const future=market(T,101);future.minutes.A_USDT=bars([...Array(12).fill(100),100.5,100.7,101],60000,T+180000);
  const observed=advanceEventResearch(future);assert.notEqual(observed.events.A_USDT?.phase,'READY');assert.ok(normalizeEventResearch(r));
});
test('later observed quote samples confirm retained progress without requiring a new price chase',()=>{
  const {e,i}=launched();assert.equal(confirmEventQuote(e,q(i.now,100.8),i.now),false);
  assert.equal(confirmEventQuote(e,q(i.now,100.8),i.now+2000),false,'repeated same quote is not a new sample');
  assert.equal(confirmEventQuote(e,q(i.now+2000,100.81),i.now+2000),false);
  assert.equal(confirmEventQuote(e,q(i.now+4000,100.81),i.now+4000),true);
  assert.equal(eventMarketRoute(launched().r,'A_USDT',102,i.now).route,null);
});
test('rotation and normal-rank changes retain identity; missing outcomes are explicit, never reconstructed',()=>{
  const {r,e}=launched(),dormant=advanceEventResearch({previous:r,now:T+900000,paths:{},quotes:{},states:{}});
  assert.equal(dormant.events.A_USDT!.id,e.id);assert.equal(dormant.events.A_USDT!.phase,'DORMANT');
  const j=market(T+1200001),next=advanceEventResearch({...j,previous:dormant});
  assert.equal(next.events.A_USDT!.detectedAt,T);assert.equal(next.events.A_USDT!.outcomes[0]!.status,'MISSING');
  const onTime=advanceEventResearch({...market(T+902000),previous:r});
  assert.equal(onTime.events.A_USDT!.outcomes[0]!.status,'OBSERVED');
  assert.equal(onTime.events.A_USDT!.outcomes[0]!.observedAt,T+902000);
  const absent=advanceEventResearch({previous:r,now:T+1200000,paths:{A_USDT:bars(Array(16).fill(100),B,T+7200000)},quotes:{},states:j.states});
  assert.notEqual(absent.events.A_USDT!.outcomes[0]!.status,'OBSERVED');
});
test('capacity preserves existing event anchors and outcomes instead of evicting by a refreshed rank',()=>{
  const i=market();for(let n=0;n<65;n++){const k=`X${n}_USDT`;i.paths[k]=bars([...Array(33).fill(100),103,104,105]);i.states[k]=state(k);i.quotes[k]=q(T,105);}
  const r=advanceEventResearch(i),ids=Object.fromEntries(Object.values(r.events).map(e=>[e.symbol,e.id]));assert.ok(r.capacitySkipped>0);
  const next=advanceEventResearch({...i,previous:r,now:T+2000});
  assert.deepEqual(Object.fromEntries(Object.values(next.events).map(e=>[e.symbol,e.id])),ids);
  assert.ok(Buffer.byteLength(JSON.stringify(next))<=EVENT_RESEARCH_BYTES);assert.ok(normalizeEventResearch(next));
});
test('mature outcome and closed-trade pressure compacts explanations while preserving causal and financial receipts',()=>{
  const source=launched(),r=structuredClone(source.r);r.events={};r.updatedAt=T+3600000;
  for(let n=0;n<14;n++){
    const e=structuredClone(source.e),symbol=`PRESSURE_${n}_USDT`;e.symbol=symbol;e.id=`event-response-v1:${symbol}:${T}`;
    e.phase='FAILED';e.tradeId=`pressure_${n}`;
    e.entry={at:T+180000,price:100.123456789,progress:.0123456789,retained:.8123456789,noise:.00123456789};
    e.exit={at:T+1800000,reason:'RESPONSE_ADVANTAGE_LOST',price:101.123456789,net:5.123456789,peak:.023456789,giveback:.0123456789};
    e.quote={firstAt:T+120000,firstPrice:100.8123456789,lastAt:T+124000,samples:3,peak:.0123456789,retained:.8123456789};
    e.reason='自身推进已连续保留，核对随后真实盘口与成交成本；本次自身启动未保留，记住失败，不重置事件再追单'.repeat(2);
    e.changes=Array.from({length:3},(_,i)=>({at:T+i,code:'RESPONSE_OPTIONAL_EXPLANATION_CHANGE_WITH_DETAILED_CONTEXT',price:100.123456789}));
    e.outcomes=e.outcomes.map(o=>({...o,at:o.dueAt,observedAt:o.dueAt,price:101.123456789,move:.0123456789,status:'OBSERVED'}));
    r.events[symbol]=e;
  }
  assert.ok(Buffer.byteLength(JSON.stringify(r))>EVENT_RESEARCH_BYTES);
  const receipts=Object.values(r.events).map(e=>({id:e.id,detectedAt:e.detectedAt,anchorAt:e.anchorAt,anchorPrice:e.anchorPrice,entry:e.entry,exit:e.exit,outcomes:e.outcomes}));
  boundedEventResearch(r);
  assert.ok(r.bytes<=EVENT_RESEARCH_BYTES);assert.equal(r.bytes,Buffer.byteLength(JSON.stringify(r)));assert.ok(normalizeEventResearch(r));
  assert.deepEqual(Object.values(r.events).map(e=>({id:e.id,detectedAt:e.detectedAt,anchorAt:e.anchorAt,anchorPrice:e.anchorPrice,entry:e.entry,exit:e.exit,outcomes:e.outcomes})),receipts);
  assert.ok(Object.values(r.events).every(e=>e.compacted&&!e.quote));
  // Native risk/lot rejection must not consume an event or lose its frozen proof.
  const blocked=structuredClone(r);
  for(const e of Object.values(blocked.events)){
    delete e.exit;delete e.entry;delete e.tradeId;e.phase='READY';e.last=structuredClone(source.e.last);
    e.quote={firstAt:T+120000,firstPrice:100.8,lastAt:T+124000,samples:3,peak:.008,retained:1};
    e.admission={at:T+124000,code:'NATIVE_ADMISSION',reason:'本周期资金风险预算已用完，保持原来的限制，等待真实可用预算'.repeat(5),price:100.8};
  }
  boundedEventResearch(blocked);assert.ok(normalizeEventResearch(blocked));
  assert.ok(blocked.bytes<=EVENT_RESEARCH_BYTES);
  assert.ok(Object.values(blocked.events).every(e=>e.proofAt===source.e.proofAt&&e.last&&!e.quote&&e.admission?.code==='NATIVE_ADMISSION'));
});
function holding(side=1){const m:ResponseHolding={version:'event-response-v1',eventId:'event',entryAt:T,sourceAt:0,peak:0,peakAt:T,
  lastClose:100,lastCloseAt:T,counterSince:null,recoveryMs:null,failedRecoveries:0,counterProgress:0,stage:'LAUNCH',reason:'test',points:[]};
  return{side:side>0?'LONG':'SHORT',entryPrice:100,openedAt:T,stopPrice:100-side*3,unified:{response:m}} as Trade;}
test('failed launch exits before money stop on repeated own opposite progress; a single counter bar remains observational',()=>{
  const t=holding(),rows=bars([...Array(14).fill(100),99.7],60000,T+60000);
  const first=eventHoldingDecision(t,q(T+60000,99.7),T+60000,bars(Array(36).fill(100)),rows);assert.equal(first.exit,null);
  t.unified!.response=first.memory;
  const next=eventHoldingDecision(t,q(T+120000,99.4),T+120000,bars(Array(36).fill(100)),bars([...Array(13).fill(100),99.7,99.4],60000,T+120000));
  assert.equal(next.exit,'RESPONSE_LAUNCH_FAILED');assert.equal(next.stop,97);
});
test('earned runner tolerates ordinary pullback then exits on preserved opposition and repeated failed recovery',()=>{
  for(const side of [1,-1]){const t=holding(side),peak=100+side*2;
    t.unified!.response!.peak=.02;t.unified!.response!.peakAt=T+60000;t.unified!.response!.lastClose=peak;t.unified!.response!.lastCloseAt=T+60000;
    const one=eventHoldingDecision(t,q(T+120000,100+side*1.6),T+120000,bars(Array(36).fill(100)),bars([...Array(13).fill(100),peak,100+side*1.6],60000,T+120000));
    assert.equal(one.exit,null);t.unified!.response=one.memory;t.stopPrice=one.stop;
    const two=eventHoldingDecision(t,q(T+180000,100+side*.8),T+180000,bars(Array(36).fill(100)),bars([...Array(12).fill(100),peak,100+side*1.6,100+side*.8],60000,T+180000));
    assert.equal(two.exit,'RESPONSE_ADVANTAGE_LOST');assert.ok(side*(two.stop-100)>0);}
});
test('matched older valid protection joins strongest base; malformed price and immutable financial identities still fail closed',()=>{
  const s=initialForward(T-7200000);s.positions=[{...holding(),id:'p',openedAt:T,favorable:.02,adverse:.01,lastPrice:102,lastQuoteAt:T+60000,
    stopPrice:101,holdScore:70,profitFloorRate:.01,peakPnlRate:.02,unified:undefined} as Trade];
  s.storage.persistedAt=T;s.revision=1;
  const overlay=buildForwardProtectionCheckpoint(s);s.positions[0]!.favorable=.03;s.positions[0]!.stopPrice=101.5;s.positions[0]!.lastQuoteAt=T+62000;
  const next=restoreForwardProtectionCheckpoint(s,overlay);assert.equal(next.positions[0]!.stopPrice,101.5);assert.equal(next.positions[0]!.favorable,.03);
  for(const bad of [NaN,-1]){const c=structuredClone(overlay);c.positions[0]!.lastPrice=bad;assert.throws(()=>restoreForwardProtectionCheckpoint(s,c));}
  const bad=structuredClone(overlay);bad.positions[0]!.openedAt++;assert.throws(()=>restoreForwardProtectionCheckpoint(s,bad));
});
test('actual new controller submits and fills native PAPER for both sides, preserves account and exports causal events',async()=>{
  for(const side of [1,-1]){
    let s=initialForward(T-7200000);const start=s.startedAt,c={quantoMultiplier:.1,leverageMax:20,maintenanceRate:.005,minContracts:1,tickSize:.01,
      enableDecimal:false,orderSizeMin:'1',orderSizeMax:'100000',marketOrderSizeMax:'100000'};
    const timing={version:'native-position-first-observed-v1' as const,prepareMs:2000,confirmMs:0,basis:'EXECUTION_CLOCK' as const,samples:0};
    const apply=(i:ReturnType<typeof market>)=>{s.extremumRegime.symbols=i.states;s.extremumRegime.updatedAt=i.now;
      s=advanceDirectStrategy({state:s,now:i.now,specialInverse:false,specialMove:true,marketAuthority:true,allowDataCycle:false,paths:i.paths,minutePaths:i.minutes,
        quotes:i.quotes,analysisQuotes:i.quotes,contracts:{A_USDT:c},paperTiming:timing}).state;};
    apply(market());assert.equal(s.positions.length,0);
    for(let n=0;n<=4;n++){const now=T+120000+n*2000,i=market(now,100+side*.8);
      i.minutes.A_USDT=bars([...Array(13).fill(100),100+side*.65,100+side*.8],60000,T+120000);apply(i);}
    assert.equal(s.startedAt,start);assert.equal(s.positions.length,1,JSON.stringify(s.directStrategy!.eventResearch));
    const t=s.positions[0]!;assert.equal(t.paperOrder!.phase,'FILLED',JSON.stringify(t.paperOrder));assert.equal(t.side,side>0?'LONG':'SHORT');
    assert.ok(t.notional>16);assert.equal(t.unified!.response!.entryAt,t.openedAt);assert.equal(t.unified!.marketRoute!.targetBasis,'MEASURED_RESPONSE');
    assert.ok(t.entryFee>0);normalizeForward(s,T+128000);
    const full=await prepareForwardWrite(null,s,T+128000,{compact:true}),db=new Map(Object.entries(full.entries)),restored=await readForwardStore({get:async<V>(k:string)=>structuredClone(db.get(k)) as V|undefined},T+130000);
    assert.equal(restored.startedAt,start);assert.equal(restored.positions[0]!.entryPrice,t.entryPrice);
    assert.equal(restored.directStrategy!.eventResearch!.events.A_USDT!.id,s.directStrategy!.eventResearch!.events.A_USDT!.id);
    const snapshot=buildReviewSnapshot({view:forwardSummary(restored,{A_USDT:q(T+130000,100+side*.8)},T+130000),exportedAt:T+130000,buildSha:'test',strategyFingerprint:'test'});
    const audit=snapshot.research.eventResponseAudit as {events:ResponseEvent[];holdings:unknown[]};assert.ok(audit.events.length);assert.equal(audit.holdings.length,1);
    const damaged=structuredClone(restored),balance=damaged.balance;damaged.directStrategy!.eventResearch!.version='corrupt' as never;
    const protectedState=advanceDirectStrategy({state:damaged,now:T+132000,specialInverse:false,specialMove:true,marketAuthority:true,paths:{},
      quotes:{A_USDT:q(T+132000,100-side*2)},contracts:{A_USDT:c},paperTiming:timing}).state;
    assert.ok(protectedState.directStrategy!.eventResearchError);assert.equal(protectedState.balance,balance);
    assert.equal(protectedState.positions[0]!.paperOrder!.action!.kind,'CLOSE','optional watch failure cannot block own fresh hard protection');
  }
});
test('invalid optional watch memory is visible and never fabricates replacement events or resets money',()=>{
  const {r}=launched(),s=initialForward(T-7200000);
  const activated=advanceDirectStrategy({state:s,now:T,specialInverse:false,specialMove:true,marketAuthority:true,paths:{},quotes:{},contracts:{}}).state;
  activated.directStrategy!.eventResearch={...r,version:'corrupt'} as never;
  const result=advanceDirectStrategy({state:activated,now:T+130000,specialInverse:false,specialMove:true,marketAuthority:true,paths:{},quotes:{},contracts:{}}).state;
  assert.equal(result.startedAt,s.startedAt);assert.ok(result.directStrategy!.eventResearchError);assert.equal(result.positions.length,0);
});
test('explicit manual PAPER reset remains readable and does not retain another account event-to-trade links',()=>{
  const s=advanceDirectStrategy({state:initialForward(T-7200000),now:T,specialInverse:false,specialMove:true,marketAuthority:true,paths:{},quotes:{},contracts:{}}).state;
  s.directStrategy!.eventResearch=launched().r;s.directStrategy!.eventResearch!.events.A_USDT!.tradeId='retired-account-trade';
  const reset=resetForwardAccountPreservingLearning(s,T+180000);normalizeForward(reset,T+180001);
  const next=advanceDirectStrategy({state:reset,now:T+180002,specialInverse:false,specialMove:true,marketAuthority:true,paths:{},quotes:{},contracts:{}}).state;
  assert.equal(next.startedAt,reset.startedAt);assert.equal(next.balance,reset.balance);
  assert.equal(next.directStrategy!.eventResponse!.cutoverAt,T+180002);assert.equal(Object.keys(next.directStrategy!.eventResearch!.events).length,0);
  assert.deepEqual(next.extremumRegime,reset.extremumRegime);
});
