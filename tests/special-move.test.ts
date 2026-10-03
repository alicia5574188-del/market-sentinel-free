import test from 'node:test';
import assert from 'node:assert/strict';
import {advanceSpecialResearch,normalizeSpecialResearch,specialRows,recentSpecialActivity,specialMarketRoute,
  observeSpecialRadar,selectSpecialMoveUniverse,SPECIAL_RESEARCH_BYTES,SPECIAL_WATCH_TTL,type SpecialRadarHistory} from '../lib/special-move.ts';
import type {CandleLike,MarketSymbolState} from '../lib/market-intelligence-engine.ts';
import {initialForward,normalizeForward,type Quote} from '../lib/forward-relations.ts';
import {advanceDirectStrategy,openDirectPlan} from '../lib/direct-strategy.ts';
import {buildForwardProtectionCheckpoint,restoreForwardProtectionCheckpoint} from '../lib/forward-protection-checkpoint.ts';
const T=1791000000000,B=300000;
const bars=(prices:number[],step=B,end=T):CandleLike[]=>prices.map((p,i)=>({time:(end-(prices.length-i)*step)/1000,
  open:p,close:p,high:p+.04,low:p-.04,volume:100,turnoverUsd:10000,volumeVenue:'GATE'}));
const flat=()=>bars(Array(36).fill(100));
const fast=(side=1)=>bars([...Array(12).fill(100),100+side*.5,100+side*.8,100+side],60000);
const q=(price=101,now=T):Quote=>({bestBid:price-.005,bestAsk:price+.005,observedAt:now,fresh:true,entryReady:true,
  sourceCount:3,disagreementRate:0,directionalAgreement:1,medianShortMove:.0005});
const state=(symbol:string,group=symbol):MarketSymbolState=>({symbol,clusterId:group,correlation:.8,beta:1,volatility:.001,
  watchScore:70,regime:'DIVERGENT',stage:'READY',dataConfidence:90,actualMove:0,expectedMove:0,residual:0,residualZ:0,
  residualPersistence:1,relativeStrength:.5,longScore:70,shortScore:70,pathLong:.8,pathShort:.8,roomLong:.1,roomShort:.1,
  sourceCount:3,venueAgreement:1,venuePressure:0,reasons:[],signalSide:'LONG',signalSince:T-600000,signalBars:3,signalLastBar:T});
function own(side=1){return{now:T,paths:{A_USDT:flat()},minutes:{A_USDT:fast(side)},quotes:{A_USDT:q(100+side)},states:{A_USDT:state('A_USDT')}};}
function market(){const i=own();i.quotes.A_USDT=q(100);i.minutes.A_USDT=bars(Array(15).fill(100),60000);
  for(const symbol of ['B_USDT','C_USDT','D_USDT']){i.paths[symbol as 'A_USDT']=bars(Array.from({length:24},(_,n)=>100+n*.2));
    i.states[symbol as 'A_USDT']=state(symbol);i.quotes[symbol as 'A_USDT']=q(104.6);}return i;}
