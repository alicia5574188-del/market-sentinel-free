import test from 'node:test';
import assert from 'node:assert/strict';
import {advanceRangeResearch,decodeRangeWindow,rangeDirection,strongRangeProof,rangeMarketRoute,makeRangeHolding,
  rangeHoldingDecision,rangeExecutionAdmission,scanRangeAnomalies,normalizeRangeResearch,rangeObservationSymbols,fairRangeRefreshBatch,
  validRangeHolding,thinFiveTape,sparseFiveTurnover,activeSwingRange,lastingRange,RANGE_OUTCOME_BYTES,RANGE_RESEARCH_BYTES,type RangeResearch,type RangeWindows,type RangeScanner} from '../lib/anomaly-range.ts';
import {advanceDirectStrategy} from '../lib/direct-strategy.ts';
import {initialForward,normalizeForward,forwardSummary,resetForwardAccountPreservingLearning,type Quote} from '../lib/forward-relations.ts';
import {buildForwardProtectionCheckpoint,restoreForwardProtectionCheckpoint} from '../lib/forward-protection-checkpoint.ts';
import {prepareForwardWrite,readForwardStore} from '../lib/forward-store.ts';
import {buildReviewSnapshot} from '../lib/research-snapshot.ts';
import {MarketDataHub} from '../lib/market-data-hub.ts';
import {fetchContractDirectory} from '../lib/gate-market.ts';
import {validMarketRoute} from '../lib/market-authority.ts';
import {rangePriority,selectRangePlans,rankRangeDiscovery} from '../lib/range-scheduler.ts';
import type {CandleLike} from '../lib/market-intelligence-engine.ts';
const B=300000,T=Math.floor(1791014400000/B)*B;
const candle=(at:number,open:number,close:number,span=.4):CandleLike=>({time:at/1000,open,close,
  high:Math.max(open,close)+span/2,low:Math.min(open,close)-span/2,volume:100,turnoverUsd:10000,volumeVenue:'BYBIT'});
const quote=(at:number,p:number):Quote=>({bestBid:p-.0001,bestAsk:p+.0001,observedAt:at,fresh:true,entryReady:true,sourceCount:2,priceSource:'BYBIT',
  bookCoverage:'DEPTH20',bids:[{price:p-.0001,size:100000}],asks:[{price:p+.0001,size:100000}]});