test('active normally correlated nonresponder becomes a watch, never a direction prediction',()=>{
  const r=advanceSpecialResearch(market()),w=r.watches.A_USDT!;
  assert.equal(w.kind,'ACTIVE_NONRESPONSE');assert.equal(w.active,true);assert.equal(w.phase,'WATCH');
  assert.equal(specialMarketRoute(r,'A_USDT',100,T).route,null);assert.equal(w.route,undefined);
});
test('actual recent quote turnover excludes low or unknown activity even with a price launch',()=>{
  for(const missing of [true,false]){const i=own();for(const b of i.paths.A_USDT){if(missing)delete b.turnoverUsd;else b.turnoverUsd=100;}
    const w=advanceSpecialResearch(i).watches.A_USDT!;assert.equal(w.active,false);
    assert.equal(w.phase,missing?'MISSING_DATA':'LOW_ACTIVITY');assert.equal(w.route,undefined);}
  const rows=flat();rows.at(-1)!.volumeVenue='OKX';assert.equal(recentSpecialActivity(rows).turnover15,null);
  for(const b of rows)delete b.volumeVenue;assert.equal(recentSpecialActivity(rows).active,false);
  const shrunk=flat();for(const b of shrunk.slice(-3))b.turnoverUsd=1000;assert.equal(recentSpecialActivity(shrunk).active,false);
});
test('live unusual discovery can precede the 5m close; completed own 1m proof authorizes both sides',()=>{
  for(const side of [1,-1]){const r=advanceSpecialResearch(own(side)),w=r.watches.A_USDT!;
    assert.equal(w.phase,'READY');assert.equal(w.route!.side,side>0?'LONG':'SHORT');
    assert.equal(w.route!.controllerVersion,'special-move-v1');assert.equal(w.route!.proofBars!.length,3);
    assert.equal(w.route!.proofAt,T);assert.equal(w.route!.targetBasis,'VOLATILITY_ESTIMATE');
    assert.equal(normalizeSpecialResearch(r)?.watches.A_USDT!.route!.proofAt,T);}
});
test('broad opposite direction does not veto the own explosive leg',()=>{
  const i=market();i.quotes.A_USDT=q(99);i.minutes.A_USDT=fast(-1);
  const w=advanceSpecialResearch(i).watches.A_USDT!;assert.equal(w.kind,'OPPOSITE_MOVE');assert.equal(w.route!.side,'SHORT');
});
test('a large burst is not chased, but a real completed retest earns new own support',()=>{
  for(const side of [1,-1]){const i=own(side);i.quotes.A_USDT=q(100+side*12.5);
    i.minutes.A_USDT=bars([...Array(12).fill(100),100+side*10,100+side*11,100+side*12.5],60000);
    assert.equal(advanceSpecialResearch(i).watches.A_USDT!.route,undefined);
    i.minutes.A_USDT=bars([...Array(12).fill(100),100+side*12,100+side*10.5,100+side*12.5],60000);
    const route=advanceSpecialResearch(i).watches.A_USDT!.route!;assert.ok(route);
    assert.equal(route.proofPath,'RETEST_RESTART');assert.equal(route.side,side>0?'LONG':'SHORT');
    assert.ok(side*(route.stop-100)>0,'actual retest support must replace the distant launch reference');
    assert.ok(Math.abs(route.proofPrice!-route.stop)/route.proofPrice!<.035);
  }
});
test('uncompleted/future bars and quote-only advance cannot manufacture a launch',()=>{
  const i=own();i.minutes.A_USDT=bars(Array(15).fill(100),60000);
  i.minutes.A_USDT.push(...bars([100.5,100.8,101],60000,T+180000));
  assert.equal(advanceSpecialResearch(i).watches.A_USDT!.route,undefined);
  const broken=flat();broken.splice(32,1);assert.equal(specialRows(broken,T).length,3);
  const future=own();future.quotes.A_USDT=q(101,T+1);assert.equal(advanceSpecialResearch(future).watches.A_USDT!.fresh,false);
});
test('another venue cannot manufacture an own 1m departure from the 5m reference',()=>{
  const i=own();for(const r of i.minutes.A_USDT)r.volumeVenue='OKX';
  assert.equal(advanceSpecialResearch(i).watches.A_USDT!.route,undefined);
  i.paths.A_USDT=bars([...Array(33).fill(100),100.5,100.8,101]);
  assert.equal(advanceSpecialResearch(i).watches.A_USDT!.route!.proofAt,T,'same-venue completed5m evidence remains admissible');
});
test('far chase, stale quote and disagreement block executable admission',()=>{
  const r=advanceSpecialResearch(own());assert.equal(specialMarketRoute(r,'A_USDT',102,T).route,null);
  assert.equal(specialMarketRoute(r,'A_USDT',101,T+10001).route,null);
  const i=own();i.quotes.A_USDT.disagreementRate=.02;assert.equal(advanceSpecialResearch(i).watches.A_USDT!.route,undefined);
});
test('repeated fresh ticks retain one proof, stop and target across checkpoint restoration',()=>{
  const i=own(),r=advanceSpecialResearch(i),again=advanceSpecialResearch({...i,previous:r,now:T+2000,quotes:{A_USDT:q(101.01,T+2000)}});
  assert.deepEqual(again.watches.A_USDT!.route,r.watches.A_USDT!.route);
  const s=initialForward(T-7200000),activated=advanceDirectStrategy({state:s,now:T,specialMove:true,marketAuthority:true,
    allowDataCycle:false,quotes:{},paths:{},contracts:{}}).state;
  activated.directStrategy!.specialResearch=again;activated.lastQuoteCycleAt=T+2000;
  const restored=restoreForwardProtectionCheckpoint(activated,buildForwardProtectionCheckpoint(activated));
  assert.deepEqual(restored.directStrategy!.specialResearch,again);assert.equal(restored.startedAt,s.startedAt);
});
test('a new event needs a genuine completed pullback and restart, not just later time',()=>{
  const i=own(),r=advanceSpecialResearch(i),later=T+180000;
  const continuation=advanceSpecialResearch({...i,previous:r,now:later,minutes:{A_USDT:bars([...Array(12).fill(100),101.1,101.2,101.3],60000,later)},quotes:{A_USDT:q(101.3,later)}});
  assert.equal(continuation.watches.A_USDT!.route!.proofAt,T);
  const restart=advanceSpecialResearch({...i,previous:r,now:later,minutes:{A_USDT:bars([...Array(12).fill(100),101,100.7,101.15],60000,later)},quotes:{A_USDT:q(101.15,later)}});
  assert.equal(restart.watches.A_USDT!.route!.proofAt,later);assert.equal(restart.watches.A_USDT!.route!.proofPath,'RETEST_RESTART');
});
test('broken old premise cannot silently become a same-side new retained event',()=>{
  const i=own(),r=advanceSpecialResearch(i);r.watches.A_USDT!.route!.stop=101.1;
  const w=advanceSpecialResearch({...i,previous:r,now:T+2000,quotes:{A_USDT:q(101,T+2000)}}).watches.A_USDT!;
  assert.notEqual(w.phase,'READY');
});
test('research survives rotation with explicit dormant authority and expires after six hours',()=>{
  const r=advanceSpecialResearch(own()),dormant=advanceSpecialResearch({previous:r,now:T+2000,paths:{},quotes:{},states:{}});
  assert.equal(dormant.watches.A_USDT!.phase,'DORMANT');assert.equal(dormant.watches.A_USDT!.firstSeenAt,T);
  assert.equal(specialMarketRoute(dormant,'A_USDT',101,T+2000).route,null);
  assert.equal(Object.keys(advanceSpecialResearch({previous:dormant,now:T+SPECIAL_WATCH_TTL+1,paths:{},quotes:{},states:{}}).watches).length,0);
});
test('group duplicates cannot overpower comparison; large research remains capped and protects held names',()=>{
  const i=market(),original=advanceSpecialResearch(i).marketMoves;
  for(let n=0;n<120;n++){const symbol=`X${n}_USDT`;i.paths[symbol as 'A_USDT']=i.paths.B_USDT!;i.states[symbol as 'A_USDT']=state(symbol,'B_USDT');i.quotes[symbol as 'A_USDT']=q(104.6);}
  const r=advanceSpecialResearch({...i,protectedSymbols:['A_USDT']});assert.deepEqual(r.marketMoves,original);
  assert.ok(Object.keys(r.watches).length<=64);assert.ok(new TextEncoder().encode(JSON.stringify(r)).length<=SPECIAL_RESEARCH_BYTES);
  assert.ok(r.watches.A_USDT);assert.ok(r.dropped>0);
});
test('corrupt or future persisted observations are rejected as optional research',()=>{
  const malformed=advanceSpecialResearch(own());assert.equal(normalizeSpecialResearch({...malformed,watches:{A_USDT:null}}),undefined);
  assert.equal(normalizeSpecialResearch({...malformed,watches:[]}),undefined);
  const r=advanceSpecialResearch(own());for(const corrupt of [(x:typeof r)=>{x.watches.A_USDT!.observedAt=T+1;},
    (x:typeof r)=>{x.watches.A_USDT!.route!.proofBars=[T+1];},(x:typeof r)=>{x.watches.A_USDT!.route!.reference.upper=NaN;}]){
    const x=structuredClone(r);corrupt(x);assert.equal(normalizeSpecialResearch(x),undefined);}
});
const ticker=(symbol:string,price:number,at:number)=>({symbol,last:price,observedAt:at,sourceCount:3,volume24hUsd:2e6,
  executionVolume24hUsd:2e6,high24h:110,low24h:90,change24hRate:0,fundingRate:0,openInterest:100,shortMoveRate:0});