function fixture(side=1,kind:'EDGE_BREAKOUT'|'EDGE_RETURN'='EDGE_BREAKOUT'){
  const windows:RangeWindows={},prior=Array.from({length:120},(_,i)=>candle(T-(120-i)*B,100+Math.sin(i/7),100+Math.sin(i/7))),
    H=Math.max(...prior.map(r=>r.high)),L=Math.min(...prior.map(r=>r.low)),edge=side>0?H:L,
    close=kind==='EDGE_BREAKOUT'?edge+side*.15:edge-side*.09,proofSide=kind==='EDGE_BREAKOUT'?side:-side,
    eventBar=candle(T,kind==='EDGE_BREAKOUT'?edge-side*.1:edge+side*.05,close,.02),
    minutes=[...Array.from({length:20},(_,i)=>candle(T+B-(20-i)*60000,close-.005,close,.03)),
      candle(T+B,close,close+proofSide*.07,.005),candle(T+B+60000,close+proofSide*.07,close+proofSide*.14,.005)],now=T+B+120000,
    discovery={at:T,scanned:500,shared:500,excluded:0,marketSamples:500,marketMove:0,loaded:1,queued:0,
      anomalies:[{symbol:'A_USDT',detectedAt:T,source:'BYBIT',sourceCount:2,own:side*.01,residual:side*.01,score:90,kind:'OWN_ACCELERATION'}]},
    paths={A_USDT:[...prior,eventBar]},q=quote(now,minutes.at(-1)!.close),input={now,windows,paths,minutes:{A_USDT:minutes},quotes:{A_USDT:q},ticks:{A_USDT:.001},discovery,positions:[],history:[]};
  const research=advanceRangeResearch(input);return{input,research,e:research.events.A_USDT!,q,prior,H,L};
}
test('pre-event 120 OHLC are lossless and frozen; current spike cannot move the range',()=>{
  const f=fixture();assert.equal(f.e.H,f.H);assert.equal(f.e.L,f.L);assert.equal(f.e.minutes,600);
  const decoded=decodeRangeWindow(f.input.windows[f.e.id]!);assert.deepEqual(decoded.map(r=>[r.open,r.high,r.low,r.close]),f.prior.map(r=>[r.open,r.high,r.low,r.close]));
  assert.ok(Buffer.byteLength(JSON.stringify(f.input.windows[f.e.id]))<8192);
  const next=advanceRangeResearch({...f.input,previous:f.research,now:f.input.now+2000});assert.equal(next.events.A_USDT!.id,f.e.id);assert.equal(next.events.A_USDT!.H,f.H);
  const broken={...f.input,windows:{},paths:{A_USDT:f.input.paths.A_USDT.slice(2)}};assert.equal(Object.keys(advanceRangeResearch(broken).events).length,0);
  const short={...f.input,windows:{},paths:{A_USDT:f.input.paths.A_USDT.slice(1)}};assert.equal(advanceRangeResearch(short).events.A_USDT!.minutes,595);
  assert.throws(()=>decodeRangeWindow({...f.input.windows[f.e.id]!,ohlc64:'broken'}));
});
test('outward completed five then new strong minutes authorize both sides; future/internal/wrong-source bars do not',()=>{
  for(const side of [1,-1]){const f=fixture(side);assert.equal(f.e.phase,'READY');assert.equal(f.e.proof!.side,side>0?'LONG':'SHORT');assert.equal(f.e.proof!.kind,'EDGE_BREAKOUT');
    assert.ok(f.e.proof!.bars.every(at=>at>f.e.proof!.fiveAt));const r=rangeMarketRoute(f.research,'A_USDT',(f.q.bestAsk+f.q.bestBid)/2,f.input.now,f.q);assert.ok(r.route);assert.ok(validMarketRoute(r.route));
    const no=advanceRangeResearch({...f.input,windows:{},now:f.input.now-1});assert.notEqual(no.events.A_USDT?.phase,'READY');
    const foreign=advanceRangeResearch({...f.input,windows:{},minutes:{A_USDT:f.input.minutes.A_USDT.map(r=>({...r,volumeVenue:'OKX'}))}});assert.notEqual(foreign.events.A_USDT?.phase,'READY');
  }
  const f=fixture();assert.equal(strongRangeProof(f.input.minutes.A_USDT,T+B+120000,'LONG',f.e.n5,.001,()=>true),undefined);
  assert.equal(rangeMarketRoute(f.research,'A_USDT',f.q.bestAsk,f.input.now+120001,{...f.q,observedAt:f.input.now+120001}).route,null);
});
test('a breakout already inside the scan window keeps the prior range and does not wait for its high',()=>{
  const prior=Array.from({length:120},(_,i)=>candle(T-(120-i)*B,100+2*Math.sin(i/8),100+2*Math.sin(i/8),.3)),oldH=Math.max(...prior.slice(0,116).map(r=>r.high));
  prior[116]=candle(T-(120-116)*B,102,110,.2);
  for(const i of [117,118,119])prior[i]=candle(T-(120-i)*B,104.6,105,.2);
  const now=T+90000,minutes=[candle(T-120000,104.6,104.8,.1),candle(T-60000,104.8,105,.1)],q=quote(now,105),windows:RangeWindows={},
    discovery={at:T,scanned:1,shared:1,excluded:0,marketSamples:1,marketMove:0,loaded:1,queued:0,
      anomalies:[{symbol:'A_USDT',detectedAt:T,source:'BYBIT',sourceCount:2,own:.02,residual:.02,score:90,kind:'OWN_ACCELERATION'}]},
    input={now,windows,paths:{A_USDT:prior},minutes:{A_USDT:minutes},quotes:{A_USDT:q},ticks:{A_USDT:.001},discovery,positions:[],history:[]},
    e=advanceRangeResearch(input).events.A_USDT!;
  assert.equal(e.phase,'READY',e?.reason);assert.equal(e.proof!.kind,'EDGE_BREAKOUT');assert.equal(e.proof!.side,'LONG');
  assert.equal(e.H,oldH);assert.ok(e.H<prior[116]!.high);assert.ok(e.proof!.price<prior[116]!.high);
  assert.equal(validRangeHolding(makeRangeHolding(e,windows[e.id]!,105,q,now)),true);
  const contrary=advanceRangeResearch({...input,windows:{},discovery:{...discovery,anomalies:[{...discovery.anomalies[0]!,own:-.02,residual:-.02}]}}).events.A_USDT!;
  assert.notEqual(contrary.proof?.kind,'EDGE_BREAKOUT');assert.ok(contrary.H>e.H);
  const chased=advanceRangeResearch({...input,windows:{},quotes:{A_USDT:quote(now,112)},minutes:{A_USDT:[candle(T-120000,111,111.4,.1),candle(T-60000,111.4,112,.1)]}}).events.A_USDT!;
  assert.notEqual(chased.phase,'READY');assert.match(chased.reason,/不追/);
});
test('a rejection already inside the scan window uses the prior edge instead of the spike',()=>{
  const prior=Array.from({length:120},(_,i)=>candle(T-(120-i)*B,100+2*Math.sin(i/8),100+2*Math.sin(i/8),.3)),oldH=Math.max(...prior.slice(0,116).map(r=>r.high));
  prior[116]=candle(T-(120-116)*B,103,oldH-.12,.3);
  for(const i of [117,118,119])prior[i]=candle(T-(120-i)*B,oldH-.1,oldH-.12,.1);
  const now=T+90000,px=oldH-.12,minutes=[candle(T-120000,px+.02,px,.05),candle(T-60000,px,px-.01,.05)],q=quote(now,px-.01),windows:RangeWindows={},
    discovery={at:T,scanned:1,shared:1,excluded:0,marketSamples:1,marketMove:0,loaded:1,queued:0,
      anomalies:[{symbol:'A_USDT',detectedAt:T,source:'BYBIT',sourceCount:2,own:-.02,residual:-.02,score:90,kind:'OWN_ACCELERATION'}]},
    e=advanceRangeResearch({now,windows,paths:{A_USDT:prior},minutes:{A_USDT:minutes},quotes:{A_USDT:q},ticks:{A_USDT:.001},discovery,positions:[],history:[]}).events.A_USDT!;
  assert.equal(e.phase,'READY',e?.reason);assert.equal(e.proof!.kind,'EDGE_RETURN');assert.equal(e.proof!.side,'SHORT');
  assert.equal(e.H,oldH);assert.ok(e.H<prior[116]!.high);
});
test('a pullback low inside the last ten hours does not replace the low before the high',()=>{
  const older=Array.from({length:80},(_,i)=>candle(T-(200-i)*B,100+Math.sin(i/6),100+Math.sin(i/6),.4));
  older[40]=candle(T-(200-40)*B,100,96,.3);
  const rally=candle(T-(200-70)*B,100,130,.4),after=Array.from({length:120},(_,i)=>candle(T-(120-i)*B,122,122,.4));
  after[80]=candle(T-(120-80)*B,122,118,.3);
  const prior=[...older.slice(0,70),rally,...older.slice(71),...after],now=T+90000,q=quote(now,121),windows:RangeWindows={},
    discovery={at:T,scanned:1,shared:1,excluded:0,marketSamples:1,marketMove:0,loaded:1,queued:0,
      anomalies:[{symbol:'A_USDT',detectedAt:T,source:'BYBIT',sourceCount:2,own:-.02,residual:-.02,score:90,kind:'OWN_ACCELERATION'}]},
    e=advanceRangeResearch({now,windows,paths:{A_USDT:prior},minutes:{A_USDT:[candle(T-120000,121.2,121,.1),candle(T-60000,121,120.8,.1)]},
      quotes:{A_USDT:q},ticks:{A_USDT:.001},discovery,positions:[],history:[]}).events.A_USDT!;
  assert.ok(e.L<118,`floor ${e.L} stayed at the pullback`);assert.ok(e.H>125,`high ${e.H}`);
  assert.notEqual(e.proof?.side,'SHORT');
});
test('a later puncture that closes back keeps the older high, and a bad freeze cannot stop the account',()=>{
  const n=220,bars=Array.from({length:n},(_,i)=>candle(T-(n-i)*B,100,100,.2)),hi=n-192;
  bars[hi-15]=candle(T-(n-(hi-15))*B,100,97,.15);
  bars[hi]=candle(T-(n-hi)*B,104,107.6,.16);
  bars[hi+1]=candle(T-(n-(hi+1))*B,107.4,103,.16);
  for(let i=hi+2;i<n-6;i++)bars[i]=candle(T-(n-i)*B,103.4,103.4,.2);
  const si=n-5;
  bars[si]=candle(T-(n-si)*B,104,112,.2);
  for(let i=si+1;i<n;i++)bars[i]=candle(T-(n-i)*B,108,107.5,.16);
  const now=T+90000,q=quote(now,107.5),windows:RangeWindows={},
    discovery={at:T,scanned:1,shared:1,excluded:0,marketSamples:1,marketMove:0,loaded:1,queued:0,
      anomalies:[{symbol:'A_USDT',detectedAt:T,source:'BYBIT',sourceCount:2,own:-.02,residual:-.02,score:90,kind:'OWN_ACCELERATION'}]},
    e=advanceRangeResearch({now,windows,paths:{A_USDT:bars},minutes:{A_USDT:[candle(T-120000,107.7,107.55,.1),candle(T-60000,107.55,107.5,.1)]},
      quotes:{A_USDT:q},ticks:{A_USDT:.001},discovery,positions:[],history:[]}).events.A_USDT!;
  assert.ok(e.H>107&&e.H<110,`high ${e.H} followed the puncture`);assert.ok(e.L<99,`floor ${e.L}`);
  const lag=Array.from({length:130},(_,i)=>candle(T-2*B-(130-i)*B,100,100,.2)),late:RangeWindows={};
  assert.equal(advanceRangeResearch({now,windows:late,paths:{A_USDT:lag},minutes:{A_USDT:[]},quotes:{A_USDT:q},ticks:{A_USDT:.001},discovery,positions:[],history:[]}).events.A_USDT,undefined);
  assert.equal(Object.keys(late).length,0);
  const state=structuredClone(trade().state),id=Object.keys(state.directStrategy!.rangeWindows??{})[0]??`anomaly-range-v1:BAD_USDT:${T}`;
  state.directStrategy!.rangeWindows??={};state.directStrategy!.rangeWindows[id]={source:'BYBIT',start:T-120*B,cutoff:T+B,count:120,ohlc64:windows[e.id]!.ohlc64};
  const restored=normalizeForward(state,now);assert.equal(restored.directStrategy!.rangeWindows![id],undefined);
});
test('near-edge rejection needs no new high/low; executing return remains at edge and cost-checked',()=>{
  for(const side of [1,-1]){const f=fixture(side,'EDGE_RETURN');assert.equal(f.e.proof?.kind,'EDGE_RETURN');assert.equal(f.e.proof?.side,side>0?'SHORT':'LONG');
    assert.ok(rangeMarketRoute(f.research,'A_USDT',f.q.bestAsk,f.input.now,f.q).route);
    assert.equal(rangeMarketRoute(f.research,'A_USDT',100,f.input.now,quote(f.input.now,100)).route,null);}
});
test('an inside turn near the edge is a return without strong bars, and a wick or the first close outside does not stop',()=>{
  const prior=Array.from({length:120},(_,i)=>candle(T-(120-i)*B,100.25,100.25,.2));
  prior[8]=candle(T-(120-8)*B,100,99.2,.15);
  prior[60]=candle(T-(120-60)*B,100.3,101.35,.12);
  prior[119]=candle(T-B,101.35,101.25,.08);
  const now=T+120000,minutes=[candle(T,101.28,101.22,.08),candle(T+60000,101.22,101.18,.08)],q=quote(now,101.18),windows:RangeWindows={},
    discovery={at:T,scanned:1,shared:1,excluded:0,marketSamples:1,marketMove:0,loaded:1,queued:0,
      anomalies:[{symbol:'A_USDT',detectedAt:T,source:'BYBIT',sourceCount:2,own:.01,residual:.01,score:90,kind:'OWN_ACCELERATION'}]},
    research=advanceRangeResearch({now,windows,paths:{A_USDT:prior},minutes:{A_USDT:minutes},quotes:{A_USDT:q},ticks:{A_USDT:.001},discovery,positions:[],history:[]}),
    e=research.events.A_USDT!;
  assert.equal(e.proof?.kind,'EDGE_RETURN',e?.reason);assert.equal(e.proof?.side,'SHORT');
  const px=e.proof!.price,holding=makeRangeHolding(e,windows[e.id]!,px,q,now),base=structuredClone(trade().t);
  base.side='SHORT';base.openedAt=now;base.entryPrice=px;base.stopPrice=e.proof!.stop;base.unified!.anomaly=holding;base.unified!.branch='RETURN';
  const room=Math.max(holding.n5,holding.D),edge=holding.H;
  const wick=candle(T+B,edge,edge-holding.D,.05);wick.high=edge+room+holding.n5;wick.low=Math.min(wick.low,edge-holding.D);
  const wickAt=T+B+300000+1000,wicked=rangeHoldingDecision(base,quote(wickAt,edge-holding.D),wickAt,[...prior,wick],minutes);
  assert.equal(wicked.exit,undefined,wicked.reason);assert.equal(wicked.memory.returnProbeAt,undefined);
  const stabbed=rangeHoldingDecision(base,quote(now+1000,e.proof!.stop+holding.n5),now+1000,prior,minutes);
  assert.equal(stabbed.exit,undefined,'a tick through the structural stop is not a second close');
  const out1=candle(T+2*B,edge,edge+room+holding.n5*.5,.05);
  base.unified!.anomaly=wicked.memory;
  const probed=rangeHoldingDecision(base,quote(T+2*B+300000+1000,out1.close),T+2*B+300000+1000,[...prior,wick,out1],minutes);
  assert.equal(probed.exit,undefined,probed.reason);assert.ok(probed.memory.returnProbeAt);assert.equal(probed.memory.returnBackAt,undefined);
  const back=candle(T+3*B,edge,edge-holding.n5*.4,.05);
  base.unified!.anomaly=probed.memory;
  const returned=rangeHoldingDecision(base,quote(T+3*B+300000+1000,back.close),T+3*B+300000+1000,[...prior,wick,out1,back],minutes);
  assert.equal(returned.exit,undefined,returned.reason);assert.ok(returned.memory.returnBackAt);
  const out2=candle(T+4*B,edge,edge+room+holding.n5,.05);
  base.unified!.anomaly=returned.memory;
  const second=rangeHoldingDecision(base,quote(T+4*B+300000+1000,out2.close),T+4*B+300000+1000,[...prior,wick,out1,back,out2],minutes);
  assert.equal(second.exit,'RANGE_RETURN_FAILED');
  const fresh=structuredClone(base);fresh.unified!.anomaly=structuredClone(holding);fresh.stopPrice=e.proof!.stop;
  const done=rangeHoldingDecision(fresh,quote(now+4000,e.proof!.target*holding.scale-.05),now+4000,prior,minutes);
  assert.equal(done.exit,'RANGE_RETURN_TARGET');
});
test('a return does not scratch a profit bounce before the center or a second outside close',()=>{
  const f=fixture(1,'EDGE_RETURN'),e=f.e,px=e.proof!.price,holding=makeRangeHolding(e,f.input.windows[e.id]!,px,f.q,f.input.now),
    t=structuredClone(trade().t),target=e.proof!.target*holding.scale;
  holding.initialRisk=holding.n5*.25;
  const R=holding.initialRisk,favorable=px-holding.n5;
  assert.ok(favorable>target+holding.D,'profit must stop short of the center');
  assert.ok(px-favorable>2*R);
  t.side='SHORT';t.openedAt=f.input.now;t.entryPrice=px;t.stopPrice=e.proof!.stop;t.unified!.anomaly=holding;t.unified!.branch='RETURN';
  let r=rangeHoldingDecision(t,quote(f.input.now+2000,favorable),f.input.now+2000,f.input.paths.A_USDT,f.input.minutes.A_USDT);
  assert.equal(r.exit,undefined);assert.equal(r.stop,e.proof!.stop);t.unified!.anomaly=r.memory;
  for(const n of [4000,6000,8000]){r=rangeHoldingDecision(t,quote(f.input.now+n,favorable),f.input.now+n,f.input.paths.A_USDT,f.input.minutes.A_USDT);
    assert.equal(r.stop,e.proof!.stop);t.unified!.anomaly=r.memory;t.stopPrice=r.stop;}
  assert.ok(r.memory.retainedPeak>2*R);
  const bounced=rangeHoldingDecision(t,quote(f.input.now+10000,px-R*.2),f.input.now+10000,f.input.paths.A_USDT,f.input.minutes.A_USDT);
  assert.equal(bounced.exit,undefined,bounced.reason);assert.equal(bounced.stop,e.proof!.stop);
  const armed=structuredClone(t);armed.stopPrice=px-R;armed.unified!.anomaly!.retainedPeak=holding.n5;
  const crossed=rangeHoldingDecision(armed,quote(f.input.now+12000,px-R*.2),f.input.now+12000,f.input.paths.A_USDT,f.input.minutes.A_USDT);
  assert.equal(crossed.exit,undefined,crossed.reason);
});
test('a green bar or a wick at the old edge is not a return, but the next close back from a new extreme is',()=>{
  const prior=Array.from({length:120},(_,i)=>candle(T-(120-i)*B,100,100,.4));
  prior[10]!.high=101.2;prior[10]!.close=100.4;
  const wick=candle(T,100.9,101.05,.1);wick.high=101.55;
  const stuck=candle(T+B,101.02,100.96,.04),stuck2=candle(T+B+60000,100.96,100.9,.04);
  const no=advanceRangeResearch({now:T+B+120000,windows:{},paths:{A_USDT:[...prior,wick]},
    minutes:{A_USDT:[stuck,stuck2]},quotes:{A_USDT:quote(T+B+120000,100.9)},ticks:{A_USDT:.001},positions:[],history:[],
    discovery:{at:T,scanned:1,shared:1,excluded:0,marketSamples:1,marketMove:0,loaded:1,queued:0,
      anomalies:[{symbol:'A_USDT',detectedAt:T,source:'BYBIT',sourceCount:2,own:-.01,residual:-.01,score:80,kind:'OWN_ACCELERATION'}]}}).events.A_USDT!;
  assert.notEqual(no.proof?.kind,'EDGE_RETURN',no.reason);
  const spike=candle(T,100.3,102.6,.2);spike.high=103;
  const back=candle(T+B,102.9,102.75,.1);
  const m1=candle(T+2*B,102.75,102.65,.04),m2=candle(T+2*B+60000,102.65,102.55,.04),now=T+2*B+120000;
  const yes=advanceRangeResearch({now,windows:{},paths:{A_USDT:[...prior,spike,back]},minutes:{A_USDT:[m1,m2]},
    quotes:{A_USDT:quote(now,102.55)},ticks:{A_USDT:.001},positions:[],history:[],
    discovery:{at:T,scanned:1,shared:1,excluded:0,marketSamples:1,marketMove:0,loaded:1,queued:0,
      anomalies:[{symbol:'A_USDT',detectedAt:T,source:'BYBIT',sourceCount:2,own:-.01,residual:-.01,score:80,kind:'OWN_ACCELERATION'}]}}).events.A_USDT!;
  assert.equal(yes.proof?.kind,'EDGE_RETURN',yes?.reason);assert.equal(yes.proof?.side,'SHORT');
  assert.ok(Math.abs(yes.H-103)<1e-9,`edge ${yes.H} should be the fresh high`);
  assert.ok(yes.proof!.stop>103);
  const rising=candle(T+2*B,102.7,102.85,.04),rising2=candle(T+2*B+60000,102.85,102.95,.04);
  const early=advanceRangeResearch({now,windows:{},paths:{A_USDT:[...prior,spike,back]},minutes:{A_USDT:[rising,rising2]},
    quotes:{A_USDT:quote(now,102.95)},ticks:{A_USDT:.001},positions:[],history:[],
    discovery:{at:T,scanned:1,shared:1,excluded:0,marketSamples:1,marketMove:0,loaded:1,queued:0,
      anomalies:[{symbol:'A_USDT',detectedAt:T,source:'BYBIT',sourceCount:2,own:-.01,residual:-.01,score:80,kind:'OWN_ACCELERATION'}]}}).events.A_USDT!;
  assert.notEqual(early.proof?.side,'SHORT',early?.reason);
});
test('a completed close through the old floor promotes the later pulled-back high',()=>{
  const bars=Array.from({length:80},(_,i)=>candle(T-(80-i)*B,100,100,.3));
  bars[15]=candle(T-(80-15)*B,100,96,.2);bars[15]!.low=90;
  bars[25]=candle(T-(80-25)*B,110,128,.2);bars[25]!.high=130;
  for(let i=26;i<40;i++)bars[i]=candle(T-(80-i)*B,120,118,.2);
  bars[45]=candle(T-(80-45)*B,100,82,.2);bars[45]!.low=80;bars[45]!.close=82;
  bars[55]=candle(T-(80-55)*B,100,108,.2);bars[55]!.high=110;
  for(let i=56;i<80;i++)bars[i]=candle(T-(80-i)*B,104,102,.25);
  const swing=activeSwingRange(bars,.001,102);
  assert.equal(swing?.rebuilt,true);assert.ok(swing!.H>105&&swing!.H<120,`promoted high ${swing?.H}`);
  const wick=bars.map(r=>({...r}));
  for(let i=45;i<80;i++)wick[i]={...wick[i]!,open:110,close:112,high:i===55?130:114,low:i===45?80:108};
  const kept=activeSwingRange(wick,.001,112);
  assert.equal(kept?.rebuilt,false);assert.ok((kept?.H??0)>120,`wick kept the old high ${kept?.H}`);
});
test('a climb back above the later high restores the major high and the confirmed pullback low',()=>{
  const bars=Array.from({length:90},(_,i)=>candle(T-(90-i)*B,100,100,.3));
  bars[12]=candle(T-(90-12)*B,100,96,.2);bars[12]!.low=90;
  bars[24]=candle(T-(90-24)*B,110,128,.2);bars[24]!.high=130;
  for(let i=25;i<36;i++)bars[i]=candle(T-(90-i)*B,120,118,.2);
  bars[42]=candle(T-(90-42)*B,100,82,.2);bars[42]!.low=80;bars[42]!.close=82;
  bars[52]=candle(T-(90-52)*B,100,108,.2);bars[52]!.high=110;
  for(let i=53;i<64;i++)bars[i]=candle(T-(90-i)*B,104,102,.25);
  bars[70]=candle(T-(90-70)*B,100,88,.2);bars[70]!.low=86;
  for(let i=71;i<90;i++)bars[i]=candle(T-(90-i)*B,112,116,.2);
  const inside=activeSwingRange(bars.slice(0,64),.001,102);
  assert.equal(inside?.rebuilt,true);assert.ok((inside?.H??0)>105&&(inside?.H??0)<120,`still under the later high ${inside?.H}`);
  const back=activeSwingRange(bars,.001,116);
  assert.equal(back?.rebuilt,true);assert.ok((back?.H??0)>120,`major high restored ${back?.H}`);
  assert.ok((back?.L??999)<90,`pullback low kept ${back?.L}`);
  assert.ok(116>back!.L&&116<back!.H);
});
test('a break stays in force for two hours and a later close outside is not another breakout',()=>{
  const bars=Array.from({length:80},(_,i)=>candle(T-(160-i)*B,100,100,.3));
  bars[20]=candle(T-(160-20)*B,100,96,.2);bars[20]!.low=94;
  bars[40]=candle(T-(160-40)*B,104,108,.2);bars[40]!.high=110;
  for(let i=41;i<60;i++)bars[i]=candle(T-(160-i)*B,106,105,.2);
  const early=lastingRange(bars,.001,105);
  assert.ok(early&&early.H>108&&early.L<98,`range before the break ${early?.H}/${early?.L}`);
  const broke=candle(T-(160-60)*B,108,112,.2);
  const chasing=Array.from({length:20},(_,i)=>candle(T-(100-i)*B,112+i*.05,113+i*.05,.2));
  const held=lastingRange([...bars,broke,...chasing],.001,chasing.at(-1)!.close);
  assert.ok(held?.brokeAt,'the break is still the active range');
  assert.ok(held&&held.H>108&&held.H<111,`ceiling stayed ${held?.H}`);
  assert.ok((held?.L??999)<98,`floor stayed ${held?.L}`);
  const tail=chasing.at(-1)!,minutes=[candle(tail.time*1000,tail.close-.1,tail.close,.05),candle(tail.time*1000+60000,tail.close,tail.close+.1,.05)];
  const e=advanceRangeResearch({now:tail.time*1000+120000,windows:{},paths:{A_USDT:[...bars,broke,...chasing]},minutes:{A_USDT:minutes},
    quotes:{A_USDT:quote(tail.time*1000+120000,tail.close)},ticks:{A_USDT:.001},positions:[],history:[],
    discovery:{at:T,scanned:1,shared:1,excluded:0,marketSamples:1,marketMove:0,loaded:1,queued:0,
      anomalies:[{symbol:'A_USDT',detectedAt:bars[0]!.time*1000,source:'BYBIT',sourceCount:2,own:.02,residual:.02,score:90,kind:'OWN_ACCELERATION'}]}}).events.A_USDT!;
  assert.notEqual(e?.proof?.kind,'EDGE_BREAKOUT',e?.reason??'no event');
});
test('causal swing direction: three rising lows, declining highs and compression are distinct',()=>{
  const low=[1,2,3].map((price,i)=>({kind:'LOW' as const,price:price+90,at:T+i,confirmedAt:T+100+i})),
    high=[3,2,1].map((price,i)=>({kind:'HIGH' as const,price:price+100,at:T+i,confirmedAt:T+100+i}));
  assert.equal(rangeDirection(low,.4,T+200),'UP');assert.equal(rangeDirection(high,.4,T+200),'DOWN');
  assert.equal(rangeDirection([...low,...high],.4,T+200),'NEUTRAL');assert.equal(rangeDirection(low,.4,T+7200200),'NEUTRAL');
});
function trade(){const f=fixture(),r=rangeMarketRoute(f.research,'A_USDT',(f.q.bestBid+f.q.bestAsk)/2,f.input.now,f.q).route!,
  state=initialForward(T-3600000),out=advanceDirectStrategy({state,now:f.input.now,paths:f.input.paths,minutePaths:f.input.minutes,quotes:f.input.quotes,
    analysisQuotes:f.input.quotes,contracts:{A_USDT:{quantoMultiplier:.1,leverageMax:20,maintenanceRate:.005,minContracts:1,tickSize:.001,enableDecimal:false,orderSizeMin:'1',orderSizeMax:'1000000',marketOrderSizeMax:'1000000'}},
    marketAuthority:true,specialMove:true,anomalyRange:true,rangeDiscovery:f.input.discovery,paperTiming:{prepareMs:2000,confirmMs:0,basis:'EXECUTION_CLOCK',samples:0}});
  assert.equal(out.state.positions.length,1,JSON.stringify(out.state.directStrategy?.plans));
  const t=out.state.positions[0]!;assert.equal(t.side,r.side);assert.equal(t.unified!.anomaly!.kind,'EDGE_BREAKOUT');
  return{...f,state:out.state,t};}
test('actual new plan uses native fixed1000 sizing/queue; immutable witness survives account/restart/archive/snapshot',async()=>{
  const f=trade();assert.ok(f.t.paperOrder);assert.equal(f.t.forecast!.sizingEquity,1000);normalizeForward(structuredClone(f.state),f.input.now);
  const prepared=await prepareForwardWrite(null,f.state,f.input.now),store=new Map(Object.entries(prepared.entries)),
    restored=await readForwardStore({get:async(key:string)=>store.get(key)},f.input.now+1);
  assert.equal(restored!.positions[0]!.unified!.anomaly!.window.ohlc64,f.t.unified!.anomaly!.window.ohlc64);
  const checkpoint=buildForwardProtectionCheckpoint({...restored!,lastQuoteCycleAt:f.input.now+2000});
  assert.equal(checkpoint.positions[0]!.unified!.anomaly!.window,undefined,'immutable witness not duplicated every protection write');
  const over=restoreForwardProtectionCheckpoint(restored!,checkpoint);assert.equal(over.positions[0]!.unified!.anomaly!.window.ohlc64,f.t.unified!.anomaly!.window.ohlc64);
  const reset=resetForwardAccountPreservingLearning(over,f.input.now+4000);assert.equal(reset.directStrategy!.rangeResearch!.events.A_USDT!.id,f.e.id);
  const snapshot=buildReviewSnapshot({view:{...forwardSummary(restored!,f.input.quotes,f.input.now),positions:[f.t]},exportedAt:f.input.now,strategyFingerprint:null,buildSha:'test'} as Parameters<typeof buildReviewSnapshot>[0]);
  assert.ok(snapshot.research.anomalyRangeAudit);assert.equal((snapshot.research.anomalyRangeAudit as {holdings:unknown[]}).holdings.length,1);
});
test('normal pullbacks and thirty minutes alone do not close; internal/profit exits do not authorize a flip',()=>{
  const f=trade(),t=f.t;t.openedAt=f.input.now;t.unified!.anomaly=makeRangeHolding(f.e,f.input.windows[f.e.id]!,t.entryPrice,f.q,f.input.now);
  const normal=rangeHoldingDecision(t,quote(f.input.now+60000,t.entryPrice-.02),f.input.now+60000,f.input.paths.A_USDT,f.input.minutes.A_USDT);
  assert.equal(normal.exit,undefined);assert.equal(normal.memory.reverseEligible,false);
  const stagnant=rangeHoldingDecision(t,quote(f.input.now+1800000,t.entryPrice),f.input.now+1800000,[],[]);assert.equal(stagnant.exit,undefined);assert.equal(stagnant.memory.stage,'REVIEW');
  t.unified!.anomaly.kind='INTERNAL_TREND';const stopped=rangeHoldingDecision(t,quote(f.input.now+2000,t.stopPrice-.1),f.input.now+2000,[],[]);
  assert.equal(stopped.exit,'RANGE_HARD_PROTECTION');assert.equal(stopped.memory.reverseEligible,false);
});
test('opposite entry is per-account flat-confirmed, fresh and edge-bound; partial/unknown close blocks native entry',()=>{
  const f=trade();assert.match(rangeExecutionAdmission(f.t,f.q,f.input.now,false)!,/归零/);assert.equal(rangeExecutionAdmission(f.t,f.q,f.input.now,true),null);
  assert.match(rangeExecutionAdmission(f.t,quote(f.input.now+120001,f.q.bestAsk),f.input.now+120001,true)!,/过期/);
  f.t.unified!.anomaly!.kind='EDGE_RETURN';assert.match(rangeExecutionAdmission(f.t,quote(f.input.now,100),f.input.now,true)!,/证明|边缘/);
});
test('bulk discovery covers more than 30 coins; missing/changed-source history does not invent a move',()=>{
  const scanner:RangeScanner={prices:new Map(),detected:new Map()},rows=Array.from({length:200},(_,i)=>({symbol:`X${i}_USDT`,source:'BYBIT',sourceCount:2,last:100,observedAt:T,volume24hUsd:2e6}));
  for(let n=0;n<4;n++)scanRangeAnomalies(rows.map((r,i)=>({...r,last:i===199?100+n*.25:100,observedAt:T+n*60000})),scanner,T+n*60000,200,0);
  const s=scanRangeAnomalies(rows.map((r,i)=>({...r,last:i===199?102:100,observedAt:T+240000})),scanner,T+240000,200,0);
  assert.equal(s.scanned,200);assert.equal(s.marketSamples,200);assert.ok(s.anomalies.some(a=>a.symbol==='X199_USDT'));
  const switched=scanRangeAnomalies(rows.map(r=>({...r,source:'OKX',last:120,observedAt:T+300000})),{prices:new Map(),detected:new Map()},T+300000,200,0);assert.equal(switched.marketSamples,0);
  assert.throws(()=>scanRangeAnomalies(Array.from({length:4097},()=>rows[0]!),scanner,T,4097,0),/CAPACITY/);
});
test('all thirty candidates compete for ten plans within original byte and window budgets',()=>{
  const f=fixture(),paths=Object.fromEntries(Array.from({length:30},(_,i)=>[`X${i}_USDT`,f.input.paths.A_USDT])),
    discovery={...f.input.discovery,anomalies:Array.from({length:30},(_,i)=>({...f.input.discovery.anomalies[0]!,symbol:`X${i}_USDT`}))};
  const windows:RangeWindows={},s=advanceRangeResearch({...f.input,paths,windows,discovery});assert.equal(s.waiting,20);assert.equal(Object.keys(s.events).length,10);
  assert.equal(Object.keys(windows).length,30);assert.ok(Object.values(s.events).every(e=>e.H===f.H&&e.L===f.L));
  assert.ok(Buffer.byteLength(JSON.stringify(s))<=RANGE_RESEARCH_BYTES);assert.ok(normalizeRangeResearch(s));
});
test('thirty live watches rotate before timeout, preserve original ranges and survive cold storage restore',async()=>{
  const f=fixture(),symbols=Array.from({length:30},(_,i)=>`X${i}_USDT`),windows:RangeWindows={},
    paths=Object.fromEntries(symbols.map(s=>[s,f.input.paths.A_USDT])),
    discovery={...f.input.discovery,anomalies:symbols.map(symbol=>({...f.input.discovery.anomalies[0]!,symbol,frozen:false}))};
  let research=advanceRangeResearch({...f.input,paths,windows,discovery});const visited=new Set(Object.keys(research.events)),original=structuredClone(windows);
  for(const a of discovery.anomalies)a.frozen=true;
  for(let n=1;n<=12;n++){
    const now=f.input.now+n*60000;
    research=advanceRangeResearch({...f.input,previous:research,now,paths,windows,discovery});
    Object.keys(research.events).forEach(s=>visited.add(s));assert.ok(Object.keys(research.events).length<=10);assert.ok(normalizeRangeResearch(research));
    assert.ok(Buffer.byteLength(JSON.stringify(research))<=RANGE_RESEARCH_BYTES);
  }
  assert.equal(visited.size,30);assert.ok(research.rotated!>0);assert.deepEqual(windows,original);
  const state=initialForward(T);state.directStrategy=structuredClone(trade().state.directStrategy!);state.directStrategy.rangeResearch=research;state.directStrategy.rangeWindows=windows;
  const saved=await prepareForwardWrite(null,state,research.updatedAt),store=new Map(Object.entries(saved.entries)),
    restored=await readForwardStore({get:async<V>(key:string)=>structuredClone(store.get(key)) as V|undefined},research.updatedAt);
  assert.deepEqual(restored!.directStrategy!.rangeWindows,original);
  const now=research.updatedAt+60000,next=advanceRangeResearch({...f.input,previous:restored!.directStrategy!.rangeResearch,now,windows:restored!.directStrategy!.rangeWindows!,paths,discovery});
  assert.ok(Object.values(next.events).every(e=>e.H===f.H&&e.L===f.L));assert.ok(normalizeRangeResearch(next));
});
test('fresh actionable newcomer replaces stalled watches without waiting thirty minutes; ten proofs remain bounded',()=>{
  const f=fixture(),old=structuredClone(f.research),windows:RangeWindows={};old.events={};
  for(let i=0;i<10;i++){const e=structuredClone(f.e);e.symbol=`OLD${i}_USDT`;e.id=`anomaly-range-v1:${e.symbol}:${T}`;e.phase='CONFIRMING';delete e.proof;
    old.events[e.symbol]=e;windows[e.id]=f.input.windows[f.e.id]!;}
  const next=advanceRangeResearch({...f.input,previous:old,windows});assert.equal(next.events.A_USDT!.phase,'READY');assert.equal(next.events.A_USDT!.rank,1);assert.ok(next.rotated!>0);
  const symbols=Array.from({length:10},(_,i)=>`READY${i}_USDT`),paths=Object.fromEntries(symbols.map(s=>[s,f.input.paths.A_USDT])),
    minutes=Object.fromEntries(symbols.map(s=>[s,f.input.minutes.A_USDT])),quotes=Object.fromEntries(symbols.map(s=>[s,f.q])),
    discovery={...f.input.discovery,anomalies:symbols.map(symbol=>({...f.input.discovery.anomalies[0]!,symbol}))},
    ten=advanceRangeResearch({...f.input,windows:{},paths,minutes,quotes,discovery});
  assert.ok(Object.values(ten.events).filter(e=>e.phase==='READY').length>=8);assert.ok(ten.events.READY0_USDT);assert.ok(normalizeRangeResearch(ten));assert.ok(Buffer.byteLength(JSON.stringify(ten))<=RANGE_RESEARCH_BYTES);
});
test('completed same-direction internal evidence ranks ahead of a raw spike; submitted execution keeps its seat',()=>{
  const f=fixture(),internal={...structuredClone(f.e),symbol:'TREND_USDT',direction:'UP' as const};internal.proof!.kind='INTERNAL_TREND';
  const raw={...structuredClone(f.e),symbol:'SPIKE_USDT',score:99};delete raw.proof;raw.phase='CONFIRMING';
  assert.ok(rangePriority(internal,f.q,f.input.now).score>rangePriority(raw,f.q,f.input.now).score);
  assert.ok(rangePriority(internal,{...f.q,priceSource:'OKX'},f.input.now).score<rangePriority(raw,f.q,f.input.now).score);
  const pending={...raw,symbol:'PENDING_USDT',phase:'EXECUTING' as const},events=[pending,...Array.from({length:30},(_,i)=>({...internal,symbol:`R${i}_USDT`}))],
    quotes=Object.fromEntries(events.map(e=>[e.symbol,f.q]));assert.ok(selectRangePlans(events,quotes,f.input.now).selected.has(pending.symbol));
  const anomalies=Array.from({length:90},(_,i)=>({...f.input.discovery.anomalies[0]!,symbol:`POOL${i}_USDT`,score:99-i/100})),visited=new Set<string>();
  for(let n=0;n<17;n++)rankRangeDiscovery(anomalies,f.input.now+n*60000).forEach(a=>visited.add(a.symbol));
  assert.equal(visited.size,90,'deep observation gives later discoveries a turn within their lifetime');
});
test('gappy five-minute tape is not watched, and a mid-range coin ranks behind an edge',()=>{
  const prior=Array.from({length:120},(_,i)=>{const gappy=i>=84&&i<100,base=gappy&&i%2?110:100;return candle(T-(120-i)*B,base,base,gappy?.05:.4);});
  assert.equal(thinFiveTape(prior,.4),true);
  const now=T+120000,windows:RangeWindows={},q=quote(now,100),
    discovery={at:T,scanned:1,shared:1,excluded:0,marketSamples:1,marketMove:0,loaded:1,queued:0,
      anomalies:[{symbol:'A_USDT',detectedAt:T,source:'BYBIT',sourceCount:2,own:.02,residual:.02,score:90,kind:'OWN_ACCELERATION'}]},
    dropped=advanceRangeResearch({now,windows,paths:{A_USDT:prior},minutes:{A_USDT:[]},quotes:{A_USDT:q},ticks:{A_USDT:.001},discovery,positions:[],history:[]});
  assert.equal(dropped.events.A_USDT,undefined);assert.match(dropped.recent?.find(r=>r.symbol==='A_USDT')?.reason??'',/断层/);
  const f=fixture(),edge={...structuredClone(f.e),symbol:'EDGE_USDT',phase:'CONFIRMING' as const,price:f.e.H},mid={...structuredClone(f.e),symbol:'MID_USDT',phase:'CONFIRMING' as const,price:(f.e.H+f.e.L)/2};
  delete edge.proof;delete mid.proof;
  assert.ok(rangePriority(edge,f.q,f.input.now).score>rangePriority(mid,f.q,f.input.now).score);
  assert.match(rangePriority(mid,f.q,f.input.now).reason,/中间/);
  const edges=Array.from({length:10},(_,i)=>({...edge,symbol:`E${i}_USDT`})),events=[...edges,mid],
    quotes=Object.fromEntries(events.map(e=>[e.symbol,f.q])),ranks=selectRangePlans(events,quotes,f.input.now).ranking;
  assert.ok(ranks.filter(r=>r.rank<=8).every(r=>r.symbol.startsWith('E')));
  assert.equal(ranks.find(r=>r.symbol==='MID_USDT')!.rank,11);
});
test('Gate turnover under one million is not scanned and releases an existing watch',()=>{
  const scanner:RangeScanner={prices:new Map(),detected:new Map([['ZK_USDT',{symbol:'ZK_USDT',detectedAt:T,source:'BYBIT',sourceCount:2,own:.08,residual:.08,score:90,kind:'OWN_ACCELERATION'}]])},
    rows=[{symbol:'ZK_USDT',source:'BYBIT',sourceCount:2,last:100,observedAt:T,volume24hUsd:252_900},
      ...Array.from({length:8},(_,i)=>({symbol:`L${i}_USDT`,source:'BYBIT',sourceCount:2,last:100,observedAt:T,volume24hUsd:2_000_000}))];
  const seen=scanRangeAnomalies(rows,scanner,T,9,0);
  assert.equal(seen.anomalies.some(a=>a.symbol==='ZK_USDT'),false);assert.equal(scanner.detected.has('ZK_USDT'),false);
  const f=fixture(),previous=structuredClone(f.research),zk=structuredClone(f.e);zk.symbol='ZK_USDT';zk.id=`anomaly-range-v1:ZK_USDT:${T}`;previous.events.ZK_USDT=zk;
  const next=advanceRangeResearch({...f.input,previous,windows:structuredClone(f.input.windows),paths:{...f.input.paths,ZK_USDT:f.input.paths.A_USDT},
    discovery:{...f.input.discovery,gateVolume:{ZK_USDT:252_900,A_USDT:5_000_000}}});
  assert.equal(next.events.ZK_USDT,undefined);assert.match(next.recent?.find(r=>r.symbol==='ZK_USDT')?.reason??'',/100万/);
  assert.equal('gateVolume' in (next.discovery??{}),false);assert.notEqual(next.events.A_USDT?.phase,'EXPIRED');
});
test('continuous flat candles with no quote turnover are not a traded tape',()=>{
  const quiet=Array.from({length:48},(_,i)=>candle(T-(48-i)*B,100,100,0)).map(r=>({...r,high:r.close,low:r.close,turnoverUsd:iTurn(r)}));
  function iTurn(r:{time:number}){return r.time%2?80:0;}
  assert.equal(sparseFiveTurnover(quiet,T+B),true);
  assert.equal(thinFiveTape(quiet,.4),false,'time-continuous zero-sum bars are not price holes');
  const liquid=quiet.map(r=>({...r,turnoverUsd:20_000}));
  assert.equal(sparseFiveTurnover(liquid,T+B),false);
  const now=T+120000,windows:RangeWindows={},q=quote(now,100),
    discovery={at:T,scanned:1,shared:1,excluded:0,marketSamples:1,marketMove:0,loaded:1,queued:0,
      anomalies:[{symbol:'ZK_USDT',detectedAt:T,source:'BYBIT',sourceCount:2,own:.08,residual:.08,score:90,kind:'OWN_ACCELERATION'}]},
    skipped=advanceRangeResearch({now,windows,paths:{ZK_USDT:quiet},minutes:{ZK_USDT:[]},quotes:{ZK_USDT:q},ticks:{ZK_USDT:.001},discovery,positions:[],history:[]});
  assert.equal(skipped.events.ZK_USDT,undefined);
  const f=fixture(),previous=structuredClone(f.research),zk=structuredClone(f.e);zk.symbol='ZK_USDT';zk.id=`anomaly-range-v1:ZK_USDT:${T}`;previous.events={ZK_USDT:zk};
  const dropped=advanceRangeResearch({...f.input,previous,windows:structuredClone(f.input.windows),paths:{...f.input.paths,ZK_USDT:quiet},
    discovery:{...f.input.discovery,anomalies:[{...f.input.discovery.anomalies[0]!,symbol:'ZK_USDT'}]}});
  assert.equal(dropped.events.ZK_USDT,undefined);assert.match(dropped.recent?.find(r=>r.symbol==='ZK_USDT')?.reason??'',/断续/);
});
test('a broken range holding does not stop the account and still exits on the submitted stop',()=>{
  const f=trade(),state=structuredClone(f.state),balance=state.balance;
  state.positions[0]!.unified!.anomaly!.window={...state.positions[0]!.unified!.anomaly!.window,ohlc64:'broken'};
  assert.equal(validRangeHolding(state.positions[0]!.unified!.anomaly!),false);
  const restored=normalizeForward(state,f.input.now);
  assert.equal(restored.positions.length,1);assert.equal(restored.balance,balance);assert.equal(restored.startedAt,state.startedAt);
  const t=restored.positions[0]!,hit=rangeHoldingDecision(t,quote(f.input.now,t.side==='LONG'?t.stopPrice-.1:t.stopPrice+.1),f.input.now,[],[]);
  assert.equal(hit.exit,'RANGE_HARD_PROTECTION');
  const held=rangeHoldingDecision(t,quote(f.input.now,t.entryPrice),f.input.now,[],[]);
  assert.equal(held.exit,undefined);
});
test('internal aligned trend uses existing completed five and new post-anomaly minutes, then holds through breakout and ordinary pullback',()=>{
  for(const sign of [1,-1]){
    const mirror=(p:number)=>sign>0?p:200-p,prior=Array.from({length:120},(_,i)=>candle(T-(120-i)*B,mirror(100+i*.01+Math.sin(i/7)),mirror(100+i*.01+Math.sin(i/7)),.1)),
      detectedAt=T+60000,now=T+180000,last=101.5;
    prior[119]=candle(T-B,mirror(last-.15),mirror(last),.02);
    const minutes=[...Array.from({length:21},(_,i)=>candle(T-(20-i)*60000,mirror(last-.005),mirror(last),.03)),
      candle(detectedAt,mirror(last),mirror(last+.07),.005),candle(detectedAt+60000,mirror(last+.07),mirror(last+.14),.005)],q=quote(now,mirror(last+.14)),windows:RangeWindows={},
      input={now,windows,paths:{A_USDT:prior},minutes:{A_USDT:minutes},quotes:{A_USDT:q},ticks:{A_USDT:.001},positions:[],history:[],
        discovery:{...fixture().input.discovery,at:now,anomalies:[{...fixture().input.discovery.anomalies[0]!,detectedAt,own:sign*.01,residual:sign*.01}]}},
      s=advanceRangeResearch(input),e=s.events.A_USDT!;
    assert.equal(e.proof!.kind,'INTERNAL_TREND');assert.equal(e.proof!.side,sign>0?'LONG':'SHORT');assert.ok(e.proof!.fiveAt<detectedAt);
    assert.ok(e.proof!.minuteBars.every(r=>r[0]!*1000>=detectedAt));
    const contrary=advanceRangeResearch({...input,windows:{},discovery:{...input.discovery,anomalies:input.discovery.anomalies.map(a=>({...a,own:-a.own}))}});
    assert.notEqual(contrary.events.A_USDT!.proof?.kind,'INTERNAL_TREND');
    const changed=advanceRangeResearch({...input,previous:s,now:now+2000,quotes:{A_USDT:quote(now+2000,mirror(last+.14))},
      discovery:{...input.discovery,anomalies:input.discovery.anomalies.map(a=>({...a,own:-a.own}))}});
    assert.notEqual(changed.events.A_USDT!.proof?.kind,'INTERNAL_TREND','fresh internal proof yields when the own anomaly changes direction');
    const t=structuredClone(trade().t);t.side=e.proof!.side;t.openedAt=now;t.entryPrice=mirror(last+.14);t.stopPrice=e.proof!.stop;
    t.unified!.anomaly=makeRangeHolding(e,windows[e.id]!,t.entryPrice,q,now);
    const witness=structuredClone(t.unified!.anomaly),edge=sign>0?e.H:e.L,breakout=candle(T,edge-sign*.1,edge+sign*.15,.02),at=T+B;
    let result=rangeHoldingDecision(t,quote(at,edge+sign*.15),at,[...prior,breakout],[]);
    assert.equal(result.exit,undefined);assert.equal(result.memory.breakoutAt,at);assert.equal(result.memory.kind,'INTERNAL_TREND');
    assert.deepEqual(result.memory.proof,witness.proof);assert.deepEqual(result.memory.window,witness.window);
    t.unified!.anomaly=result.memory;t.stopPrice=result.stop;
    const returned=candle(T+B,edge+sign*.15,edge-sign*.07,.02),later=T+2*B+60000;
    result=rangeHoldingDecision(t,quote(later,edge-sign*.07),later,[...prior,breakout,returned],[]);
    assert.equal(result.exit,undefined);assert.equal(result.memory.reverseEligible,false);assert.ok(sign*(result.stop-t.stopPrice)>=0);
  }
});
test('fast return can close before another five-minute bar and resume edge return only after confirmed flat',()=>{
  const f=trade(),t=structuredClone(f.t),minuteStart=f.input.now,
    minutes=[...Array.from({length:20},(_,i)=>candle(minuteStart-(20-i)*60000,f.H-.095,f.H-.09,.03)),
      candle(minuteStart,f.H-.09,f.H-.16,.005),candle(minuteStart+60000,f.H-.16,f.H-.23,.005)],now=minuteStart+120000;
  const decision=rangeHoldingDecision(t,quote(now,f.H-.23),now,f.input.paths.A_USDT,minutes);
  assert.equal(decision.exit,'RANGE_BREAKOUT_FAILED');assert.equal(decision.memory.reverseEligible,true);
  f.research.events.A_USDT!.tradeId=t.id;
  const closed={...t,closedAt:now,unified:{...t.unified!,anomaly:decision.memory}},next=advanceRangeResearch({...f.input,previous:f.research,now:now+6000,
    windows:f.input.windows,quotes:{A_USDT:quote(now+6000,f.H-.23)},minutes:{A_USDT:minutes},history:[closed]});
  assert.equal(next.events.A_USDT!.proof!.kind,'EDGE_RETURN');assert.equal(next.events.A_USDT!.proof!.side,'SHORT');
  assert.notEqual(next.events.A_USDT!.proof!.id,t.unified!.anomaly!.proof.id);
  const occupied=advanceRangeResearch({...f.input,previous:f.research,now,history:[closed],positions:[t]});assert.equal(occupied.events.A_USDT!.phase,'EXECUTING');
  const future=rangeHoldingDecision(t,quote(now-1,f.H-.23),now-1,f.input.paths.A_USDT,minutes);assert.equal(future.memory.reverseEligible,false);
});
test('below-budget expired plans immediately release all ten admission seats and frozen windows',()=>{
  const f=fixture(),s=structuredClone(f.research),windows:RangeWindows={};s.events={};
  for(let i=0;i<10;i++){const symbol=`OLD${i}_USDT`,e=structuredClone(f.e);e.symbol=symbol;e.id+=i;e.phase='EXPIRED';e.outcomes.forEach(o=>o.status='MISSING');
    s.events[symbol]=e;windows[e.id]=f.input.windows[f.e.id]!;}
  assert.ok(Buffer.byteLength(JSON.stringify(s))<RANGE_RESEARCH_BYTES);
  const next=advanceRangeResearch({...f.input,previous:s,windows});
  assert.equal(Object.keys(next.events).length,1);assert.equal(next.events.A_USDT!.phase,'READY');assert.equal(next.recycled,10);
  assert.deepEqual(Object.keys(windows),[f.e.id]);assert.ok(normalizeRangeResearch(next));
});
test('stale candles cannot make an unfilled plan immortal; retired outcomes complete only from their own source',()=>{
  const f=fixture(),now=T+31*60000,windows=structuredClone(f.input.windows);
  let s=advanceRangeResearch({...f.input,previous:f.research,now,windows,paths:{},discovery:undefined});
  assert.equal(Object.keys(s.events).length,0);assert.equal(s.recycled,1);assert.equal(s.recent![0]!.outcomes[2]!.status,'PENDING');
  assert.equal(Object.keys(windows).length,0);
  const observedAt=T+45*60000,bar=candle(observedAt-B,100,102),record=s.recent![0]!;
  s=advanceRangeResearch({...f.input,previous:s,now:observedAt,windows,paths:{A_USDT:[{...bar,volumeVenue:'OKX'}]},discovery:undefined});
  assert.equal(s.recent![0]!.outcomes[2]!.status,'PENDING');
  s=advanceRangeResearch({...f.input,previous:s,now:observedAt+1,windows,paths:{A_USDT:[bar]},discovery:undefined});
  assert.equal(s.recent![0]!.outcomes[2]!.status,'OBSERVED');assert.equal(s.recent![0]!.outcomes[2]!.price,102);
  assert.equal(s.recent![0]!.outcomes[2]!.move,102/record.anchorPrice-1);
  const resumed=advanceRangeResearch({...f.input,previous:s,now:observedAt+2,windows,discovery:f.input.discovery});
  assert.equal(Object.keys(resumed.events).length,0,'old cached discovery cannot resurrect a retired plan');
});
test('actual pending/filled financial obligations never expire or lose their immutable witness',()=>{
  const f=trade(),s=f.state.directStrategy!.rangeResearch!,windows=f.state.directStrategy!.rangeWindows!,now=T+65*60000;
  const witness=structuredClone(f.t.unified!.anomaly!.window),before=structuredClone(windows);
  const next=advanceRangeResearch({...f.input,previous:s,now,windows,paths:{},discovery:undefined,positions:[f.t]});
  assert.equal(next.events.A_USDT!.phase,'EXECUTING');assert.equal(next.recycled??0,0);
  assert.deepEqual(windows,before);assert.deepEqual(f.t.unified!.anomaly!.window,witness);
  const filled=structuredClone(f.t);filled.paperOrder!.phase='FILLED';
  const holding=advanceRangeResearch({...f.input,previous:next,now:now+2000,windows,paths:{},discovery:undefined,positions:[filled]});
  assert.equal(holding.events.A_USDT,undefined);assert.equal(windows[f.e.id],undefined);assert.deepEqual(filled.unified!.anomaly!.window,witness);
  assert.deepEqual(filled.unified!.anomaly,f.t.unified!.anomaly,'releasing research does not change financial protection');
});
test('ten submitted financial orders survive research pressure without losing execution seats or own witnesses',()=>{
  const f=trade(),previous=structuredClone(f.research),windows:RangeWindows={};previous.events={};
  const positions=Array.from({length:10},(_,i)=>{const e=structuredClone(f.e),t=structuredClone(f.t);e.symbol=`P${i}_USDT`;e.id=`anomaly-range-v1:${e.symbol}:${T}`;e.phase='EXECUTING';e.reason='';
    e.tradeId=`pending_${i}`;t.id=e.tradeId;t.symbol=e.symbol;t.unified!.anomaly!.eventId=e.id;t.unified!.anomaly!.proof=structuredClone(e.proof!);
    previous.events[e.symbol]=e;windows[e.id]=f.input.windows[f.e.id]!;return t;});
  previous.ranking=[];previous.discovery=undefined;assert.ok(normalizeRangeResearch(previous));const financial=structuredClone(positions);
  const discovery={...f.input.discovery,anomalies:Array.from({length:8},(_,i)=>({...f.input.discovery.anomalies[0]!,symbol:`NEW_MARKET${i}_USDT`}))},
    quotes=Object.fromEntries(positions.map(t=>[t.symbol,f.q])),paths=Object.fromEntries(positions.map(t=>[t.symbol,f.input.paths.A_USDT])),
    next=advanceRangeResearch({...f.input,previous,windows,positions,quotes,paths,discovery});
  assert.equal(Object.keys(next.events).length,10);assert.ok(Object.values(next.events).every(e=>e.phase==='EXECUTING'));assert.ok(normalizeRangeResearch(next));
  assert.deepEqual(positions,financial);assert.equal(Object.keys(windows).length,10);
});
test('an evicted parked original window is never recaptured later within the same frozen anomaly',()=>{
  const f=fixture(),symbols=Array.from({length:30},(_,i)=>`EVICT${i}_USDT`),windows:RangeWindows={},
    paths=Object.fromEntries(symbols.map(s=>[s,f.input.paths.A_USDT])),discovery={...f.input.discovery,anomalies:symbols.map(symbol=>({...f.input.discovery.anomalies[0]!,symbol}))};
  const previous=advanceRangeResearch({...f.input,paths,windows,discovery}),ids=new Set(Object.keys(windows)),
    newDiscovery={...f.input.discovery,anomalies:[{...f.input.discovery.anomalies[0]!,symbol:'NEW_USDT'}]},
    next=advanceRangeResearch({...f.input,previous,paths:{...paths,NEW_USDT:f.input.paths.A_USDT},windows,discovery:newDiscovery});
  const victim=[...ids].find(id=>!windows[id])!;assert.ok(victim);const symbol=victim.split(':')[1]!;
  const resumed=advanceRangeResearch({...f.input,previous:next,now:f.input.now+2000,paths,windows,
    discovery:{...discovery,anomalies:[{...discovery.anomalies.find(a=>a.symbol===symbol)!,frozen:true}]}});
  assert.equal(resumed.events[symbol],undefined);assert.equal(windows[victim],undefined);assert.ok(resumed.capacitySkipped>next.capacitySkipped);
});
test('optional pending outcomes yield bounded bytes and disclose omissions instead of blocking active work',()=>{
  const f=fixture(),s=structuredClone(f.research);s.events={};
  for(let i=0;i<30;i++){const e=structuredClone(f.e);e.symbol=`OLD${i}_USDT`;e.id+=i;e.phase='DONE';delete e.proof;e.swings=[];s.events[e.symbol]=e;}
  // Migrate the supported legacy30-event shape while remaining under the original byte budget.
  for(const e of Object.values(s.events)){e.reason='';delete e.activity;e.outcomes.forEach(o=>{o.at=null;o.price=null;o.move=null;});}
  // Use two bounded batches; each contains ten terminal events below24KiB.
  const batch=Object.values(s.events);s.events=Object.fromEntries(batch.slice(0,10).map(e=>[e.symbol,e]));
  let next=advanceRangeResearch({...f.input,previous:s,windows:{},discovery:undefined});
  next.events=Object.fromEntries(batch.slice(10,20).map(e=>[e.symbol,e]));
  next=advanceRangeResearch({...f.input,previous:next,windows:{}});
  assert.ok(next.events.A_USDT);assert.ok((next.omittedOutcomes??0)>0);assert.ok(next.recent!.length<=12);
  assert.ok(Buffer.byteLength(JSON.stringify(next.recent))<=RANGE_OUTCOME_BYTES);assert.ok(normalizeRangeResearch(next));
  const malformed=structuredClone(next);malformed.recent![0]!.outcomes[0]!.dueAt++;
  assert.equal(normalizeRangeResearch(malformed),undefined);
});
test('hundreds of timeout/new-plan rotations stay bounded and admit new work after every restart',()=>{
  const f=fixture(),windows:RangeWindows={};let s:RangeResearch|undefined;
  for(let n=0;n<200;n++){
    const shift=n*35*60000,detectedAt=T+shift,now=f.input.now+shift,symbol=`ROUND${n}_USDT`,
      paths={[symbol]:f.input.paths.A_USDT.map(r=>({...r,time:r.time+shift/1000}))},
      discovery={...f.input.discovery,at:now,anomalies:[{...f.input.discovery.anomalies[0]!,symbol,detectedAt}]};
    s=advanceRangeResearch({...f.input,previous:s,windows,now,paths,minutes:{},quotes:{},discovery});
    assert.ok(s.events[symbol],`round ${n} is admitted`);assert.equal(Object.keys(s.events).length,1);assert.equal(Object.keys(windows).length,1);
    assert.ok(Buffer.byteLength(JSON.stringify(s))<=RANGE_RESEARCH_BYTES);assert.ok(Buffer.byteLength(JSON.stringify(s.recent??[]))<=RANGE_OUTCOME_BYTES);
    s=normalizeRangeResearch(JSON.parse(JSON.stringify(s)));assert.ok(s,'restart accepts lifecycle state');
  }
  assert.equal(s!.recycled,199);assert.equal(s!.capacitySkipped,0);
});
test('new anomalous markets precede retired observations and refresh failures cannot starve later seats',()=>{
  const f=fixture(),s=structuredClone(f.research);s.events.A_USDT!.phase='EXPIRED';
  const anomalies=Array.from({length:30},(_,i)=>({...f.input.discovery.anomalies[0]!,symbol:`NEW${i}_USDT`})),
    symbols=rangeObservationSymbols(s,['HELD_USDT'],anomalies,f.input.now);
  assert.equal(symbols.length,30);assert.equal(symbols[0],'HELD_USDT');assert.ok(symbols.includes('NEW0_USDT'));assert.ok(!symbols.includes('A_USDT'));
  const attempts=new Map<string,number>(),seen=new Set<string>();
  for(let n=1;n<=6;n++)fairRangeRefreshBatch(symbols,symbols,attempts,n*5000,5).forEach(s=>seen.add(s));
  assert.equal(seen.size,30,'even if all first requests fail, each seat gets one attempt');
  fairRangeRefreshBatch(['NEW0_USDT'],['NEW0_USDT'],attempts,35000,5);assert.equal(attempts.size,1);
});
test('full storage plus protection overlay restore recycled outcomes without changing money or identities',async()=>{
  const f=trade(),s=structuredClone(f.state),windows=s.directStrategy!.rangeWindows!;
  s.positions=[];
  const saved=await prepareForwardWrite(null,s,f.input.now),store=new Map(Object.entries(saved.entries)),now=T+31*60000;
  const next=structuredClone(s);next.directStrategy!.rangeResearch=advanceRangeResearch({...f.input,previous:s.directStrategy!.rangeResearch,now,windows,paths:{},discovery:undefined});
  const checkpoint=buildForwardProtectionCheckpoint(next),base=await readForwardStore({get:async<V>(key:string)=>structuredClone(store.get(key)) as V|undefined},now);
  const restored=restoreForwardProtectionCheckpoint(base!,checkpoint);
  assert.equal(restored.startedAt,s.startedAt);assert.equal(restored.balance,s.balance);assert.equal(restored.fees,s.fees);assert.deepEqual(restored.history,base.history);
  assert.equal(Object.keys(restored.directStrategy!.rangeResearch!.events).length,0);assert.equal(restored.directStrategy!.rangeResearch!.recent!.length,1);
  const review=buildReviewSnapshot({view:forwardSummary(restored,{},now),exportedAt:now,strategyFingerprint:null,buildSha:'test'} as Parameters<typeof buildReviewSnapshot>[0]);
  assert.equal((review.research.anomalyRangeAudit as {recentOutcomes:unknown[]}).recentOutcomes.length,1);
});
test('actual common contract catalog paginates Bybit, excludes delivery/USDC/delisted and uses no Gate prices',async()=>{
  const original=globalThis.fetch,calls:string[]=[],instrument=(symbol:string,extra={})=>({symbol,baseCoin:symbol.slice(0,-4),quoteCoin:'USDT',settleCoin:'USDT',status:'Trading',contractType:'LinearPerpetual',...extra});
  globalThis.fetch=async url=>{const u=String(url);calls.push(u);
    if(u.includes('instruments-info'))return Response.json({retCode:0,result:{list:u.includes('cursor=next')?[instrument('ETHUSDT')]:[instrument('BTCUSDT'),instrument('BADUSDT',{contractType:'LinearFutures'}),instrument('USDCUSDT',{settleCoin:'USDC'}),instrument('DEADUSDT',{status:'Settled'})],nextPageCursor:u.includes('cursor=next')?'':'next'}});
    if(u.includes('bybit')&&u.includes('tickers'))return Response.json({retCode:0,result:{list:Array.from({length:20},(_,i)=>({symbol:i===0?'BTCUSDT':i===1?'ETHUSDT':`X${i}USDT`,lastPrice:'100',bid1Price:'99.9',ask1Price:'100.1',turnover24h:'10000000'}))}});
    if(u.includes('/futures/usdt/contracts'))return Response.json([{name:'BTC_USDT',quanto_multiplier:'0.01',order_price_round:'0.1',leverage_max:'100',maintenance_rate:'0.005',status:'trading'}]);
    throw new Error('synthetic source unavailable');};
  try{const hub=new MarketDataHub();assert.equal(await hub.refreshInstrumentCatalog(T),4);await hub.refresh(T);
    assert.deepEqual(hub.commonSymbols(['BTC_USDT','ETH_USDT','BAD_USDT','USDC_USDT','DEAD_USDT','GATEONLY_USDT']),['BTC_USDT','ETH_USDT']);
    assert.equal(hub.discoveryRows(['BTC_USDT','ETH_USDT','GATEONLY_USDT'],T).length,2);
    assert.equal(await hub.refreshInstrumentCatalog(T+1),0);assert.equal(calls.filter(u=>u.includes('cursor=next')).length,1);
    const directory=await fetchContractDirectory();assert.equal(directory[0]!.symbol,'BTC_USDT');assert.equal(directory[0]!.last,0);
    assert.equal(calls.filter(u=>u.includes('/futures/usdt/tickers')).length,0);
    calls.length=0;assert.equal(await hub.pinnedCandles('BTC_USDT','5m',120,'BYBIT'),null);assert.equal(calls.length,1);assert.ok(calls[0]!.includes('bybit'));}
  finally{globalThis.fetch=original;}
});
test('fast completed reentry exits at edge; later shallow sideways pullbacks keep holding',()=>{
  const f=trade(),t=f.t,m=t.unified!.anomaly!,now=f.input.now+B,
    returned=candle(T+B,f.H+.1,f.H-.09,.02),minuteStart=T+2*B,
    minute=[...Array.from({length:20},(_,i)=>candle(minuteStart-(20-i)*60000,f.H-.095,f.H-.09,.03)),
      candle(minuteStart,f.H-.09,f.H-.16,.005),candle(minuteStart+60000,f.H-.16,f.H-.23,.005)],at=minuteStart+120000;
  const result=rangeHoldingDecision(t,quote(at,f.H-.23),at,[...f.input.paths.A_USDT,returned],minute);
  assert.equal(result.exit,'RANGE_BREAKOUT_FAILED');assert.equal(result.memory.reverseEligible,true);
  const internal=rangeHoldingDecision(t,quote(at,100),at,[...f.input.paths.A_USDT,returned],minute);
  assert.equal(internal.memory.reverseEligible,false);
  const insideFirst=rangeHoldingDecision(t,quote(now,f.H-.1),now,[...f.input.paths.A_USDT,returned],[]);
  assert.equal(insideFirst.exit,undefined);t.unified!.anomaly=insideFirst.memory;
  const sideways=candle(T+2*B,f.H-.1,f.H-.11,.02),late=T+3*B;
  const failed=rangeHoldingDecision(t,quote(late,f.H-.11),late,[...f.input.paths.A_USDT,returned,sideways],[]);
  assert.equal(failed.exit,undefined);assert.equal(failed.memory.reverseEligible,false);
  assert.equal(m.window.ohlc64,f.input.windows[f.e.id]!.ohlc64);
});
test('profit guard needs three distinct retained quotes and cannot widen or automatically reverse',()=>{
  const f=trade(),t=f.t,R=t.unified!.anomaly!.initialRisk,price=t.entryPrice+R*5;
  let r=rangeHoldingDecision(t,quote(f.input.now+2000,price),f.input.now+2000,[],[]);assert.equal(r.stop,t.stopPrice);t.unified!.anomaly=r.memory;
  r=rangeHoldingDecision(t,quote(f.input.now+2000,price),f.input.now+4000,[],[]);assert.equal(r.memory.peakSamples,1);t.unified!.anomaly=r.memory;
  for(const n of [4000,6000]){r=rangeHoldingDecision(t,quote(f.input.now+n,price),f.input.now+n,[],[]);t.unified!.anomaly=r.memory;t.stopPrice=r.stop;}
  assert.ok(t.stopPrice>t.entryPrice);const stopped=rangeHoldingDecision(t,quote(f.input.now+8000,t.stopPrice-.01),f.input.now+8000,[],[]);
  assert.equal(stopped.exit,'RANGE_HARD_PROTECTION');assert.equal(stopped.memory.reverseEligible,false);assert.ok(stopped.stop>=t.stopPrice);
});
test('real PAPER queue confirms old closure before new edge return and never reuses the old proof or witness',()=>{
  const f=trade(),contracts={A_USDT:{quantoMultiplier:.1,leverageMax:20,maintenanceRate:.005,minContracts:1,tickSize:.001,enableDecimal:false,orderSizeMin:'1',orderSizeMax:'1000000',marketOrderSizeMax:'1000000'}},
    apply=(state:typeof f.state,at:number,p:number,paths=f.input.paths,minutes=f.input.minutes)=>advanceDirectStrategy({state,now:at,paths,minutePaths:minutes,
      quotes:{A_USDT:quote(at,p)},analysisQuotes:{A_USDT:quote(at,p)},contracts,marketAuthority:true,specialMove:true,anomalyRange:true,
      rangeDiscovery:f.input.discovery,paperTiming:{prepareMs:2000,confirmMs:0,basis:'EXECUTION_CLOCK',samples:0}}).state;
  let s=apply(f.state,f.input.now+2000,f.q.bestAsk);s=apply(s,f.input.now+4000,f.q.bestAsk);assert.equal(s.positions[0]!.paperOrder!.phase,'FILLED',JSON.stringify(s.positions[0]!.paperOrder));
  const oldId=s.positions[0]!.id,oldProof=s.positions[0]!.unified!.anomaly!.proof.id,witness=s.positions[0]!.unified!.anomaly!.window.ohlc64,
    returned=candle(T+B,f.H+.1,f.H-.09,.02),minuteStart=T+2*B,
    minutes={A_USDT:[...Array.from({length:20},(_,i)=>candle(minuteStart-(20-i)*60000,f.H-.095,f.H-.09,.03)),
      candle(minuteStart,f.H-.09,f.H-.16,.005),candle(minuteStart+60000,f.H-.16,f.H-.23,.005)]},paths={A_USDT:[...f.input.paths.A_USDT,returned]},at=minuteStart+120000;
  s=apply(s,at,f.H-.23,paths,minutes);assert.equal(s.positions.length,1);assert.equal(s.positions[0]!.side,'LONG');assert.equal(s.positions[0]!.paperOrder!.action!.kind,'CLOSE');
  s=apply(s,at+2000,f.H-.23,paths,minutes);assert.equal(s.positions[0]!.paperOrder!.action!.phase,'SUBMITTED');assert.equal(s.history.length,0);
  s=apply(s,at+4000,f.H-.23,paths,minutes);assert.equal(s.history[0]!.id,oldId);assert.equal(s.positions.length,0);
  s=apply(s,at+6000,f.H-.23,paths,minutes);assert.equal(s.positions.length,1,JSON.stringify(s.directStrategy!.plans));assert.equal(s.positions[0]!.side,'SHORT');
  assert.equal(s.positions[0]!.unified!.predecessorId,oldId);assert.notEqual(s.positions[0]!.unified!.anomaly!.proof.id,oldProof);
  assert.equal(s.positions[0]!.unified!.anomaly!.window.ohlc64,witness);assert.ok(s.history[0]!.exitFee>0);assert.equal(s.fees,s.history[0]!.entryFee+s.history[0]!.exitFee,'unfilled reverse has not charged account fees');
  normalizeForward(s,at+6000);
});
test('ten full immutable financial witnesses and bounded research fit original account/protection budgets',async()=>{
  const f=trade(),s=structuredClone(f.state);s.positions=Array.from({length:10},(_,i)=>{const t=structuredClone(f.t);t.id=`budget_${i}`;t.symbol=`X${i}_USDT`;
    t.rule.id+=i;t.unified!.sourceId+=i;t.unified!.referenceId+=i;t.unified!.anomaly!.eventId+=i;return t;});
  const raw=buildForwardProtectionCheckpoint(s);assert.ok(Buffer.byteLength(JSON.stringify(raw))<112*1024);
  assert.ok(raw.positions.every(t=>!t.unified!.anomaly!.window));
  const saved=await prepareForwardWrite(null,s,f.input.now),store=new Map(Object.entries(saved.entries));
  const restored=await readForwardStore({get:async<V>(key:string)=>structuredClone(store.get(key)) as V|undefined},f.input.now+1);
  assert.equal(restored.positions.length,10);assert.ok(restored.positions.every(t=>decodeRangeWindow(t.unified!.anomaly!.window).length===120));
});

test('two substantive contrary completed minutes request review without automatic close or flip',()=>{
  const f=trade(),t=f.t;t.openedAt=f.input.now;const at=f.input.now,px=t.entryPrice,mins=[candle(at,px+.16,px+.10,.01),candle(at+60000,px+.10,px+.04,.01)];
  const decision=rangeHoldingDecision(t,quote(at+120000,px+.04),at+120000,[],mins);
  assert.equal(decision.exit,undefined);assert.equal(decision.memory.stage,'REVIEW');assert.equal(decision.memory.reverseEligible,false);
  assert.match(decision.reason,/两根/);
});