test('bulk minute observations discover quiet active candidates without inventing history',()=>{
  const h:SpecialRadarHistory=new Map();let rows;
  for(let n=0;n<=16;n++)rows=observeSpecialRadar([ticker('QUIET_USDT',100,T+n*60000),...Array.from({length:20},(_,k)=>ticker(`B${k}_USDT`,100+n*.1,T+n*60000))],h,T+n*60000);
  assert.equal(rows![0]!.move15Rate,0);
  const picked=selectSpecialMoveUniverse({rows:rows!,limit:6,lockedSymbols:[],rotationSeed:0,now:T+16*60000});
  assert.ok(picked.some(r=>r.symbol==='QUIET_USDT'));assert.equal(picked.length,6);
  const before=h.get('QUIET_USDT')!.length;observeSpecialRadar([ticker('QUIET_USDT',99,T+16*60000)],h,T+16*60000);
  assert.equal(h.get('QUIET_USDT')!.length,before);
  const gap:SpecialRadarHistory=new Map();observeSpecialRadar([ticker('GAP_USDT',100,T)],gap,T);
  assert.equal(observeSpecialRadar([ticker('GAP_USDT',110,T+15*60000)],gap,T+15*60000)[0]!.move15Rate,undefined);
});
test('radar history and scan capacity are bounded; held names retain priority',()=>{
  const h:SpecialRadarHistory=new Map(),rows=Array.from({length:1100},(_,n)=>ticker(`X${n}_USDT`,100,T));observeSpecialRadar(rows,h,T);
  assert.equal(h.size,1024);const picked=selectSpecialMoveUniverse({rows,limit:30,lockedSymbols:['X999_USDT'],rotationSeed:7,now:T});
  assert.equal(picked.length,30);assert.equal(picked[0]!.symbol,'X999_USDT');assert.equal(new Set(picked.map(r=>r.symbol)).size,30);
});
test('actual controller reaches shared PAPER submission without broad quorum or resetting money',()=>{
  for(const side of [1,-1])for(const launch of [1,12.5]){
  const base=initialForward(T-7200000),start=base.startedAt,c={quantoMultiplier:.1,leverageMax:20,maintenanceRate:.005,minContracts:1,tickSize:.01};
  const i=own(side);let s=base;
  if(launch>1)i.minutes.A_USDT=bars([...Array(12).fill(100),100+side*12,100+side*10.5,100+side*launch],60000);
  for(let n=0;n<=42;n++){const now=T+n*2000;
    s=advanceDirectStrategy({state:s,now,specialMove:true,marketAuthority:true,allowDataCycle:false,entrySymbols:['A_USDT','MISSING_USDT'],
      quotes:{A_USDT:q(100+side*(launch+n*.014),now)},analysisQuotes:{A_USDT:q(100+side*(launch+n*.014),now)},paths:i.paths,minutePaths:i.minutes,
      contracts:{A_USDT:c},paperTiming:{version:'native-position-first-observed-v1',prepareMs:2000,confirmMs:0,basis:'EXECUTION_CLOCK',samples:0}}).state;
    if(s.positions.length)break;
  }
  assert.equal(s.startedAt,start);assert.equal(s.history.length,0);assert.equal(s.directStrategy!.specialMove!.version,'special-move-v1');
  assert.ok(s.positions.length>0,JSON.stringify({plans:s.directStrategy!.plans,validations:s.entryValidations,diagnostics:s.entryDiagnostics}));
  assert.equal(s.positions[0]!.side,side>0?'LONG':'SHORT');assert.equal(s.positions[0]!.paperOrder!.phase,'PREPARING');
  assert.equal(s.balance,1000);assert.ok(s.positions[0]!.notional>16);assert.equal(normalizeForward(s,T+84000).startedAt,start);
  }
});
test('losing optional research cannot rearm a previously traded same-side explosive event',()=>{
  const i=own(),c={quantoMultiplier:.1,leverageMax:20,maintenanceRate:.005,minContracts:1,tickSize:.01};
  const s=advanceDirectStrategy({state:initialForward(T-7200000),now:T,specialMove:true,marketAuthority:true,
    quotes:i.quotes,paths:i.paths,minutePaths:i.minutes,contracts:{A_USDT:c},allowDataCycle:false}).state;
  s.lastSide.A_USDT='LONG';s.lastExitAt.A_USDT=T+1000;
  assert.match(openDirectPlan(s,s.directStrategy!.plans.A_USDT!,q(),c,T,i.quotes,undefined,i.minutes.A_USDT,undefined,i.paths.A_USDT)!,/等待退出之后真实回踩重启/);
  assert.equal(s.positions.length,0);assert.equal(s.balance,1000);
});
